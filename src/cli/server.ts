/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HTTP server for standalone AI Engineer Coach dashboard.
 *
 * Uses Node's built-in http module (zero dependencies).
 * Serves:
 *   - GET /         → Dashboard HTML shell
 *   - GET /app.js   → Webview bundle (Preact app)
 *   - GET /styles.css → Bundled CSS
 *   - POST /api/*   → RPC method handlers (same as VS Code extension)
 *
 * The server parses logs on startup, caches the Analyzer in memory,
 * and serves the existing webview with a fetch-based RPC adapter.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Analyzer } from '../core/analyzer';
import { findLogsDirs, parseAllLogs, ParseResult } from '../core/parser';
import { handleRpcMethod } from './rpc-adapter';
import { getStandaloneHtml, getErrorHtml } from './server-html';
import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';
import { runtimeDebug } from '../core/runtime-debug';

/** Server configuration options. */
export interface ServerOptions {
  /** Port to listen on (default: 3000) */
  port: number;
  /** Workspace root for project-level rules */
  workspaceRoot?: string;
}

/** Running server state. */
interface ServerState {
  analyzer: Analyzer;
  parseResult: ParseResult;
}

/**
 * Start the HTTP server.
 *
 * This function:
 * 1. Discovers and parses session logs
 * 2. Builds the analyzer
 * 3. Starts the HTTP server
 * 4. Logs the URL to access the dashboard
 */
export async function startServer(options: ServerOptions): Promise<void> {
  const port = options.port || 3000;

  // Step 1: Discover log directories
  console.log('Discovering session logs...');
  const dirs = findLogsDirs();
  if (dirs.length === 0) {
    console.error('No AI session log directories found.');
    console.error('Make sure you have used Copilot, Claude Code, Codex, or OpenCode.');
    process.exit(1);
  }
  console.log(`Found ${dirs.length} log directories.`);

  // Step 2: Parse all logs
  console.log('Parsing session logs...');
  const parseResult = parseAllLogs(dirs);
  console.log(`Parsed ${parseResult.sessions.length} sessions across ${parseResult.workspaces.size} workspaces.`);

  // Step 3: Build analyzer
  console.log('Building analyzer...');
  const analyzer = new Analyzer(
    parseResult.sessions,
    parseResult.editLocIndex,
    parseResult.workspaces
  );

  const state: ServerState = { analyzer, parseResult };

  // Step 4: Create and start HTTP server
  const server = createServer(state);

  server.listen(port, () => {
    console.log(`\nAI Engineer Coach dashboard running at:`);
    console.log(`  http://localhost:${port}`);
    console.log(`\nPress Ctrl+C to stop.`);
  });
}

/**
 * Create the HTTP server with all routes.
 */
function createServer(state: ServerState): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Set CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Route: RPC API
      if (pathname.startsWith('/api/') && req.method === 'POST') {
        await handleApiRequest(req, res, state);
        return;
      }

      // Route: Webview bundle (app.js)
      if (pathname === '/app.js') {
        serveFile(res, path.join(__dirname, '..', 'webview', 'app.js'), 'application/javascript');
        return;
      }

      // Route: CSS bundle
      if (pathname === '/styles.css') {
        serveFile(res, path.join(__dirname, '..', 'webview', 'styles.css'), 'text/css');
        return;
      }

      // Route: Dashboard HTML (default)
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getStandaloneHtml({
          tokenReportingEnabled: FF_TOKEN_REPORTING_ENABLED,
        }));
        return;
      }

      // Route: Serve static assets from dist/webview/
      const assetPath = path.join(__dirname, '..', 'webview', pathname);
      if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        const ext = path.extname(assetPath);
        const mime = getMimeType(ext);
        serveFile(res, assetPath, mime);
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      console.error('Server error:', err);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(getErrorHtml(err instanceof Error ? err.message : 'Internal server error'));
    }
  });
}

/**
 * Handle an API request to /api/{method}.
 *
 * Expects a POST request with JSON body:
 *   { "params": { ... } }
 *
 * Returns JSON:
 *   { "data": <result> }  or  { "error": "<message>" }
 */
async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState,
): Promise<void> {
  // Extract method name from URL path: /api/getDailyActivity → getDailyActivity
  const method = req.url?.replace('/api/', '') || '';

  if (!method) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing method name' }));
    return;
  }

  // Parse request body
  const body = await readRequestBody(req);
  let params: Record<string, unknown> = {};
  try {
    if (body) {
      const parsed = JSON.parse(body);
      params = parsed.params || parsed;
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  // Call the RPC handler
  const result = await handleRpcMethod(
    method,
    params,
    state.analyzer,
    state.parseResult
  );

  // Return result
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify({ data: result }));
}

/**
 * Read the full request body as a string.
 */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => { resolve(body); });
    req.on('error', () => { resolve(''); });
  });
}

/**
 * Serve a file with the given MIME type.
 */
function serveFile(res: http.ServerResponse, filePath: string, mimeType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
  }
}

/**
 * Get MIME type from file extension.
 */
function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
  };
  return map[ext] || 'application/octet-stream';
}
