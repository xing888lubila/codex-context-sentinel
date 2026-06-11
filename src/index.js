#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  analyzeTranscriptFile,
  analyzeSessions,
  buildHookBlockReason,
  defaultCodexSessionsDir,
  formatMarkdownReport,
  readMatchingSessions,
  readJsonFile,
  writeJsonFile,
} from "./sentinel.js";

function parseArgs(argv) {
  const args = {
    command: argv[2] ?? "help",
    project: process.cwd(),
    sessions: defaultCodexSessionsDir(),
    limit: 200,
    json: false,
    warnScore: 55,
    blockScore: 75,
    continueToken: "sentinel-continue",
    cooldownTokens: 25000,
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
      continue;
    }

    if (current === "--warn-score" && next !== undefined) {
      args.warnScore = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (current === "--block-score" && next !== undefined) {
      args.blockScore = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (current === "--continue-token" && next !== undefined) {
      args.continueToken = next;
      index += 1;
      continue;
    }

    if (current === "--cooldown-tokens" && next !== undefined) {
      args.cooldownTokens = Number.parseInt(next, 10);
      index += 1;
    }
  }

  return args;
}

function printHelp() {
  console.log(`codex-context-sentinel

Usage:
  context-sentinel scan --project <path> [--sessions <path>] [--limit <n>] [--json]
  context-sentinel hook [--warn-score <n>] [--block-score <n>]
  context-sentinel install-hook [--warn-score <n>] [--block-score <n>]

Examples:
  context-sentinel scan --project "G:\\文档\\New project 2"
  context-sentinel scan --project "G:\\文档\\New project 2" --json
  context-sentinel install-hook --block-score 75
`);
}

function runScan(args) {
  const sessions = readMatchingSessions({
    sessionsDir: args.sessions,
    projectPath: args.project,
    limit: Number.isFinite(args.limit) ? args.limit : 200,
  });
  const analysis = analyzeSessions(sessions, args.project);

  if (args.json) {
    console.log(
      JSON.stringify({ ...analysis, sessionsDir: args.sessions }, null, 2),
    );
    return;
  }

  process.stdout.write(formatMarkdownReport(analysis, args.sessions));
}

async function runHook(args) {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const sessionId =
    typeof input.session_id === "string" ? input.session_id : "unknown";
  const transcriptPath =
    typeof input.transcript_path === "string" ? input.transcript_path : null;
  const statePath = join(homedir(), ".codex", "context-sentinel", "state.json");
  const state = readJsonFile(statePath, { sessions: {} });
  const previousState = state.sessions?.[sessionId] ?? {};
  const analysis = analyzeTranscriptFile({ transcriptPath, cwd });
  const continueRequested = prompt.includes(args.continueToken);
  const thresholdScore = Number.isFinite(args.blockScore) ? args.blockScore : 75;
  const warnScore = Number.isFinite(args.warnScore) ? args.warnScore : 55;
  const cooldownTokens = Number.isFinite(args.cooldownTokens)
    ? args.cooldownTokens
    : 25000;
  const suppressedUntilTokens =
    typeof previousState.suppressedUntilTokens === "number"
      ? previousState.suppressedUntilTokens
      : 0;

  if (continueRequested) {
    writeJsonFile(statePath, {
      ...state,
      sessions: {
        ...(state.sessions ?? {}),
        [sessionId]: {
          lastAcknowledgedAt: new Date().toISOString(),
          suppressedUntilTokens: analysis.estimatedTokens + cooldownTokens,
        },
      },
    });
    writeHookJson({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "Context Sentinel warning was acknowledged for this turn.",
      },
    });
    return;
  }

  if (
    analysis.score >= thresholdScore &&
    analysis.estimatedTokens >= suppressedUntilTokens
  ) {
    writeHookJson({
      decision: "block",
      reason: buildHookBlockReason({
        analysis,
        continueToken: args.continueToken,
      }),
    });
    return;
  }

  if (analysis.score >= warnScore) {
    writeHookJson({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          "Context Sentinel notice: this thread is getting long.",
          `Current context pressure score is ${analysis.score}.`,
          "Briefly suggest a fresh thread if the next response requires broad historical context.",
        ].join(" "),
      },
    });
    return;
  }

  writeHookJson({ continue: true, suppressOutput: true });
}

function runInstallHook(args) {
  const hooksPath = join(homedir(), ".codex", "hooks.json");
  const existing = readJsonFile(hooksPath, { hooks: {} });
  const command = buildHookCommand(args);
  const hookEntry = {
    type: "command",
    command,
    commandWindows: command,
    timeout: 10,
    statusMessage: "Checking context length",
  };
  const userPromptHooks = existing.hooks?.UserPromptSubmit ?? [];
  const nextUserPromptHooks = removeSentinelHooks(userPromptHooks);
  nextUserPromptHooks.push({
    hooks: [hookEntry],
  });

  writeJsonFile(hooksPath, {
    ...existing,
    hooks: {
      ...(existing.hooks ?? {}),
      UserPromptSubmit: nextUserPromptHooks,
    },
  });

  console.log(`Installed Codex Context Sentinel hook at ${hooksPath}`);
  console.log("Restart Codex or open /hooks to review and trust the hook.");
}

function buildHookCommand(args) {
  const scriptPath = resolve(import.meta.dirname, "index.js");
  const parts = [
    "node",
    quoteForCommand(scriptPath),
    "hook",
    "--warn-score",
    String(args.warnScore),
    "--block-score",
    String(args.blockScore),
    "--continue-token",
    quoteForCommand(args.continueToken),
    "--cooldown-tokens",
    String(args.cooldownTokens),
  ];

  return parts.join(" ");
}

function removeSentinelHooks(groups) {
  return groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).filter(
        (hook) =>
          typeof hook.command !== "string" ||
          !hook.command.includes("codex-context-sentinel") ||
          !hook.command.includes(" hook"),
      ),
    }))
    .filter((group) => group.hooks.length > 0);
}

function quoteForCommand(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

async function readStdinJson() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (raw.length === 0) {
    return {};
  }

  return JSON.parse(raw);
}

function writeHookJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "scan") {
    runScan(args);
    return;
  }

  if (args.command === "hook") {
    await runHook(args);
    return;
  }

  if (args.command === "install-hook") {
    runInstallHook(args);
    return;
  }

  printHelp();
}

main().catch((error) => {
  if (process.argv[2] === "hook") {
    writeHookJson({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Context Sentinel hook failed open: ${error.message}`,
      },
    });
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
