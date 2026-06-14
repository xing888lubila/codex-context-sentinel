import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_LIMIT = 200;
const DEFAULT_THRESHOLDS = {
  noticeScore: 60,
  strongScore: 65,
  newThreadScore: 70,
};

export function defaultCodexSessionsDir() {
  const codexHome = process.env.CODEX_HOME;

  return codexHome && codexHome.length > 0
    ? join(codexHome, "sessions")
    : join(homedir(), ".codex", "sessions");
}

export function defaultSentinelDir() {
  return join(homedir(), ".codex", "context-sentinel");
}

export function defaultHandoffsDir() {
  return join(defaultSentinelDir(), "handoffs");
}

export function defaultWatcherStatePath() {
  return join(defaultSentinelDir(), "watcher-state.json");
}

export function normalizeForSearch(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

export function listSessionFiles(rootDir, limit = DEFAULT_LIMIT) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop();

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .sort((first, second) => second.mtimeMs - first.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.file);
}

export function readMatchingSessions({ sessionsDir, projectPath, limit }) {
  const normalizedProjectPath = normalizeForSearch(resolve(projectPath));
  const normalizedProjectName = normalizeForSearch(
    resolve(projectPath).split(/[\\/]/).at(-1) ?? projectPath,
  );

  return listSessionFiles(sessionsDir, limit)
    .map((file) => {
      const content = readFileSync(file, "utf8");
      const normalizedContent = normalizeForSearch(content);
      const projectPathMatches = normalizedContent.includes(
        normalizedProjectPath,
      );
      const projectNameMatches =
        normalizedProjectName.length > 0 &&
        normalizedContent.includes(normalizedProjectName);

      if (!projectPathMatches && !projectNameMatches) {
        return null;
      }

      return {
        file,
        content,
      };
    })
    .filter(Boolean);
}

export function readLatestMatchingSession({ sessionsDir, projectPath, limit }) {
  return readMatchingSessions({ sessionsDir, projectPath, limit }).slice(0, 1);
}

export function analyzeSessions(sessions, projectPath, thresholds = {}) {
  const normalizedThresholds = normalizeThresholds(thresholds);
  const joinedContent = sessions.map((session) => session.content).join("\n");
  const normalizedContent = normalizeForSearch(joinedContent);
  const normalizedProjectPath = normalizeForSearch(resolve(projectPath));
  const normalizedProjectName = normalizeForSearch(
    resolve(projectPath).split(/[\\/]/).at(-1) ?? projectPath,
  );
  const estimatedTokens = Math.ceil(joinedContent.length / 4);
  const userMessages = countMatches(joinedContent, /"role"\s*:\s*"user"/g);
  const assistantMessages = countMatches(
    joinedContent,
    /"role"\s*:\s*"assistant"/g,
  );
  const toolActivities =
    countMatches(joinedContent, /"type"\s*:\s*"function_call"/g) +
    countMatches(joinedContent, /"tool_call_id"/g) +
    countMatches(joinedContent, /"recipient_name"/g);
  const projectMentions =
    countSubstring(normalizedContent, normalizedProjectPath) +
    countSubstring(normalizedContent, normalizedProjectName);
  const score = scoreContextPressure({
    estimatedTokens,
    sessionCount: sessions.length,
    toolActivities,
    projectMentions,
  });
  const recommendation = recommendationFromScore(score, normalizedThresholds);
  const alertLevel = alertLevelFromScore(score, normalizedThresholds);

  return {
    projectPath: resolve(projectPath),
    sessionFiles: sessions.map((session) => session.file),
    sessionCount: sessions.length,
    estimatedCharacters: joinedContent.length,
    estimatedTokens,
    userMessages,
    assistantMessages,
    toolActivities,
    projectMentions,
    score,
    alertLevel,
    recommendation,
    handoffPrompt: buildHandoffPrompt({
      projectPath: resolve(projectPath),
      recommendation,
    }),
  };
}

export function analyzeTranscriptFile({ transcriptPath, cwd, thresholds = {} }) {
  if (
    transcriptPath === null ||
    transcriptPath === undefined ||
    transcriptPath.length === 0 ||
    !existsSync(transcriptPath)
  ) {
    return analyzeSessions([], cwd, thresholds);
  }

  return analyzeSessions(
    [
      {
        file: transcriptPath,
        content: readFileSync(transcriptPath, "utf8"),
      },
    ],
    cwd,
    thresholds,
  );
}

export function scoreContextPressure(metrics) {
  let score = 0;

  score += Math.min(40, Math.floor(metrics.estimatedTokens / 25000) * 10);
  score += Math.min(20, Math.max(0, metrics.sessionCount - 1) * 4);
  score += Math.min(25, Math.floor(metrics.toolActivities / 80) * 5);
  score += Math.min(15, Math.floor(metrics.projectMentions / 40) * 3);

  return score;
}

export function recommendationFromScore(score, thresholds = {}) {
  const normalizedThresholds = normalizeThresholds(thresholds);

  if (score >= normalizedThresholds.newThreadScore) {
    return "start-new-thread";
  }

  if (score >= normalizedThresholds.noticeScore) {
    return "consider-new-thread";
  }

  return "continue-current-thread";
}

export function alertLevelFromScore(score, thresholds = {}) {
  const normalizedThresholds = normalizeThresholds(thresholds);

  if (score >= normalizedThresholds.newThreadScore) {
    return "start-new-thread";
  }

  if (score >= normalizedThresholds.strongScore) {
    return "strong-reminder";
  }

  if (score >= normalizedThresholds.noticeScore) {
    return "reminder";
  }

  return "none";
}

export function normalizeThresholds(thresholds = {}) {
  const noticeScore = normalizeScore(
    thresholds.noticeScore,
    DEFAULT_THRESHOLDS.noticeScore,
  );
  const strongScore = Math.max(
    noticeScore,
    normalizeScore(thresholds.strongScore, DEFAULT_THRESHOLDS.strongScore),
  );
  const newThreadScore = Math.max(
    strongScore,
    normalizeScore(
      thresholds.newThreadScore,
      DEFAULT_THRESHOLDS.newThreadScore,
    ),
  );

  return {
    noticeScore,
    strongScore,
    newThreadScore,
  };
}

export function buildHandoffPrompt({ projectPath, recommendation }) {
  if (recommendation === "continue-current-thread") {
    return "";
  }

  return [
    `Continue the project in ${projectPath}.`,
    "First inspect git status, recent PR state, and the current task handoff docs.",
    "Do not delete user files. Keep code changes on a branch and use PR workflow where applicable.",
    "If the previous thread was long, use existing docs and current repository state as the source of truth instead of relying on stale conversation memory.",
  ].join(" ");
}

export function buildHandoffMarkdown({ analysis, generatedAt = new Date() }) {
  const handoffPrompt =
    analysis.handoffPrompt ||
    buildHandoffPrompt({
      projectPath: analysis.projectPath,
      recommendation: analysis.recommendation,
    });

  return [
    "# Codex Context Sentinel Handoff",
    "",
    `Generated at: ${generatedAt.toISOString()}`,
    `Project: ${analysis.projectPath}`,
    `Recommendation: ${analysis.recommendation}`,
    `Context pressure score: ${analysis.score}`,
    `Estimated tokens: ${analysis.estimatedTokens}`,
    `Matched session files: ${analysis.sessionCount}`,
    `Tool activities: ${analysis.toolActivities}`,
    "",
    "## New Thread Prompt",
    "",
    handoffPrompt,
    "",
    "## Note",
    "",
    "This is a local heuristic based on Codex session files, not exact token accounting.",
    "",
  ].join("\n");
}

export function buildHandoffFilePath({
  handoffsDir = defaultHandoffsDir(),
  projectPath,
  now = new Date(),
}) {
  const timestamp = formatTimestampForFile(now);
  const slug = slugProjectName(projectPath);

  return join(handoffsDir, `${timestamp}-${slug}.md`);
}

export function writeHandoffFile({ analysis, handoffsDir, now = new Date() }) {
  const filePath = buildHandoffFilePath({
    handoffsDir,
    projectPath: analysis.projectPath,
    now,
  });

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buildHandoffMarkdown({ analysis, generatedAt: now }));

  return filePath;
}

export function shouldNotify({
  state,
  projectPath,
  recommendation,
  nowMs = Date.now(),
  cooldownMs = 30 * 60 * 1000,
}) {
  if (recommendation === "continue-current-thread") {
    return false;
  }

  const key = notificationStateKey({ projectPath, recommendation });
  const lastNotifiedAtMs =
    typeof state.notifications?.[key]?.lastNotifiedAtMs === "number"
      ? state.notifications[key].lastNotifiedAtMs
      : 0;

  return nowMs - lastNotifiedAtMs >= cooldownMs;
}

export function recordNotification({
  state,
  projectPath,
  recommendation,
  handoffPath,
  now = new Date(),
}) {
  const key = notificationStateKey({ projectPath, recommendation });

  return {
    ...state,
    notifications: {
      ...(state.notifications ?? {}),
      [key]: {
        projectPath: resolve(projectPath),
        recommendation,
        handoffPath,
        lastNotifiedAt: now.toISOString(),
        lastNotifiedAtMs: now.getTime(),
      },
    },
  };
}

export function notificationStateKey({ projectPath, recommendation }) {
  return `${normalizeForSearch(resolve(projectPath))}|${recommendation}`;
}

export function buildHookBlockReason({ analysis, continueToken }) {
  return [
    "Codex Context Sentinel: 当前对话上下文已经过长，建议开启新对话继续。",
    "",
    `上下文压力评分：${analysis.score}`,
    `估算 tokens：${analysis.estimatedTokens}`,
    `工具活动次数：${analysis.toolActivities}`,
    "",
    "新对话可复制提示：",
    analysis.handoffPrompt ||
      buildHandoffPrompt({
        projectPath: analysis.projectPath,
        recommendation: "start-new-thread",
      }),
    "",
    `如果你仍要在当前对话继续，请在下一条消息中包含 ${continueToken}。`,
  ].join("\n");
}

export function readJsonFile(filePath, fallback) {
  try {
    if (!existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function formatMarkdownReport(analysis, sessionsDir) {
  const lines = [
    "# Codex Context Sentinel Report",
    "",
    `Project: ${analysis.projectPath}`,
    `Sessions directory: ${sessionsDir}`,
    "",
    "## Metrics",
    "",
    `- Matched session files: ${analysis.sessionCount}`,
    `- Estimated characters: ${analysis.estimatedCharacters}`,
    `- Estimated tokens: ${analysis.estimatedTokens}`,
    `- User messages: ${analysis.userMessages}`,
    `- Assistant messages: ${analysis.assistantMessages}`,
    `- Tool activities: ${analysis.toolActivities}`,
    `- Project mentions: ${analysis.projectMentions}`,
    `- Context pressure score: ${analysis.score}`,
    "",
    "## Recommendation",
    "",
    analysis.recommendation,
  ];

  if (analysis.handoffPrompt.length > 0) {
    lines.push("", "## New Thread Handoff Prompt", "", analysis.handoffPrompt);
  }

  return `${lines.join("\n")}\n`;
}

function formatTimestampForFile(date) {
  const pad = (value) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function slugProjectName(projectPath) {
  return (
    basename(resolve(projectPath))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function countMatches(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

function countSubstring(value, substring) {
  if (substring.length === 0) {
    return 0;
  }

  let count = 0;
  let index = value.indexOf(substring);

  while (index !== -1) {
    count += 1;
    index = value.indexOf(substring, index + substring.length);
  }

  return count;
}

function normalizeScore(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
