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
import { diffLines } from "../core/diff";
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
  file: TFile;
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
  const identity = path.toLocaleLowerCase();
  return DEFAULT_BATCH_EXCLUDED_PREFIXES.some((prefix) => {
    const protectedIdentity = prefix.toLocaleLowerCase();
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
  private candidateListEl: HTMLElement | null = null;
  private candidateSummaryEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private liveStatusEl: HTMLElement | null = null;
  private items: BatchItem[] = [];
  private generating = false;
  private applying = false;
  private closed = false;
  private cancelRequested = false;
  private activeRequest: { profileId: string; threadKey: string } | null = null;
  private batchId = "";

  constructor(private readonly plugin: BoundedNoteChatPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("agent-change-gate-batch-modal");
    if (this.plugin.isBatchRecoveryLocked()) {
      this.contentEl.createEl("h2", { text: "Vault batch review is locked" });
      this.contentEl.createEl("p", {
        text: "Resolve or explicitly abandon the existing batch recovery state in Agent Change Gate settings before generating more billed drafts.",
      });
      new ButtonComponent(this.contentEl).setButtonText("Close").onClick(() => this.close());
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
    this.contentEl.empty();
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
      if (!isProtectedBatchPath(file.path)) folders.add(folderOf(file.path));
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
    new ButtonComponent(actions)
      .setButtonText("Prepare selected notes")
      .setCta()
      .onClick(() => void this.prepareAndGenerate());
    new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
  }

  private visibleFiles(): TFile[] {
    const query = this.search.trim().toLocaleLowerCase();
    return this.plugin.batchMarkdownFiles()
      .filter((file) => normalizeVaultBatchPath(file.path) === file.path)
      .filter((file) => !isProtectedBatchPath(file.path))
      .filter((file) => pathInFolder(file.path, this.selectedFolder, this.includeSubfolders))
      .filter((file) => !query || file.path.toLocaleLowerCase().includes(query))
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
    this.candidateSummaryEl?.setText(
      `${this.selectedPaths.size.toLocaleString()} selected / ${visible.length.toLocaleString()} visible; hard limit 20 files`,
    );
  }

  private async prepareAndGenerate(): Promise<void> {
    if (this.generating || this.applying) return;
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

    let prepared: PreparedSelection;
    try {
      prepared = await this.prepareSelection([...this.selectedPaths]);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "The batch selection could not be prepared.");
      return;
    }
    if (prepared.items.length === 0) {
      new Notice("No selected note has an eligible scope.");
      return;
    }
    const accepted = await new ConfirmModal(
      this.app,
      `Generate drafts for ${prepared.items.length} notes?`,
      `Agent Change Gate will send ${prepared.scopeCharacters.toLocaleString()} scope characters from ${prepared.items.length} notes in ${prepared.items.length} separate ACP turns. Paths: ${prepared.items.map((item) => item.file.path).join(", ")}.${prepared.skipped.length > 0 ? ` Not sent: ${prepared.skipped.map((item) => `${item.path} (${item.reason})`).join(", ")}.` : ""} The agent or model provider may retain content and charge for use. No note will change yet.`,
      `Generate ${prepared.items.length} drafts`,
    ).waitForDecision();
    if (!accepted || this.closed) return;

    this.items = prepared.items;
    this.batchId = randomUUID();
    this.cancelRequested = false;
    this.generating = true;
    this.renderProgress();
    await this.generateDrafts(profile, instruction);
  }

  private async prepareSelection(paths: string[]): Promise<PreparedSelection> {
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
          maxTotalCharacters: MAX_BATCH_TOTAL_CHARACTERS,
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
        snapshot = captureScope(file.path, candidate.content, this.batchScope);
      } catch (error) {
        if (this.batchScope === "frontmatter") {
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
        file,
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

  private async generateDrafts(profile: AgentProfile, instruction: string): Promise<void> {
    let consecutiveFailures = 0;
    for (let index = 0; index < this.items.length; index += 1) {
      const item = this.items[index];
      if (!item) continue;
      if (this.cancelRequested || this.closed) {
        item.status = "cancelled";
        continue;
      }
      item.status = "generating";
      this.renderProgress();
      const threadKey = `vault-batch:${this.batchId}:${index}`;
      this.activeRequest = { profileId: profile.id, threadKey };
      const auditRecord = createAuditRecord({
        agentId: agentContextId(profile),
        notePath: item.file.path,
        scope: this.batchScope,
        task: "edit",
        scopeChars: item.snapshot.originalScope.length,
        scopeHash: hashText(item.snapshot.originalScope),
        historyChars: 0,
        historyHash: EMPTY_HISTORY_HASH,
      });
      item.auditId = auditRecord.id;
      appendAuditRecord(this.plugin.state.auditLog, auditRecord);
      try {
        const currentText = await this.plugin.readBatchFile(item.file);
        if (!isSnapshotCurrent(item.snapshot, item.file.path, currentText)) {
          item.status = "stale";
          item.statusDetail = "The note changed before its turn was sent.";
          updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "stale");
          await this.plugin.saveState();
          continue;
        }
        await this.plugin.saveState();
        const raw = await this.plugin.acpPool.prompt(
          profile,
          threadKey,
          buildAgentPrompt({
            task: "edit",
            instruction,
            notePath: item.file.path,
            scope: this.batchScope,
            noteContent: item.snapshot.originalScope,
            priorMessages: [],
          }),
          {
            timeoutMs: this.plugin.state.settings.promptTimeoutMs,
            onStatus: (status) => {
              item.statusDetail = status;
              this.liveStatusEl?.setText(`${item.file.path}: ${status}`);
            },
          },
        );
        if (this.cancelRequested) throw new AcpTurnCancelledError();
        const reply = parseAgentReply(raw, this.plugin.state.settings.maxContextChars, "edit");
        item.message = reply.message;
        if (reply.action !== "propose_edit" || reply.replacement === undefined) {
          item.status = "skipped";
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
        item.status = cancelled ? "cancelled" : "failed";
        item.statusDetail = cancelled
          ? "Generation stopped before any edit was applied."
          : error instanceof Error ? error.message : "ACP draft generation failed.";
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
    this.generating = false;
    this.activeRequest = null;
    this.renderProgress();
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
    this.liveStatusEl = contentEl.createDiv({
      cls: "visually-hidden",
      attr: { "aria-live": "polite" },
    });
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
        .onClick(() => this.close());
    }
  }

  private renderProgressItem(container: HTMLElement, item: BatchItem): void {
    const row = container.createDiv({ cls: "agent-change-gate-batch-progress-item" });
    const text = row.createDiv();
    text.createEl("strong", { text: item.file.path });
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
      title: `Review batch draft for ${item.file.path}`,
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
    updateAuditOutcome(this.plugin.state.auditLog, item.auditId, approved ? "proposed" : "discarded");
    await this.plugin.saveState();
    this.renderProgress();
  }

  private async stopGeneration(): Promise<void> {
    if (!this.generating || this.cancelRequested) return;
    this.cancelRequested = true;
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
    const accepted = await new ConfirmModal(
      this.app,
      `Apply ${edits.length} reviewed edits?`,
      `Agent Change Gate will write ${edits.length} Markdown notes. Multi-file writes are not one filesystem transaction. Every target is checked before the first write, and a bounded recovery journal enables best-effort rollback without overwriting later changes.${this.plugin.state.batchRecovery?.phase === "completed" ? " This replaces the undo journal for the previous completed batch." : ""}`,
      `Apply ${edits.length} reviewed edits`,
    ).waitForDecision();
    if (!accepted || this.closed) return;
    this.applying = true;
    this.renderProgress();
    try {
      const result = await this.plugin.applyVaultBatch(this.batchId, this.selectedAgent, edits);
      for (const item of this.items) {
        if (item.status !== "approved") continue;
        const outcome = result.outcomes.get(item.file.path);
        if (!outcome) continue;
        item.status = outcome;
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
      new Notice(result.message);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "The vault batch could not be applied.");
    } finally {
      this.applying = false;
      this.renderProgress();
    }
  }
}
