import { App, ButtonComponent, Modal } from "obsidian";

import { diffLines, type LineDiffLine, type LineDiffOperation } from "../core/diff";
import { visibleReviewText } from "../core/review-text";

export interface DiffModalOptions {
  title: string;
  original: string;
  replacement: string;
  agentSummary?: string;
  gateSummary?: string;
  agentWarnings?: string[];
  gateWarnings?: string[];
}

export class DiffModal extends Modal {
  private settled = false;
  private resolveResult: ((accepted: boolean) => void) | null = null;

  constructor(app: App, private readonly options: DiffModalOptions) {
    super(app);
  }

  waitForDecision(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.resolveResult = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: visibleReviewText(this.options.title) });
    if (this.options.gateSummary) {
      contentEl.createEl("strong", { text: "Gate summary" });
      contentEl.createEl("p", { text: visibleReviewText(this.options.gateSummary) });
    }
    if (this.options.agentSummary) {
      contentEl.createEl("strong", { text: "Agent summary" });
      contentEl.createEl("p", { text: visibleReviewText(this.options.agentSummary) });
    }
    if ((this.options.gateWarnings?.length ?? 0) > 0) {
      contentEl.createEl("strong", { text: "Gate warnings" });
    }
    for (const warning of this.options.gateWarnings ?? []) {
      contentEl.createEl("p", {
        cls: "bounded-note-chat-warning",
        text: visibleReviewText(warning),
      });
    }
    if ((this.options.agentWarnings?.length ?? 0) > 0) {
      contentEl.createEl("strong", { text: "Agent warnings (untrusted)" });
    }
    for (const warning of this.options.agentWarnings ?? []) {
      contentEl.createEl("p", {
        cls: "bounded-note-chat-warning",
        text: visibleReviewText(warning),
      });
    }

    const result = diffLines(this.options.original, this.options.replacement, {
      maxLines: 4_000,
      maxOperations: 4_000,
    });
    const added = result.operations
      .filter((operation) => operation.kind === "add")
      .reduce((total, operation) => total + operation.lines.length, 0);
    const removed = result.operations
      .filter((operation) => operation.kind === "remove")
      .reduce((total, operation) => total + operation.lines.length, 0);
    const hasChanges = added + removed > 0 || result.truncated;
    contentEl.createEl("p", {
      cls: "agent-change-gate-diff-summary",
      text: `${added} added · ${removed} removed`,
    });
    if (!result.exact) {
      contentEl.createEl("p", {
        cls: "bounded-note-chat-warning",
        text: result.truncated
          ? "This proposal is too large to render safely. Apply is disabled; reduce the selected scope and try again."
          : "This is a complete coarse diff because an exact line comparison exceeded the display work limit.",
      });
    }

    const diff = contentEl.createDiv({
      cls: "agent-change-gate-unified-diff",
      attr: {
        "aria-label": "Bounded line diff between the captured scope and proposed replacement",
        role: "region",
        tabindex: "0",
      },
    });
    if (!hasChanges) {
      diff.createDiv({ cls: "agent-change-gate-diff-empty", text: "No textual change." });
    } else {
      for (const operation of result.operations) {
        this.renderOperation(diff, operation);
      }
    }

    const actions = contentEl.createDiv({ cls: "bounded-note-chat-diff-actions" });
    new ButtonComponent(actions)
      .setButtonText("Apply this edit")
      .setCta()
      .setDisabled(result.truncated || !hasChanges)
      .onClick(() => this.finish(true));
    new ButtonComponent(actions)
      .setButtonText("Discard")
      .onClick(() => this.finish(false));
  }

  private renderOperation(container: HTMLElement, operation: LineDiffOperation): void {
    if (operation.omittedCharacters !== undefined) {
      container.createDiv({
        cls: `agent-change-gate-diff-line is-${operation.kind}`,
        text: `${operation.kind === "add" ? "+" : "−"} ${operation.omittedCharacters.toLocaleString()} characters omitted`,
      });
      return;
    }

    if (operation.kind === "equal" && operation.lines.length > 12) {
      this.renderLines(container, operation, operation.lines.slice(0, 5), 0);
      container.createDiv({
        cls: "agent-change-gate-diff-collapsed",
        text: `… ${(operation.lines.length - 10).toLocaleString()} unchanged lines …`,
      });
      this.renderLines(
        container,
        operation,
        operation.lines.slice(-5),
        operation.lines.length - 5,
      );
      return;
    }
    this.renderLines(container, operation, operation.lines, 0);
  }

  private renderLines(
    container: HTMLElement,
    operation: LineDiffOperation,
    lines: LineDiffLine[],
    lineOffset: number,
  ): void {
    let oldLine = operation.oldStart + (operation.kind === "add" ? 0 : lineOffset);
    let newLine = operation.newStart + (operation.kind === "remove" ? 0 : lineOffset);
    for (const line of lines) {
      const row = container.createDiv({
        cls: `agent-change-gate-diff-line is-${operation.kind}`,
      });
      row.createSpan({
        cls: "agent-change-gate-diff-number",
        text: operation.kind === "add" ? "" : String(oldLine + 1),
      });
      row.createSpan({
        cls: "agent-change-gate-diff-number",
        text: operation.kind === "remove" ? "" : String(newLine + 1),
      });
      row.createSpan({
        cls: "agent-change-gate-diff-marker",
        text: operation.kind === "add" ? "+" : operation.kind === "remove" ? "−" : " ",
      });
      row.createEl("code", {
        cls: "agent-change-gate-diff-code",
        text: line.text.length > 0 ? visibleReviewText(line.text) : " ",
      });
      if (operation.kind !== "equal") this.renderEnding(row, line);
      if (operation.kind !== "add") oldLine += 1;
      if (operation.kind !== "remove") newLine += 1;
    }
  }

  private renderEnding(row: HTMLElement, line: LineDiffLine): void {
    const label = line.ending === "\r\n"
      ? "CRLF"
      : line.ending === "\r"
        ? "CR"
        : line.ending === "\n"
          ? "LF"
          : "no newline";
    row.createSpan({
      cls: "agent-change-gate-diff-ending",
      attr: { "aria-label": `Line ending: ${label}`, title: `Line ending: ${label}` },
      text: label,
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.finish(false, false);
  }

  private finish(accepted: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult?.(accepted);
    if (close) this.close();
  }
}
