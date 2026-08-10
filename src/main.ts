import {
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  type TFile,
} from "obsidian";

import { emptyData, hydrateData, prunePersistedState } from "./core/state";
import { isWorkspaceOutsideVault } from "./core/path-safety";
import { KeyedTaskQueue } from "./core/keyed-task-queue";
import { SerialTaskQueue } from "./core/serial-task-queue";
import type { AgentDiagnostics, AgentProfile, PersistedData } from "./core/types";
import { AcpPool } from "./hermes/acp-client";
import { discoverAcpAgents } from "./hermes/discovery";
import { AuditModal } from "./ui/audit-modal";
import { BoundedNoteChatView, VIEW_TYPE_BOUNDED_NOTE_CHAT } from "./ui/chat-view";
import { DiffModal } from "./ui/diff-modal";
import { BoundedNoteChatSettingTab } from "./ui/settings-tab";

export default class BoundedNoteChatPlugin extends Plugin {
  state: PersistedData = emptyData();
  agents: AgentProfile[] = [];
  diagnostics: AgentDiagnostics | null = null;
  readonly acpPool = new AcpPool();
  private readonly chatViews = new Set<BoundedNoteChatView>();
  private readonly noteMutationQueue = new KeyedTaskQueue();
  private readonly saveQueue = new SerialTaskQueue();
  private agentRefreshGeneration = 0;

  override async onload(): Promise<void> {
    this.state = hydrateData(await this.loadData());
    await this.saveState();
    this.registerView(
      VIEW_TYPE_BOUNDED_NOTE_CHAT,
      (leaf) => new BoundedNoteChatView(leaf, this),
    );
    this.addRibbonIcon("message-square-lock", "Open Agent Change Gate", () => {
      void this.activateView();
    });
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "review-undo-last-gated-edit",
      name: "Review and undo last applied edit",
      checkCallback: (checking) => {
        const view = this.getActiveMarkdownView();
        const file = view?.file;
        const checkpoint = file ? this.state.checkpoints[file.path] : undefined;
        if (!view || !file || !checkpoint) return false;
        if (!checking) void this.undoCheckpoint(file, view);
        return true;
      },
    });
    this.addCommand({
      id: "show-scope-receipts",
      name: "Show scope receipts",
      callback: () => new AuditModal(this.app, this.state.auditLog).open(),
    });
    this.addSettingTab(new BoundedNoteChatSettingTab(this));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshChatViews()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshChatViews()));

    this.app.workspace.onLayoutReady(() => {
      void this.refreshAgents(false).catch((error) => {
        this.diagnostics = {
          ok: false,
          message: error instanceof Error ? error.message : "ACP agent discovery failed.",
        };
        this.refreshChatViews();
      });
    });
  }

  override onunload(): void {
    this.agentRefreshGeneration += 1;
    this.acpPool.reset();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BOUNDED_NOTE_CHAT);
  }

  registerChatView(view: BoundedNoteChatView): void {
    this.chatViews.add(view);
  }

  unregisterChatView(view: BoundedNoteChatView): void {
    this.chatViews.delete(view);
  }

  async saveState(): Promise<void> {
    prunePersistedState(this.state);
    const snapshot = structuredClone(this.state);
    await this.saveQueue.enqueue(async () => await this.saveData(snapshot));
  }

  async runNoteMutation<T>(notePath: string, task: () => Promise<T>): Promise<T> {
    return await this.noteMutationQueue.run(notePath, task);
  }

  async configurationChanged(refresh = true): Promise<void> {
    this.invalidateAgentConfiguration();
    await this.saveState();
    if (refresh) await this.refreshAgents(false);
  }

  invalidateAgentConfiguration(): void {
    this.agentRefreshGeneration += 1;
    this.acpPool.reset();
    this.agents = [];
    this.diagnostics = {
      ok: false,
      message: "Agent settings changed. Run Detect and check agents before chatting.",
    };
    this.refreshChatViews();
  }

  async refreshAgents(showNotice: boolean): Promise<AgentDiagnostics> {
    const generation = ++this.agentRefreshGeneration;
    const settingsSnapshot = structuredClone(this.state.settings);
    const superseded: AgentDiagnostics = {
      ok: false,
      message: "Agent discovery was superseded by a newer configuration.",
    };
    try {
      const result = await discoverAcpAgents(settingsSnapshot);
      const adapter = this.app.vault.adapter;
      const vaultBasePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
      if (vaultBasePath) {
        const unsafeProfile = result.profiles.find((profile) => (
          profile.source === "custom"
          && !isWorkspaceOutsideVault(vaultBasePath, profile.workspace, profile.transport)
        ));
        if (unsafeProfile) {
          throw new Error(`${unsafeProfile.label} uses the vault as its ACP working directory. Choose a path outside the vault.`);
        }
      }
      if (generation !== this.agentRefreshGeneration) return superseded;
      if (result.profiles.length > 0 && !result.profiles.some((profile) => profile.id === this.state.settings.defaultAgent)) {
        this.state.settings.defaultAgent = result.profiles[0]?.id ?? "default";
        await this.saveState();
        if (generation !== this.agentRefreshGeneration) return superseded;
      }
      this.agents = result.profiles;
      this.diagnostics = result.diagnostics;
      this.refreshChatViews();
      if (showNotice) new Notice(result.diagnostics.message);
      return result.diagnostics;
    } catch (error) {
      if (generation !== this.agentRefreshGeneration) return superseded;
      const diagnostics = {
        ok: false,
        message: error instanceof Error ? error.message : "ACP agent discovery failed.",
      };
      this.agents = [];
      this.diagnostics = diagnostics;
      this.refreshChatViews();
      if (showNotice) new Notice(diagnostics.message);
      return diagnostics;
    }
  }

  async checkProfile(profile: AgentProfile): Promise<AgentDiagnostics> {
    await this.acpPool.check(profile, Math.min(this.state.settings.promptTimeoutMs, 30_000));
    return {
      ok: true,
      message: `${profile.label} completed ACP initialization. Agent Change Gate sent no model prompt; executable startup behavior is outside the gate.`,
      executable: profile.executable,
      transport: profile.transport,
      profiles: [profile.id],
    };
  }

  getActiveMarkdownView(): MarkdownView | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;

    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) return active;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        return leaf.view;
      }
    }
    return null;
  }

  private refreshChatViews(): void {
    for (const view of this.chatViews) view.refresh();
  }

  private async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOUNDED_NOTE_CHAT)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) {
        new Notice("Could not open the Agent Change Gate sidebar.");
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_BOUNDED_NOTE_CHAT, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private async undoCheckpoint(file: TFile, view: MarkdownView): Promise<void> {
    const checkpoint = this.state.checkpoints[file.path];
    if (!checkpoint) return;
    if (view.editor.getValue() !== checkpoint.after) {
      new Notice("The note changed after the saved edit, so the plugin will not overwrite it.");
      return;
    }
    const accepted = await new DiffModal(this.app, {
      title: `Review undo for ${file.path}`,
      original: checkpoint.after,
      replacement: checkpoint.before,
      gateSummary: "Restore the note snapshot captured immediately before the last Agent Change Gate edit.",
    }).waitForDecision();
    if (!accepted) return;
    await this.runNoteMutation(file.path, async () => {
      const currentView = this.getActiveMarkdownView();
      if (currentView?.file?.path !== file.path || currentView.editor.getValue() !== checkpoint.after) {
        new Notice("The note changed while the undo was being reviewed, so it was not applied.");
        return;
      }
      try {
        currentView.editor.setValue(checkpoint.before);
      } catch {
        new Notice("The undo could not be applied.");
        return;
      }
      if (this.state.checkpoints[file.path] === checkpoint) {
        delete this.state.checkpoints[file.path];
      }
      try {
        await this.saveState();
      } catch {
        this.state.checkpoints[file.path] = checkpoint;
        new Notice("The note was restored, but the stale recovery checkpoint could not be cleared. It cannot overwrite the restored note.");
        return;
      }
      new Notice("Last Agent Change Gate edit undone.");
    });
  }
}
