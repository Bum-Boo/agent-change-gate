// Synthetic reproduction tests for docs/cloud-20261031-review.md.
// They assert behavior observed on main (1c2860b), not desired behavior, so
// that `npm test` stays green. Each "REPRO" case documents a finding.
//
// The editor stand-in uses the real @codemirror/state package (a transitive
// dev dependency of `obsidian`) because Obsidian's Editor is backed by a
// CodeMirror 6 document. Obsidian GUI behavior itself is not exercised here.
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { diffLines } from "../src/core/diff";
import { visibleReviewText } from "../src/core/review-text";
import { validateReplacement } from "../src/core/safety";
import {
  applyReplacement,
  captureScope,
  isSnapshotCurrent,
  replacementForSnapshot,
} from "../src/core/scope";
import type { ScopeKind, ScopeSnapshot } from "../src/core/types";

class Cm6Editor {
  private state: EditorState;

  constructor(text: string) {
    this.state = EditorState.create({ doc: text });
  }

  getValue(): string {
    return this.state.doc.toString();
  }

  replaceRange(text: string, from: number, to: number): void {
    this.state = this.state.update({ changes: { from, to, insert: text } }).state;
  }
}

const MAX = 120_000;
const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");

/** Mirrors src/ui/chat-view.ts:413-541 without Obsidian UI objects. */
function gate(editor: Cm6Editor, notePath: string, snapshot: ScopeSnapshot, proposal: string) {
  const validation = validateReplacement(snapshot, proposal, MAX);
  if (!validation.ok) return { status: "blocked" as const, validation };
  const effective = replacementForSnapshot(snapshot, proposal);
  const reviewed = diffLines(snapshot.originalScope, effective, { maxLines: 4_000, maxOperations: 4_000 });
  if (!isSnapshotCurrent(snapshot, notePath, editor.getValue())) return { status: "stale" as const };
  const checkpointAfter = applyReplacement(snapshot, effective);
  editor.replaceRange(replacementForSnapshot(snapshot, effective), snapshot.from, snapshot.to);
  return { status: "applied" as const, validation, effective, reviewed, checkpointAfter };
}

describe("REPRO F1: CR/CRLF in a proposal is reviewed but normalized on apply", () => {
  it("shows CRLF endings in the diff, stores LF, and the undo checkpoint no longer matches", () => {
    const note = "# 제목\n첫 줄\n둘째 줄\n";
    const editor = new Cm6Editor(note);
    const snapshot = captureScope("synthetic/노트.md", editor.getValue(), "body");
    const proposal = "# 제목\r\n고친 줄\r\n둘째 줄\r\n";

    const result = gate(editor, "synthetic/노트.md", snapshot, proposal);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;

    // Reviewed: every line carries a CRLF terminator, so every line is a change.
    const endings = result.reviewed.operations.flatMap((op) => op.kind === "add" ? op.lines.map((l) => l.ending) : []);
    expect(endings).toEqual(["\r\n", "\r\n", "\r\n"]);
    // Applied: CodeMirror splits on /\r\n?|\n/ and the document holds LF only.
    expect(editor.getValue()).toBe("# 제목\n고친 줄\n둘째 줄\n");
    expect(editor.getValue()).not.toBe(result.checkpointAfter);
    // main.ts:209 then refuses undo because editor value !== checkpoint.after.
  });

  it("a lone CR passes validation and becomes LF after apply", () => {
    const editor = new Cm6Editor("가\n나\n");
    const snapshot = captureScope("n.md", editor.getValue(), "body");
    const result = gate(editor, "n.md", snapshot, "가\r다\n");
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.warnings).toEqual([]);
    expect(editor.getValue()).toBe("가\n다\n");
    expect(editor.getValue()).not.toBe(result.checkpointAfter);
  });
});

describe("REPRO F2: selection boundary inside a surrogate pair (main lacks the guard)", () => {
  it("accepts a mid-pair selection and the applied note contains a lone surrogate", () => {
    const note = "앞😀뒤";
    const lowSurrogate = note.indexOf("😀") + 1;
    const snapshot = captureScope("n.md", note, "selection", { from: lowSurrogate, to: note.length });
    expect(snapshot.originalScope).toBe("\uDE00뒤");
    const after = applyReplacement(snapshot, "X");
    expect(after).toBe("앞\uD83DX");
    expect(utf8(after).toString("utf8")).toBe("앞�X");
  });

  it("accepts NaN/fractional offsets without an error", () => {
    expect(() => captureScope("n.md", "abcdef", "selection", { from: Number.NaN, to: 3 })).not.toThrow();
    const fractional = captureScope("n.md", "abcdef", "selection", { from: 1.5, to: 3.5 });
    expect([fractional.from, fractional.to]).toEqual([1.5, 3.5]);
  });
});

describe("REPRO F3: NFC -> NFD rewrite has no gate signal", () => {
  it("passes validation without warnings and renders identically in review", () => {
    const nfc = "한글 노트\n";
    const nfd = nfc.normalize("NFD");
    const snapshot = captureScope("n.md", nfc, "body");
    const validation = validateReplacement(snapshot, nfd, MAX);
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
    const diff = diffLines(nfc, nfd);
    expect(diff.operations.map((op) => op.kind)).toEqual(["remove", "add"]);
    const [removed, added] = diff.operations.map((op) => visibleReviewText(op.lines[0]?.text ?? ""));
    expect(removed).not.toBe(added);
    expect(removed?.normalize("NFC")).toBe(added?.normalize("NFC"));
    expect(added).not.toContain("⟦");
  });
});

describe("covered: gate invariants hold for Korean/NFD text", () => {
  const notes: Array<[string, ScopeKind, { from: number; to: number } | undefined]> = [
    ["---\n제목: 한글\n---\n본문 첫 줄\n둘째\n", "body", undefined],
    ["---\n제목: 한글\n---\n본문 첫 줄\n", "frontmatter", undefined],
    ["앞부분 한글 中間 뒷부분\n", "selection", { from: 4, to: 6 }],
    ["앞부분 한글 中間 뒷부분\n".normalize("NFD"), "selection", { from: 3, to: 9 }],
  ];

  for (const [note, scope, selection] of notes) {
    it(`${scope} edit leaves bytes outside the scope identical (${note.length} units)`, () => {
      const editor = new Cm6Editor(note);
      const snapshot = captureScope("synthetic/노트.md", editor.getValue(), scope, selection);
      const proposal = scope === "frontmatter" ? "---\n제목: 바뀐 한글\n---\n" : "바뀐 ﾃｷｽﾄ 한글".normalize("NFD");
      const result = gate(editor, "synthetic/노트.md", snapshot, proposal);
      expect(result.status).toBe("applied");
      const value = editor.getValue();
      expect(value).toBe(applyReplacement(snapshot, proposal));
      expect(utf8(value.slice(0, snapshot.from)).equals(utf8(note.slice(0, snapshot.from)))).toBe(true);
      const suffix = note.slice(snapshot.to);
      expect(utf8(value.slice(value.length - suffix.length)).equals(utf8(suffix))).toBe(true);
      // Diff reconstructs exactly what was inserted.
      if (result.status === "applied") {
        const rebuilt = result.reviewed.operations
          .filter((op) => op.kind !== "remove")
          .flatMap((op) => op.lines.map((line) => line.text + line.ending))
          .join("");
        expect(rebuilt).toBe(result.effective);
      }
    });
  }

  it("rejects stale approvals after NFC->NFD, path change, or one-character edit", () => {
    const note = "한글 본문\n";
    const snapshot = captureScope("a.md", note, "body");
    expect(isSnapshotCurrent(snapshot, "a.md", note.normalize("NFD"))).toBe(false);
    expect(isSnapshotCurrent(snapshot, "b.md", note)).toBe(false);
    expect(isSnapshotCurrent(snapshot, "a.md", `${note} `)).toBe(false);
    const editor = new Cm6Editor(note);
    gate(editor, "a.md", snapshot, "첫 번째 승인\n");
    expect(gate(editor, "a.md", snapshot, "두 번째 승인\n").status).toBe("stale");
    expect(editor.getValue()).toBe("첫 번째 승인\n");
  });

  it("frontmatter proposals cannot carry body text past the block", () => {
    const snapshot = captureScope("n.md", "---\na: 1\n---\n본문\n", "frontmatter");
    expect(validateReplacement(snapshot, "---\na: 2\n---\n탈출\n", MAX).ok).toBe(false);
    expect(validateReplacement(snapshot, "---\na: 2\n---", MAX).ok).toBe(false);
  });

  it("replacementForSnapshot is idempotent, so the triple call in chat-view is safe", () => {
    for (const note of ["---\na: 1\n---", "---\r\na: 1\r\n---", "---\na: 1\n---\n본문"]) {
      const snapshot = captureScope("n.md", note, "body");
      const once = replacementForSnapshot(snapshot, "새 본문");
      expect(replacementForSnapshot(snapshot, once)).toBe(once);
    }
  });
});
