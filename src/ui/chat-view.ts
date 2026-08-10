import {
  ButtonComponent,
  ItemView,
  Notice,
  parseYaml,
  WorkspaceLeaf,
} from "obsidian";

import {
  appendAuditRecord,
  createAuditRecord,
  updateAuditOutcome,
} from "../core/audit";
import { agentContextId } from "../core/agent-identity";
import { buildAgentPrompt, historyForPrompt, parseAgentReply } from "../core/protocol";
import { instructionError, shouldSubmitComposer } from "../core/input";
import {
  applyReplacement,
  captureScope,
  isSnapshotCurrent,
  replacementForSnapshot,
  hashText,
  scopeContextKey,
} from "../core/scope";
import { validateReplacement } from "../core/safety";
import {
  appendMessage,
  canStoreCheckpoint,
  createMessage,
  getOrCreateThread,
  storeCheckpoint,
  threadKey,
} from "../core/state";
import type { ChatTask, ScopeKind } from "../core/types";
import { AcpTurnCancelledError } from "../hermes/acp-client";
import type BoundedNoteChatPlugin from "../main";
import { ConfirmModal } from "./confirm-modal";
import { DiffModal } from "./diff-modal";

export const VIEW_TYPE_BOUNDED_NOTE_CHAT = "agent-change-gate-view";

export class BoundedNoteChatView extends ItemView {
  private selectedAgent = "";
  private noteScope: ScopeKind = "body";
  private task: ChatTask = "ask";
  private includeHistory = false;
  private preflighting = false;
  private busy = false;
  private messagesEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private receiptEl: HTMLElement | null = null;
  private sendButton: ButtonComponent | null = null;
  private stopButton: ButtonComponent | null = null;
  private clearButton: ButtonComponent | null = null;
  private instructionEl: HTMLTextAreaElement | null = null;
  private agentSelectEl: HTMLSelectElement | null = null;
  private taskSelectEl: HTMLSelectElement | null = null;
  private scopeSelectEl: HTMLSelectElement | null = null;
  private historySelectEl: HTMLSelectElement | null = null;
  private activeRequest: { profileId: string; threadKey: string } | null = null;
  private cancelRequested = false;
  private closed = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: BoundedNoteChatPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_BOUNDED_NOTE_CHAT;
  }

  override getDisplayText(): string {
    return "Agent Change Gate";
  }

  override getIcon(): string {
    return "message-square-lock";
  }

  override async onOpen(): Promise<void> {
    this.closed = false;
    this.plugin.registerChatView(this);
    this.selectedAgent = this.plugin.state.settings.defaultAgent;
    this.render();
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    if (this.activeRequest) {
      this.cancelRequested = true;
      await this.plugin.acpPool.cancel(this.activeRequest.profileId, this.activeRequest.threadKey);
    }
    this.plugin.unregisterChatView(this);
  }

  refresh(): void {
    if (!this.busy && !this.closed) this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bounded-note-chat-view");

    const activeFile = this.app.workspace.getActiveFile();
    const notePath = activeFile?.extension === "md" ? activeFile.path : "No active Markdown note";

    const toolbar = root.createDiv({ cls: "bounded-note-chat-toolbar" });
    const agentSelect = toolbar.createEl("select", { attr: { "aria-label": "ACP agent" } });
    this.agentSelectEl = agentSelect;
    if (this.plugin.agents.length === 0) {
      agentSelect.createEl("option", { text: "No ACP agents ready", value: "" });
      this.selectedAgent = "";
    } else {
      if (!this.plugin.agents.some((profile) => profile.id === this.selectedAgent)) {
        this.selectedAgent = this.plugin.agents.some((profile) => profile.id === this.plugin.state.settings.defaultAgent)
          ? this.plugin.state.settings.defaultAgent
          : this.plugin.agents[0]?.id ?? "";
      }
      for (const profile of this.plugin.agents) {
        const source = profile.source === "custom" ? "ACP" : "Hermes";
        const option = agentSelect.createEl("option", { text: `${profile.label} · ${source}`, value: profile.id });
        option.selected = profile.id === this.selectedAgent;
      }
    }
    agentSelect.addEventListener("change", () => {
      this.selectedAgent = agentSelect.value;
      this.plugin.state.settings.defaultAgent = this.selectedAgent;
      void this.plugin.saveState();
      this.renderMessages(notePath);
    });

    const taskSelect = toolbar.createEl("select", { attr: { "aria-label": "Task" } });
    this.taskSelectEl = taskSelect;
    for (const optionValue of ["ask", "edit"] as const) {
      const option = taskSelect.createEl("option", {
        value: optionValue,
        text: optionValue === "ask" ? "Ask about scope" : "Suggest an edit",
      });
      option.selected = this.task === optionValue;
    }
    taskSelect.addEventListener("change", () => {
      this.task = taskSelect.value === "edit" ? "edit" : "ask";
    });

    const scopeSelect = toolbar.createEl("select", { attr: { "aria-label": "Note scope" } });
    this.scopeSelectEl = scopeSelect;
    const scopeLabels: Record<ScopeKind, string> = {
      body: "Note body",
      selection: "Current selection",
      frontmatter: "YAML frontmatter",
    };
    for (const optionValue of ["body", "selection", "frontmatter"] as const) {
      const option = scopeSelect.createEl("option", { value: optionValue, text: scopeLabels[optionValue] });
      option.selected = this.noteScope === optionValue;
    }
    scopeSelect.addEventListener("change", () => {
      const value = scopeSelect.value;
      this.noteScope = value === "selection" || value === "frontmatter" ? value : "body";
    });

    const historySelect = toolbar.createEl("select", { attr: { "aria-label": "Agent conversation context" } });
    this.historySelectEl = historySelect;
    for (const option of [
      { value: "off", label: "Context: scope only" },
      { value: "same-scope", label: "Context: exact-scope thread" },
    ]) {
      const element = historySelect.createEl("option", { value: option.value, text: option.label });
      element.selected = this.includeHistory === (option.value === "same-scope");
    }
    historySelect.addEventListener("change", () => {
      this.includeHistory = historySelect.value === "same-scope";
    });

    const boundary = root.createDiv({ cls: "bounded-note-chat-boundary" });
    boundary.createEl("strong", { text: "Review gate" });
    boundary.createSpan({
      text: "No client filesystem or terminal capability. Every plugin-applied agent change requires review. The agent process is not sandboxed.",
    });

    root.createDiv({ cls: "bounded-note-chat-note", text: notePath });
    this.receiptEl = root.createDiv({
      cls: "bounded-note-chat-scope-receipt",
      text: "The scope is captured only when you send.",
    });
    this.messagesEl = root.createDiv({ cls: "bounded-note-chat-messages" });
    this.renderMessages(notePath);

    const composer = root.createDiv({ cls: "bounded-note-chat-composer" });
    this.instructionEl = composer.createEl("textarea", {
      attr: {
        placeholder: "Ask your agent, or describe the edit you want…",
        "aria-label": "Message to ACP agent",
      },
    });
    this.instructionEl.addEventListener("keydown", (event) => {
      if (shouldSubmitComposer(event)) {
        event.preventDefault();
        void this.send();
      }
    });

    const actions = composer.createDiv({ cls: "bounded-note-chat-composer-actions" });
    this.sendButton = new ButtonComponent(actions)
      .setButtonText("Send")
      .setCta()
      .onClick(() => void this.send());
    this.stopButton = new ButtonComponent(actions)
      .setButtonText("Stop")
      .setWarning()
      .onClick(() => void this.stop());
    this.clearButton = new ButtonComponent(actions)
      .setButtonText("Clear thread")
      .onClick(() => void this.clearThread());
    this.statusEl = actions.createEl("span", { cls: "bounded-note-chat-note" });
    this.updateBusyState();
  }

  private renderMessages(notePath: string): void {
    const container = this.messagesEl;
    if (!container) return;
    container.empty();
    if (!this.selectedAgent || notePath === "No active Markdown note") {
      if (this.selectedAgent) {
        container.createDiv({
          cls: "bounded-note-chat-message",
          attr: { "data-role": "system" },
          text: "Open a Markdown note to begin.",
        });
      } else {
        const onboarding = container.createDiv({ cls: "bounded-note-chat-onboarding" });
        onboarding.createEl("strong", { text: "Connect an ACP agent" });
        onboarding.createEl("p", {
          text: "Hermes profiles are detected automatically. Other ACP agents can be added in plugin settings with a literal executable and argument list.",
        });
        new ButtonComponent(onboarding)
          .setButtonText("Detect agents")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.refreshAgents(true);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Agent discovery failed.");
            }
          });
      }
      return;
    }
    const profile = this.plugin.agents.find((item) => item.id === this.selectedAgent);
    const thread = profile
      ? this.plugin.state.threads[threadKey(agentContextId(profile), notePath)]
      : undefined;
    if (!thread || thread.messages.length === 0) {
      container.createDiv({
        cls: "bounded-note-chat-message",
        attr: { "data-role": "system" },
        text: "The chosen scope is the only current-note text in the host prompt. Thread history is sent only when Context: exact-scope thread is selected. This plugin will not apply a proposed replacement until you review the diff.",
      });
    }
    for (const message of thread?.messages ?? []) {
      const messageEl = container.createDiv({
        cls: "bounded-note-chat-message",
        attr: { "data-role": message.role },
      });
      if (message.scope) {
        messageEl.createDiv({ cls: "agent-change-gate-message-scope", text: message.scope });
      }
      messageEl.createDiv({ text: message.text });
    }
    container.scrollTop = container.scrollHeight;
  }

  private async send(): Promise<void> {
    if (this.busy || this.preflighting) return;
    const instructionEl = this.instructionEl;
    const instruction = instructionEl?.value.trim() ?? "";
    const invalidInstruction = instructionError(instruction);
    if (invalidInstruction) {
      new Notice(invalidInstruction);
      return;
    }
    const profile = this.plugin.agents.find((item) => item.id === this.selectedAgent);
    if (!profile) {
      new Notice("Choose a ready ACP agent first.");
      return;
    }
    const view = this.plugin.getActiveMarkdownView();
    const file = view?.file;
    if (!view || !file || file.extension !== "md") {
      new Notice("Open a Markdown note first.");
      return;
    }

    const editor = view.editor;
    const fullText = editor.getValue();
    const requestedTask = this.task;
    let snapshot;
    try {
      const from = editor.posToOffset(editor.getCursor("from"));
      const to = editor.posToOffset(editor.getCursor("to"));
      snapshot = captureScope(file.path, fullText, this.noteScope, { from, to });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not capture the note scope.");
      return;
    }
    if (snapshot.originalScope.length > this.plugin.state.settings.maxContextChars) {
      new Notice(`The selected scope exceeds the ${this.plugin.state.settings.maxContextChars.toLocaleString()} character limit.`);
      return;
    }

    const contextAgentId = agentContextId(profile);
    const existingThread = this.plugin.state.threads[threadKey(contextAgentId, file.path)];
    const scopeHash = hashText(snapshot.originalScope);
    const scopeKey = scopeContextKey(snapshot);
    const priorMessages = this.includeHistory
      ? (existingThread?.messages ?? []).filter((message) => (
        message.scope === snapshot.scope && message.scopeKey === scopeKey
      ))
      : [];
    const promptHistory = historyForPrompt(priorMessages);
    const historyChars = promptHistory.reduce((total, message) => total + message.text.length, 0);
    const historyHash = hashText(JSON.stringify(promptHistory));
    const estimatedContextChars = instruction.length + snapshot.originalScope.length + historyChars;
    if (estimatedContextChars > 60_000) {
      this.preflighting = true;
      this.updateBusyState();
      let accepted = false;
      try {
        accepted = await new ConfirmModal(
          this.app,
          "Send a large agent context?",
          `This turn includes approximately ${estimatedContextChars.toLocaleString()} instruction, scope, and optional-history characters. The selected agent may send them to a billed remote model provider.`,
          "Send large context",
        ).waitForDecision();
      } finally {
        this.preflighting = false;
        this.updateBusyState();
      }
      if (this.closed) return;
      if (!accepted) return;
    }
    const thread = getOrCreateThread(this.plugin.state, contextAgentId, file.path);
    const auditRecord = createAuditRecord({
      agentId: contextAgentId,
      notePath: file.path,
      scope: snapshot.scope,
      task: requestedTask,
      scopeChars: snapshot.originalScope.length,
      scopeHash,
      historyChars,
      historyHash,
    });
    appendMessage(
      thread,
      createMessage("user", instruction, snapshot.scope, scopeKey),
      this.plugin.state.settings.historyLimit,
    );
    appendAuditRecord(this.plugin.state.auditLog, auditRecord);
    if (instructionEl) instructionEl.value = "";
    if (this.receiptEl) {
      this.receiptEl.setText(
        `${snapshot.scope} · ${snapshot.originalScope.length.toLocaleString()} scope chars`
        + (historyChars > 0 ? ` + ${historyChars.toLocaleString()} exact-scope history chars` : "")
        + ` · receipt ${scopeHash.slice(0, 12)}`,
      );
    }
    this.activeRequest = { profileId: profile.id, threadKey: thread.key };
    this.cancelRequested = false;
    this.busy = true;
    this.updateBusyState();
    this.renderMessages(file.path);
    let editApplied = false;

    try {
      await this.plugin.saveState();
      if (this.cancelRequested) throw new AcpTurnCancelledError();
      const currentProfile = this.plugin.agents.find((item) => item.id === profile.id);
      if (!currentProfile || agentContextId(currentProfile) !== contextAgentId) {
        throw new AcpTurnCancelledError("Agent settings changed before the request was sent.");
      }
      const currentView = this.plugin.getActiveMarkdownView();
      if (!currentView?.file || !isSnapshotCurrent(snapshot, currentView.file.path, currentView.editor.getValue())) {
        throw new AcpTurnCancelledError("The note changed before the request was sent.");
      }
      const prompt = buildAgentPrompt({
        task: requestedTask,
        instruction,
        notePath: file.path,
        scope: snapshot.scope,
        noteContent: snapshot.originalScope,
        priorMessages,
      });
      const raw = await this.plugin.acpPool.prompt(profile, thread.key, prompt, {
        timeoutMs: this.plugin.state.settings.promptTimeoutMs,
        onStatus: (status) => {
          if (this.statusEl) this.statusEl.setText(status);
        },
      });
      if (this.cancelRequested) throw new AcpTurnCancelledError();
      this.activeRequest = null;
      this.updateBusyState();
      const reply = parseAgentReply(raw, this.plugin.state.settings.maxContextChars, requestedTask);
      appendMessage(
        thread,
        createMessage("assistant", reply.message, snapshot.scope, scopeKey),
        this.plugin.state.settings.historyLimit,
      );

      if (reply.action === "propose_edit" && reply.replacement !== undefined) {
        const validation = validateReplacement(
          snapshot,
          reply.replacement,
          this.plugin.state.settings.maxContextChars,
          parseYaml,
        );
        if (!validation.ok) {
          const message = `Blocked unsafe proposal: ${validation.errors.join(" ")}`;
          appendMessage(
            thread,
            createMessage("system", message, snapshot.scope, scopeKey),
            this.plugin.state.settings.historyLimit,
          );
          updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "blocked");
          await this.plugin.saveState();
          new Notice(message);
        } else {
          const effectiveReplacement = replacementForSnapshot(snapshot, reply.replacement);
          const checkpointAvailable = canStoreCheckpoint(
            snapshot.fullText,
            applyReplacement(snapshot, effectiveReplacement),
          );
          updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "proposed");
          await this.plugin.saveState();
          this.renderMessages(file.path);
          if (this.statusEl) this.statusEl.setText("Reviewing proposal…");
          const accepted = await new DiffModal(this.app, {
            title: `Review edit for ${snapshot.notePath}`,
            original: snapshot.originalScope,
            replacement: effectiveReplacement,
            agentSummary: reply.summary,
            agentWarnings: reply.warnings,
            gateWarnings: [
              ...validation.warnings,
              ...(checkpointAvailable
                ? []
                : ["This note is too large for the bounded recovery store. The edit can still be reviewed and applied, but Agent Change Gate will not offer its own undo checkpoint."]),
            ],
          }).waitForDecision();
          if (accepted) {
            const outcome = await this.applyAcceptedEdit(snapshot, effectiveReplacement);
            editApplied = outcome === "applied";
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, outcome);
          } else {
            updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "discarded");
          }
          await this.plugin.saveState();
        }
      } else {
        updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, "replied");
        await this.plugin.saveState();
      }
    } catch (error) {
      if (editApplied) {
        new Notice("The edit was applied, but its final local receipt could not be saved. Use Obsidian undo or file recovery if needed.");
        return;
      }
      const cancelled = this.cancelRequested || error instanceof AcpTurnCancelledError;
      const message = cancelled
        ? "Request cancelled. No proposal was applied."
        : "Request failed before any proposal was applied.";
      appendMessage(
        thread,
        createMessage("system", message, snapshot.scope, scopeKey),
        this.plugin.state.settings.historyLimit,
      );
      updateAuditOutcome(this.plugin.state.auditLog, auditRecord.id, cancelled ? "cancelled" : "error");
      try {
        await this.plugin.saveState();
      } catch {
        new Notice("The request failed and the local error receipt could not be saved.");
      }
      new Notice(message);
    } finally {
      this.activeRequest = null;
      this.cancelRequested = false;
      this.busy = false;
      this.updateBusyState();
      if (!this.closed) this.render();
    }
  }

  private async applyAcceptedEdit(
    snapshot: ReturnType<typeof captureScope>,
    replacement: string,
  ): Promise<"applied" | "stale"> {
    return await this.plugin.runNoteMutation(snapshot.notePath, async () => {
    const view = this.plugin.getActiveMarkdownView();
    const file = view?.file;
    if (!view || !file || !isSnapshotCurrent(snapshot, file.path, view.editor.getValue())) {
      new Notice("The note or captured scope changed after it was sent. The edit was not applied.");
      return "stale";
    }
    const after = applyReplacement(snapshot, replacement);
    const checkpoint = {
      notePath: file.path,
      before: snapshot.fullText,
      after,
      createdAt: Date.now(),
    };
    const checkpointStored = storeCheckpoint(this.plugin.state, checkpoint);
    try {
      await this.plugin.saveState();
    } catch (error) {
      if (checkpointStored && this.plugin.state.checkpoints[snapshot.notePath] === checkpoint) {
        delete this.plugin.state.checkpoints[snapshot.notePath];
        try {
          await this.plugin.saveState();
        } catch {
          // The in-memory rollback still prevents the outer retry from persisting it.
        }
      }
      throw error;
    }
    const currentView = this.plugin.getActiveMarkdownView();
    const currentFile = currentView?.file;
    if (!currentView || !currentFile || !isSnapshotCurrent(snapshot, currentFile.path, currentView.editor.getValue())) {
      if (checkpointStored && this.plugin.state.checkpoints[snapshot.notePath] === checkpoint) {
        delete this.plugin.state.checkpoints[snapshot.notePath];
      }
      await this.plugin.saveState();
      new Notice("The note changed while the recovery state was being prepared. The edit was not applied.");
      return "stale";
    }
    const effectiveReplacement = replacementForSnapshot(snapshot, replacement);
    const from = currentView.editor.offsetToPos(snapshot.from);
    const to = currentView.editor.offsetToPos(snapshot.to);
    try {
      currentView.editor.replaceRange(effectiveReplacement, from, to);
    } catch (error) {
      if (checkpointStored && this.plugin.state.checkpoints[snapshot.notePath] === checkpoint) {
        delete this.plugin.state.checkpoints[snapshot.notePath];
      }
      await this.plugin.saveState();
      throw error;
    }
    new Notice(checkpointStored
      ? "Edit applied. Use “Review and undo last applied edit” if needed."
      : "Edit applied without an Agent Change Gate recovery checkpoint. Use Obsidian undo or file recovery if needed.");
    return "applied";
    });
  }

  private async stop(): Promise<void> {
    const request = this.activeRequest;
    if (!request || this.cancelRequested) return;
    this.cancelRequested = true;
    this.stopButton?.setDisabled(true);
    if (this.statusEl) this.statusEl.setText("Stopping…");
    const found = await this.plugin.acpPool.cancel(request.profileId, request.threadKey);
    if (!found && this.statusEl) this.statusEl.setText("Stopping before send…");
  }

  private async clearThread(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || !this.selectedAgent) return;
    const profile = this.plugin.agents.find((item) => item.id === this.selectedAgent);
    if (!profile) return;
    const key = threadKey(agentContextId(profile), file.path);
    const thread = this.plugin.state.threads[key];
    if (!thread || thread.messages.length === 0) return;
    const accepted = await new ConfirmModal(
      this.app,
      "Clear this chat thread?",
      `This removes the locally stored ${this.selectedAgent} conversation for ${file.path}. It does not change the note.`,
      "Clear thread",
    ).waitForDecision();
    if (!accepted) return;
    const previousThreads = this.plugin.state.threads;
    this.plugin.state.threads = { ...previousThreads };
    delete this.plugin.state.threads[key];
    try {
      await this.plugin.saveState();
    } catch {
      this.plugin.state.threads = {
        ...previousThreads,
        ...this.plugin.state.threads,
      };
      new Notice("The thread was not cleared because the local state file could not be updated.");
      return;
    }
    this.renderMessages(file.path);
  }

  private updateBusyState(): void {
    const controlsBusy = this.busy || this.preflighting;
    this.sendButton?.setDisabled(controlsBusy);
    this.stopButton?.setDisabled(!this.busy || !this.activeRequest || this.cancelRequested);
    this.clearButton?.setDisabled(controlsBusy);
    if (this.instructionEl) this.instructionEl.disabled = controlsBusy;
    if (this.agentSelectEl) this.agentSelectEl.disabled = controlsBusy;
    if (this.taskSelectEl) this.taskSelectEl.disabled = controlsBusy;
    if (this.scopeSelectEl) this.scopeSelectEl.disabled = controlsBusy;
    if (this.historySelectEl) this.historySelectEl.disabled = controlsBusy;
    if (this.statusEl) this.statusEl.setText(this.preflighting ? "Awaiting confirmation…" : this.busy ? "Working…" : "");
  }
}
