/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* OpenCode session parser
 *
 * Two storage modes:
 *
 * 1. JSON file storage (older versions):
 *   ~/.local/share/opencode/storage/session/global/<session-id>.json   -- session metadata
 *   ~/.local/share/opencode/storage/message/<session-id>/<msg-id>.json -- message metadata
 *   ~/.local/share/opencode/storage/part/<msg-id>/<part-id>.json       -- content parts
 *
 * 2. SQLite database (newer versions, v1.15+):
 *   ~/.local/share/opencode/opencode.db
 *   Tables: session, session_message (type=user|assistant|event), part
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ModelUsage, Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests, extractCodeBlocks } from './parser-shared';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId } from './helpers';

interface OcSession {
  id: string;
  slug?: string;
  version?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

interface OcMessage {
  id: string;
  sessionID: string;
  role: string;
  time?: { created?: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  finish?: string;
  summary?: { title?: string; diffs?: unknown[] };
  variant?: string;
  model?: { providerID?: string; modelID?: string };
}

interface OcPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string };
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
  reason?: string;
}

interface OpenCodeSqliteSessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
  model: string | null;
  agent: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

interface OpenCodeSqliteMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OpenCodeSqlitePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OpenCodeAssistantData {
  responseText: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  modelId: string;
  totalElapsed: number | null;
  lastTs: number | null;
  tokenSource: OcMessage['tokens'] | null;
}

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'patch']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'find']);

export function findOpenCodeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];

  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (fs.existsSync(dbPath)) return [dbPath];

  // JSON file storage (older versions)
  const storagePath = path.join(home, '.local', 'share', 'opencode', 'storage');
  if (fs.existsSync(storagePath)) dirs.push(storagePath);

  return dirs;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    assertTrustedPath(filePath);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readAllJsonInDir<T>(dir: string): T[] {
  const results: T[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const data = readJsonSafe<T>(path.join(dir, e.name));
      if (data) results.push(data);
    }
  } catch {
    /* skip unreadable dirs */
  }
  return results;
}

function projectNameFromDir(directory: string): string {
  return directory.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown';
}

function getOpenCodeUserText(msg: OcMessage, partsByMsg: Map<string, OcPart[]>): string {
  const userParts = partsByMsg.get(msg.id) || [];
  const userTextFromParts = userParts
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text!)
    .join('\n');
  return userTextFromParts || msg.summary?.title || '';
}

function findAssistantMessages(messages: OcMessage[], startIndex: number, parentId: string): OcMessage[] {
  const matches: OcMessage[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const candidate = messages[i];
    if (candidate.role === 'user') break;
    if (candidate.role === 'assistant' && candidate.parentID === parentId) matches.push(candidate);
  }

  const next = messages[startIndex];
  if (matches.length === 0 && next?.role === 'assistant') matches.push(next);
  return matches;
}

function applyOpenCodePart(part: OcPart, data: Pick<OpenCodeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles'>, textParts: string[]): void {
  if ((part.type === 'text' || part.type === 'reasoning') && part.text) {
    textParts.push(part.text);
    return;
  }

  if (part.type !== 'tool' || !part.tool) return;

  data.toolsUsed.push(part.tool);
  const input = part.state?.input || {};
  const filePath = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : typeof input.command === 'string'
          ? input.command
          : null;
  if (!filePath) return;

  const toolLower = part.tool.toLowerCase();
  if (WRITE_TOOLS.has(toolLower)) {
    data.editedFiles.push(filePath);
    const content = typeof input.content === 'string' ? input.content
      : typeof input.code === 'string' ? input.code
        : typeof input.new_string === 'string' ? input.new_string
          : typeof part.state?.output === 'string' ? part.state.output
            : null;
    if (content) {
      const ext = filePath.split('.').pop() || 'unknown';
      textParts.push(`\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
    }
  } else if (READ_TOOLS.has(toolLower)) {
    data.referencedFiles.push(filePath);
  }
}

function collectAssistantData(
  assistantMessages: OcMessage[],
  partsByMsg: Map<string, OcPart[]>,
  userTs: number | null,
  lastTs: number | null,
): OpenCodeAssistantData {
  const data: OpenCodeAssistantData = {
    responseText: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    modelId: '',
    totalElapsed: null,
    lastTs,
    tokenSource: null,
  };

  const textParts: string[] = [];
  for (const assistantMsg of assistantMessages) {
    const assistantTs = assistantMsg.time?.completed || assistantMsg.time?.created || null;
    if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;
    if (userTs && assistantTs) data.totalElapsed = assistantTs - userTs;

    if (assistantMsg.modelID) data.modelId = assistantMsg.modelID;
    data.tokenSource = assistantMsg.tokens ?? data.tokenSource;

    const parts = partsByMsg.get(assistantMsg.id) || [];
    for (const part of parts) {
      applyOpenCodePart(part, data, textParts);
    }
  }
  data.responseText = textParts.join('\n');

  return data;
}

function indexPartsByMessage(rawMessages: OcMessage[], storageDir: string): Map<string, OcPart[]> {
  const partsByMsg = new Map<string, OcPart[]>();
  for (const msg of rawMessages) {
    const partDir = path.join(storageDir, 'part', msg.id);
    const parts = readAllJsonInDir<OcPart>(partDir);
    if (parts.length > 0) partsByMsg.set(msg.id, parts);
  }
  return partsByMsg;
}

function getOpenCodeWorkspace(rawSession: OcSession): { wsId: string; wsName: string } {
  return {
    wsId: `opencode-${rawSession.id}`,
    wsName: rawSession.directory
      ? projectNameFromDir(rawSession.directory)
      : rawSession.title || rawSession.slug || 'unknown',
  };
}

function buildOpenCodeRequest(
  msg: OcMessage,
  partsByMsg: Map<string, OcPart[]>,
  assistantData: OpenCodeAssistantData,
  userTs: number | null,
): SessionRequest {
  const cacheRead = assistantData.tokenSource?.cache?.read ?? 0;
  const cacheWrite = assistantData.tokenSource?.cache?.write ?? 0;
  const hasTokenData = assistantData.tokenSource != null;
  return createRequest({
    requestId: msg.id,
    timestamp: userTs,
    messageText: getOpenCodeUserText(msg, partsByMsg),
    responseText: assistantData.responseText,
    agentName: msg.agent || 'OpenCode',
    agentMode: msg.agent || 'build',
    modelId: assistantData.modelId,
    toolsUsed: assistantData.toolsUsed,
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: [...new Set(assistantData.referencedFiles)],
    totalElapsed: assistantData.totalElapsed,
    promptTokens: hasTokenData ? (assistantData.tokenSource?.input ?? 0) + cacheRead + cacheWrite : null,
    completionTokens: hasTokenData ? (assistantData.tokenSource?.output ?? 0) : null,
    cacheReadTokens: cacheRead > 0 ? cacheRead : null,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
    reasoningEffort: canonicalizeReasoningEffort(msg.variant)
      ?? extractReasoningEffortFromModelId(assistantData.modelId),
  });
}

function buildOpenCodeSession(
  rawSession: OcSession,
  rawMessages: OcMessage[],
  partsByMsg: Map<string, OcPart[]>,
  modelUsage?: Record<string, ModelUsage>,
): Session | null {
  if (!rawSession.id) return null;

  rawMessages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
  if (rawMessages.length === 0) return null;

  const { wsId, wsName } = getOpenCodeWorkspace(rawSession);
  const requests: SessionRequest[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    if (msg.role !== 'user') continue;

    const userTs = msg.time?.created || null;
    if (userTs && (!firstTs || userTs < firstTs)) firstTs = userTs;

    const assistantMessages = findAssistantMessages(rawMessages, i + 1, msg.id);
    const assistantData = collectAssistantData(assistantMessages, partsByMsg, userTs, lastTs);
    lastTs = assistantData.lastTs;
    requests.push(buildOpenCodeRequest(msg, partsByMsg, assistantData, userTs));
  }

  if (requests.length === 0) return null;

  return createSession({
    sessionId: rawSession.id,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: 'OpenCode',
    creationDate: firstTs || (rawSession.time?.created || null),
      lastMessageDate: lastTs || (rawSession.time?.updated || null),
      requests,
      modelUsage,
      hasDevcontainer: detectDevcontainerFromRequests(requests, rawSession.directory),
  });
}

function parseOpenCodeSession(rawSession: OcSession, storageDir: string): Session | null {
  if (!rawSession.id) return null;

  const msgDir = path.join(storageDir, 'message', rawSession.id);
  const rawMessages = readAllJsonInDir<OcMessage>(msgDir);
  const partsByMsg = indexPartsByMessage(rawMessages, storageDir);
  return buildOpenCodeSession(rawSession, rawMessages, partsByMsg);
}

export function parseOpenCodeSessions(storageDir: string): Session[] {
  if (storageDir.endsWith('.db') && fs.existsSync(storageDir)) {
    return parseOpenCodeSQLite(storageDir);
  }

  // JSON file storage mode (older versions)
  const sessions: Session[] = [];
  const sessionDir = path.join(storageDir, 'session', 'global');
  const rawSessions = readAllJsonInDir<OcSession>(sessionDir);

  for (const rawSession of rawSessions) {
    const session = parseOpenCodeSession(rawSession, storageDir);
    if (session) sessions.push(session);
  }

  // If no JSON sessions found, try SQLite DB as fallback
  // (some versions have both storage/ dir and opencode.db)
  if (sessions.length === 0) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    if (fs.existsSync(dbPath)) {
      return parseOpenCodeSQLite(dbPath);
    }
  }

  return sessions;
}

/* ---- SQLite-based parser (OpenCode v1.15+) ---- */

function getExecStdout(error: unknown): string {
  const stdout = error && typeof error === 'object' && 'stdout' in error
    ? (error as { stdout?: unknown }).stdout
    : undefined;
  return typeof stdout === 'string' ? stdout : Buffer.isBuffer(stdout) ? stdout.toString('utf-8') : '';
}

/** Query SQLite using the `sqlite3` CLI. No npm dependency needed. */
function sqliteQuery(dbPath: string, sql: string): string {
  try {
    assertTrustedPath(dbPath);
    return execFileSync('sqlite3', [dbPath, sql], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    return getExecStdout(error);
  }
}

function sqliteQueryJson<T>(dbPath: string, sql: string): T[] {
  try {
    assertTrustedPath(dbPath);
    const raw = execFileSync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch (error) {
    const stdout = getExecStdout(error);
    if (!stdout) return [];
    try {
      const parsed: unknown = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
}

function escapeSqlString(value: string): string {
  return value.replaceAll('\'', '\'\'');
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringFromRecord(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function timeFromRecord(record: Record<string, unknown> | null, fallback: number): { created?: number; completed?: number } {
  const rawTime = record?.time;
  const time = rawTime && typeof rawTime === 'object' && !Array.isArray(rawTime)
    ? rawTime as Record<string, unknown>
    : {};
  const created = typeof time.created === 'number' ? time.created : fallback;
  const completed = typeof time.completed === 'number' ? time.completed : undefined;
  return { created, completed };
}

function tokensFromRecord(record: Record<string, unknown> | null): OcMessage['tokens'] | undefined {
  const rawTokens = record?.tokens;
  if (!rawTokens || typeof rawTokens !== 'object' || Array.isArray(rawTokens)) return undefined;
  const tokens = rawTokens as Record<string, unknown>;
  const rawCache = tokens.cache;
  const cache = rawCache && typeof rawCache === 'object' && !Array.isArray(rawCache)
    ? rawCache as Record<string, unknown>
    : undefined;
  return {
    input: typeof tokens.input === 'number' ? tokens.input : undefined,
    output: typeof tokens.output === 'number' ? tokens.output : undefined,
    reasoning: typeof tokens.reasoning === 'number' ? tokens.reasoning : undefined,
    cache: cache ? {
      read: typeof cache.read === 'number' ? cache.read : undefined,
      write: typeof cache.write === 'number' ? cache.write : undefined,
    } : undefined,
  };
}

function sqliteMessageFromRow(row: OpenCodeSqliteMessageRow): OcMessage | null {
  const data = parseJsonRecord(row.data);
  const role = stringFromRecord(data, 'role');
  if (role !== 'user' && role !== 'assistant') return null;

  const rawModel = data?.model;
  const model = rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel)
    ? rawModel as Record<string, unknown>
    : undefined;
  return {
    id: row.id,
    sessionID: row.session_id,
    role,
    parentID: stringFromRecord(data, 'parentID'),
    modelID: stringFromRecord(data, 'modelID') || (typeof model?.modelID === 'string' ? model.modelID : ''),
    providerID: stringFromRecord(data, 'providerID') || (typeof model?.providerID === 'string' ? model.providerID : ''),
    mode: stringFromRecord(data, 'mode'),
    agent: stringFromRecord(data, 'agent'),
    tokens: tokensFromRecord(data),
    finish: stringFromRecord(data, 'finish'),
    variant: typeof model?.variant === 'string' ? model.variant : undefined,
    summary: data?.summary && typeof data.summary === 'object' && !Array.isArray(data.summary)
      ? data.summary as OcMessage['summary']
      : undefined,
    time: timeFromRecord(data, row.time_created),
  };
}

function sqlitePartFromRow(row: OpenCodeSqlitePartRow): OcPart | null {
  const data = parseJsonRecord(row.data);
  const type = stringFromRecord(data, 'type');
  if (!type) return null;
  const state = data?.state && typeof data.state === 'object' && !Array.isArray(data.state)
    ? data.state as OcPart['state']
    : undefined;
  return {
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
    type,
    text: stringFromRecord(data, 'text'),
    tool: stringFromRecord(data, 'tool'),
    callID: stringFromRecord(data, 'callID'),
    state,
    tokens: tokensFromRecord(data) as OcPart['tokens'],
    cost: typeof data?.cost === 'number' ? data.cost : undefined,
    reason: stringFromRecord(data, 'reason'),
  };
}

function buildOpenCodeModelUsage(row: OpenCodeSqliteSessionRow): Record<string, ModelUsage> | undefined {
  const model = parseJsonRecord(row.model);
  const modelId = stringFromRecord(model, 'id') || stringFromRecord(model, 'modelID');
  if (!modelId || (!row.tokens_input && !row.tokens_output)) return undefined;
  return {
    [modelId]: {
      inputTokens: row.tokens_input || 0,
      outputTokens: row.tokens_output || 0,
      cacheReadTokens: row.tokens_cache_read || 0,
      cacheWriteTokens: row.tokens_cache_write || 0,
      reasoningTokens: row.tokens_reasoning || 0,
    },
  };
}

/** Parse OpenCode sessions from SQLite database. */
function parseOpenCodeSQLite(dbPath: string): Session[] {
  const sessions: Session[] = [];

  const sessionRows = sqliteQueryJson<OpenCodeSqliteSessionRow>(dbPath,
    `SELECT id, directory, title, time_created, time_updated, model, agent, cost,
            tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
            permission, version
     FROM session
     ORDER BY time_created ASC;`
  );

  if (sessionRows.length > 0) {
    for (const row of sessionRows) {
      const rawMessages = sqliteQueryJson<OpenCodeSqliteMessageRow>(dbPath,
        `SELECT id, session_id, time_created, data
         FROM message
         WHERE session_id = '${escapeSqlString(row.id)}'
         ORDER BY time_created ASC;`
      ).map(sqliteMessageFromRow).filter((msg): msg is OcMessage => msg != null);

      const partsByMsg = new Map<string, OcPart[]>();
      for (const part of sqliteQueryJson<OpenCodeSqlitePartRow>(dbPath,
        `SELECT id, message_id, session_id, time_created, data
         FROM part
         WHERE session_id = '${escapeSqlString(row.id)}'
         ORDER BY time_created ASC;`
      ).map(sqlitePartFromRow).filter((part): part is OcPart => part != null)) {
        const parts = partsByMsg.get(part.messageID) || [];
        parts.push(part);
        partsByMsg.set(part.messageID, parts);
      }

      const session = buildOpenCodeSession({
        id: row.id,
        directory: row.directory,
        title: row.title,
        time: { created: row.time_created, updated: row.time_updated },
      }, rawMessages, partsByMsg, buildOpenCodeModelUsage(row));
      if (session) sessions.push(session);
    }
  }

  if (sessions.length > 0) return sessions;

  const legacyRows = sqliteQuery(dbPath,
    `SELECT id, directory, title, time_created, time_updated, model, agent, cost,
            tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
            permission, version
     FROM session
     ORDER BY time_created ASC;`
  );
  if (!legacyRows.trim()) return sessions;

  for (const line of legacyRows.trim().split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('|');
    if (cols.length < 14) continue;

    const sessionId = cols[0];
    const directory = cols[1];
    const timeCreated = parseInt(cols[3], 10);
    const timeUpdated = parseInt(cols[4], 10);
    const modelJson = cols[5];

    const tokensInput = parseInt(cols[8], 10) || 0;
    const tokensOutput = parseInt(cols[9], 10) || 0;
    const tokensReasoning = parseInt(cols[10], 10) || 0;
    const tokensCacheRead = parseInt(cols[11], 10) || 0;
    const tokensCacheWrite = parseInt(cols[12], 10) || 0;

    // Fetch messages for this session
    const msgRows = sqliteQuery(dbPath,
      `SELECT id, type, time_created, data
       FROM session_message
       WHERE session_id = '${sessionId.replace(/'/g, "''")}'
       ORDER BY time_created ASC;`
    );

    const requests: SessionRequest[] = [];
    let currentUserMessage = '';
    let currentAssistantTexts: string[] = [];
    let currentToolsUsed: string[] = [];
    let currentEditedFiles: string[] = [];
    let turnModel = '';
    let turnStartTs: number | null = null;
    let lastTs: number | null = null;

    if (msgRows.trim()) {
      for (const msgLine of msgRows.trim().split('\n')) {
        if (!msgLine.trim()) continue;
        const msgCols = msgLine.split('|');
        if (msgCols.length < 4) continue;

        const msgType = msgCols[1];
        const msgTime = parseInt(msgCols[2], 10);
        const dataStr = msgCols.slice(3).join('|'); // data may contain |

        if (msgType === 'user') {
          // Flush previous request
          if (currentUserMessage) {
            const req = buildOpenCodeRequestFromSQLite(
              currentUserMessage, currentAssistantTexts.join('\n'),
              currentToolsUsed, currentEditedFiles, turnModel, turnStartTs, lastTs,
            );
            if (req) requests.push(req);
          }
          try {
            const data = JSON.parse(dataStr);
            currentUserMessage = extractTextFromOcData(data);
          } catch {
            currentUserMessage = dataStr.slice(0, 500);
          }
          turnStartTs = msgTime;
          currentAssistantTexts = [];
          currentToolsUsed = [];
          currentEditedFiles = [];
        } else if (msgType === 'assistant') {
          try {
            const data = JSON.parse(dataStr);
            const text = extractTextFromOcData(data);
            if (text) currentAssistantTexts.push(text);
            if (data.model && typeof data.model === 'object') {
              const m = data.model as Record<string, unknown>;
              if (m.id) turnModel = String(m.id);
            }
            if (Array.isArray(data.tool_calls)) {
              for (const tc of data.tool_calls) {
                if (tc && typeof tc === 'object' && 'function' in (tc as Record<string, unknown>)) {
                  const fn = (tc as Record<string, unknown>).function as Record<string, unknown>;
                  const toolName = String(fn.name || '').toLowerCase();
                  currentToolsUsed.push(toolName);
                  if (WRITE_TOOLS.has(toolName)) {
                    const input = (fn.input as Record<string, unknown>) || {};
                    const filePath = String(input.file_path || input.path || '');
                    if (filePath) currentEditedFiles.push(filePath);
                  }
                }
              }
            }
          } catch { /* skip */ }
          lastTs = msgTime;
        } else if (msgType === 'event') {
          try {
            const data = JSON.parse(dataStr);
            if (data.model && typeof data.model === 'object') {
              const m = data.model as Record<string, unknown>;
              if (m.id) turnModel = String(m.id);
            }
          } catch { /* skip */ }
        }
      }

      // Flush last request
      if (currentUserMessage) {
        const req = buildOpenCodeRequestFromSQLite(
          currentUserMessage, currentAssistantTexts.join('\n'),
          currentToolsUsed, currentEditedFiles, turnModel, turnStartTs, lastTs,
        );
        if (req) requests.push(req);
      }
    }

    if (requests.length === 0) continue;

    // Parse model info from session-level JSON
    let modelId = '';
    try {
      const m = JSON.parse(modelJson);
      if (m && typeof m === 'object' && 'id' in m) modelId = String((m as Record<string, unknown>).id);
    } catch { /* skip */ }

    const wsName = projectNameFromDir(directory);
    const wsId = `opencode-${wsName}`;

    const modelUsage: Record<string, ModelUsage> = {};
    if (modelId && (tokensInput || tokensOutput)) {
      modelUsage[modelId] = {
        inputTokens: tokensInput,
        outputTokens: tokensOutput,
        cacheReadTokens: tokensCacheRead,
        cacheWriteTokens: tokensCacheWrite,
        reasoningTokens: tokensReasoning,
      };
    }

    sessions.push(createSession({
      sessionId,
      workspaceId: wsId,
      workspaceName: wsName,
      location: 'terminal',
      harness: 'OpenCode',
      creationDate: timeCreated || null,
      lastMessageDate: lastTs || timeUpdated || null,
      requests,
      modelUsage,
      hasDevcontainer: detectDevcontainerFromRequests(requests, directory),
    }));
  }

  return sessions;
}

/** Extract text content from OpenCode message data JSON. */
function extractTextFromOcData(data: Record<string, unknown>): string {
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.content)) {
    return data.content
      .filter((c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
      .map((c: unknown) => (c as Record<string, unknown>).text || '')
      .join('\n');
  }
  if (typeof data.message === 'string') return data.message;
  return '';
}

/** Build a SessionRequest from SQLite-parsed data. */
function buildOpenCodeRequestFromSQLite(
  userMessage: string,
  responseText: string,
  toolsUsed: string[],
  editedFiles: string[],
  modelId: string,
  startTs: number | null,
  endTs: number | null,
): SessionRequest | null {
  const aiCode = extractCodeBlocks(responseText);
  const userCode = extractCodeBlocks(userMessage);
  const totalElapsed = (startTs && endTs) ? endTs - startTs : null;

  return createRequest({
    requestId: `oc-sqlite-${startTs || Date.now()}`,
    timestamp: startTs || Date.now(),
    messageText: userMessage,
    responseText,
    modelId,
    toolsUsed: [...new Set(toolsUsed)],
    editedFiles,
    aiCode,
    userCode,
    totalElapsed,
  });
}
