import { describe, expect, it } from "vitest";

import { agentContextId } from "../src/core/agent-identity";
import { appendMessage, createMessage, emptyData, getOrCreateThread, hydrateData } from "../src/core/state";
import type { AgentProfile } from "../src/core/types";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "custom-one",
    label: "Custom one",
    home: "C:\\agent",
    workspace: "C:\\work",
    transport: "native",
    executable: "agent.exe",
    source: "custom",
    launch: { command: "agent.exe", args: ["acp"] },
    ...overrides,
  };
}

describe("agent context identity", () => {
  it("is stable across display-label changes", () => {
    expect(agentContextId(profile())).toBe(agentContextId(profile({ label: "Renamed" })));
  });

  it("changes when a launch target or workspace changes", () => {
    const original = agentContextId(profile());
    expect(agentContextId(profile({ workspace: "C:\\other" }))).not.toBe(original);
    expect(agentContextId(profile({
      executable: "other.exe",
      launch: { command: "other.exe", args: ["acp"] },
    }))).not.toBe(original);
  });

  it("round-trips the longest valid profile ID through persisted threads", () => {
    const contextId = agentContextId(profile({ id: `a${"b".repeat(63)}` }));
    const data = emptyData();
    const thread = getOrCreateThread(data, contextId, "A.md");
    appendMessage(thread, createMessage("user", "hello", "body", "a".repeat(64)), 40);

    const hydrated = hydrateData(structuredClone(data));

    expect(Object.values(hydrated.threads)[0]?.agentId).toBe(contextId);
  });
});
