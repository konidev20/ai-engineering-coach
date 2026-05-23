/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * File-based persistent store that implements the TrustMemento interface.
 *
 * Replaces vscode.Memento for CLI/standalone mode. Stores data as JSON files
 * under ~/.ai-engineer-coach/ with atomic writes (write .tmp, then rename).
 *
 * Why not a database?
 * - Only a few KB of data (approvals, budgets, preferences)
 * - No concurrent writers (single process)
 * - Human-readable and editable
 * - Zero dependencies
 *
 * Future LLM integration will use this same store for:
 * - API provider configuration references
 * - LLM usage tracking (token counts, cost estimates)
 * - Cached LLM responses with TTL
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Directory where all CLI data is stored: ~/.ai-engineer-coach/ */
const DATA_DIR = path.join(os.homedir(), '.ai-engineer-coach');

/**
 * FileStore: a key-value store backed by individual JSON files.
 * Each key maps to a separate file for minimal contention and easy debugging.
 *
 * Implements TrustMemento so it works with the existing rule-trust system.
 */
export class FileStore {
  private readonly dir: string;

  constructor(dir: string = DATA_DIR) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Get a value by key, returning defaultValue if not found. */
  get<T>(key: string, defaultValue: T): T {
    const filePath = this.keyPath(key);
    if (!fs.existsSync(filePath)) return defaultValue;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      // Corrupted or unreadable file — return default
      return defaultValue;
    }
  }

  /** Persist a value to disk atomically. */
  async update(key: string, value: unknown): Promise<void> {
    const filePath = this.keyPath(key);
    const tmpPath = filePath + '.tmp';
    const data = JSON.stringify(value, null, 2);
    // Write to temp file first, then rename for atomicity
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  /** Delete a key's file. */
  async delete(key: string): Promise<void> {
    const filePath = this.keyPath(key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /** Resolve the file path for a given key. */
  private keyPath(key: string): string {
    // Sanitize key to a safe filename
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /** Return the data directory path (for logging). */
  get dataDir(): string {
    return this.dir;
  }
}
