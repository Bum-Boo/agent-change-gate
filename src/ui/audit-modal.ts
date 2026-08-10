import { App, Modal } from "obsidian";

import type { ScopeAuditRecord } from "../core/audit";

export class AuditModal extends Modal {
  constructor(app: App, private readonly records: ScopeAuditRecord[]) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Scope receipts" });
    contentEl.createEl("p", {
      text: "Local records showing what scope was sent and how each request ended. Instruction, note-body, and model-response plaintext is omitted, but deterministic hashes can confirm guessed content.",
    });

    if (this.records.length === 0) {
      contentEl.createEl("p", { text: "No requests have been recorded yet." });
      return;
    }

    const viewport = contentEl.createDiv({ cls: "agent-change-gate-audit" });
    const table = viewport.createEl("table");
    const header = table.createEl("thead").createEl("tr");
    for (const label of ["Time", "Outcome", "Agent", "Note", "Scope", "Size", "Receipt"]) {
      header.createEl("th", { text: label });
    }

    const body = table.createEl("tbody");
    for (const record of [...this.records].reverse()) {
      const row = body.createEl("tr");
      row.createEl("td", { text: new Date(record.updatedAt).toLocaleString() });
      row.createEl("td", {
        cls: `agent-change-gate-audit-outcome is-${record.outcome}`,
        text: record.outcome,
      });
      row.createEl("td", { text: record.agentId });
      row.createEl("td", { text: record.notePath });
      row.createEl("td", { text: `${record.task} · ${record.scope}` });
      row.createEl("td", {
        text: record.historyChars > 0
          ? `${record.scopeChars.toLocaleString()} scope + ${record.historyChars.toLocaleString()} history chars`
          : `${record.scopeChars.toLocaleString()} scope chars`,
      });
      row.createEl("td", {
        attr: {
          title: record.historyChars > 0
            ? `Scope SHA-256: ${record.scopeHash}\nHistory SHA-256: ${record.historyHash}`
            : `Scope SHA-256: ${record.scopeHash}`,
        },
        text: record.historyChars > 0
          ? `s:${record.scopeHash.slice(0, 8)} h:${record.historyHash.slice(0, 8)}`
          : record.scopeHash.slice(0, 12),
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
