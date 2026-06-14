import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeSessions,
  buildHandoffFilePath,
  buildHandoffMarkdown,
  buildHookBlockReason,
  buildHandoffPrompt,
  notificationStateKey,
  alertLevelFromScore,
  readLatestMatchingSession,
  recordNotification,
  recommendationFromScore,
  scoreContextPressure,
  shouldNotify,
} from "../src/sentinel.js";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("context pressure scoring", () => {
  it("recommends continuing for small sessions", () => {
    const score = scoreContextPressure({
      estimatedTokens: 2000,
      sessionCount: 1,
      toolActivities: 5,
      projectMentions: 3,
    });

    assert.equal(recommendationFromScore(score), "continue-current-thread");
  });

  it("recommends a new thread for high pressure sessions", () => {
    const score = scoreContextPressure({
      estimatedTokens: 160000,
      sessionCount: 9,
      toolActivities: 400,
      projectMentions: 160,
    });

    assert.equal(recommendationFromScore(score), "start-new-thread");
  });

  it("uses 60/65/70 alert thresholds by default", () => {
    assert.equal(recommendationFromScore(59), "continue-current-thread");
    assert.equal(alertLevelFromScore(60), "reminder");
    assert.equal(recommendationFromScore(60), "consider-new-thread");
    assert.equal(alertLevelFromScore(65), "strong-reminder");
    assert.equal(recommendationFromScore(65), "consider-new-thread");
    assert.equal(alertLevelFromScore(70), "start-new-thread");
    assert.equal(recommendationFromScore(70), "start-new-thread");
  });
});

describe("session analysis", () => {
  it("counts project sessions and produces a handoff prompt", () => {
    const content = [
      JSON.stringify({ role: "user", content: "work in G:/docs/demo" }),
      JSON.stringify({ role: "assistant", content: "checking" }),
      JSON.stringify({ type: "function_call", name: "shell" }),
      "G:/docs/demo ".repeat(200),
    ].join("\n");

    const analysis = analyzeSessions(
      [
        {
          file: "session.jsonl",
          content,
        },
      ],
      "G:/docs/demo",
    );

    assert.equal(analysis.sessionCount, 1);
    assert.equal(analysis.userMessages, 1);
    assert.equal(analysis.assistantMessages, 1);
    assert.equal(analysis.toolActivities, 1);
    assert.ok(analysis.projectMentions >= 1);
  });

  it("builds no handoff prompt when continuing is fine", () => {
    assert.equal(
      buildHandoffPrompt({
        projectPath: "G:/docs/demo",
        recommendation: "continue-current-thread",
      }),
      "",
    );
  });

  it("builds a hook block reason with the continue token", () => {
    const reason = buildHookBlockReason({
      analysis: {
        score: 90,
        estimatedTokens: 120000,
        toolActivities: 300,
        handoffPrompt: "Start a clean thread.",
      },
      continueToken: "sentinel-continue",
    });

    assert.match(reason, /上下文已经过长/);
    assert.match(reason, /Start a clean thread/);
    assert.match(reason, /sentinel-continue/);
  });
});

describe("latest session matching", () => {
  it("returns only the most recently modified matching project session", () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "sentinel-sessions-"));
    const oldFile = join(sessionsDir, "old.jsonl");
    const newFile = join(sessionsDir, "new.jsonl");

    writeFileSync(oldFile, "work in G:/docs/demo");
    writeFileSync(newFile, "continue work in G:/docs/demo");

    const oldTime = new Date("2026-06-11T10:00:00.000Z");
    const newTime = new Date("2026-06-11T11:00:00.000Z");
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const sessions = readLatestMatchingSession({
      sessionsDir,
      projectPath: "G:/docs/demo",
      limit: 20,
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].file, newFile);
  });
});

describe("handoff files", () => {
  it("builds a timestamped project handoff path", () => {
    const filePath = buildHandoffFilePath({
      handoffsDir: "C:/Users/ASUS/.codex/context-sentinel/handoffs",
      projectPath: "G:/docs/House App",
      now: new Date(2026, 5, 11, 10, 20, 30),
    });

    assert.equal(
      filePath.replaceAll("\\", "/"),
      "C:/Users/ASUS/.codex/context-sentinel/handoffs/20260611-102030-house-app.md",
    );
  });

  it("writes a concise heuristic handoff markdown body", () => {
    const markdown = buildHandoffMarkdown({
      generatedAt: new Date("2026-06-11T10:20:30.000Z"),
      analysis: {
        projectPath: "G:/docs/demo",
        recommendation: "start-new-thread",
        score: 90,
        estimatedTokens: 120000,
        sessionCount: 4,
        toolActivities: 300,
        handoffPrompt: "Start a clean thread.",
      },
    });

    assert.match(markdown, /Codex Context Sentinel Handoff/);
    assert.match(markdown, /Start a clean thread/);
    assert.match(markdown, /not exact token accounting/);
  });
});

describe("notification cooldown", () => {
  it("does not notify for continue-current-thread", () => {
    assert.equal(
      shouldNotify({
        state: {},
        projectPath: "G:/docs/demo",
        recommendation: "continue-current-thread",
      }),
      false,
    );
  });

  it("suppresses the same project and recommendation during cooldown", () => {
    const now = new Date("2026-06-11T10:00:00.000Z");
    const state = recordNotification({
      state: {},
      projectPath: "G:/docs/demo",
      recommendation: "start-new-thread",
      alertLevel: "start-new-thread",
      handoffPath: "handoff.md",
      now,
    });

    assert.equal(
      shouldNotify({
        state,
        projectPath: "G:/docs/demo",
        recommendation: "start-new-thread",
        alertLevel: "start-new-thread",
        nowMs: now.getTime() + 29 * 60 * 1000,
        cooldownMs: 30 * 60 * 1000,
      }),
      false,
    );
    assert.equal(
      shouldNotify({
        state,
        projectPath: "G:/docs/demo",
        recommendation: "start-new-thread",
        alertLevel: "start-new-thread",
        nowMs: now.getTime() + 31 * 60 * 1000,
        cooldownMs: 30 * 60 * 1000,
      }),
      true,
    );
  });

  it("uses a stable normalized notification key", () => {
    assert.equal(
      notificationStateKey({
        projectPath: "G:\\docs\\demo",
        recommendation: "consider-new-thread",
        alertLevel: "reminder",
      }),
      notificationStateKey({
        projectPath: "G:/docs/demo",
        recommendation: "consider-new-thread",
        alertLevel: "reminder",
      }),
    );
  });

  it("uses separate cooldown keys for reminder and strong reminder", () => {
    const state = recordNotification({
      state: {},
      projectPath: "G:/docs/demo",
      recommendation: "consider-new-thread",
      alertLevel: "reminder",
      handoffPath: "handoff.md",
      now: new Date("2026-06-11T10:00:00.000Z"),
    });

    assert.equal(
      shouldNotify({
        state,
        projectPath: "G:/docs/demo",
        recommendation: "consider-new-thread",
        alertLevel: "strong-reminder",
        nowMs: new Date("2026-06-11T10:01:00.000Z").getTime(),
        cooldownMs: 30 * 60 * 1000,
      }),
      true,
    );
  });
});
