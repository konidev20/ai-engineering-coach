/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Core analysis pipeline: discover logs → parse → analyze → serialize.
 *
 * This is the heart of the CLI. It reuses the same parser and analyzer
 * that the VS Code extension uses, ensuring consistent results across
 * both modes.
 *
 * Usage:
 *   const result = await runAnalysis();
 *   console.log(JSON.stringify(result, null, 2));
 */

import { findLogsDirs, parseAllLogs, ParseResult, collectExternalHarnessesSync } from '../core/parser';
import { Analyzer } from '../core/analyzer';
import { runtimeDebug } from '../core/runtime-debug';

/**
 * Complete analysis output — all data the webview needs to render.
 * Structured to match the RPC method responses the webview expects.
 */
export interface AnalysisOutput {
  // Raw parse results
  parseResult: {
    sessionCount: number;
    workspaceCount: number;
    harnesses: string[];
  };

  // Analyzer data (keyed by RPC method name for easy webview consumption)
  data: Record<string, unknown>;

  // Metadata
  meta: {
    parseTimeMs: number;
    analyzeTimeMs: number;
    totalSessions: number;
    totalWorkspaces: number;
    harnesses: string[];
  };
}

/**
 * Run the full analysis pipeline.
 *
 * @param workspaceRoot - Optional workspace root for project-level rules
 * @returns Complete analysis output ready for JSON serialization
 */
export async function runAnalysis(_workspaceRoot?: string): Promise<AnalysisOutput> {
  const t0 = Date.now();

  // Step 1: Discover log directories
  runtimeDebug('cli', 'findLogsDirs');
  const dirs = findLogsDirs();
  runtimeDebug('cli', 'logs-dirs-found', `count=${dirs.length}`);

  // Step 2: Parse all logs (may be empty if no VS Code/Xcode logs)
  runtimeDebug('cli', 'parseAllLogs');
  const parseResult: ParseResult = dirs.length > 0
    ? parseAllLogs(dirs)
    : { sessions: [], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
  const parseTimeMs = Date.now() - t0;

  // Step 2b: Collect external harness sessions (Claude, Codex, OpenCode)
  // These are independent of VS Code logs and may be the only data source.
  runtimeDebug('cli', 'collectExternalHarnesses');
  collectExternalHarnessesSync(parseResult.workspaces, parseResult.sessions);

  if (parseResult.sessions.length === 0) {
    throw new Error(
      'No AI session logs found.\n' +
      'Make sure you have used Copilot, Claude Code, Codex, or OpenCode.\n' +
      'Logs are searched in standard locations for each harness.'
    );
  }

  runtimeDebug('cli', 'parse-complete',
    `sessions=${parseResult.sessions.length} workspaces=${parseResult.workspaces.size}`
  );

  // Step 3: Build analyzer
  const t1 = Date.now();
  const analyzer = new Analyzer(
    parseResult.sessions,
    parseResult.editLocIndex,
    parseResult.workspaces
  );
  const analyzeTimeMs = Date.now() - t1;

  // Step 4: Collect all data the webview needs
  const data = collectAllData(analyzer);

  // Step 5: Build output
  const harnesses = analyzer.getHarnesses();

  return {
    parseResult: {
      sessionCount: parseResult.sessions.length,
      workspaceCount: parseResult.workspaces.size,
      harnesses,
    },
    data,
    meta: {
      parseTimeMs,
      analyzeTimeMs,
      totalSessions: parseResult.sessions.length,
      totalWorkspaces: parseResult.workspaces.size,
      harnesses,
    },
  };
}

/**
 * Collect all analyzer data in a format matching RPC responses.
 * This lets the webview use the same data structure whether it gets
 * data from the VS Code extension or from a JSON file.
 */
function collectAllData(analyzer: Analyzer): Record<string, unknown> {
  return {
    getWorkspaces: analyzer.getWorkspaces(),
    getHarnesses: analyzer.getHarnesses(),
    getHarnessBreakdown: analyzer.getHarnessBreakdown(),
    getDailyActivity: analyzer.getDailyActivity(),
    getWorkspaceBreakdown: analyzer.getWorkspaceBreakdown(),
    getHourlyDistribution: analyzer.getHourlyDistribution(),
    getHeatmap: analyzer.getHeatmap(),
    getCodeProduction: analyzer.getCodeProduction(),
    getConsumption: analyzer.getConsumption(),
    getBurndown: analyzer.getBurndown({ sku: 'pro' }),
    getAiCredits: analyzer.getAiCredits(),
    getAiCreditBurndown: analyzer.getAiCreditBurndown({ sku: 'pro' }),
    getTokenCoverage: analyzer.getTokenCoverage(),
    getDayTimeline: analyzer.getDayTimeline(),
    getSessions: analyzer.getSessions(1, 20),
    getWorkLifeBalance: analyzer.getWorkLifeBalance(),
    getAntiPatterns: analyzer.getAntiPatterns(),
    getHarnessComparison: analyzer.getHarnessComparison(),
    getParserCoverage: analyzer.getParserCoverage(),
    getWorkflowOptimization: analyzer.getWorkflowOptimization(),
    getStats: analyzer.getStats(),
    getConfigHealth: analyzer.getConfigHealth(),
    getInsights: analyzer.getInsights(),
    getFlowState: analyzer.getFlowState(),
    getContextManagement: analyzer.getContextManagement(),
    getCalendarActivity: analyzer.getCalendarActivity(),
    getProjectOverview: analyzer.getProjectOverview(),
  };
}
