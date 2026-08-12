import { randomUUID } from "node:crypto";

import {
  ButtonComponent,
  Modal,
  Notice,
  parseYaml,
  Setting,
  type TFile,
} from "obsidian";

import { agentContextId } from "../core/agent-identity";
import {
  bindBatchProposal,
  DEFAULT_BATCH_EXCLUDED_PREFIXES,
  MAX_BATCH_FILE_CHARACTERS,
  MAX_BATCH_TOTAL_CHARACTERS,
  normalizeVaultBatchPath,
  selectBatchCandidates,
  validateBatchProposals,
  type BatchCandidate,
} from "../core/batch";
import { appendAuditRecord, createAuditRecord, updateAuditOutcome } from "../core/audit";
import {
  canBeginVaultBatchRun,
  decideVaultBatchClose,
  sameVaultBatchSetup,
  vaultBatchTurnBlockReason,
  type VaultBatchCloseDecision,
  type VaultBatchSetupIdentity,
} from "../core/batch-close";
import { diffLines } from "../core/diff";
import { classifyAcpError } from "../core/errors";
import { instructionError } from "../core/input";
import { buildAgentPrompt, parseAgentReply } from "../core/protocol";
import {
  applyReplacement,
  captureScope,
  hashText,
  isSnapshotCurrent,
  replacementForSnapshot,
} from "../core/scope";
import { validateReplacement } from "../core/safety";
import type { AgentProfile, ScopeSnapshot } from "../core/types";
import { AcpTurnCancelledError } from "../hermes/acp-client";
import type BoundedNoteChatPlugin from "../main";
import { ConfirmModal } from "./confirm-modal";
import { DiffModal } from "./diff-modal";

type BatchScope = "body" | "frontmatter";
type BatchItemStatus =
  | "queued"
  | "generating"
  | "ready"
  | "approved"
  | "rejected"
  | "skipped"
  | "blocked"
  | "failed"
  | "stale"
  | "cancelled"
  | "applied"
  | "rolled-back"
  | "recovery-required"
  | "not-applied";

export interface ApprovedVaultBatchEdit {
  snapshot: ScopeSnapshot;
  candidate: BatchCandidate;
  effectiveReplacement: string;
  afterText: string;
  afterHash: string;
  auditId: string;
}

interface BatchItem {
  snapshot: ScopeSnapshot;
  candidate: BatchCandidate;
  status: BatchItemStatus;
  statusDetail?: string;
  message?: string;
  summary?: string;
  agentWarnings: string[];
  gateWarnings: string[];
  effectiveReplacement?: string;
  afterText?: string;
  afterHash?: string;
  auditId?: string;
}

interface PreparedSelection {
  items: BatchItem[];
  scopeCharacters: number;
  skipped: Array<{ path: string; reason: string }>;
}

const EMPTY_HISTORY_HASH = hashText(JSON.stringify([]));
const MAX_VISIBLE_PATHS = 500;

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function pathInFolder(path: string, folder: string, includeSubfolders: boolean): boolean {
  const parent = folderOf(path);
  if (includeSubfolders) return folder === "" || parent === folder || parent.startsWith(`${folder}/`);
  return parent === folder;
}

function isProtectedBatchPath(path: string): boolean {
  const identity = path.toLowerCase();
  return DEFAULT_BATCH_EXCLUDED_PREFIXES.some((prefix) => {
    const protectedIdentity = prefix.toLowerCase();
    return identity === protectedIdentity || identity.startsWith(`${protectedIdentity}/`);
  });
}

function statusLabel(status: BatchItemStatus): string {
  const labels: Record<BatchItemStatus, string> = {
    queued: "Queued",
    generating: "Generating",
    ready: "Ready to review",
    approved: "Approved",
    rejected: "Rejected",
    skipped: "No edit proposed",
    blocked: "Blocked",
    failed: "Failed",
    stale: "Stale",
    cancelled: "Cancelled",
    applied: "Applied",
    "rolled-back": "Rolled back",
    "recovery-required": "Recovery required",
    "not-applied": "Not applied",
  };
  return labels[status];
}

export class VaultBatchModal extends Modal {
  private selectedAgent = "";
  private selectedFolder = "";
  private includeSubfolders = false;
  private batchScope: BatchScope = "body";
  private search = "";
  private selectedPaths = new Set<string>();
  private instructionEl: HTMLTextAreaElement | null = null;
  private prepareButton: ButtonComponent | null = null;
  private candidateListEl: HTMLElement | null = null;
  private candidateSummaryEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private liveStatusEl: HTMLElement | null = null;
  private items: BatchItem[] = [];
  private preparing = false;
  private generating = false;
  private applying = false;
  private closed = false;
  private cancelRequested = false;
  private activeRequest: { profileId: string; threadKey: string } | null = null;
  private batchId = "";
  private closeRequestActive = false;
  private closeApproved = false;
  private batchRunToken: symbol | null = null;
  private liveStatusText = "";
  private batchResultMessage: string | null = null;
  private generatedAgent: { profileId: string; contextId: string } | null = null;

  constructor(private readonly plugin: BoundedNoteChatPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.closed = false;
    this.closeApproved = false;
    this.closeRequestActive = false;
    this.modalEl.addClass("agent-change-gate-batch-modal");
    this.liveStatusEl = this.modalEl.createDiv({
      cls: "visually-hidden agent-change-gate-batch-live-status",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
      text: this.liveStatusText,
    });
    if (this.plugin.isBatchRecoveryLocked()) {
      this.contentEl.createEl("h2", { text: "Vault batch review is locked" });
      this.contentEl.createEl("p", {
        text: "Resolve or explicitly abandon the existing batch recovery state in Agent Change Gate settings before generating more billed drafts.",
      });
      new ButtonComponent(this.contentEl).setButtonText("Close").onClick(() => this.requestUserClose());
      return;
    }
    this.selectedAgent = this.plugin.state.settings.defaultAgent;
    const activePath = this.app.workspace.getActiveFile()?.path;
    this.selectedFolder = activePath ? folderOf(activePath) : "";
    this.renderSetup();
  }

  override onClose(): void {
    this.closed = true;
    this.cancelRequested = true;
    this.batchRunToken = null;
    if (this.activeRequest) {
      void this.plugin.acpPool.cancel(this.activeRequest.profileId, this.activeRequest.threadKey);
    }
    for (const item of this.items) {
      if (item.auditId && (item.status === "ready" || item.status === "approved")) {
        updateAuditOutcome(this.plugin.state.auditLog, item.auditId, "discarded");
      }
    }
    void this.plugin.saveState().catch(() => {
      new Notice("Batch receipt metadata could not be saved while closing the review.");
    });
    this.liveStatusEl?.remove();
    this.liveStatusEl = null;
    this.contentEl.empty();
  }

  override close(): void {
    if (this.closeApproved) {
      super.close();
      return;
    }
    if (!this.closed) this.requestUserClose();
  }

  private requestUserClose(): void {
    if (this.closed || this.closeRequestActive) return;
    void this.resolveCloseRequest();
  }

  private closeDecision(): VaultBatchCloseDecision {
    const discardableDrafts = this.items.filter((item) => (
      item.status === "ready" || item.status === "approved"
    )).length;
    return decideVaultBatchClose({
      applying: this.applying,
      generating: this.generating,
      discardableDrafts,
    });
  }

  private finishClose(): void {
    this.closeApproved = true;
    super.close();
  }

  private async resolveCloseRequest(): Promise<void> {
    const decision = this.closeDecision();
    if (decision === "block_applying") {
      new Notice("Wait for the active batch write and recovery checks to finish. This review cannot close while notes may be changing.");
      return;
    }
    if (decision === "close") {
      this.finishClose();
      return;
    }

    this.closeRequestActive = true;
    try {
      const discardableDrafts = this.items.filter((item) => (
        item.status === "ready" || item.status === "approved"
      )).length;
      const cancelling = decision === "confirm_cancel_generation";
      const accepted = await new ConfirmModal(
        this.app,
        cancelling ? "Stop batch generation and close?" : `Discard ${discardableDrafts} unapplied drafts?`,
        cancelling
          ? `Agent Change Gate will request cancellation of the active ACP turn and permanently discard any drafts already generated in this review${discardableDrafts > 0 ? ` (${discardableDrafts} currently unapplied)` : ""}. No note changes have started.`
          : `Closing now permanently discards ${discardableDrafts} generated or reviewed drafts that have not been applied. No notes will change.`,
        cancelling ? "Stop and close" : "Discard drafts and close",
      ).waitForDecision();
      if (!accepted || this.closed) return;

      const currentDecision = this.closeDecision();
      if (currentDecision === "block_applying") {
        new Notice("The batch started applying while close confirmation was open. Wait for the write and recovery checks to finish.");
        return;
      }
      if (currentDecision === "confirm_cancel_generation") {
        this.cancelRequested = true;
        this.renderProgress();
        const request = this.activeRequest;
        if (request) {
          try {
            await this.plugin.acpPool.cancel(request.profileId, request.threadKey);
          } catch {
            new Notice("The active ACP turn did not acknowledge cancellation. The review will close and no draft from that turn will be applied.");
          }
        }
      }
      this.finishClose();
    } finally {
      this.closeRequestActive = false;
    }
  }

  private renderSetup(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Vault batch review (experimental)" });
    const boundary = contentEl.createDiv({ cls: "bounded-note-chat-boundary" });
    boundary.createEl("strong", { text: "Batch review" });
    boundary.createSpan({
      text: "The agent receives one selected note at a time and no client filesystem capability. Every draft must be reviewed before this plugin writes it.",
    });

    const agentSetting = new Setting(contentEl).setName("ACP agent");
    agentSetting.addDropdown((dropdown) => {
      if (this.plugin.agents.length === 0) dropdown.addOption("", "No ACP agents ready");
      for (const profile of this.plugin.agents) dropdown.addOption(profile.id, profile.label);
      if (!this.plugin.agents.some((profile) => profile.id === this.selectedAgent)) {
        this.selectedAgent = this.plugin.agents[0]?.id ?? "";
      }
      dropdown.setValue(this.selectedAgent).onChange((value) => {
        this.selectedAgent = value;
      });
    });

    const folders = new Set<string>([""]);
    for (const file of this.plugin.batchMarkdownFiles()) {
      if (isProtectedBatchPath(file.path)) continue;
      let folder = folderOf(file.path);
      while (folder) {
        folders.add(folder);
        folder = folderOf(folder);
      }
    }
    new Setting(contentEl)
      .setName("Folder")
      .setDesc("Vault root or one existing Markdown folder.")
      .addDropdown((dropdown) => {
        for (const folder of [...folders].sort((left, right) => left.localeCompare(right))) {
          dropdown.addOption(folder, folder || "Vault root");
        }
        if (!folders.has(this.selectedFolder)) this.selectedFolder = "";
        dropdown.setValue(this.selectedFolder).onChange((value) => {
          this.selectedFolder = value;
          this.selectedPaths.clear();
          this.renderCandidateList();
        });
      });

    new Setting(contentEl)
      .setName("Include subfolders")
      .setDesc("Off by default so a folder selection stays narrow.")
      .addToggle((toggle) => toggle.setValue(this.includeSubfolders).onChange((value) => {
        this.includeSubfolders = value;
        this.selectedPaths.clear();
        this.renderCandidateList();
      }));

    new Setting(contentEl)
      .setName("Scope in each note")
      .setDesc("Body preserves YAML frontmatter. Frontmatter requires an existing complete YAML block.")
      .addDropdown((dropdown) => dropdown
        .addOption("body", "Note body")
        .addOption("frontmatter", "YAML frontmatter")
        .setValue(this.batchScope)
        .onChange((value) => {
          this.batchScope = value === "frontmatter" ? "frontmatter" : "body";
        }));

    new Setting(contentEl)
      .setName("Filter paths")
      .addSearch((search) => search
        .setPlaceholder("Projects/ or a note name")
        .setValue(this.search)
        .onChange((value) => {
          this.search = value;
          this.renderCandidateList();
        }));

    const selectionActions = contentEl.createDiv({ cls: "bounded-note-chat-diff-actions" });
    new ButtonComponent(selectionActions)
      .setButtonText(`Select visible (up to ${this.plugin.state.settings.vaultBatchMaxFiles})`)
      .onClick(() => {
        const visible = this.visibleFiles()
          .filter((file) => !this.plugin.isBatchFileOpen(file.path))
          .slice(0, this.plugin.state.settings.vaultBatchMaxFiles);
        this.selectedPaths = new Set(visible.map((file) => file.path));
        this.renderCandidateList();
      });
    new ButtonComponent(selectionActions)
      .setButtonText("Clear selection")
      .onClick(() => {
        this.selectedPaths.clear();
        this.renderCandidateList();
      });

    this.candidateSummaryEl = contentEl.createDiv({ cls: "bounded-note-chat-scope-receipt" });
    this.candidateSummaryEl.setAttribute("role", "status");
    this.candidateSummaryEl.setAttribute("aria-live", "polite");
    this.candidateListEl = contentEl.createDiv({ cls: "agent-change-gate-batch-files" });
    this.renderCandidateList();

    new Setting(contentEl).setName("Batch instruction").setHeading();
    this.instructionEl = contentEl.createEl("textarea", {
      cls: "agent-change-gate-batch-instruction",
      attr: {
        "aria-label": "Instruction repeated for each selected note",
        placeholder: "Describe the same bounded edit to propose for every selected note.",
      },
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "The instruction is sent separately with each note. Batch history is always off. No note changes during draft generation.",
    });

    const actions = contentEl.createDiv({ cls: "bounded-note-chat-diff-actions" });
    this.prepareButton = new ButtonComponent(actions)
      .setButtonText("Prepare selected notes")
      .setCta()
      .onClick(() => void this.prepareAndGenerate());
    new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.requestUserClose());
  }

  private visibleFiles(): TFile[] {
    const query = this.search.trim().toLowerCase();
    return this.plugin.batchMarkdownFiles()
      .filter((file) => normalizeVaultBatchPath(file.path) === file.path)
      .filter((file) => !isProtectedBatchPath(file.path))
      .filter((file) => pathInFolder(file.path, this.selectedFolder, this.includeSubfolders))
      .filter((file) => !query || file.path.toLowerCase().includes(query))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private renderCandidateList(): void {
    const container = this.candidateListEl;
    if (!container) return;
    container.empty();
    const visible = this.visibleFiles();
    const rendered = visible.slice(0, MAX_VISIBLE_PATHS);
    for (const file of rendered) {
      const row = container.createEl("label", { cls: "agent-change-gate-batch-file" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedPaths.has(file.path);
      const isOpen = this.plugin.isBatchFileOpen(file.path);
      checkbox.disabled = isOpen || (!checkbox.checked
        && this.selectedPaths.size >= this.plugin.state.settings.vaultBatchMaxFiles);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedPaths.add(file.path);
        else this.selectedPaths.delete(file.path);
        this.renderCandidateList();
      });
      row.createSpan({ text: isOpen ? `${file.path} (open - close before batch)` : file.path });
    }
    if (visible.length > rendered.length) {
      container.createEl("p", {
        cls: "setting-item-description",
        text: `${(visible.length - rendered.length).toLocaleString()} more paths are hidden. Narrow the path filter.`,
      });
    }
    const visiblePaths = new Set(visible.map((file) => file.path));
    const hiddenSelected = [...this.selectedPaths]
      .filter((path) => !visiblePaths.has(path))
      .sort((left, right) => left.localeCompare(right));
    this.candidateSummaryEl?.setText(
      `${this.selectedPaths.size.toLocaleString()} selected / ${visible.length.toLocaleString()} visible; hard limit 20 files`
      + (hiddenSelected.length > 0
        ? ` · ${hiddenSelected.length.toLocaleString()} selected outside this filter: ${hiddenSelected.join(", ")}`
        : ""),
    );
  }

  private async prepareAndGenerate(): Promise<void> {
    if (!canBeginVaultBatchRun({
      preparing: this.preparing,
      generating: this.generating,
      applying: this.applying,
      closed: this.closed,
    })) return;
    const runToken = Symbol("vault-batch-run");
    this.batchRunToken = runToken;
    this.preparing = true;
    this.cancelRequested = false;
    this.prepareButton?.setDisabled(true).setButtonText("Preparing…");
    try {
      if (this.plugin.isBatchRecoveryLocked()) {
        new Notice("Resolve the existing batch recovery state before generating another batch.");
        return;
      }
      const instruction = this.instructionEl?.value.trim() ?? "";
      const instructionProblem = instructionError(instruction);
      if (instructionProblem) {
        new Notice(instructionProblem);
        return;
      }
      const profile = this.plugin.agents.find((item) => item.id === this.selectedAgent);
      if (!profile) {
        new Notice("Choose a ready ACP agent first.");
        return;
      }
      if (this.selectedPaths.size === 0) {
        new Notice("Select at least one Markdown note.");
        return;
      }
      if (this.selectedPaths.size > this.plugin.state.settings.vaultBatchMaxFiles) {
        new Notice("The selection exceeds the configured batch file limit.");
        return;
      }
      const expectedAgentContextId = agentContextId(profile);
      const setup: VaultBatchSetupIdentity = {
        agentContextId: expectedAgentContextId,
        instruction,
        paths: [...this.selectedPaths].sort((left, right) => left.localeCompare(right)),
        scope: this.batchScope,
      };

      let prepared: PreparedSelection;
      try {
        prepared = await this.prepareSelection([...setup.paths], setup.scope);
      } catch (error) {
        new Notice("The batch selection could not be prepared. Close selected Markdown views, verify the notes and configured limits, then try again. No model turn was started.");
        return;
      }
      if (!this.isCurrentBatchRun(runToken)) return;
      if (!this.sameCurrentSetup(setup)) {
        new Notice("The agent, scope, instruction, or selected paths changed during preparation. No model turn was started.");
        return;
      }
      if (prepared.items.length === 0) {
        new Notice("No selected note has an eligible scope.");
        return;
      }
      const accepted = await new ConfirmModal(
        this.app,
        `Generate drafts for ${prepared.items.length} notes?`,
        `Agent: ${profile.label}. Scope: ${setup.scope}. Agent Change Gate will send ${prepared.scopeCharacters.toLocaleString()} scope characters from ${prepared.items.length} notes in ${prepared.items.length} separate ACP turns. Paths: ${prepared.items.map((item) => item.snapshot.notePath).join(", ")}.${prepared.skipped.length > 0 ? ` Not sent: ${prepared.skipped.map((item) => `${item.path} (${item.reason})`).join(", ")}.` : ""} The agent or model provider may retain content and charge for use. No note will change yet.`,
        `Generate ${prepared.items.length} drafts`,
      ).waitForDecision();
      if (!accepted || !this.isCurrentBatchRun(runToken)) return;
      if (!this.sameCurrentSetup(setup)) {
        new Notice("The agent, scope, instruction, or selected paths changed while confirmation was open. No model turn was started.");
        return;
      }

      const currentProfile = this.plugin.agents.find((item) => item.id === profile.id);
      if (!currentProfile || agentContextId(currentProfile) !== expectedAgentContextId) {
        new Notice("The selected ACP agent changed during batch preparation. No model turn was started.");
        return;
      }
      if (this.plugin.isBatchRecoveryLocked()) {
        new Notice("Batch recovery became locked during preparation. No model turn was started.");
        return;
      }

      this.items = prepared.items;
      this.batchId = randomUUID();
      this.generatedAgent = { profileId: currentProfile.id, contextId: expectedAgentContextId };
      this.batchResultMessage = null;
      this.announceStatus(`Starting ${prepared.items.length} separate draft turns.`);
      this.preparing = false;
      this.generating = true;
      this.renderProgress();
      await this.generateDrafts(currentProfile, instruction, setup.scope, runToken, expectedAgentContextId);
    } finally {
      if (this.batchRunToken === runToken) {
        this.batchRunToken = null;
        this.generating = false;
        this.activeRequest = null;
      }
      this.preparing = false;
      this.prepareButton?.setDisabled(false).setButtonText("Prepare selected notes");
    }
  }

  private isCurrentBatchRun(runToken: symbol): boolean {
    return this.batchRunToken === runToken && !this.cancelRequested && !this.closed;
  }

  private sameCurrentSetup(expected: Readonly<VaultBatchSetupIdentity>): boolean {
    const currentProfile = this.plugin.agents.find((profile) => profile.id === this.selectedAgent);
    return sameVaultBatchSetup(expected, {
      agentContextId: currentProfile ? agentContextId(currentProfile) : null,
      instruction: this.instructionEl?.value.trim() ?? "",
      paths: [...this.selectedPaths].sort((left, right) => left.localeCompare(right)),
      scope: this.batchScope,
    });
  }

  private async prepareSelection(paths: string[], scope: BatchScope): Promise<PreparedSelection> {
    const files: Array<{ file: TFile; content: string }> = [];
    for (const path of paths.sort((left, right) => left.localeCompare(right))) {
      const file = this.plugin.batchMarkdownFiles().find((item) => item.path === path);
      if (!file) throw new Error(`${path} no longer exists as a Markdown note.`);
      const content = await this.plugin.readBatchFile(file);
      files.push({ file, content });
    }

    const selection = selectBatchCandidates(
      files.map(({ file, content }) => ({ path: file.path, content })),
      {
        limits: {
          maxFiles: this.plugin.state.settings.vaultBatchMaxFiles,
          maxFileCharacters: Math.min(
            MAX_BATCH_FILE_CHARACTERS,
            this.plugin.state.settings.maxContextChars,
          ),
          maxTotalCharacters: Math.min(
            MAX_BATCH_TOTAL_CHARACTERS,
            this.plugin.state.settings.vaultBatchMaxTotalChars,
          ),
          maxProposals: this.plugin.state.settings.vaultBatchMaxFiles,
        },
      },
    );
    if (!selection.ok) {
      throw new Error(selection.diagnostics.map((item) => item.path ? `${item.path}: ${item.message}` : item.message).join(" "));
    }

    const fileByPath = new Map(files.map(({ file }) => [file.path, file]));
    const items: BatchItem[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let scopeCharacters = 0;
    for (const candidate of selection.candidates) {
      const file = fileByPath.get(candidate.path);
      if (!file) continue;
      let snapshot: ScopeSnapshot;
      try {
        snapshot = captureScope(file.path, candidate.content, scope);
      } catch (error) {
        if (scope === "frontmatter") {
          skipped.push({ path: file.path, reason: "no complete YAML frontmatter" });
          continue;
        }
        throw error;
      }
      if (snapshot.originalScope.length > this.plugin.state.settings.maxContextChars) {
        throw new Error(`${file.path} exceeds the per-note context limit.`);
      }
      scopeCharacters += snapshot.originalScope.length;
      items.push({
        snapshot,
        candidate,
        status: "queued",
        agentWarnings: [],
        gateWarnings: [],
      });
    }
    if (scopeCharacters > this.plugin.state.settings.vaultBatchMaxTotalChars) {
      throw new Error(`The selected scopes contain ${scopeCharacters.toLocaleString()} characters; the batch limit is ${this.plugin.state.settings.vaultBatchMaxTotalChars.toLocaleString()}.`);
    }
    return { items, scopeCharacters, skipped };
  }

  private async generateDrafts(
    profile: AgentProfile,
    instruction: string,
    scope: BatchScope,
    runToken: symbol,
    expectedAgentContextId: string,
  ): Promise<void> {
    let consecutiveFailures = 0;
    try {
      for (let index = 0; index < this.items.length; index += 1) {
        const item = this.items[index];
        if (!item) continue;
        if (!this.isCurrentBatchRun(runToken)) {
          item.status = "cancelled";
          continue;
        }
        item.status = "generating";
        this.renderProgress();
        const threadKey = `vault-batch:${this.batchId}:${index}`;
        const notePath = item.snapshot.notePath;
        const auditRecord = createAuditRecord({
          agentId: expectedAgentContextId,
          notePath,
          scope: item.snapshot.scope,
          task: "edit",
          scopeChars: item.snapshot.originalScope.length,
          scopeHash: hashText(item.snapshot.originalScope),
          historyChars: 0,
          historyHash: EMPTY_HISTORY_HASH,
        });
        item.auditId = auditRecord.id;
        appendAuditRecord(this.plugin.state.auditLog, auditRecord);
        try {
          const currentFile = this.plugin.batchMarkdownFiles().find((file) => file.path === notePath);
          if (!currentFile) {
            item.status = "stale";
            item.statusDetail = "The note disappeared or moved before its turn was sent.";
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "stale");
            await this.plugin.saveState();
            continue;
          }
          const currentText = await this.plugin.readBatchFile(currentFile);
          if (!isSnapshotCurrent(item.snapshot, currentFile.path, currentText)) {
            item.status = "stale";
            item.statusDetail = "The note changed before its turn was sent.";
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "stale");
            await this.plugin.saveState();
            continue;
          }
          await this.plugin.saveState();
          const promptFile = this.plugin.batchMarkdownFiles().find((file) => file.path === notePath);
          if (!promptFile) {
            item.status = "stale";
            item.statusDetail = "The note disappeared or moved while request metadata was prepared.";
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "stale");
            continue;
          }
          const promptText = await this.plugin.readBatchFile(promptFile);
          if (!isSnapshotCurrent(item.snapshot, promptFile.path, promptText)) {
            item.status = "stale";
            item.statusDetail = "The note changed while request metadata was prepared.";
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "stale");
            continue;
          }
          const currentProfile = this.plugin.agents.find((candidate) => candidate.id === profile.id);
          const turnBlock = vaultBatchTurnBlockReason({
            expectedRunToken: runToken,
            currentRunToken: this.batchRunToken,
            cancelled: this.cancelRequested,
            closed: this.closed,
            recoveryLocked: this.plugin.isBatchRecoveryLocked(),
            expectedAgentContextId,
            currentAgentContextId: currentProfile ? agentContextId(currentProfile) : null,
          });
          if (turnBlock === "cancelled") throw new AcpTurnCancelledError();
          if (turnBlock === "recovery_locked") {
            this.cancelRequested = true;
            item.status = "failed";
            item.statusDetail = "Batch recovery became locked before this model turn. No further turn was started.";
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "error");
            continue;
          }
          if (turnBlock === "agent_changed" || !currentProfile) {
            this.cancelRequested = true;
            throw new AcpTurnCancelledError("The ACP agent changed before this model turn was started.");
          }
          this.activeRequest = { profileId: currentProfile.id, threadKey };
          const raw = await this.plugin.acpPool.prompt(
            currentProfile,
            threadKey,
            buildAgentPrompt({
              task: "edit",
              instruction,
              notePath,
              scope,
              noteContent: item.snapshot.originalScope,
              priorMessages: [],
            }),
            {
              timeoutMs: this.plugin.state.settings.promptTimeoutMs,
              onStatus: (status) => {
                item.statusDetail = status;
                this.announceStatus(`${notePath}: ${status}`);
              },
            },
          );
          if (!this.isCurrentBatchRun(runToken)) throw new AcpTurnCancelledError();
          const reply = parseAgentReply(raw, this.plugin.state.settings.maxContextChars, "edit");
          item.message = reply.message;
          if (reply.action !== "propose_edit" || reply.replacement === undefined) {
            item.status = "skipped";
            item.statusDetail = undefined;
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "replied");
            consecutiveFailures = 0;
            await this.plugin.saveState();
            this.renderProgress();
            continue;
          }
          const validation = validateReplacement(
            item.snapshot,
            reply.replacement,
            Math.min(MAX_BATCH_FILE_CHARACTERS, this.plugin.state.settings.maxContextChars),
            parseYaml,
          );
          if (!validation.ok) {
            item.status = "blocked";
            item.statusDetail = validation.errors.join(" ");
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "blocked");
            await this.plugin.saveState();
            this.renderProgress();
            continue;
          }
          const effectiveReplacement = replacementForSnapshot(item.snapshot, reply.replacement);
          const afterText = applyReplacement(item.snapshot, effectiveReplacement);
          const hostValidation = validateBatchProposals(
            [bindBatchProposal(item.candidate, afterText)],
            [item.candidate],
            {
              maxFiles: 1,
              maxProposals: 1,
              maxFileCharacters: Math.min(MAX_BATCH_FILE_CHARACTERS, this.plugin.state.settings.maxContextChars),
              maxTotalCharacters: MAX_BATCH_TOTAL_CHARACTERS,
            },
          );
          const render = diffLines(item.snapshot.originalScope, effectiveReplacement, {
            maxLines: 4_000,
            maxOperations: 4_000,
          });
          if (!hostValidation.ok || render.truncated) {
            item.status = "blocked";
            item.statusDetail = render.truncated
              ? "The complete diff exceeds the bounded review renderer."
              : hostValidation.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "blocked");
          } else {
            item.status = "ready";
            item.statusDetail = undefined;
            item.summary = reply.summary;
            item.agentWarnings = reply.warnings;
            item.gateWarnings = validation.warnings;
            item.effectiveReplacement = effectiveReplacement;
            item.afterText = afterText;
            item.afterHash = hashText(afterText);
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "proposed");
            consecutiveFailures = 0;
          }
        } catch (error) {
          const cancelled = this.cancelRequested || error instanceof AcpTurnCancelledError;
          const safeError = classifyAcpError(error, { phase: "turn" });
          item.status = cancelled ? "cancelled" : "failed";
          item.statusDetail = cancelled
            ? "Generation stopped before any edit was applied."
            : `${safeError.category} (${safeError.diagnosticCode}). ${safeError.nextAction}`;
          updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, cancelled ? "cancelled" : "error");
          if (!cancelled) consecutiveFailures += 1;
        } finally {
          this.activeRequest = null;
          try {
            await this.plugin.saveState();
          } catch {
            item.status = "failed";
            item.statusDetail = "The local metadata receipt could not be saved.";
            consecutiveFailures += 1;
          }
          this.renderProgress();
        }
        if (consecutiveFailures >= 3) {
          this.cancelRequested = true;
          for (const remaining of this.items.slice(index + 1)) remaining.status = "cancelled";
          new Notice("Batch generation stopped after three consecutive failures.");
          break;
        }
      }
    } finally {
      if (this.batchRunToken === runToken) {
        this.generating = false;
        this.activeRequest = null;
        this.batchRunToken = null;
        this.announceStatus(this.cancelRequested
          ? "Draft generation stopped. No edit was applied."
          : "Draft generation finished. Review every ready draft before applying.");
      }
      this.renderProgress();
    }
  }

  private announceStatus(message: string): void {
    this.liveStatusText = message;
    this.liveStatusEl?.setText(message);
  }

  private renderProgress(): void {
    if (this.closed) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Vault batch review" });
    const summary = contentEl.createEl("p", { cls: "agent-change-gate-diff-summary" });
    const ready = this.items.filter((item) => item.status === "ready").length;
    const approved = this.items.filter((item) => item.status === "approved").length;
    const settled = this.items.filter((item) => item.status !== "queued" && item.status !== "generating").length;
    summary.setText(`${settled} of ${this.items.length} generated or settled; ${ready} awaiting review; ${approved} approved.`);
    if (this.batchResultMessage) {
      contentEl.createDiv({
        cls: "agent-change-gate-batch-result",
        attr: { role: "region", "aria-label": "Batch apply result" },
        text: this.batchResultMessage,
      });
    }
    this.progressEl = contentEl.createDiv({ cls: "agent-change-gate-batch-progress" });
    for (const item of this.items) this.renderProgressItem(this.progressEl, item);

    const actions = contentEl.createDiv({ cls: "bounded-note-chat-diff-actions" });
    if (this.generating) {
      new ButtonComponent(actions)
        .setButtonText(this.cancelRequested ? "Stopping..." : "Stop batch")
        .setWarning()
        .setDisabled(this.cancelRequested)
        .onClick(() => void this.stopGeneration());
    } else {
      const hasUnreviewed = this.items.some((item) => item.status === "ready");
      new ButtonComponent(actions)
        .setButtonText(`Apply ${approved} reviewed edits`)
        .setCta()
        .setDisabled(this.applying || approved === 0 || hasUnreviewed)
        .onClick(() => void this.applyApproved());
      new ButtonComponent(actions)
        .setButtonText("Close without applying")
        .setDisabled(this.applying)
        .onClick(() => this.requestUserClose());
    }
  }

  private renderProgressItem(container: HTMLElement, item: BatchItem): void {
    const row = container.createDiv({ cls: "agent-change-gate-batch-progress-item" });
    const text = row.createDiv();
    text.createEl("strong", { text: item.snapshot.notePath });
    text.createDiv({
      cls: `agent-change-gate-batch-status is-${item.status}`,
      text: item.statusDetail ? `${statusLabel(item.status)} - ${item.statusDetail}` : statusLabel(item.status),
    });
    if (item.message) text.createDiv({ cls: "setting-item-description", text: item.message });
    if (["ready", "approved", "rejected"].includes(item.status)) {
      new ButtonComponent(row)
        .setButtonText(item.status === "ready" ? "Review draft" : "Review again")
        .setDisabled(this.generating || this.applying)
        .onClick(() => void this.reviewItem(item));
    }
  }

  private async reviewItem(item: BatchItem): Promise<void> {
    if (!item.effectiveReplacement || !item.auditId || this.generating || this.applying) return;
    updateAuditOutcome(this.plugin.state.auditLog, item.auditId, "proposed");
    const approved = await new DiffModal(this.app, {
      title: `Review batch draft for ${item.snapshot.notePath}`,
      original: item.snapshot.originalScope,
      replacement: item.effectiveReplacement,
      agentSummary: item.summary,
      agentWarnings: item.agentWarnings,
      gateWarnings: item.gateWarnings,
      gateSummary: "This only marks the draft as reviewed. No note changes until the final batch confirmation.",
      acceptLabel: "Approve draft",
      rejectLabel: "Reject draft",
    }).waitForDecision();
    if (this.closed) {
      updateAuditOutcome(this.plugin.state.auditLog, item.auditId, "discarded");
      await this.plugin.saveState();
      return;
    }
    item.status = approved ? "approved" : "rejected";
    item.statusDetail = undefined;
    updateAuditOutcome(this.plugin.state.auditLog, item.auditId, approved ? "proposed" : "discarded");
    await this.plugin.saveState();
    this.renderProgress();
  }

  private async stopGeneration(): Promise<void> {
    if (!this.generating || this.cancelRequested) return;
    this.cancelRequested = true;
    this.announceStatus("Stopping draft generation. No edit has been applied.");
    const request = this.activeRequest;
    if (request) await this.plugin.acpPool.cancel(request.profileId, request.threadKey);
    this.renderProgress();
  }

  private async applyApproved(): Promise<void> {
    if (this.generating || this.applying || this.items.some((item) => item.status === "ready")) return;
    const edits: ApprovedVaultBatchEdit[] = [];
    for (const item of this.items) {
      if (item.status !== "approved") continue;
      if (!item.effectiveReplacement || !item.afterText || !item.afterHash || !item.auditId) return;
      edits.push({
        snapshot: item.snapshot,
        candidate: item.candidate,
        effectiveReplacement: item.effectiveReplacement,
        afterText: item.afterText,
        afterHash: item.afterHash,
        auditId: item.auditId,
      });
    }
    if (edits.length === 0) return;
    const generatedAgent = this.generatedAgent;
    if (!generatedAgent) {
      new Notice("The batch agent identity is unavailable. No write started.");
      return;
    }
    const accepted = await new ConfirmModal(
      this.app,
      `Apply ${edits.length} reviewed edits?`,
      `Agent Change Gate will write ${edits.length} Markdown notes. Multi-file writes are not one filesystem transaction. Every target is checked before the first write, and a bounded recovery journal enables best-effort rollback without overwriting later changes.${this.plugin.state.batchRecovery?.phase === "completed" ? " This replaces the undo journal for the previous completed batch." : ""}`,
      `Apply ${edits.length} reviewed edits`,
    ).waitForDecision();
    if (!accepted || this.closed) return;
    this.applying = true;
    this.batchResultMessage = null;
    this.announceStatus(`Applying ${edits.length} reviewed edits with guarded recovery.`);
    this.renderProgress();
    try {
      const result = await this.plugin.applyVaultBatch(
        this.batchId,
        generatedAgent.profileId,
        generatedAgent.contextId,
        edits,
      );
      for (const item of this.items) {
        if (item.status !== "approved") continue;
        const outcome = result.outcomes.get(item.snapshot.notePath);
        if (!outcome) continue;
        item.status = outcome;
        item.statusDetail = outcome === "applied"
          ? "Reviewed edit applied."
          : outcome === "stale"
            ? "This target changed or disappeared after review; no batch write started."
            : outcome === "rolled-back"
              ? "The edit was written, then safely restored after the batch failed."
              : outcome === "not-applied"
                ? "This reviewed edit was not written."
                : "The final file state requires recovery review; divergent content was not overwritten.";
        if (item.auditId) {
          updateAuditOutcome(
            this.plugin.state.auditLog,
            item.auditId,
            outcome === "applied"
              ? "applied"
              : outcome === "stale"
                ? "stale"
                : outcome === "rolled-back"
                  ? "rolled_back"
                  : outcome === "not-applied"
                    ? "not_applied"
                    : "recovery_required",
          );
        }
      }
      try {
        await this.plugin.saveState();
      } catch {
        new Notice("The notes reached the reported batch state, but final receipt metadata could not be saved.");
      }
      this.batchResultMessage = result.message;
      this.announceStatus(result.message);
      new Notice(result.message);
    } catch {
      const message = "The vault batch could not be applied. No additional plugin write was started.";
      this.batchResultMessage = message;
      this.announceStatus(message);
      new Notice(message);
    } finally {
      this.applying = false;
      this.renderProgress();
    }
  }
}
