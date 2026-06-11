#!/usr/bin/env node

import {
  analyzeSessions,
  defaultCodexSessionsDir,
  formatMarkdownReport,
  readMatchingSessions,
} from "./sentinel.js";

function parseArgs(argv) {
  const args = {
    command: argv[2] ?? "help",
    project: process.cwd(),
    sessions: defaultCodexSessionsDir(),
    limit: 200,
    json: false,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--project" && next !== undefined) {
      args.project = next;
      index += 1;
      continue;
    }

    if (current === "--sessions" && next !== undefined) {
      args.sessions = next;
      index += 1;
      continue;
    }

    if (current === "--limit" && next !== undefined) {
      args.limit = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (current === "--json") {
      args.json = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`codex-context-sentinel

Usage:
  context-sentinel scan --project <path> [--sessions <path>] [--limit <n>] [--json]

Examples:
  context-sentinel scan --project "G:\\文档\\New project 2"
  context-sentinel scan --project "G:\\文档\\New project 2" --json
`);
}

function main() {
  const args = parseArgs(process.argv);

  if (args.command !== "scan") {
    printHelp();
    return;
  }

  const sessions = readMatchingSessions({
    sessionsDir: args.sessions,
    projectPath: args.project,
    limit: Number.isFinite(args.limit) ? args.limit : 200,
  });
  const analysis = analyzeSessions(sessions, args.project);

  if (args.json) {
    console.log(JSON.stringify({ ...analysis, sessionsDir: args.sessions }, null, 2));
    return;
  }

  process.stdout.write(formatMarkdownReport(analysis, args.sessions));
}

main();
