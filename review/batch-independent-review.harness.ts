/**
 * Independent review harness for PR #3 (codex/vault-batch-mode @ 4108176).
 * All note data is synthetic and in memory; no vault, model, or network access.
 *
 * Tests named "DEFECT ..." assert the CURRENT (observed) behavior so the
 * reproduction is deterministic; the expected behavior is described inline.
 * Tests named "COVERED ..." confirm safety behavior that already holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const confirmDecision = vi.hoisted(() => ({ value: true }));

vi.mock("obsidian", () => {
  class FileSystemAdapter {
    getBasePath(): string {
      return "/synthetic-vault";
    }
  }
  class TFile {
    extension: string;
    constructor(public path: string) {
      this.extension = path.split(".").pop()?.toLowerCase() ?? "";
    }
  }
  class MarkdownView {
    constructor(public file: TFile | null = null) {}
  }
  class Plugin {
    app: unknown;
    manifest: { id: string };
    constructor(app: unknown, manifest: { id: string }) {
      this.app = app;
      this.manifest = manifest;
    }
    async loadData(): Promise<unknown> {
      return null;
    }
    async saveData(_data: unknown): Promise<void> {}
  }
  class Notice {
    static messages: string[] = [];
    constructor(message: string) {
      Notice.messages.push(message);
    }
  }
  return { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile };
});

vi.mock("../src/ui/audit-modal", () => ({ AuditModal: class { open(): void {} } }));
vi.mock("../src/ui/batch-modal", () => ({ VaultBatchModal: class { open(): void {} } }));
vi.mock("../src/ui/chat-view", () => ({
  BoundedNoteChatView: class { refresh(): void {} },
  VIEW_TYPE_BOUNDED_NOTE_CHAT: "agent-change-gate-view",
}));
vi.mock("../src/ui/confirm-modal", () => ({
  ConfirmModal: class {
    async waitForDecision(): Promise<boolean> {
      return confirmDecision.value;
    }
  },
}));
vi.mock("../src/ui/diff-modal", () => ({ DiffModal: class {} }));
vi.mock("../src/ui/settings-tab", () => ({ BoundedNoteChatSettingTab: class {} }));
vi.mock("../src/hermes/acp-client", () => ({
  AcpPool: class {
    check = vi.fn();
    reset(): void {}
  },
}));

import { MarkdownView, Notice, TFile } from "obsidian";

import { agentContextId } from "../src/core/agent-identity";
import { applyReplacement, captureScope, hashText } from "../src/core/scope";
import { hydrateData } from "../src/core/state";
import type { AgentProfile } from "../src/core/types";
import BoundedNoteChatPlugin from "../src/main";
import type { ApprovedVaultBatchEdit } from "../src/ui/batch-modal";

const MockTFile = TFile as unknown as new (path: string) => TFile;
const MockMarkdownView = MarkdownView as unknown as new (file: TFile | null) => MarkdownView;
const notices = (Notice as unknown as { messages: string[] }).messages;

interface Host {
  app: unknown;
  contents: Map<string, string>;
  openPaths: Set<string>;
  writes: Array<{ path: string; after: string }>;
  /** Runs after the plugin's write for `path` lands on "disk". */
  afterWrite: Map<string, () => void>;
  /** Throws before the plugin's callback runs for `path` (one shot). */
  failBefore: Set<string>;
}

function createHost(initial: Record<string, string>): Host {
  const contents = new Map(Object.entries(initial));
  const files = new Map(Object.keys(initial).map((path) => [path, new MockTFile(path)]));
  const openPaths = new Set<string>();
  const writes: Host["writes"] = [];
  const afterWrite = new Map<string, () => void>();
  const failBefore = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => (contents.has(path) ? files.get(path) ?? null : null),
      read: async (file: TFile) => {
        const content = contents.get(file.path);
        if (content === undefined) throw new Error("missing");
        return content;
      },
      process: async (file: TFile, update: (current: string) => string) => {
        if (failBefore.delete(file.path)) throw new Error("Injected I/O failure.");
        const current = contents.get(file.path);
        if (current === undefined) throw new Error("missing");
        const next = update(current);
        contents.set(file.path, next);
        writes.push({ path: file.path, after: next });
        const hook = afterWrite.get(file.path);
        afterWrite.delete(file.path);
        hook?.();
      },
    },
    workspace: {
      getLeavesOfType: (type: string) => (type !== "markdown"
        ? []
        : [...openPaths].map((path) => ({ view: new MockMarkdownView(files.get(path) ?? null) }))),
    },
  };
  return { app, contents, openPaths, writes, afterWrite, failBefore };
}

const profile: AgentProfile = {
  id: "default",
  label: "Default",
  home: "",
  workspace: "/synthetic-agent-workspace",
  transport: "native",
  executable: "agent",
  source: "custom",
  launch: { command: "agent", args: ["acp"] },
};

function createPlugin(host: Host, saved: { last: unknown }): BoundedNoteChatPlugin {
  const plugin = new BoundedNoteChatPlugin(host.app as never, { id: "agent-change-gate", version: "0.3.0" } as never);
  plugin.agents = [profile];
  plugin.saveData = async (data: unknown) => {
    saved.last = JSON.parse(JSON.stringify(data));
  };
  return plugin;
}

function edit(path: string, before: string, replacement: string): ApprovedVaultBatchEdit {
  const snapshot = captureScope(path, before, "body");
  const afterText = applyReplacement(snapshot, replacement);
  return {
    snapshot,
    candidate: { path, content: before, contentHash: hashText(before) },
    effectiveReplacement: replacement,
    afterText,
    afterHash: hashText(afterText),
    auditId: `audit-${path}`,
  };
}

const ctx = agentContextId(profile);
type Internals = {
  reconcileInterruptedBatchUnlocked(): Promise<void>;
  undoVaultBatch(): Promise<void>;
};

beforeEach(() => {
  notices.length = 0;
  confirmDecision.value = true;
});

describe("F1: a note the plugin never wrote is reported as recovery-required and locks all writes", () => {
  it("DEFECT: external edit to an un-attempted target during a failing batch", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo", "C.md": "charlie" });
    const saved = { last: null as unknown };
    const plugin = createPlugin(host, saved);
    // Synthetic sync/other-editor change to C.md while A.md is being written,
    // then an I/O failure on B.md. The plugin never calls process() for C.md.
    host.afterWrite.set("A.md", () => host.contents.set("C.md", "charlie (user edit)"));
    host.failBefore.add("B.md");

    const result = await plugin.applyVaultBatch("batch-f1", "default", ctx, [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
      edit("C.md", "charlie", "CHARLIE"),
    ]);

    // No data loss: A rolled back, user's C edit preserved, plugin never wrote C.
    expect(host.writes.map((w) => w.path)).toEqual(["A.md", "A.md"]);
    expect(host.contents.get("A.md")).toBe("alpha");
    expect(host.contents.get("C.md")).toBe("charlie (user edit)");
    // Observed: C.md (never written) is labelled recovery-required and the
    // whole plugin is locked. Expected: C.md "not-applied", no lock, because
    // every plugin-written file was rolled back exactly.
    expect(Object.fromEntries(result.outcomes)).toEqual({
      "A.md": "rolled-back",
      "B.md": "not-applied",
      "C.md": "recovery-required",
    });
    expect(plugin.state.batchRecovery?.phase).toBe("recovery_required");
    expect(plugin.isBatchRecoveryLocked()).toBe(true);
    await expect(plugin.runNoteMutation("Other.md", async () => "write")).rejects.toThrow(/Resolve the interrupted/u);

    // Undo cannot clear it either: it refuses because C.md is neither before nor after.
    await (plugin as unknown as Internals).undoVaultBatch();
    expect(notices.some((m) => m.includes("C.md changed after the batch"))).toBe(true);
    expect(plugin.isBatchRecoveryLocked()).toBe(true);
    // The only exit is "abandon unresolved" in settings, i.e. discarding the
    // recovery proof, although nothing needs recovering.
  });

  it("DEFECT: external edit to the target being written makes the in-callback guard fire", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const saved = { last: null as unknown };
    const plugin = createPlugin(host, saved);
    host.afterWrite.set("A.md", () => host.contents.set("B.md", "bravo (synced from phone)"));

    const result = await plugin.applyVaultBatch("batch-f1b", "default", ctx, [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);

    expect(host.contents.get("A.md")).toBe("alpha");
    expect(host.contents.get("B.md")).toBe("bravo (synced from phone)");
    // Expected: B.md "stale"/"not-applied" (guard refused before writing).
    expect(Object.fromEntries(result.outcomes)).toEqual({
      "A.md": "rolled-back",
      "B.md": "recovery-required",
    });
    expect(plugin.isBatchRecoveryLocked()).toBe(true);
  });
});

describe("restart reconciliation after a partial write", () => {
  it("COVERED: crash between A's write and its journal update reconciles by hash and undo restores exactly", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const saved = { last: null as unknown };
    const plugin = createPlugin(host, saved);
    let crashSnapshot: unknown = null;
    host.afterWrite.set("A.md", () => {
      crashSnapshot = structuredClone(saved.last); // persisted state at the instant of the "crash"
    });
    await plugin.applyVaultBatch("batch-crash", "default", ctx, [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);
    const persisted = crashSnapshot as { batchRecovery: { phase: string; entries: Array<{ state: string }> } };
    expect(persisted.batchRecovery.phase).toBe("applying");
    expect(persisted.batchRecovery.entries.map((e) => e.state)).toEqual(["pending", "pending"]);

    // Restart against the vault state at the crash: A written, B untouched.
    const host2 = createHost({ "A.md": "ALPHA", "B.md": "bravo" });
    const saved2 = { last: null as unknown };
    const plugin2 = createPlugin(host2, saved2);
    plugin2.state = hydrateData(crashSnapshot);
    await (plugin2 as unknown as Internals).reconcileInterruptedBatchUnlocked();
    expect(plugin2.state.batchRecovery?.phase).toBe("recovery_required");
    expect(plugin2.state.batchRecovery?.entries.map((e) => e.state)).toEqual(["written", "rolled_back"]);
    expect(plugin2.isBatchRecoveryLocked()).toBe(true);

    await (plugin2 as unknown as Internals).undoVaultBatch();
    expect(host2.contents.get("A.md")).toBe("alpha");
    expect(host2.contents.get("B.md")).toBe("bravo");
    expect(plugin2.state.batchRecovery).toBeNull();
    expect(plugin2.isBatchRecoveryLocked()).toBe(false);
  });

  it("COVERED: reconcile with a later user edit keeps the user's text and stays locked", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const saved = { last: null as unknown };
    const plugin = createPlugin(host, saved);
    let crashSnapshot: unknown = null;
    host.afterWrite.set("A.md", () => {
      crashSnapshot = structuredClone(saved.last);
    });
    await plugin.applyVaultBatch("batch-crash-2", "default", ctx, [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);
    const host2 = createHost({ "A.md": "ALPHA + user addition", "B.md": "bravo" });
    const plugin2 = createPlugin(host2, { last: null });
    plugin2.state = hydrateData(crashSnapshot);
    await (plugin2 as unknown as Internals).reconcileInterruptedBatchUnlocked();
    await (plugin2 as unknown as Internals).undoVaultBatch();
    expect(host2.writes).toEqual([]);
    expect(host2.contents.get("A.md")).toBe("ALPHA + user addition");
    expect(plugin2.isBatchRecoveryLocked()).toBe(true);
  });
});

describe("rollback / undo against concurrent edits", () => {
  it("COVERED: user edit to an applied file before automatic rollback is never overwritten", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const plugin = createPlugin(host, { last: null });
    host.afterWrite.set("A.md", () => {
      host.contents.set("A.md", "ALPHA edited by user");
      host.failBefore.add("B.md");
    });
    const result = await plugin.applyVaultBatch("batch-rb", "default", ctx, [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);
    expect(host.contents.get("A.md")).toBe("ALPHA edited by user");
    expect(result.outcomes.get("A.md")).toBe("recovery-required");
    expect(plugin.isBatchRecoveryLocked()).toBe(true);
  });

  it("COVERED: undo of a completed batch performs zero writes if any target diverged", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const plugin = createPlugin(host, { last: null });
    await plugin.applyVaultBatch("batch-undo", "default", ctx, [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);
    expect(plugin.state.batchRecovery?.phase).toBe("completed");
    host.contents.set("B.md", "BRAVO plus later work");
    host.writes.length = 0;
    await (plugin as unknown as Internals).undoVaultBatch();
    expect(host.writes).toEqual([]);
    expect(host.contents.get("A.md")).toBe("ALPHA");
    expect(host.contents.get("B.md")).toBe("BRAVO plus later work");
    expect(plugin.state.batchRecovery?.phase).toBe("completed");
  });

  it("COVERED: a target opened in an editor between preflight and its write is not written", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const plugin = createPlugin(host, { last: null });
    host.afterWrite.set("A.md", () => host.openPaths.add("B.md"));
    const result = await plugin.applyVaultBatch("batch-open", "default", ctx, [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);
    expect(host.writes.filter((w) => w.path === "B.md")).toEqual([]);
    expect(host.contents.get("A.md")).toBe("alpha");
    expect(result.outcomes.get("A.md")).toBe("rolled-back");
  });
});

describe("journal privacy and durability", () => {
  it("COVERED (disclosed in PRIVACY.md): journal holds original scope text but never replacement/after text", async () => {
    const host = createHost({ "A.md": "---\ntitle: t\n---\nsynthetic private body" });
    const saved = { last: null as unknown };
    const plugin = createPlugin(host, saved);
    const snapshot = captureScope("A.md", host.contents.get("A.md") ?? "", "body");
    const replacement = "\nSYNTHETIC REPLACEMENT MARKER";
    const afterText = applyReplacement(snapshot, replacement);
    await plugin.applyVaultBatch("batch-priv", "default", ctx, [{
      snapshot,
      candidate: { path: "A.md", content: snapshot.fullText, contentHash: hashText(snapshot.fullText) },
      effectiveReplacement: replacement,
      afterText,
      afterHash: hashText(afterText),
      auditId: "audit-A",
    }]);
    const json = JSON.stringify(saved.last);
    expect(json).toContain("synthetic private body");
    expect(json).not.toContain("SYNTHETIC REPLACEMENT MARKER");
    expect(json).not.toContain("title: t");
  });

  it("COVERED: prepared journal is persisted before the first write", async () => {
    const host = createHost({ "A.md": "alpha" });
    const saved = { last: null as unknown };
    const plugin = createPlugin(host, saved);
    let atFirstWrite: unknown = null;
    host.afterWrite.set("A.md", () => {
      atFirstWrite = structuredClone(saved.last);
    });
    await plugin.applyVaultBatch("batch-dur", "default", ctx, [edit("A.md", "alpha", "ALPHA")]);
    expect((atFirstWrite as { batchRecovery: { phase: string } }).batchRecovery.phase).toBe("applying");
  });
});
