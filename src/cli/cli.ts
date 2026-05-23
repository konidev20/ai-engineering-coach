/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CLI entry point for AI Engineer Coach.
 *
 * Usage:
 *   ai-coach analyze          Parse logs and output JSON to stdout
 *   ai-coach serve [--port N] Start HTTP server with web dashboard
 *   ai-coach help             Show this help message
 *
 * This file is intentionally minimal — it parses args and delegates to
 * the appropriate command handler. No external CLI library needed.
 */

import { runAnalysis } from './analyze';
import { startServer } from './server';
import { FileStore } from './store';
import { setDefaultTrustStore } from '../core/rule-trust';
import { loadAllRuleLayersAsync } from '../core/rule-loader';

/** Parse command-line arguments into a structured format. */
interface CliArgs {
  command: string;
  port: number;
  workspaceRoot?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'help',
    port: 3000,
  };

  // Skip node and script path
  const raw = argv.slice(2);

  if (raw.length === 0) return args;

  const command = raw[0];
  if (['analyze', 'serve', 'help'].includes(command)) {
    args.command = command;
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Run "ai-coach help" for usage information.');
    process.exit(1);
  }

  // Parse flags
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '--port' && raw[i + 1]) {
      args.port = parseInt(raw[i + 1], 10);
      i++;
    } else if (raw[i] === '--workspace' && raw[i + 1]) {
      args.workspaceRoot = raw[i + 1];
      i++;
    }
  }

  return args;
}

/** Show help text. */
function showHelp(): void {
  console.log(`
AI Engineer Coach — CLI

Usage:
  ai-coach analyze [--workspace <path>]   Parse logs and output JSON to stdout
  ai-coach serve [--port <number>]        Start HTTP server with web dashboard
  ai-coach help                           Show this help message

Options:
  --workspace <path>   Workspace root for project-level rules (optional)
  --port <number>      Port for the HTTP server (default: 3000)

Examples:
  ai-coach analyze > analysis.json
  ai-coach serve
  ai-coach serve --port 8080
  `);
}

/** Main entry point. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case 'help':
      showHelp();
      break;

    case 'analyze': {
      // Initialize the file store for trust gate
      const store = new FileStore();
      setDefaultTrustStore(store);

      // Load rules (this will auto-approve built-in rules, prompt for others)
      try {
        await loadAllRuleLayersAsync(args.workspaceRoot);
      } catch (err) {
        // Rules are optional — continue even if loading fails
        console.error('Warning: Failed to load rules:', err);
      }

      // Run analysis and output JSON
      const result = await runAnalysis(args.workspaceRoot);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'serve': {
      // Initialize the file store for trust gate
      const store = new FileStore();
      setDefaultTrustStore(store);

      // Load rules
      try {
        await loadAllRuleLayersAsync(args.workspaceRoot);
      } catch (err) {
        console.error('Warning: Failed to load rules:', err);
      }

      // Start the HTTP server
      await startServer({
        port: args.port,
        workspaceRoot: args.workspaceRoot,
      });
      break;
    }
  }
}

// Run if executed directly (not imported)
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
