import path from "node:path";

import { describe, expect, it } from "vitest";

import { createAuditRecord } from "../src/core/audit";
import { hashText } from "../src/core/scope";
import {
  appendMessage,
  createMessage,
  canStoreCheckpoint,
  emptyData,
  getOrCreateThread,
  hydrateData,
  MAX_STORED_MESSAGE_CHARS,
  MAX_STORED_THREADS,
  pruneThreads,
  storeCheckpoint,
  threadKey,
} from "../src/core/state";

describe("thread isolation", () => {
  it("uses both agent and note path in the thread key", () => {
    expect(threadKey("agent-a", "A.md")).not.toBe(threadKey("agent-a", "B.md"));
    expect(threadKey("agent-a", "A.md")).not.toBe(threadKey("agent-b", "A.md"));
  });

  it("never reuses note A's thread for note B", () => {
    const data = emptyData();
    const a = getOrCreateThread(data, "scribe", "A.md");
    const b = getOrCreateThread(data, "scribe", "B.md");
    appendMessage(a, createMessage("user", "A only"), 40);
    expect(b.messages).toEqual([]);
    expect(a).not.toBe(b);
  });

  it("does not share mutable default setting arrays", () => {
    const first = emptyData();
    const second = emptyData();
    first.settings.agentProfiles.push("changed");
    first.settings.customAcpAgents?.push({
      id: "custom-one",
      label: "Custom",
      workspace: path.resolve("test-workspace"),
      launch: { command: "agent", args: [] },
    });
    expect(second.settings.agentProfiles).toEqual([]);
    expect(second.settings.customAcpAgents).toEqual([]);
  });

  it("bounds persisted chat history", () => {
    const thread = getOrCreateThread(emptyData(), "scribe", "A.md");
    for (let index = 0; index < 10; index += 1) {
      appendMessage(thread, createMessage("user", String(index)), 4);
    }
    expect(thread.messages.map((message) => message.text)).toEqual(["6", "7", "8", "9"]);
  });

  it("removes expired recovery snapshots during hydration", () => {
    const data = emptyData();
    data.checkpoints["A.md"] = {
      notePath: "A.md",
      before: "before",
      after: "after",
      createdAt: Date.now() - 31 * 24 * 60 * 60 * 1_000,
    };
    expect(hydrateData(data).checkpoints).toEqual({});
  });

  it("bounds recovery checkpoints by reviewable size and count", () => {
    const data = emptyData();
    expect(canStoreCheckpoint("a".repeat(300_000), "b".repeat(300_000))).toBe(true);
    expect(canStoreCheckpoint("a".repeat(300_001), "b".repeat(300_000))).toBe(false);
    for (let index = 0; index < 25; index += 1) {
      storeCheckpoint(data, {
        notePath: `${index}.md`,
        before: "before",
        after: "after",
        createdAt: Date.now() + index,
      });
    }
    expect(Object.keys(data.checkpoints)).toHaveLength(20);
    expect(data.checkpoints["24.md"]).toBeDefined();
  });

  it("globally bounds stored thread text", () => {
    const data = emptyData();
    const thread = getOrCreateThread(data, "agent", "large.md");
    for (let index = 0; index < 100; index += 1) {
      thread.messages.push(createMessage("assistant", "x".repeat(24_000), "body"));
    }
    pruneThreads(data);
    const storedChars = Object.values(data.threads)
      .flatMap((item) => item.messages)
      .reduce((total, message) => total + message.text.length, 0);
    expect(storedChars).toBeLessThanOrEqual(MAX_STORED_MESSAGE_CHARS);
  });

  it("preserves retained thread identity across pruning and persistence preparation", () => {
    const data = emptyData();
    const thread = getOrCreateThread(data, "agent", "identity.md");
    appendMessage(thread, createMessage("user", "before save", "body"), 40);

    pruneThreads(data);
    appendMessage(thread, createMessage("assistant", "after save", "body"), 40);

    expect(data.threads[thread.key]).toBe(thread);
    expect(data.threads[thread.key]?.messages.map((message) => message.text)).toEqual([
      "before save",
      "after save",
    ]);
  });

  it("does not let empty lookup-era threads evict real conversations", () => {
    const data = emptyData();
    for (let index = 0; index < MAX_STORED_THREADS; index += 1) {
      const thread = getOrCreateThread(data, "agent", `${index}.md`);
      appendMessage(thread, createMessage("user", `message ${index}`, "body"), 40);
    }
    const empty = getOrCreateThread(data, "agent", "empty.md");
    expect(empty.messages).toEqual([]);

    pruneThreads(data);

    expect(Object.keys(data.threads)).toHaveLength(MAX_STORED_THREADS);
    expect(data.threads[threadKey("agent", "empty.md")]).toBeUndefined();
    expect(Object.values(data.threads).every((thread) => thread.messages.length === 1)).toBe(true);
  });

  it("hydrates metadata-only scope receipts", () => {
    const data = emptyData();
    data.auditLog.push(createAuditRecord({
      agentId: "default",
      notePath: "A.md",
      scope: "body",
      task: "ask",
      scopeChars: 7,
      scopeHash: "b".repeat(64),
      historyChars: 0,
      historyHash: "c".repeat(64),
    }));
    expect(hydrateData(data).auditLog).toHaveLength(1);
  });

  it("normalizes damaged string settings instead of exposing invalid runtime values", () => {
    const hydrated = hydrateData({
      settings: {
        hermesExecutable: 42,
        hermesHome: null,
        wslDistribution: false,
        defaultAgent: "NOT VALID",
      },
    });
    expect(hydrated.settings.hermesExecutable).toBe("");
    expect(hydrated.settings.hermesHome).toBe("");
    expect(hydrated.settings.wslDistribution).toBe("");
    expect(hydrated.settings.defaultAgent).toBe("default");
    expect(hydrated.settings.hermesEnabled).toBe(true);
    expect(hydrated.settings.vaultBatchEnabled).toBe(false);
    expect(hydrated.settings.vaultBatchMaxFiles).toBe(10);
    expect(hydrated.settings.vaultBatchMaxTotalChars).toBe(200_000);
  });

  it("bounds experimental vault batch settings during hydration", () => {
    const hydrated = hydrateData({
      settings: {
        vaultBatchEnabled: true,
        vaultBatchMaxFiles: 999,
        vaultBatchMaxTotalChars: 9_000_000,
      },
    });
    expect(hydrated.settings.vaultBatchEnabled).toBe(true);
    expect(hydrated.settings.vaultBatchMaxFiles).toBe(20);
    expect(hydrated.settings.vaultBatchMaxTotalChars).toBe(500_000);
  });

  it("fails closed when persisted batch recovery metadata is malformed", () => {
    const malformed = hydrateData({ batchRecovery: { schemaVersion: 999, entries: [] } });
    expect(malformed.batchRecovery).toBeNull();
    expect(malformed.batchRecoveryCorrupt).toBe(true);
    expect(malformed.batchRecoveryQuarantine).toContain('"schemaVersion":999');

    const persistedGate = hydrateData({ batchRecovery: null, batchRecoveryCorrupt: true });
    expect(persistedGate.batchRecoveryCorrupt).toBe(true);
  });

  it("expires completed batch undo metadata without dropping unresolved proof", () => {
    const timestamp = Date.now() - 8 * 24 * 60 * 60 * 1_000;
    const recovery = {
      schemaVersion: 1,
      id: "batch-old",
      createdAt: timestamp,
      updatedAt: timestamp,
      phase: "completed",
      agentContextId: "default@0123456789abcdef",
      entries: [{
        path: "A.md",
        scope: "body",
        from: 0,
        beforeScope: "before",
        beforeFullHash: hashText("before"),
        afterScopeLength: 5,
        afterFullHash: hashText("after"),
        state: "written",
      }],
    };
    const completed = hydrateData({ batchRecovery: recovery });
    expect(completed.batchRecovery).toBeNull();
    expect(completed.batchRecoveryCorrupt).toBe(false);

    const unresolved = hydrateData({ batchRecovery: { ...recovery, phase: "recovery_required" } });
    expect(unresolved.batchRecovery?.phase).toBe("recovery_required");
    expect(unresolved.batchRecoveryCorrupt).toBe(false);
  });

  it("retains only strictly validated custom ACP definitions", () => {
    const workspace = path.resolve("test-workspace");
    const hydrated = hydrateData({
      settings: {
        customAcpAgents: [
          {
            id: "custom-safe",
            label: "Safe agent",
            workspace,
            transport: "native",
            launch: { command: "agent.exe", args: ["acp"] },
          },
          {
            id: "custom-env",
            label: "Unsafe agent",
            workspace,
            launch: { command: "agent.exe", args: [], env: { API_KEY: "secret" } },
          },
        ],
      },
    });
    expect(hydrated.settings.customAcpAgents).toEqual([
      {
        id: "custom-safe",
        label: "Safe agent",
        workspace,
        transport: "native",
        launch: { command: "agent.exe", args: ["acp"] },
      },
    ]);
  });

  it("drops unknown message fields while hydrating persisted state", () => {
    const key = threadKey("agent", "A.md");
    const hydrated = hydrateData({
      threads: {
        [key]: {
          key,
          agentId: "agent",
          notePath: "A.md",
          updatedAt: Date.now(),
          messages: [{
            id: "message",
            role: "user",
            text: "hello",
            createdAt: Date.now(),
            scope: "body",
            scopeKey: "a".repeat(64),
            unexpected: { large: "x".repeat(100_000) },
          }],
        },
      },
    });
    expect(hydrated.threads[key]?.messages[0]).toEqual({
      id: "message",
      role: "user",
      text: "hello",
      createdAt: expect.any(Number),
      scope: "body",
      scopeKey: "a".repeat(64),
    });
  });
});
