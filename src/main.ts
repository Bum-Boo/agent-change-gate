import {
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
} from "obsidian";

import {
  classifyBatchRecoveryEntry,
  hydrateBatchRecoveryJournal,
  prepareBatchRecoveryRestore,
  type BatchRecoveryJournal,
} from "./core/batch-recovery";
import {
  bindBatchProposal,
  MAX_BATCH_TOTAL_CHARACTERS,
  preflightBatchTransaction,
  validateBatchProposals,
} from "./core/batch";
import { agentContextId } from "./core/agent-identity";
import { emptyData, hydrateData, prunePersistedState } from "./core/state";
import { isWorkspaceOutsideVault } from "./core/path-safety";
import { KeyedTaskQueue } from "./core/keyed-task-queue";
import { SerialTaskQueue } from "./core/serial-task-queue";
import type { AgentDiagnostics, AgentProfile, PersistedData } from "./core/types";
import { AcpPool } from "./hermes/acp-client";
import { discoverAcpAgents } from "./hermes/discovery";
import { AuditModal } from "./ui/audit-modal";
import { type ApprovedVaultBatchEdit, VaultBatchModal } from "./ui/batch-modal";
import { BoundedNoteChatView, VIEW_TYPE_BOUNDED_NOTE_CHAT } from "./ui/chat-view";
import { ConfirmModal } from "./ui/confirm-modal";
import { DiffModal } from "./ui/diff-modal";
import { BoundedNoteChatSettingTab } from "./ui/settings-tab";

export default class BoundedNoteChatPlugin extends Plugin {
  state: PersistedData = emptyData();
  agents: AgentProfile[] = [];
  diagnostics: AgentDiagnostics | null = null;
  readonly acpPool = new AcpPool();
  private readonly chatViews = new Set<BoundedNoteChatView>();
  private readonly noteMutationQueue = new KeyedTaskQueue();
  private readonly mutationQueue = new SerialTaskQueue();
  private readonly saveQueue = new SerialTaskQueue();
  private batchRecoveryBusy = false;
  private agentRefreshGeneration = 0;

  override async onload(): Promise<void> {
    this.state = hydrateData(await this.loadData());
    if (!(this.state.batchRecoveryCorrupt && !this.state.batchRecoveryQuarantine)) {
      await this.saveState();
    }
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
      id: "open-vault-batch-review",
      name: "Open vault batch review (experimental)",
      checkCallback: (checking) => {
        if (!this.state.settings.vaultBatchEnabled || this.isBatchRecoveryLocked()) return false;
        if (!checking) new VaultBatchModal(this).open();
        return true;
      },
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
    this.addCommand({
      id: "undo-last-vault-batch",
      name: "Review and undo last vault batch",
      checkCallback: (checking) => {
        if (!this.state.batchRecovery) return false;
        if (!checking) {
          void this.undoVaultBatch().catch((error) => {
            new Notice(error instanceof Error ? error.message : "Batch undo failed before it could finish.");
          });
        }
        return true;
      },
    });
    this.addSettingTab(new BoundedNoteChatSettingTab(this));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshChatViews()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshChatViews()));

    this.app.workspace.onLayoutReady(() => {
      void this.reconcileInterruptedBatch().catch((error) => {
        new Notice(error instanceof Error ? error.message : "Batch recovery reconciliation failed.", 10_000);
      });
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
    if (this.state.batchRecoveryCorrupt && !this.state.batchRecoveryQuarantine) {
      throw new Error("Refusing to overwrite an oversized or unreadable recovery record. Back up data.json, then explicitly abandon recovery in settings if you want to unlock writes.");
    }
    prunePersistedState(this.state);
    const snapshot = structuredClone(this.state);
    await this.saveQueue.enqueue(async () => await this.saveData(snapshot));
  }

  async runNoteMutation<T>(notePath: string, task: () => Promise<T>): Promise<T> {
    return await this.mutationQueue.enqueue(async () => {
      if (this.state.batchRecoveryCorrupt || (this.state.batchRecovery && this.state.batchRecovery.phase !== "completed")) {
        throw new Error("Resolve the interrupted vault batch recovery state before applying another plugin edit.");
      }
      return await this.noteMutationQueue.run(notePath, task);
    });
  }

  async runBatchMutation<T>(task: () => Promise<T>): Promise<T> {
    return await this.mutationQueue.enqueue(async () => {
      this.batchRecoveryBusy = true;
      try {
        return await task();
      } finally {
        this.batchRecoveryBusy = false;
      }
    });
  }

  async clearRecoveryState(options: {
    expectedBatchId: string | null;
    expectedCorrupt: boolean;
    abandonUnresolved: boolean;
    clearSingleCheckpoints: boolean;
  }): Promise<{ ok: boolean; message: string }> {
    return await this.runBatchMutation(async () => {
      const currentId = this.state.batchRecovery?.id ?? null;
      if (currentId !== options.expectedBatchId || this.state.batchRecoveryCorrupt !== options.expectedCorrupt) {
        return { ok: false, message: "Recovery state changed while confirmation was open. Nothing was cleared." };
      }
      if (!options.abandonUnresolved && this.isBatchRecoveryLocked()) {
        return { ok: false, message: "Unresolved batch recovery was not cleared." };
      }
      const previousCheckpoints = this.state.checkpoints;
      const previousJournal = this.state.batchRecovery;
      const previousCorrupt = this.state.batchRecoveryCorrupt;
      const previousQuarantine = this.state.batchRecoveryQuarantine;
      if (options.clearSingleCheckpoints) this.state.checkpoints = {};
      this.state.batchRecovery = null;
      this.state.batchRecoveryCorrupt = false;
      this.state.batchRecoveryQuarantine = null;
      try {
        await this.saveState();
      } catch {
        this.state.checkpoints = previousCheckpoints;
        this.state.batchRecovery = previousJournal;
        this.state.batchRecoveryCorrupt = previousCorrupt;
        this.state.batchRecoveryQuarantine = previousQuarantine;
        return { ok: false, message: "Recovery state was not cleared because local state could not be saved." };
      }
      return {
        ok: true,
        message: options.abandonUnresolved
          ? "Current notes were kept unchanged and the batch recovery lock was cleared."
          : "Recovery snapshots cleared.",
      };
    });
  }

  batchMarkdownFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  isBatchRecoveryLocked(): boolean {
    return this.state.batchRecoveryCorrupt
      || Boolean(this.state.batchRecovery && this.state.batchRecovery.phase !== "completed");
  }

  isBatchRecoveryOperationActive(): boolean {
    return this.batchRecoveryBusy;
  }

  isBatchFileOpen(notePath: string): boolean {
    return this.app.workspace.getLeavesOfType("markdown").some((leaf) => (
      leaf.view instanceof MarkdownView && leaf.view.file?.path === notePath
    ));
  }

  async readBatchFile(file: TFile): Promise<string> {
    if (this.isBatchFileOpen(file.path)) {
      throw new Error(`${file.path} is open in Obsidian. Close every batch target before scanning, applying, or recovering it.`);
    }
    return await this.app.vault.read(file);
  }

  async applyVaultBatch(
    batchId: string,
    profileId: string,
    edits: ApprovedVaultBatchEdit[],
  ): Promise<{
    outcomes: Map<string, "applied" | "stale" | "rolled-back" | "recovery-required" | "not-applied">;
    message: string;
  }> {
    return await this.runBatchMutation(async () => {
      const outcomes = new Map<string, "applied" | "stale" | "rolled-back" | "recovery-required" | "not-applied">();
      const profile = this.agents.find((item) => item.id === profileId);
      if (!profile) {
        for (const edit of edits) outcomes.set(edit.snapshot.notePath, "not-applied");
        return { outcomes, message: "The selected ACP profile changed. No batch write started." };
      }
      if (this.state.batchRecoveryCorrupt || (this.state.batchRecovery && this.state.batchRecovery.phase !== "completed")) {
        for (const edit of edits) outcomes.set(edit.snapshot.notePath, "recovery-required");
        return { outcomes, message: "Resolve the interrupted batch recovery state before applying another batch." };
      }

      const candidates = edits.map((edit) => edit.candidate);
      const proposalValidation = validateBatchProposals(
        edits.map((edit) => bindBatchProposal(edit.candidate, edit.afterText)),
        candidates,
        {
          maxFiles: this.state.settings.vaultBatchMaxFiles,
          maxProposals: this.state.settings.vaultBatchMaxFiles,
          maxFileCharacters: Math.min(120_000, this.state.settings.maxContextChars),
          maxTotalCharacters: MAX_BATCH_TOTAL_CHARACTERS,
        },
      );
      if (!proposalValidation.ok) {
        for (const edit of edits) outcomes.set(edit.snapshot.notePath, "not-applied");
        return {
          outcomes,
          message: `The reviewed batch failed host validation. No write started. ${proposalValidation.diagnostics.map((item) => item.message).join(" ")}`,
        };
      }

      const currentFiles: Array<{ path: string; content: string }> = [];
      try {
        for (const edit of edits) {
          const target = this.app.vault.getAbstractFileByPath(edit.snapshot.notePath);
          if (!(target instanceof TFile) || target.extension !== "md") continue;
          currentFiles.push({ path: target.path, content: await this.readBatchFile(target) });
        }
      } catch (error) {
        for (const edit of edits) outcomes.set(edit.snapshot.notePath, "not-applied");
        return {
          outcomes,
          message: error instanceof Error ? `${error.message} No write started.` : "A target could not be re-read. No write started.",
        };
      }
      const preflight = preflightBatchTransaction(proposalValidation.proposals, currentFiles);
      if (!preflight.ok) {
        const stalePaths = new Set(preflight.stale.map((item) => item.path.toLocaleLowerCase()));
        for (const edit of edits) {
          outcomes.set(
            edit.snapshot.notePath,
            stalePaths.has(edit.snapshot.notePath.toLocaleLowerCase()) ? "stale" : "not-applied",
          );
        }
        return {
          outcomes,
          message: `At least one reviewed note changed or disappeared. No write started. ${preflight.stale.map((item) => item.path).join(", ")}`,
        };
      }

      const now = Date.now();
      const proposedJournal: BatchRecoveryJournal = {
        schemaVersion: 1,
        id: batchId,
        createdAt: now,
        updatedAt: now,
        phase: "prepared",
        agentContextId: agentContextId(profile),
        entries: edits.map((edit) => ({
          path: edit.snapshot.notePath,
          scope: edit.snapshot.scope === "frontmatter" ? "frontmatter" : "body",
          from: edit.snapshot.from,
          beforeScope: edit.snapshot.originalScope,
          beforeFullHash: edit.snapshot.fullHash,
          afterScopeLength: edit.effectiveReplacement.length,
          afterFullHash: edit.afterHash,
          state: "pending",
        })),
      };
      const journal = hydrateBatchRecoveryJournal(proposedJournal, now);
      if (!journal) {
        for (const edit of edits) outcomes.set(edit.snapshot.notePath, "not-applied");
        return { outcomes, message: "The bounded recovery journal could not represent this batch. No write started." };
      }

      const previousBatchRecovery = this.state.batchRecovery;
      const previousBatchRecoveryCorrupt = this.state.batchRecoveryCorrupt;
      const previousBatchRecoveryQuarantine = this.state.batchRecoveryQuarantine;
      this.state.batchRecovery = journal;
      this.state.batchRecoveryCorrupt = false;
      this.state.batchRecoveryQuarantine = null;
      try {
        await this.saveState();
      } catch {
        this.state.batchRecovery = previousBatchRecovery;
        this.state.batchRecoveryCorrupt = previousBatchRecoveryCorrupt;
        this.state.batchRecoveryQuarantine = previousBatchRecoveryQuarantine;
        for (const edit of edits) outcomes.set(edit.snapshot.notePath, "not-applied");
        return { outcomes, message: "The recovery journal could not be saved. No write started." };
      }

      journal.phase = "applying";
      journal.updatedAt = Date.now();
      const editByPath = new Map(edits.map((edit) => [edit.snapshot.notePath, edit]));
      let failure: unknown = null;
      try {
        await this.saveState();
        for (const entry of journal.entries) {
          const edit = editByPath.get(entry.path);
          const target = this.app.vault.getAbstractFileByPath(entry.path);
          if (!edit || !(target instanceof TFile) || target.extension !== "md") {
            throw new Error(`${entry.path} disappeared before its write.`);
          }
          if (this.isBatchFileOpen(entry.path)) {
            throw new Error(`${entry.path} was opened after batch preflight.`);
          }
          await this.app.vault.process(target, (current) => {
            if (this.isBatchFileOpen(entry.path)) {
              throw new Error(`${entry.path} was opened during the batch write.`);
            }
            if (current !== edit.snapshot.fullText || current !== edit.candidate.content) {
              throw new Error(`${entry.path} changed during the batch write.`);
            }
            return edit.afterText;
          });
          entry.state = "written";
          journal.updatedAt = Date.now();
          await this.saveState();
        }
      } catch (error) {
        failure = error;
      }

      if (!failure) {
        journal.phase = "completed";
        journal.updatedAt = Date.now();
        try {
          await this.saveState();
        } catch (error) {
          failure = error;
        }
      }
      if (!failure) {
        for (const edit of edits) outcomes.set(edit.snapshot.notePath, "applied");
        return {
          outcomes,
          message: `${edits.length} reviewed edits applied. Use the command "Review and undo last vault batch" while those notes remain unchanged.`,
        };
      }

      let recoveryRequired = false;
      for (const entry of journal.entries) {
        const target = this.app.vault.getAbstractFileByPath(entry.path);
        if (!(target instanceof TFile) || target.extension !== "md") {
          entry.state = "conflict";
          recoveryRequired = true;
          continue;
        }
        try {
          const current = await this.app.vault.read(target);
          const classification = classifyBatchRecoveryEntry(entry, current).classification;
          if (classification === "after") entry.state = "written";
          else if (classification === "before") entry.state = "rolled_back";
          else {
            entry.state = "conflict";
            recoveryRequired = true;
          }
        } catch {
          entry.state = "conflict";
          recoveryRequired = true;
        }
      }
      journal.phase = "rolling_back";
      journal.updatedAt = Date.now();
      try {
        await this.saveState();
      } catch {
        // The prepared journal was already persisted and remains sufficient for startup reconciliation.
      }
      for (const entry of [...journal.entries].reverse()) {
        if (entry.state !== "written") continue;
        const target = this.app.vault.getAbstractFileByPath(entry.path);
        if (!(target instanceof TFile) || target.extension !== "md") {
          entry.state = "conflict";
          recoveryRequired = true;
          continue;
        }
        if (this.isBatchFileOpen(entry.path)) {
          entry.state = "conflict";
          recoveryRequired = true;
          continue;
        }
        try {
          await this.app.vault.process(target, (current) => {
            if (this.isBatchFileOpen(entry.path)) {
              throw new Error(`${entry.path} was opened during automatic rollback.`);
            }
            const restore = prepareBatchRecoveryRestore(entry, current);
            if (!restore.ok) throw new Error(`${entry.path} no longer matches the applied batch text.`);
            return restore.restoredText;
          });
          entry.state = "rolled_back";
        } catch {
          entry.state = "conflict";
          recoveryRequired = true;
        }
        journal.updatedAt = Date.now();
        try {
          await this.saveState();
        } catch {
          recoveryRequired = true;
        }
      }

      if (recoveryRequired) {
        journal.phase = "recovery_required";
        journal.updatedAt = Date.now();
        const entryByPath = new Map(journal.entries.map((entry) => [entry.path, entry]));
        for (const edit of edits) {
          outcomes.set(
            edit.snapshot.notePath,
            entryByPath.get(edit.snapshot.notePath)?.state === "rolled_back"
              ? "rolled-back"
              : "recovery-required",
          );
        }
        try {
          await this.saveState();
        } catch {
          // Keep the already-persisted prepared journal and the in-memory conflict state.
        }
        return {
          outcomes,
          message: `The batch did not finish. ${[...outcomes.values()].filter((value) => value === "rolled-back").length} edits were safely rolled back; ${[...outcomes.values()].filter((value) => value === "recovery-required").length} require recovery review. No divergent note was overwritten.`,
        };
      }

      this.state.batchRecovery = null;
      this.state.batchRecoveryCorrupt = false;
      this.state.batchRecoveryQuarantine = null;
      try {
        await this.saveState();
      } catch {
        this.state.batchRecovery = journal;
      }
      for (const edit of edits) outcomes.set(edit.snapshot.notePath, "rolled-back");
      return {
        outcomes,
        message: "The batch did not finish. Every completed write was safely rolled back; no reviewed edit remains applied.",
      };
    });
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

  private async reconcileInterruptedBatch(): Promise<void> {
    await this.runBatchMutation(async () => await this.reconcileInterruptedBatchUnlocked());
  }

  private async reconcileInterruptedBatchUnlocked(): Promise<void> {
    if (this.state.batchRecoveryCorrupt) {
      new Notice("Batch recovery metadata is damaged. Agent Change Gate will block plugin writes until you explicitly keep the current vault state in settings.", 10_000);
      return;
    }
    const journal = this.state.batchRecovery;
    if (!journal || journal.phase === "completed") return;
    let hasApplied = false;
    let hasConflict = false;
    for (const entry of journal.entries) {
      const target = this.app.vault.getAbstractFileByPath(entry.path);
      if (!(target instanceof TFile) || target.extension !== "md") {
        entry.state = "conflict";
        hasConflict = true;
        continue;
      }
      try {
        const current = await this.app.vault.read(target);
        const { classification } = classifyBatchRecoveryEntry(entry, current);
        if (classification === "after") {
          entry.state = "written";
          hasApplied = true;
        } else if (classification === "before") {
          entry.state = "rolled_back";
        } else {
          entry.state = "conflict";
          hasConflict = true;
        }
      } catch {
        entry.state = "conflict";
        hasConflict = true;
      }
    }
    if (!hasApplied && !hasConflict) {
      this.state.batchRecovery = null;
      this.state.batchRecoveryCorrupt = false;
      this.state.batchRecoveryQuarantine = null;
      await this.saveState();
      new Notice("An interrupted vault batch had no remaining applied edits. Its recovery journal was cleared.");
      return;
    }
    journal.phase = "recovery_required";
    journal.updatedAt = Date.now();
    try {
      await this.saveState();
    } catch {
      // Keep the in-memory recovery gate active even if the status refresh cannot be persisted.
    }
    new Notice("An interrupted vault batch needs recovery review. Agent Change Gate will block further plugin writes until it is resolved.", 10_000);
  }

  private async undoVaultBatch(): Promise<void> {
    const journal = this.state.batchRecovery;
    if (!journal) return;
    const openTargets = journal.entries
      .filter((entry) => this.isBatchFileOpen(entry.path))
      .map((entry) => entry.path);
    if (openTargets.length > 0) {
      new Notice(`Close these Markdown views before batch undo: ${openTargets.join(", ")}`);
      return;
    }
    const pathPreview = journal.entries.slice(0, 5).map((entry) => entry.path).join(", ");
    const extra = journal.entries.length > 5 ? ` and ${journal.entries.length - 5} more` : "";
    const accepted = await new ConfirmModal(
      this.app,
      `Undo ${journal.entries.length} vault batch edits?`,
      `Only exact, unchanged batch results can be restored. Targets: ${pathPreview}${extra}. If any note diverged, no undo write will start.`,
      `Undo ${journal.entries.length} edits`,
    ).waitForDecision();
    if (!accepted) return;

    await this.runBatchMutation(async () => {
      if (this.state.batchRecovery?.id !== journal.id || this.state.batchRecoveryCorrupt) {
        new Notice("The batch recovery state changed while the undo confirmation was open. No undo write started.");
        return;
      }
      const restores = new Map<string, string>();
      const alreadyBefore = new Set<string>();
      for (const entry of journal.entries) {
        const target = this.app.vault.getAbstractFileByPath(entry.path);
        if (!(target instanceof TFile) || target.extension !== "md") {
          new Notice(`${entry.path} is missing. No batch undo write started.`);
          return;
        }
        const current = await this.readBatchFile(target);
        const classification = classifyBatchRecoveryEntry(entry, current).classification;
        if (classification === "before") {
          alreadyBefore.add(entry.path);
          continue;
        }
        const restore = prepareBatchRecoveryRestore(entry, current);
        if (!restore.ok) {
          new Notice(`${entry.path} changed after the batch. No batch undo write started.`);
          return;
        }
        restores.set(entry.path, restore.restoredText);
      }

      journal.phase = "rolling_back";
      journal.updatedAt = Date.now();
      await this.saveState();
      let failed = false;
      for (const entry of [...journal.entries].reverse()) {
        if (alreadyBefore.has(entry.path)) {
          entry.state = "rolled_back";
          continue;
        }
        const target = this.app.vault.getAbstractFileByPath(entry.path);
        const restoredText = restores.get(entry.path);
        if (!(target instanceof TFile) || restoredText === undefined) {
          entry.state = "conflict";
          failed = true;
          break;
        }
        try {
          if (this.isBatchFileOpen(entry.path)) {
            entry.state = "conflict";
            failed = true;
            break;
          }
          await this.app.vault.process(target, (current) => {
            if (this.isBatchFileOpen(entry.path)) {
              throw new Error("The note was opened during batch undo.");
            }
            const restore = prepareBatchRecoveryRestore(entry, current);
            if (!restore.ok || restore.restoredText !== restoredText) {
              throw new Error("The note changed during batch undo.");
            }
            return restore.restoredText;
          });
          entry.state = "rolled_back";
          journal.updatedAt = Date.now();
          await this.saveState();
        } catch {
          entry.state = "conflict";
          failed = true;
          break;
        }
      }
      if (failed) {
        journal.phase = "recovery_required";
        journal.updatedAt = Date.now();
        try {
          await this.saveState();
        } catch {
          // The earlier completed journal remains the persisted recovery proof.
        }
        new Notice("Batch undo stopped after a conflict. Divergent notes were not overwritten; recovery review is required.", 10_000);
        return;
      }
      if (this.state.batchRecovery?.id !== journal.id) {
        journal.phase = "recovery_required";
        new Notice("The recovery state changed during undo. The current recovery proof was left in place.");
        return;
      }
      this.state.batchRecovery = null;
      this.state.batchRecoveryCorrupt = false;
      this.state.batchRecoveryQuarantine = null;
      await this.saveState();
      new Notice("Last Agent Change Gate vault batch undone.");
    });
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
