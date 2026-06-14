#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  analyzeTranscriptFile,
  analyzeSessions,
  buildHookBlockReason,
  defaultCodexSessionsDir,
  defaultHandoffsDir,
  defaultWatcherStatePath,
  formatMarkdownReport,
  readLatestMatchingSession,
  readMatchingSessions,
  readJsonFile,
  recordNotification,
  normalizeThresholds,
  shouldNotify,
  writeHandoffFile,
  writeJsonFile,
} from "./sentinel.js";

const execFileAsync = promisify(execFile);
const WATCHER_TASK_NAME = "CodexContextSentinel";

function parseArgs(argv) {
  const args = {
    command: argv[2] ?? "help",
    project: process.cwd(),
    sessions: defaultCodexSessionsDir(),
    state: defaultWatcherStatePath(),
    handoffs: defaultHandoffsDir(),
    limit: 200,
    json: false,
    warnScore: 60,
    blockScore: 70,
    noticeScore: 60,
    strongScore: 65,
    newThreadScore: 70,
    continueToken: "sentinel-continue",
    cooldownTokens: 25000,
    interval: 300,
    cooldownMinutes: 30,
    scope: "latest",
    once: false,
    taskName: WATCHER_TASK_NAME,
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

    if (current === "--state" && next !== undefined) {
      args.state = next;
      index += 1;
      continue;
    }

    if (current === "--handoffs" && next !== undefined) {
      args.handoffs = next;
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

    if (current === "--notice-score" && next !== undefined) {
      args.noticeScore = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (current === "--strong-score" && next !== undefined) {
      args.strongScore = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (current === "--new-thread-score" && next !== undefined) {
      args.newThreadScore = Number.parseInt(next, 10);
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
      continue;
    }

    if (current === "--interval" && next !== undefined) {
      args.interval = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (current === "--cooldown-minutes" && next !== undefined) {
      args.cooldownMinutes = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (current === "--scope" && next !== undefined) {
      args.scope = next;
      index += 1;
      continue;
    }

    if (current === "--task-name" && next !== undefined) {
      args.taskName = next;
      index += 1;
      continue;
    }

    if (current === "--once") {
      args.once = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`codex-context-sentinel

Usage:
  context-sentinel scan --project <path> [--sessions <path>] [--limit <n>] [--json]
  context-sentinel watch --project <path> [--interval <seconds>] [--scope latest|project]
  context-sentinel notify-test [--project <path>]
  context-sentinel status [--state <path>]
  context-sentinel stop [--state <path>]
  context-sentinel install-windows-task --project <path> [--interval <seconds>] [--cooldown-minutes <minutes>] [--scope latest|project]
  context-sentinel hook [--warn-score <n>] [--block-score <n>]
  context-sentinel install-hook [--warn-score <n>] [--block-score <n>]

Examples:
  context-sentinel scan --project "G:\\文档\\New project 2"
  context-sentinel watch --project "G:\\文档\\New project 2" --interval 300
  context-sentinel notify-test --project "G:\\文档\\New project 2"
  context-sentinel install-windows-task --project "G:\\文档\\New project 2"
  context-sentinel install-hook --block-score 75
`);
}

function runScan(args) {
  const sessions = readSessionsForScope({
    sessionsDir: args.sessions,
    projectPath: args.project,
    limit: Number.isFinite(args.limit) ? args.limit : 200,
    scope: "project",
  });
  const analysis = analyzeSessions(sessions, args.project, thresholdsFromArgs(args));

  if (args.json) {
    console.log(
      JSON.stringify({ ...analysis, sessionsDir: args.sessions }, null, 2),
    );
    return;
  }

  process.stdout.write(formatMarkdownReport(analysis, args.sessions));
}

async function runWatch(args) {
  const intervalSeconds = normalizePositiveNumber(args.interval, 300);
  const cooldownMs =
    normalizePositiveNumber(args.cooldownMinutes, 30) * 60 * 1000;
  const statePath = resolve(args.state);
  const projectPath = resolve(args.project);

  await runWatchIteration({
    ...args,
    project: projectPath,
    state: statePath,
    cooldownMs,
    startedAt: new Date(),
  });

  if (args.once) {
    markWatcherStopped(statePath, projectPath);
    return;
  }

  console.log(
    `Context Sentinel watcher running for ${projectPath}. Interval: ${intervalSeconds}s.`,
  );

  const timer = setInterval(() => {
    runWatchIteration({
      ...args,
      project: projectPath,
      state: statePath,
      cooldownMs,
      startedAt: null,
    }).catch((error) => {
      const state = readJsonFile(statePath, {});
      writeJsonFile(statePath, {
        ...state,
        pid: process.pid,
        projectPath,
        running: true,
        lastError: error.message,
        lastErrorAt: new Date().toISOString(),
      });
    });
  }, intervalSeconds * 1000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    markWatcherStopped(statePath, projectPath);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(timer);
    markWatcherStopped(statePath, projectPath);
    process.exit(0);
  });
}

async function runWatchIteration(args) {
  const now = new Date();
  const sessions = readSessionsForScope({
    sessionsDir: args.sessions,
    projectPath: args.project,
    limit: Number.isFinite(args.limit) ? args.limit : 200,
    scope: args.scope,
  });
  const analysis = analyzeSessions(sessions, args.project, thresholdsFromArgs(args));
  const previousState = readJsonFile(args.state, {});
  const thresholds = thresholdsFromArgs(args);
  let nextState = {
    ...previousState,
    pid: process.pid,
    running: true,
    projectPath: analysis.projectPath,
    sessionsDir: args.sessions,
    handoffsDir: args.handoffs,
    intervalSeconds: normalizePositiveNumber(args.interval, 300),
    cooldownMinutes: normalizePositiveNumber(args.cooldownMinutes, 30),
    scope: normalizeScope(args.scope),
    thresholds,
    startedAt:
      args.startedAt instanceof Date
        ? args.startedAt.toISOString()
        : previousState.startedAt ?? now.toISOString(),
    lastScanAt: now.toISOString(),
    lastRecommendation: analysis.recommendation,
    lastAlertLevel: analysis.alertLevel,
    lastScore: analysis.score,
    lastEstimatedTokens: analysis.estimatedTokens,
    lastMatchedSessionFiles: analysis.sessionCount,
    lastSessionFile: analysis.sessionFiles[0] ?? null,
    lastError: null,
  };

  if (
    shouldNotify({
      state: previousState,
      projectPath: analysis.projectPath,
      recommendation: analysis.recommendation,
      alertLevel: analysis.alertLevel,
      nowMs: now.getTime(),
      cooldownMs: args.cooldownMs,
    })
  ) {
    const handoffPath = writeHandoffFile({
      analysis,
      handoffsDir: args.handoffs,
      now,
    });

    await sendWindowsNotification({
      title: "Codex Context Sentinel",
      message: "Codex 上下文过长，建议开启新对话",
      details: `${analysis.projectPath}\n提醒级别：${analysis.alertLevel}\n建议：${analysis.recommendation}`,
    });

    nextState = recordNotification({
      state: nextState,
      projectPath: analysis.projectPath,
      recommendation: analysis.recommendation,
      alertLevel: analysis.alertLevel,
      handoffPath,
      now,
    });
    nextState.lastHandoffPath = handoffPath;
    nextState.lastNotificationAt = now.toISOString();
  }

  writeJsonFile(args.state, nextState);
}

function runStatus(args) {
  const statePath = resolve(args.state);
  const state = readJsonFile(statePath, null);

  if (state === null) {
    console.log(`No watcher state file found at ${statePath}`);
    return;
  }

  const running = isPidRunning(state.pid);
  console.log(`State file: ${statePath}`);
  console.log(`Running: ${running ? "yes" : "no"}`);
  console.log(`PID: ${state.pid ?? "unknown"}`);
  console.log(`Project: ${state.projectPath ?? "unknown"}`);
  console.log(`Last scan: ${state.lastScanAt ?? "never"}`);
  console.log(`Last recommendation: ${state.lastRecommendation ?? "unknown"}`);
  console.log(`Last alert level: ${state.lastAlertLevel ?? "unknown"}`);
  console.log(`Last score: ${state.lastScore ?? "unknown"}`);
  console.log(`Last session file: ${state.lastSessionFile ?? "unknown"}`);
  console.log(`Last handoff: ${state.lastHandoffPath ?? "none"}`);
}

function runStop(args) {
  const statePath = resolve(args.state);
  const state = readJsonFile(statePath, null);

  if (state === null || typeof state.pid !== "number") {
    console.log(`No watcher PID found at ${statePath}`);
    return;
  }

  if (!isPidRunning(state.pid)) {
    markWatcherStopped(statePath, state.projectPath);
    console.log(`Watcher PID ${state.pid} is not running.`);
    return;
  }

  process.kill(state.pid);
  markWatcherStopped(statePath, state.projectPath);
  console.log(`Stopped watcher PID ${state.pid}.`);
}

async function runNotifyTest(args) {
  await sendWindowsNotification({
    title: "Codex Context Sentinel",
    message: "Codex 上下文过长，建议开启新对话",
    details: `测试通知：项目 ${resolve(args.project)}；建议级别：start-new-thread`,
  });
  console.log("Sent Context Sentinel test notification.");
}

async function runInstallWindowsTask(args) {
  if (process.platform !== "win32") {
    throw new Error("install-windows-task is only supported on Windows.");
  }

  const scriptPath = resolve(import.meta.dirname, "index.js");
  const launcherPath = join(
    dirname(resolve(args.state)),
    `${sanitizeTaskName(args.taskName)}.ps1`,
  );
  const launcherCommand = [
    "&",
    quoteForPowerShell(process.execPath),
    quoteForPowerShell(scriptPath),
    "watch",
    "--project",
    quoteForPowerShell(resolve(args.project)),
    "--sessions",
    quoteForPowerShell(resolve(args.sessions)),
    "--interval",
    String(normalizePositiveNumber(args.interval, 300)),
    "--cooldown-minutes",
    String(normalizePositiveNumber(args.cooldownMinutes, 30)),
    "--scope",
    normalizeScope(args.scope),
    "--notice-score",
    String(thresholdsFromArgs(args).noticeScore),
    "--strong-score",
    String(thresholdsFromArgs(args).strongScore),
    "--new-thread-score",
    String(thresholdsFromArgs(args).newThreadScore),
    "--state",
    quoteForPowerShell(resolve(args.state)),
    "--handoffs",
    quoteForPowerShell(resolve(args.handoffs)),
  ].join(" ");
  const taskCommand = [
    "powershell.exe",
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    quoteForCmd(launcherPath),
  ].join(" ");

  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(
    launcherPath,
    `\uFEFF${["$ErrorActionPreference = 'Stop'", launcherCommand, ""].join("\r\n")}`,
    "utf8",
  );

  await execFileAsync("schtasks.exe", [
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/TN",
    args.taskName,
    "/TR",
    taskCommand,
  ]);

  console.log(`Installed Windows scheduled task: ${args.taskName}`);
  console.log(`Launcher: ${launcherPath}`);
  console.log("It will start at user logon. To start now, run:");
  console.log(`schtasks /Run /TN ${args.taskName}`);
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
  const analysis = analyzeTranscriptFile({
    transcriptPath,
    cwd,
    thresholds: thresholdsFromArgs(args),
  });
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

function quoteForCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteForPowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sanitizeTaskName(value) {
  return (
    String(value)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || WATCHER_TASK_NAME
  );
}

function normalizePositiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeScope(value) {
  return value === "project" ? "project" : "latest";
}

function thresholdsFromArgs(args) {
  return normalizeThresholds({
    noticeScore: Number.isFinite(args.noticeScore)
      ? args.noticeScore
      : args.warnScore,
    strongScore: args.strongScore,
    newThreadScore: Number.isFinite(args.newThreadScore)
      ? args.newThreadScore
      : args.blockScore,
  });
}

function readSessionsForScope({ sessionsDir, projectPath, limit, scope }) {
  const normalizedScope = normalizeScope(scope);
  const reader =
    normalizedScope === "latest" ? readLatestMatchingSession : readMatchingSessions;

  return reader({ sessionsDir, projectPath, limit });
}

function isPidRunning(pid) {
  if (typeof pid !== "number") {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function markWatcherStopped(statePath, projectPath) {
  const state = readJsonFile(statePath, {});
  writeJsonFile(statePath, {
    ...state,
    running: false,
    projectPath: projectPath ?? state.projectPath,
    stoppedAt: new Date().toISOString(),
  });
}

async function sendWindowsNotification({ title, message, details }) {
  if (process.platform !== "win32") {
    console.log(`${title}: ${message}\n${details}`);
    return;
  }

  const notificationScriptPath = join(
    homedir(),
    ".codex",
    "context-sentinel",
    "show-notification.ps1",
  );
  mkdirSync(dirname(notificationScriptPath), { recursive: true });
  writeFileSync(
    notificationScriptPath,
    buildNotificationPowerShell({ title, message, details }),
    "utf8",
  );

  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-Sta",
        "-NoProfile",
        "-WindowStyle",
        "Normal",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        notificationScriptPath,
      ],
      {
        timeout: 65000,
        windowsHide: false,
      },
    );
    return;
  } catch (error) {
    console.error(`Context Sentinel popup failed: ${error.message}`);
    // Fall through to inline PowerShell-based notification attempts.
  }

  const script = `
$title = ${toPowerShellString(title)}
$message = ${toPowerShellString(message)}
$details = ${toPowerShellString(details)}
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $title
  $form.Width = 460
  $form.Height = 210
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.StartPosition = 'Manual'
  $form.FormBorderStyle = 'FixedSingle'
  $form.MaximizeBox = $false
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Left = $area.Right - $form.Width - 24
  $form.Top = $area.Bottom - $form.Height - 24

  $titleLabel = New-Object System.Windows.Forms.Label
  $titleLabel.Text = $message
  $titleLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $titleLabel.AutoSize = $false
  $titleLabel.Left = 18
  $titleLabel.Top = 18
  $titleLabel.Width = 410
  $titleLabel.Height = 34

  $detailsLabel = New-Object System.Windows.Forms.Label
  $detailsLabel.Text = $details
  $detailsLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $detailsLabel.AutoSize = $false
  $detailsLabel.Left = 18
  $detailsLabel.Top = 60
  $detailsLabel.Width = 410
  $detailsLabel.Height = 70

  $button = New-Object System.Windows.Forms.Button
  $button.Text = '关闭'
  $button.Width = 86
  $button.Height = 30
  $button.Left = $form.Width - 120
  $button.Top = $form.Height - 78
  $button.Add_Click({ $form.Close() })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 60000
  $timer.Add_Tick({
    $timer.Stop()
    $form.Close()
  })

  $form.Controls.Add($titleLabel)
  $form.Controls.Add($detailsLabel)
  $form.Controls.Add($button)
  $form.Add_Shown({ $timer.Start(); $form.Activate() })
  [System.Windows.Forms.Application]::Run($form)
  exit 0
} catch {
}
if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {
  New-BurntToastNotification -Text $title, $message, $details | Out-Null
  exit 0
}
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $safeTitle = [System.Security.SecurityElement]::Escape($title)
  $safeMessage = [System.Security.SecurityElement]::Escape($message)
  $safeDetails = [System.Security.SecurityElement]::Escape($details)
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeMessage</text><text>$safeDetails</text></binding></visual></toast>")
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Codex Context Sentinel").Show($toast)
} catch {
  Write-Output ($title + [Environment]::NewLine + $message + [Environment]::NewLine + $details)
}
`;

  await new Promise((resolvePromise) => {
    const child = spawn(
      "powershell.exe",
      ["-Sta", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.on("error", () => resolvePromise());
    child.unref();
    resolvePromise();
  });
}

function toPowerShellString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildNotificationPowerShell({ title, message, details }) {
  return `\uFEFF$ErrorActionPreference = 'Stop'
$title = ${toPowerShellString(title)}
$message = ${toPowerShellString(message)}
$details = ${toPowerShellString(details)}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $title
$form.Width = 460
$form.Height = 220
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.StartPosition = 'Manual'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $area.Right - $form.Width - 24
$form.Top = $area.Bottom - $form.Height - 24

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = $message
$titleLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$titleLabel.AutoSize = $false
$titleLabel.Left = 18
$titleLabel.Top = 18
$titleLabel.Width = 410
$titleLabel.Height = 38

$detailsLabel = New-Object System.Windows.Forms.Label
$detailsLabel.Text = $details
$detailsLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$detailsLabel.AutoSize = $false
$detailsLabel.Left = 18
$detailsLabel.Top = 64
$detailsLabel.Width = 410
$detailsLabel.Height = 78

$button = New-Object System.Windows.Forms.Button
$button.Text = '关闭'
$button.Width = 86
$button.Height = 30
$button.Left = $form.Width - 120
$button.Top = $form.Height - 78
$button.Add_Click({ $form.Close() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000
$timer.Add_Tick({
  $timer.Stop()
  $form.Close()
})

$form.Controls.Add($titleLabel)
$form.Controls.Add($detailsLabel)
$form.Controls.Add($button)
$form.Add_Shown({ $timer.Start(); $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
`;
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

  if (args.command === "watch") {
    await runWatch(args);
    return;
  }

  if (args.command === "notify-test") {
    await runNotifyTest(args);
    return;
  }

  if (args.command === "status") {
    runStatus(args);
    return;
  }

  if (args.command === "stop") {
    runStop(args);
    return;
  }

  if (args.command === "install-windows-task") {
    await runInstallWindowsTask(args);
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
