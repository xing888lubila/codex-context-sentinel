import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeSessions,
  buildHandoffPrompt,
  recommendationFromScore,
  scoreContextPressure,
} from "../src/sentinel.js";

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
});
