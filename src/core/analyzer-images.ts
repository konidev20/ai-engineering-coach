/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Image Gallery analyzer -- extracts image usage moments from sessions */

import { AnalyzerBase } from './analyzer-base';
import { DateFilter, Session } from './types';
import { toDateStr } from './helpers';

/* ── Public types ─────────────────────────────────────────────── */

export interface ImageMoment {
  /** Unique key for dedup (requestId) */
  id: string;
  timestamp: number;
  date: string;
  /** Short excerpt from the user prompt (first 120 chars) */
  promptExcerpt: string;
  /** Short excerpt from the AI response */
  responseExcerpt: string;
  /** Number of images attached to this request */
  imageCount: number;
  /** Model used */
  model: string;
  /** Workspace name */
  workspace: string;
  workspaceId: string;
  sessionId: string;
  /** Agent / mode used */
  agent: string;
  /** Files edited in this turn */
  editedFiles: string[];
  /** AI-generated lines of code */
  aiLoc: number;
  /** Position within the session (1-based turn number) */
  turnNumber: number;
  /** Total turns in the session */
  sessionTurns: number;
}

export interface CodingJourney {
  /** Workspace this journey belongs to */
  workspace: string;
  workspaceId: string;
  /** Ordered moments that form a visual story */
  moments: ImageMoment[];
  /** Total AI LoC across the journey */
  totalAiLoc: number;
  /** Date range label */
  dateRange: string;
  /** Number of distinct models used */
  distinctModels: number;
  /** Number of distinct prompts (unique prompt texts) */
  distinctPrompts: number;
}

export interface ImageQualityFlag {
  kind: 'too-many-per-turn' | 'image-without-context';
  label: string;
  description: string;
  severity: 'info' | 'warn';
  moments: ImageMoment[];
}

export interface ImageStory {
  /** Session this story belongs to */
  sessionId: string;
  workspace: string;
  workspaceId: string;
  /** Ordered moments forming the story */
  moments: ImageMoment[];
  /** Total AI LoC across the story */
  totalAiLoc: number;
  /** Date label */
  date: string;
  /** Dominant model */
  model: string;
  /** Agent used */
  agent: string;
  /** Total images in the story */
  totalImages: number;
  /** Files edited across the story */
  editedFiles: string[];
}

export interface ImageGalleryData {
  /** All image moments, newest first */
  moments: ImageMoment[];
  /** Session-based stories (groups of consecutive image moments) */
  stories: ImageStory[];
  /** Grouped coding journeys (workspace clusters) */
  journeys: CodingJourney[];
  /** Quality flags / learning opportunities */
  qualityFlags: ImageQualityFlag[];
  /** Summary stats */
  summary: {
    totalImages: number;
    totalMoments: number;
    totalSessions: number;
    avgImagesPerMoment: number;
    topWorkspace: string;
    topModel: string;
    dateRange: string;
    /** Images per day over time */
    dailyImages: { date: string; count: number }[];
  };
}

/* ── Analyzer ─────────────────────────────────────────────────── */

export class ImageAnalyzer extends AnalyzerBase {
  getImageGallery(f?: DateFilter): ImageGalleryData {
    const reqs = this.filter(f);
    const sessions = this.filteredSessions(f);

    // Build lookup: requestId -> session
    const reqSessionMap = new Map<string, Session>();
    for (const s of sessions) {
      for (const r of s.requests) {
        reqSessionMap.set(r.requestId, s);
      }
    }

    // Extract all image moments
    const moments: ImageMoment[] = [];
    const sessionImageCounts = new Map<string, number>();

    for (const r of reqs) {
      const imgCount = r.variableKinds['image'] || 0;
      if (imgCount <= 0) continue;

      const session = this.requestSessionMap.get(r) ?? reqSessionMap.get(r.requestId);
      if (!session) continue;

      const turnIdx = session.requests.indexOf(r);
      const aiLoc = r.aiCode.reduce((s, b) => s + b.loc, 0);

      moments.push({
        id: r.requestId,
        timestamp: r.timestamp ?? 0,
        date: r.timestamp ? toDateStr(r.timestamp) : '',
        promptExcerpt: truncate(r.messageText, 120),
        responseExcerpt: truncate(r.responseText, 200),
        imageCount: imgCount,
        model: r.modelId || 'unknown',
        workspace: session.workspaceName || 'Unknown',
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        agent: r.agentMode || r.agentName || '',
        editedFiles: r.editedFiles.slice(0, 10),
        aiLoc,
        turnNumber: turnIdx + 1,
        sessionTurns: session.requests.length,
      });

      sessionImageCounts.set(
        session.sessionId,
        (sessionImageCounts.get(session.sessionId) ?? 0) + imgCount,
      );
    }

    moments.sort((a, b) => b.timestamp - a.timestamp);

    // Build journeys: cluster by workspace, ordered chronologically
    const journeys = this.buildJourneys(moments);

    // Build session-based stories for reels
    const stories = this.buildStories(moments);

    // Quality flags
    const qualityFlags = this.detectQualityFlags(moments);

    // Summary
    const totalImages = moments.reduce((s, m) => s + m.imageCount, 0);
    const workspaceCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const dailyMap = new Map<string, number>();

    for (const m of moments) {
      workspaceCounts.set(m.workspace, (workspaceCounts.get(m.workspace) ?? 0) + m.imageCount);
      modelCounts.set(m.model, (modelCounts.get(m.model) ?? 0) + m.imageCount);
      dailyMap.set(m.date, (dailyMap.get(m.date) ?? 0) + m.imageCount);
    }

    const topWorkspace = maxEntry(workspaceCounts) ?? '';
    const topModel = maxEntry(modelCounts) ?? '';
    const dates = moments.filter(m => m.date).map(m => m.date);
    const dateRange = dates.length > 0
      ? `${dates[dates.length - 1]} \u2013 ${dates[0]}`
      : '';

    const dailyImages = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    const sessionsWithImages = new Set(moments.map(m => m.sessionId)).size;

    return {
      moments,
      stories,
      journeys,
      qualityFlags,
      summary: {
        totalImages,
        totalMoments: moments.length,
        totalSessions: sessionsWithImages,
        avgImagesPerMoment: moments.length > 0 ? +(totalImages / moments.length).toFixed(1) : 0,
        topWorkspace,
        topModel,
        dateRange,
        dailyImages,
      },
    };
  }

  private buildJourneys(moments: ImageMoment[]): CodingJourney[] {
    const byWorkspace = new Map<string, ImageMoment[]>();
    for (const m of moments) {
      const key = m.workspaceId || m.workspace;
      if (!byWorkspace.has(key)) byWorkspace.set(key, []);
      byWorkspace.get(key)!.push(m);
    }

    const journeys: CodingJourney[] = [];
    for (const [wsId, wsMoments] of byWorkspace) {
      if (wsMoments.length < 2) continue; // need at least 2 moments for a journey
      const sorted = [...wsMoments].sort((a, b) => a.timestamp - b.timestamp);
      const models = new Set(sorted.map(m => m.model));
      const prompts = new Set(sorted.map(m => m.promptExcerpt));
      const totalAiLoc = sorted.reduce((s, m) => s + m.aiLoc, 0);
      const dates = sorted.filter(m => m.date).map(m => m.date);

      journeys.push({
        workspace: sorted[0].workspace,
        workspaceId: wsId,
        moments: sorted,
        totalAiLoc,
        dateRange: dates.length > 0 ? `${dates[0]} \u2013 ${dates[dates.length - 1]}` : '',
        distinctModels: models.size,
        distinctPrompts: prompts.size,
      });
    }

    // Sort by number of moments descending (richest journeys first)
    journeys.sort((a, b) => b.moments.length - a.moments.length);
    return journeys;
  }

  private buildStories(moments: ImageMoment[]): ImageStory[] {
    // Group moments by session
    const bySession = new Map<string, ImageMoment[]>();
    for (const m of moments) {
      if (!bySession.has(m.sessionId)) bySession.set(m.sessionId, []);
      bySession.get(m.sessionId)!.push(m);
    }

    const stories: ImageStory[] = [];
    for (const [sessionId, sessionMoments] of bySession) {
      if (sessionMoments.length < 2) continue; // single-image sessions aren't stories
      const sorted = [...sessionMoments].sort((a, b) => a.turnNumber - b.turnNumber);
      const allFiles = new Set<string>();
      for (const m of sorted) m.editedFiles.forEach(f => allFiles.add(f));
      const modelCounts = new Map<string, number>();
      for (const m of sorted) modelCounts.set(m.model, (modelCounts.get(m.model) ?? 0) + 1);
      const topModel = maxEntry(modelCounts) ?? sorted[0].model;

      stories.push({
        sessionId,
        workspace: sorted[0].workspace,
        workspaceId: sorted[0].workspaceId,
        moments: sorted,
        totalAiLoc: sorted.reduce((s, m) => s + m.aiLoc, 0),
        date: sorted[0].date,
        model: topModel,
        agent: sorted[0].agent || 'Chat',
        totalImages: sorted.reduce((s, m) => s + m.imageCount, 0),
        editedFiles: [...allFiles].slice(0, 15),
      });
    }

    // Sort by number of moments descending (richest stories first)
    stories.sort((a, b) => b.moments.length - a.moments.length);
    return stories;
  }

  private detectQualityFlags(
    moments: ImageMoment[],
  ): ImageQualityFlag[] {
    const flags: ImageQualityFlag[] = [];

    // 1) Too many images per turn (> 3 images in one request)
    const tooMany = moments.filter(m => m.imageCount > 3);
    if (tooMany.length > 0) {
      flags.push({
        kind: 'too-many-per-turn',
        label: 'Too many images per prompt',
        description: `${tooMany.length} prompt(s) included 4+ images. Models process each image separately and can lose focus. Try sending fewer, more targeted screenshots.`,
        severity: 'warn',
        moments: tooMany.slice(0, 10),
      });
    }

    // 2) Image prompts with very short text (< 20 chars) -- missing context
    const noContext = moments.filter(m => m.promptExcerpt.length < 20);
    if (noContext.length > 0) {
      flags.push({
        kind: 'image-without-context',
        label: 'Images without text context',
        description: `${noContext.length} image prompt(s) had fewer than 20 characters of text. Always describe what the screenshot shows and what you want changed -- the model may misinterpret UI elements without guidance.`,
        severity: 'warn',
        moments: noContext.slice(0, 10),
      });
    }

    return flags;
  }
}

/* ── Helpers ────────────────────────────────────────────────── */

function truncate(text: string, max: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '\u2026';
}

function maxEntry(map: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestVal = -1;
  for (const [k, v] of map) {
    if (v > bestVal) { bestVal = v; best = k; }
  }
  return best;
}
