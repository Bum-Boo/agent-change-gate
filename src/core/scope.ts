import { createHash } from "node:crypto";

import type { ScopeKind, ScopeSnapshot } from "./types";

export interface TextRange {
  from: number;
  to: number;
}

export interface SelectionRange extends TextRange {}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function scopeContextKey(snapshot: ScopeSnapshot): string {
  return hashText(JSON.stringify({
    scope: snapshot.scope,
    from: snapshot.from,
    to: snapshot.to,
    scopeHash: hashText(snapshot.originalScope),
  }));
}

export function findFrontmatterRange(text: string): TextRange | null {
  const opening = /^---[\t ]*(?:\r?\n|$)/.exec(text);
  if (!opening || opening[0].length === text.length) {
    return null;
  }

  let cursor = opening[0].length;
  while (cursor <= text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, lineEnd).replace(/\r$/, "");
    if (/^(---|\.\.\.)[\t ]*$/.test(line)) {
      return { from: 0, to: newline === -1 ? lineEnd : lineEnd + 1 };
    }
    if (newline === -1) {
      break;
    }
    cursor = newline + 1;
  }
  return null;
}

export function resolveScopeRange(
  fullText: string,
  scope: ScopeKind,
  selection?: SelectionRange,
): TextRange {
  const frontmatter = findFrontmatterRange(fullText);

  if (scope === "selection") {
    if (!selection || selection.from === selection.to) {
      throw new Error("Select some note text before using Selection scope.");
    }
    const from = Math.max(0, Math.min(selection.from, selection.to));
    const to = Math.min(fullText.length, Math.max(selection.from, selection.to));
    if (from >= to) {
      throw new Error("The selected range is outside the current note.");
    }
    return { from, to };
  }

  if (scope === "frontmatter") {
    if (!frontmatter) {
      throw new Error("This note has no YAML frontmatter.");
    }
    return frontmatter;
  }

  return { from: frontmatter?.to ?? 0, to: fullText.length };
}

export function captureScope(
  notePath: string,
  fullText: string,
  scope: ScopeKind,
  selection?: SelectionRange,
): ScopeSnapshot {
  const range = resolveScopeRange(fullText, scope, selection);
  return {
    notePath,
    scope,
    fullText,
    fullHash: hashText(fullText),
    from: range.from,
    to: range.to,
    originalScope: fullText.slice(range.from, range.to),
    capturedAt: Date.now(),
  };
}

export function applyReplacement(snapshot: ScopeSnapshot, replacement: string): string {
  const effectiveReplacement = replacementForSnapshot(snapshot, replacement);
  return `${snapshot.fullText.slice(0, snapshot.from)}${effectiveReplacement}${snapshot.fullText.slice(snapshot.to)}`;
}

export function replacementForSnapshot(snapshot: ScopeSnapshot, replacement: string): string {
  const prefix = snapshot.fullText.slice(0, snapshot.from);
  if (
    snapshot.scope === "body"
    && snapshot.from > 0
    && snapshot.to === snapshot.fullText.length
    && !prefix.endsWith("\n")
    && replacement.length > 0
    && !replacement.startsWith("\n")
    && !replacement.startsWith("\r")
  ) {
    const separator = snapshot.fullText.includes("\r\n") ? "\r\n" : "\n";
    return `${separator}${replacement}`;
  }
  return replacement;
}

export function isSnapshotCurrent(snapshot: ScopeSnapshot, notePath: string, currentText: string): boolean {
  return snapshot.notePath === notePath && snapshot.fullHash === hashText(currentText) && snapshot.fullText === currentText;
}
