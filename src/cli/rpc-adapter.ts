/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * RPC adapter: bridges existing panel-rpc handlers to HTTP routes.
 *
 * The webview sends RPC calls via postMessage in VS Code mode.
 * In standalone mode, it sends HTTP POST requests to /api/{method}.
 * This adapter receives those requests, calls the same handler functions,
 * and returns JSON responses.
 *
 * LLM-dependent methods are stubbed with a "not available" error.
 * This is intentional — LLM support will be added later via a pluggable
 * provider interface (OpenAI-compatible, Copilot API, etc.).
 */

import { Analyzer } from '../core/analyzer';
import { ParseResult } from '../core/parser';
import { getRpcHandler } from '../webview/panel-rpc';

/**
 * Methods that require LLM access and are not available in CLI mode.
 * These will return a structured error response.
 */
const LLM_METHODS = new Set([
  'generateRule',
  'explainOccurrence',
  'compileNlRule',
  'reviewContextFiles',
  // Extension methods that use LLM
  'createSkill',
  'generateSkillContent',
  'generateLearningQuiz',
  'generateLearningResources',
  'generateCodeComparison',
  'generateDidYouKnow',
  'triageSkills',
  'discoverCatalog',
  'triageCatalog',
]);

/**
 * Methods that require VS Code-specific APIs and are not available in CLI mode.
 */
const VSCODE_METHODS = new Set([
  'reviewLocalRules',
  'openExternal',
  'installSkill',
  'installCatalogItem',
  'getWorkspaceDeps',
  'getSdlcToolAnalysis',
  'getSdlcRepoScan',
  'getSdlcGitHubData',
]);

/**
 * Handle an RPC method call from the webview.
 *
 * @param method - The RPC method name
 * @param params - The method parameters
 * @param analyzer - The analyzer instance
 * @param parseResult - The parse result (needed for some methods)
 * @returns The method result or an error object
 */
export async function handleRpcMethod(
  method: string,
  params: Record<string, unknown>,
  analyzer: Analyzer,
  parseResult: ParseResult,
): Promise<unknown> {
  // Check if method is LLM-dependent
  if (LLM_METHODS.has(method)) {
    return {
      error: `Method "${method}" requires LLM access and is not available in CLI mode.`,
    };
  }

  // Check if method requires VS Code APIs
  if (VSCODE_METHODS.has(method)) {
    return {
      error: `Method "${method}" requires VS Code and is not available in CLI mode.`,
    };
  }

  // Get the handler for this method
  const handler = getRpcHandler(method);
  if (!handler) {
    return {
      error: `Unknown method: ${method}`,
    };
  }

  // Call the handler
  try {
    return await Promise.resolve(handler(analyzer, parseResult, params));
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
