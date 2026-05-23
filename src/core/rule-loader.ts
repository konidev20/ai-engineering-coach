/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Multi-layer rule loader.
 *
 * Rules are loaded from three directories (lowest to highest precedence):
 *   1. Built-in:  dist/rules/          (shipped with the extension)
 *   2. Personal:  ~/.ai-engineer-coach/rules/  (user-level, shared across workspaces)
 *   3. Project:   <workspace>/.ai-engineer-coach/rules/ (workspace-specific)
 *
 * The rule engine merges them so that project rules override personal rules
 * which override built-in rules (by matching on rule ID).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  registerBuiltinRuleSource,
  registerPersonalRuleSource,
  registerProjectRuleSource,
  clearLayerRules,
  loadBuiltinRules,
} from './rule-engine';
import { parseMetric, registerMetric, clearMetrics } from './metric-engine';
import type { MetricDefinition } from './metric-engine';
import { warnCore } from './log';
import { hashContent, type TrustGate, type TrustLayer } from './rule-trust';

let defaultTrustGate: TrustGate | undefined;
export function setDefaultTrustGate(gate: TrustGate | undefined): void {
  defaultTrustGate = gate;
}
function resolveGate(explicit?: TrustGate): TrustGate | undefined {
  return explicit ?? defaultTrustGate;
}

/** Well-known directory name used for personal and project rule storage. */
export const RULES_DIR_NAME = '.ai-engineer-coach/rules';

/** Absolute path to the personal rules directory. */
export function getPersonalRulesDir(): string {
  return path.join(os.homedir(), RULES_DIR_NAME);
}

/** Absolute path to the project rules directory for a given workspace root. */
export function getProjectRulesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, RULES_DIR_NAME);
}

let builtinRegistered = false;

function getBuiltinRulesDirs(): string[] {
  return [
    path.join(__dirname, 'rules'),
    path.join(__dirname, '..', 'rules'),
    path.join(__dirname, '..', 'src', 'core', 'rules'),
  ];
}

function getBuiltinMetricsDirs(): string[] {
  return [
    path.join(__dirname, 'metrics'),
    path.join(__dirname, '..', 'metrics'),
    path.join(__dirname, '..', 'src', 'core', 'metrics'),
  ];
}

/**
 * Load all .md files from the built-in rules/ directory and register them.
 * Safe to call multiple times (only loads once).
 */
export function registerAllBuiltinRules(): void {
  if (builtinRegistered) return;
  builtinRegistered = true;

  for (const rulesDir of getBuiltinRulesDirs()) {
    try {
      const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const id = file.replace(/\.md$/, '');
        const source = fs.readFileSync(path.join(rulesDir, file), 'utf-8');
        registerBuiltinRuleSource(id, source);
      }
      return;
    } catch {
      // Try the next known build/source location.
    }
  }
  warnCore('RuleLoader', 'Could not find rules directory');
}

/**
 * Load personal rules from ~/.ai-engineer-coach/rules/.
 * Can be called multiple times to reload (clears + re-registers).
 */
export function loadPersonalRules(trustGate?: TrustGate): number {
  clearLayerRules('personal');
  const dir = getPersonalRulesDir();
  return loadRulesFromDir(dir, (id, source, filePath) => registerPersonalRuleSource(id, source, filePath),
    resolveGate(trustGate), 'personal');
}

/**
 * Load project rules from <workspaceRoot>/.ai-engineer-coach/rules/.
 * Can be called multiple times to reload (clears + re-registers).
 */
export function loadProjectRules(workspaceRoot: string, trustGate?: TrustGate): number {
  clearLayerRules('project');
  const dir = getProjectRulesDir(workspaceRoot);
  return loadRulesFromDir(dir, (id, source, filePath) => registerProjectRuleSource(id, source, filePath),
    resolveGate(trustGate), 'project');
}

/**
 * Load all three layers. Call during extension activation.
 */
export function loadAllRuleLayers(workspaceRoot?: string, trustGate?: TrustGate): { builtin: number; personal: number; project: number } {
  registerAllBuiltinRules();
  const personal = loadPersonalRules(trustGate);
  const project = workspaceRoot ? loadProjectRules(workspaceRoot, trustGate) : 0;
  return {
    builtin: loadBuiltinRules().length,
    personal,
    project,
  };
}

/**
 * Scan a directory for .md rule files and call the register callback for each.
 * Returns the number of rules loaded.
 *
 * When `trustGate` is supplied, each file is checked before registration.
 * Files that fail the gate are skipped and reported via `trustGate.onBlocked`.
 */
function loadRulesFromDir(
  dir: string,
  register: (id: string, source: string, filePath: string) => void,
  trustGate?: TrustGate,
  layer: TrustLayer = 'personal',
): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return 0; // Directory doesn't exist yet -- that's fine
  }

  let count = 0;
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const id = file.replace(/\.md$/, '');
      const source = fs.readFileSync(filePath, 'utf-8');
      if (trustGate && !trustGate.isAllowed(filePath, source)) {
        trustGate.onBlocked({ filePath, layer, kind: 'rule', hash: hashContent(source), content: source });
        continue;
      }
      register(id, source, filePath);
      count++;
    } catch {
      warnCore('RuleLoader', `Failed to read ${filePath}`);
    }
  }
  return count;
}

/**
 * Summary of loaded rule layers (used by the UI help panel).
 */
export interface RuleLayerInfo {
  layer: 'built-in' | 'personal' | 'project';
  directory: string;
  exists: boolean;
  ruleCount: number;
}

/**
 * Get info about all rule layers, useful for the UI help panel.
 */
export function getRuleLayerInfo(workspaceRoot?: string): RuleLayerInfo[] {
  const personalDir = getPersonalRulesDir();
  const projectDir = workspaceRoot ? getProjectRulesDir(workspaceRoot) : '';

  function countMdFiles(dir: string): { exists: boolean; count: number } {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      return { exists: true, count: files.length };
    } catch {
      return { exists: false, count: 0 };
    }
  }

  const builtinCandidates = getBuiltinRulesDirs().map(dir => ({ dir, info: countMdFiles(dir) }));
  const builtin = builtinCandidates.find(candidate => candidate.info.exists) ?? builtinCandidates[0];
  const builtinDir = builtin.dir;
  const b = countMdFiles(builtinDir);
  const p = countMdFiles(personalDir);
  const pr = projectDir ? countMdFiles(projectDir) : { exists: false, count: 0 };

  const layers: RuleLayerInfo[] = [
    { layer: 'built-in', directory: builtinDir, exists: b.exists, ruleCount: b.count },
    { layer: 'personal', directory: personalDir, exists: p.exists, ruleCount: p.count },
  ];
  if (workspaceRoot) {
    layers.push({ layer: 'project', directory: projectDir, exists: pr.exists, ruleCount: pr.count });
  }
  return layers;
}

/* ================================================================== */
/*  Metric file loading (.metric.md)                                  */
/* ================================================================== */

let builtinMetricsRegistered = false;

/**
 * Load built-in .metric.md files from the metrics/ directory.
 */
export function registerAllBuiltinMetrics(): number {
  if (builtinMetricsRegistered) return 0;
  builtinMetricsRegistered = true;

  for (const dir of getBuiltinMetricsDirs()) {
    const count = loadMetricsFromDir(dir, 'built-in');
    if (count > 0) return count;
  }
  return 0;
}

/**
 * Load personal .metric.md files from ~/.ai-engineer-coach/metrics/.
 */
export function loadPersonalMetrics(trustGate?: TrustGate): number {
  const dir = path.join(os.homedir(), '.ai-engineer-coach', 'metrics');
  return loadMetricsFromDir(dir, 'personal', resolveGate(trustGate), 'personal');
}

/**
 * Load project .metric.md files from <workspace>/.ai-engineer-coach/metrics/.
 */
export function loadProjectMetrics(workspaceRoot: string, trustGate?: TrustGate): number {
  const dir = path.join(workspaceRoot, '.ai-engineer-coach', 'metrics');
  return loadMetricsFromDir(dir, 'project', resolveGate(trustGate), 'project');
}

/**
 * Load all metric layers. Call during extension activation.
 */
export function loadAllMetricLayers(workspaceRoot?: string, trustGate?: TrustGate): { builtin: number; personal: number; project: number } {
  clearMetrics();
  const builtin = registerAllBuiltinMetrics();
  const personal = loadPersonalMetrics(trustGate);
  const project = workspaceRoot ? loadProjectMetrics(workspaceRoot, trustGate) : 0;
  return { builtin, personal, project };
}

function loadMetricsFromDir(
  dir: string,
  source: MetricDefinition['source'],
  trustGate?: TrustGate,
  layer?: TrustLayer,
): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.metric.md'));
  } catch {
    return 0;
  }

  let count = 0;
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const markdown = fs.readFileSync(filePath, 'utf-8');
      if (trustGate && layer && !trustGate.isAllowed(filePath, markdown)) {
        trustGate.onBlocked({ filePath, layer, kind: 'metric', hash: hashContent(markdown), content: markdown });
        continue;
      }
      const metric = parseMetric(markdown);
      if (metric) {
        metric.source = source;
        metric.sourceFilePath = filePath;
        registerMetric(metric);
        count++;
      }
    } catch {
      warnCore('MetricLoader', `Failed to read ${filePath}`);
    }
  }
  return count;
}

const fsp = fs.promises;

export async function registerAllBuiltinRulesAsync(): Promise<void> {
  if (builtinRegistered) return;
  builtinRegistered = true;

  for (const rulesDir of getBuiltinRulesDirs()) {
    try {
      const files = (await fsp.readdir(rulesDir)).filter(f => f.endsWith('.md'));
      await Promise.all(files.map(async file => {
        const id = file.replace(/\.md$/, '');
        try {
          const source = await fsp.readFile(path.join(rulesDir, file), 'utf-8');
          registerBuiltinRuleSource(id, source);
        } catch {
          warnCore('RuleLoader', `Failed to read ${path.join(rulesDir, file)}`);
        }
      }));
      return;
    } catch {
      // Try the next known build/source location.
    }
  }
  warnCore('RuleLoader', 'Could not find rules directory');
}

async function loadRulesFromDirAsync(
  dir: string,
  register: (id: string, source: string, filePath: string) => void,
  trustGate?: TrustGate,
  layer: TrustLayer = 'personal',
): Promise<number> {
  let files: string[];
  try {
    files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md'));
  } catch {
    return 0;
  }

  let count = 0;
  await Promise.all(files.map(async file => {
    const filePath = path.join(dir, file);
    try {
      const id = file.replace(/\.md$/, '');
      const source = await fsp.readFile(filePath, 'utf-8');
      if (trustGate && !trustGate.isAllowed(filePath, source)) {
        trustGate.onBlocked({ filePath, layer, kind: 'rule', hash: hashContent(source), content: source });
        return;
      }
      register(id, source, filePath);
      count++;
    } catch {
      warnCore('RuleLoader', `Failed to read ${filePath}`);
    }
  }));
  return count;
}

export async function loadPersonalRulesAsync(trustGate?: TrustGate): Promise<number> {
  clearLayerRules('personal');
  return loadRulesFromDirAsync(getPersonalRulesDir(),
    (id, source, filePath) => registerPersonalRuleSource(id, source, filePath),
    resolveGate(trustGate), 'personal');
}

export async function loadProjectRulesAsync(workspaceRoot: string, trustGate?: TrustGate): Promise<number> {
  clearLayerRules('project');
  return loadRulesFromDirAsync(getProjectRulesDir(workspaceRoot),
    (id, source, filePath) => registerProjectRuleSource(id, source, filePath),
    resolveGate(trustGate), 'project');
}

export async function loadAllRuleLayersAsync(workspaceRoot?: string, trustGate?: TrustGate): Promise<{ builtin: number; personal: number; project: number }> {
  await registerAllBuiltinRulesAsync();
  const [personal, project] = await Promise.all([
    loadPersonalRulesAsync(trustGate),
    workspaceRoot ? loadProjectRulesAsync(workspaceRoot, trustGate) : Promise.resolve(0),
  ]);
  return {
    builtin: loadBuiltinRules().length,
    personal,
    project,
  };
}

export async function registerAllBuiltinMetricsAsync(): Promise<number> {
  if (builtinMetricsRegistered) return 0;
  builtinMetricsRegistered = true;

  for (const dir of getBuiltinMetricsDirs()) {
    const count = await loadMetricsFromDirAsync(dir, 'built-in');
    if (count > 0) return count;
  }
  return 0;
}

export async function loadPersonalMetricsAsync(trustGate?: TrustGate): Promise<number> {
  return loadMetricsFromDirAsync(path.join(os.homedir(), '.ai-engineer-coach', 'metrics'), 'personal', resolveGate(trustGate), 'personal');
}

export async function loadProjectMetricsAsync(workspaceRoot: string, trustGate?: TrustGate): Promise<number> {
  return loadMetricsFromDirAsync(path.join(workspaceRoot, '.ai-engineer-coach', 'metrics'), 'project', resolveGate(trustGate), 'project');
}

export async function loadAllMetricLayersAsync(workspaceRoot?: string, trustGate?: TrustGate): Promise<{ builtin: number; personal: number; project: number }> {
  clearMetrics();
  const builtin = await registerAllBuiltinMetricsAsync();
  const [personal, project] = await Promise.all([
    loadPersonalMetricsAsync(trustGate),
    workspaceRoot ? loadProjectMetricsAsync(workspaceRoot, trustGate) : Promise.resolve(0),
  ]);
  return { builtin, personal, project };
}

async function loadMetricsFromDirAsync(
  dir: string,
  source: MetricDefinition['source'],
  trustGate?: TrustGate,
  layer?: TrustLayer,
): Promise<number> {
  let files: string[];
  try {
    files = (await fsp.readdir(dir)).filter(f => f.endsWith('.metric.md'));
  } catch {
    return 0;
  }

  let count = 0;
  await Promise.all(files.map(async file => {
    const filePath = path.join(dir, file);
    try {
      const markdown = await fsp.readFile(filePath, 'utf-8');
      if (trustGate && layer && !trustGate.isAllowed(filePath, markdown)) {
        trustGate.onBlocked({ filePath, layer, kind: 'metric', hash: hashContent(markdown), content: markdown });
        return;
      }
      const metric = parseMetric(markdown);
      if (metric) {
        metric.source = source;
        metric.sourceFilePath = filePath;
        registerMetric(metric);
        count++;
      }
    } catch {
      warnCore('MetricLoader', `Failed to read ${filePath}`);
    }
  }));
  return count;
}
