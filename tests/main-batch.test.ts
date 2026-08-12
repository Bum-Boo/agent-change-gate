import { beforeEach, describe, expect, it, vi } from "vitest";

const acpCheck = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("obsidian", () => {
  class FileSystemAdapter {
    getBasePath(): string {
      return "C:\\vault";
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
    constructor(_message: string, _duration?: number) {}
  }

  return { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile };
});

vi.mock("../src/ui/audit-modal", () => ({
  AuditModal: class AuditModal {
    open(): void {}
  },
}));

vi.mock("../src/ui/batch-modal", () => ({
  VaultBatchModal: class VaultBatchModal {
    open(): void {}
  },
}));

vi.mock("../src/ui/chat-view", () => ({
  BoundedNoteChatView: class BoundedNoteChatView {
    refresh(): void {}
  },
  VIEW_TYPE_BOUNDED_NOTE_CHAT: "agent-change-gate-view",
}));

vi.mock("../src/ui/confirm-modal", () => ({
  ConfirmModal: class ConfirmModal {},
}));

vi.mock("../src/ui/diff-modal", () => ({
  DiffModal: class DiffModal {},
}));

vi.mock("../src/ui/settings-tab", () => ({
  BoundedNoteChatSettingTab: class BoundedNoteChatSettingTab {},
}));

vi.mock("../src/hermes/acp-client", () => ({
  AcpPool: class AcpPool {
    check = acpCheck;
    reset(): void {}
  },
}));

import { MarkdownView, TFile } from "obsidian";

import { applyReplacement, captureScope, hashText } from "../src/core/scope";
import { agentContextId } from "../src/core/agent-identity";
import type { AgentProfile } from "../src/core/types";
import BoundedNoteChatPlugin from "../src/main";
import type { ApprovedVaultBatchEdit } from "../src/ui/batch-modal";

const MockTFile = TFile as unknown as new (path: string) => TFile;
const MockMarkdownView = MarkdownView as unknown as new (file: TFile | null) => MarkdownView;

interface WriteEvent {
  after: string;
  before: string;
  path: string;
}

interface FakeHost {
  app: {
    vault: {
      getAbstractFileByPath(path: string): TFile | null;
      process(file: TFile, update: (current: string) => string): Promise<void>;
      read(file: TFile): Promise<string>;
    };
    workspace: {
      getLeavesOfType(type: string): Array<{ view: MarkdownView }>;
    };
  };
  contents: Map<string, string>;
  failNextProcess(path: string, beforeThrow?: () => void): void;
  files: Map<string, TFile>;
  openPaths: Set<string>;
  failNextRead(path: string, message: string): void;
  processAttempts: string[];
  writeEvents: WriteEvent[];
}

function createHost(initial: Record<string, string>): FakeHost {
  const contents = new Map(Object.entries(initial));
  const files = new Map(
    Object.keys(initial).map((path) => [path, new MockTFile(path)]),
  );
  const openPaths = new Set<string>();
  const processAttempts: string[] = [];
  const writeEvents: WriteEvent[] = [];
  let processFailure: { path: string; beforeThrow?: () => void } | null = null;
  let readFailure: { path: string; message: string } | null = null;

  const host: FakeHost = {
    app: {
      vault: {
        getAbstractFileByPath(path) {
          return files.get(path) ?? null;
        },
        async read(file) {
          if (readFailure?.path === file.path) {
            const failure = readFailure;
            readFailure = null;
            throw new Error(failure.message);
          }
          const content = contents.get(file.path);
          if (content === undefined) throw new Error(`${file.path} is missing.`);
          return content;
        },
        async process(file, update) {
          processAttempts.push(file.path);
          if (processFailure?.path === file.path) {
            const failure = processFailure;
            processFailure = null;
            failure.beforeThrow?.();
            throw new Error(`Injected write failure for ${file.path}.`);
          }
          const before = contents.get(file.path);
          if (before === undefined) throw new Error(`${file.path} is missing.`);
          const after = update(before);
          contents.set(file.path, after);
          writeEvents.push({ path: file.path, before, after });
        },
      },
      workspace: {
        getLeavesOfType(type) {
          if (type !== "markdown") return [];
          return [...openPaths].map((path) => ({
            view: new MockMarkdownView(files.get(path) ?? null),
          }));
        },
      },
    },
    contents,
    failNextRead(path, message) {
      readFailure = { path, message };
    },
    failNextProcess(path, beforeThrow) {
      processFailure = { path, ...(beforeThrow ? { beforeThrow } : {}) };
    },
    files,
    openPaths,
    processAttempts,
    writeEvents,
  };
  return host;
}

function edit(path: string, before: string, replacement: string): ApprovedVaultBatchEdit {
  const snapshot = captureScope(path, before, "body");
  const effectiveReplacement = replacement;
  const afterText = applyReplacement(snapshot, effectiveReplacement);
  return {
    snapshot,
    candidate: { path, content: before, contentHash: hashText(before) },
    effectiveReplacement,
    afterText,
    afterHash: hashText(afterText),
    auditId: `audit-${path}`,
  };
}

function createPlugin(host: FakeHost): BoundedNoteChatPlugin {
  const plugin = new BoundedNoteChatPlugin(
    host.app as never,
    { id: "agent-change-gate", version: "0.3.0" } as never,
  );
  const profile: AgentProfile = {
    id: "default",
    label: "Default",
    home: "",
    workspace: "C:\\agent-workspace",
    transport: "native",
    executable: "agent.exe",
    source: "custom",
    launch: { command: "agent.exe", args: ["acp"] },
  };
  plugin.agents = [profile];
  return plugin;
}

function defaultAgentContext(plugin: BoundedNoteChatPlugin): string {
  const profile = plugin.agents[0];
  if (!profile) throw new Error("Missing test profile.");
  return agentContextId(profile);
}

function outcomes(result: Awaited<ReturnType<BoundedNoteChatPlugin["applyVaultBatch"]>>): Record<string, string> {
  return Object.fromEntries(result.outcomes);
}

describe("applyVaultBatch host integration", () => {
  beforeEach(() => {
    acpCheck.mockReset();
    acpCheck.mockResolvedValue();
  });

  it("performs zero writes when one approved target is stale", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "changed outside the gate" });
    const plugin = createPlugin(host);
    const result = await plugin.applyVaultBatch("batch-stale", "default", defaultAgentContext(plugin), [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);

    expect(outcomes(result)).toEqual({
      "A.md": "not-applied",
      "B.md": "stale",
    });
    expect(host.processAttempts).toEqual([]);
    expect(host.writeEvents).toEqual([]);
    expect(host.contents.get("A.md")).toBe("alpha");
    expect(host.contents.get("B.md")).toBe("changed outside the gate");
    expect(plugin.state.batchRecovery).toBeNull();
  });

  it("does not expose an absolute path from a host read failure", async () => {
    const host = createHost({ "A.md": "alpha" });
    const plugin = createPlugin(host);
    host.failNextRead("A.md", "EACCES C:\\Users\\Private\\Secret Vault\\A.md token=secret");

    const result = await plugin.applyVaultBatch("batch-read-failure", "default", defaultAgentContext(plugin), [
      edit("A.md", "alpha", "ALPHA"),
    ]);

    expect(result.message).toBe("A selected target could not be safely re-read. Close every selected Markdown view, verify the notes still exist, and try again. No write started.");
    expect(result.message).not.toMatch(/Private|Secret Vault|token=secret/u);
    expect(host.processAttempts).toEqual([]);
  });

  it("rolls back the first write and reports later untouched files as not applied", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo", "C.md": "charlie" });
    const plugin = createPlugin(host);
    host.failNextProcess("B.md");

    const result = await plugin.applyVaultBatch("batch-write-failure", "default", defaultAgentContext(plugin), [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
      edit("C.md", "charlie", "CHARLIE"),
    ]);

    expect(outcomes(result)).toEqual({
      "A.md": "rolled-back",
      "B.md": "not-applied",
      "C.md": "not-applied",
    });
    expect(host.processAttempts).toEqual(["A.md", "B.md", "A.md"]);
    expect(host.writeEvents).toEqual([
      { path: "A.md", before: "alpha", after: "ALPHA" },
      { path: "A.md", before: "ALPHA", after: "alpha" },
    ]);
    expect(Object.fromEntries(host.contents)).toEqual({
      "A.md": "alpha",
      "B.md": "bravo",
      "C.md": "charlie",
    });
    expect(plugin.state.batchRecovery).toBeNull();
    expect(result.message).toContain("1 completed writes were safely rolled back");
    expect(result.message).toContain("2 reviewed edits were never written");
  });

  it("keeps an applied file unchanged and records recovery-required when it opens before rollback", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const plugin = createPlugin(host);
    host.failNextProcess("B.md", () => host.openPaths.add("A.md"));

    const result = await plugin.applyVaultBatch("batch-open-conflict", "default", defaultAgentContext(plugin), [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);

    expect(outcomes(result)).toEqual({
      "A.md": "recovery-required",
      "B.md": "not-applied",
    });
    expect(host.processAttempts).toEqual(["A.md", "B.md"]);
    expect(host.contents.get("A.md")).toBe("ALPHA");
    expect(host.contents.get("B.md")).toBe("bravo");
    expect(plugin.state.batchRecovery?.phase).toBe("recovery_required");
    expect(plugin.state.batchRecovery?.entries).toEqual([
      expect.objectContaining({ path: "A.md", state: "conflict" }),
      expect.objectContaining({ path: "B.md", state: "pending" }),
    ]);
  });

  it("performs zero writes and restores prior state when the initial recovery journal cannot be saved", async () => {
    const host = createHost({ "A.md": "alpha", "B.md": "bravo" });
    const plugin = createPlugin(host);
    const save = vi.spyOn(plugin, "saveState").mockRejectedValueOnce(new Error("Injected save failure."));

    const result = await plugin.applyVaultBatch("batch-journal-save-failure", "default", defaultAgentContext(plugin), [
      edit("A.md", "alpha", "ALPHA"),
      edit("B.md", "bravo", "BRAVO"),
    ]);

    expect(outcomes(result)).toEqual({
      "A.md": "not-applied",
      "B.md": "not-applied",
    });
    expect(result.message).toBe("The recovery journal could not be saved. No write started.");
    expect(host.processAttempts).toEqual([]);
    expect(host.writeEvents).toEqual([]);
    expect(plugin.state.batchRecovery).toBeNull();
    expect(plugin.state.batchRecoveryCorrupt).toBe(false);
    expect(plugin.state.batchRecoveryQuarantine).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("connection readiness races", () => {
  beforeEach(() => {
    acpCheck.mockReset();
    acpCheck.mockResolvedValue();
  });

  it("does not publish a stale successful check after agent settings change", async () => {
    const host = createHost({ "A.md": "alpha" });
    const plugin = createPlugin(host);
    const profile = plugin.agents[0];
    if (!profile) throw new Error("Missing test profile.");
    let finishCheck!: () => void;
    acpCheck.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCheck = () => resolve();
    }));

    const pending = plugin.checkProfile(profile);
    plugin.invalidateAgentConfiguration();
    finishCheck();
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      stage: "initialization",
      message: "The connection check was superseded by newer agent settings. Run it again.",
    });
    expect(plugin.agents).toEqual([]);
    expect(plugin.diagnostics).toMatchObject({ ok: false, stage: "discovery" });
  });
});
