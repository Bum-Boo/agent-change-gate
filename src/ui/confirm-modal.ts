import { App, ButtonComponent, Modal } from "obsidian";

export class ConfirmModal extends Modal {
  private settled = false;
  private resolveResult: ((accepted: boolean) => void) | null = null;

  constructor(
    app: App,
    private readonly heading: string,
    private readonly message: string,
    private readonly confirmLabel: string,
  ) {
    super(app);
  }

  waitForDecision(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.resolveResult = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.heading });
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "bounded-note-chat-diff-actions" });
    new ButtonComponent(actions)
      .setButtonText(this.confirmLabel)
      .setWarning()
      .onClick(() => this.finish(true));
    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => this.finish(false));
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
