import { describe, expect, it } from "vitest";

import { diffLines, type LineDiffOperation } from "../src/core/diff";
import { visibleReviewText } from "../src/core/review-text";
import { validateReplacement } from "../src/core/safety";
import {
  applyReplacement,
  captureScope,
  findFrontmatterRange,
  hashText,
  isSnapshotCurrent,
  resolveScopeRange,
} from "../src/core/scope";
import type { ScopeKind } from "../src/core/types";

const FRONT = "---\n제목: 연구 노트 😀\n태그: [대학원, 논문]\n---\n";
const NOTES: Record<string, string> = {
  lf: `${FRONT}# 서론\n가나다 👨‍👩‍👧 é 🇰🇷\n끝`,
  crlf: FRONT.replace(/\n/g, "\r\n") + "# 서론\r\n가나다 😀\r\n끝\r\n",
  noBody: "---\n제목: 빈 본문\n---\n",
  noBodyEof: "---\n제목: 빈 본문\n---",
  noFrontmatter: "한글 😀 only\n",
  empty: "",
  invisible: `${FRONT}a​b cㅤd e﻿`,
};
const REPLACEMENTS = ["새 본문", "😀 새\r\n본문\n", "x​y", "한́글"];

const text = (operation: LineDiffOperation): string =>
  operation.lines.map((line) => `${line.text}${line.ending}`).join("");

describe("scope replacement keeps everything outside the captured scope", () => {
  const scopes: ScopeKind[] = ["body", "frontmatter", "selection"];
  for (const [name, note] of Object.entries(NOTES)) {
    for (const scope of scopes) {
      for (const replacement of REPLACEMENTS) {
        it(`${name}/${scope}/${JSON.stringify(replacement)}`, () => {
          let snapshot;
          try {
            snapshot = captureScope("N.md", note, scope, { from: 0, to: Math.min(note.length, 5) });
          } catch {
            // frontmatter on a note without it, selection on an empty note: refusal is the contract.
            return;
          }
          expect(note.slice(snapshot.from, snapshot.to)).toBe(snapshot.originalScope);
          const after = applyReplacement(snapshot, replacement);
          const prefix = note.slice(0, snapshot.from);
          const suffix = note.slice(snapshot.to);
          expect(after.startsWith(prefix)).toBe(true);
          expect(after.endsWith(suffix)).toBe(true);
          const middle = after.slice(prefix.length, after.length - suffix.length);
          // Only a single line break may be added, and only for body-after-unterminated-frontmatter.
          expect([replacement, `\n${replacement}`, `\r\n${replacement}`]).toContain(middle);
          expect(Buffer.from(prefix + suffix, "utf8").equals(
            Buffer.from(after.slice(0, prefix.length) + after.slice(after.length - suffix.length), "utf8"),
          )).toBe(true);
          // The diff the reviewer sees reconstructs both sides exactly.
          const ops = diffLines(note, after).operations;
          expect(ops.filter((o) => o.kind !== "add").map(text).join("")).toBe(note);
          expect(ops.filter((o) => o.kind !== "remove").map(text).join("")).toBe(after);
        });
      }
    }
  }

  it("treats an empty body as an insertion point, with and without a trailing newline", () => {
    const withNewline = captureScope("N.md", NOTES.noBody!, "body");
    expect([withNewline.from, withNewline.to]).toEqual([NOTES.noBody!.length, NOTES.noBody!.length]);
    expect(applyReplacement(withNewline, "본문")).toBe(`${NOTES.noBody}본문`);
    const eof = captureScope("N.md", NOTES.noBodyEof!, "body");
    expect(applyReplacement(eof, "본문")).toBe(`${NOTES.noBodyEof}\n본문`);
    const crlf = captureScope("N.md", "---\r\na: 1\r\n---", "body");
    expect(applyReplacement(crlf, "본문")).toBe("---\r\na: 1\r\n---\r\n본문");
  });

  it("covers the entire note when there is no frontmatter", () => {
    const note = NOTES.noFrontmatter!;
    const snapshot = captureScope("N.md", note, "body");
    expect([snapshot.from, snapshot.to]).toEqual([0, note.length]);
    expect(applyReplacement(snapshot, "전체")).toBe("전체");
  });
});

describe("selection range validation", () => {
  const note = "가😀나 é 끝";
  const emoji = note.indexOf("😀");

  it("normalizes reversed ranges and clamps to the note", () => {
    expect(resolveScopeRange(note, "selection", { from: 3, to: 0 })).toEqual({ from: 0, to: 3 });
    expect(resolveScopeRange(note, "selection", { from: -5, to: 1 })).toEqual({ from: 0, to: 1 });
    expect(resolveScopeRange(note, "selection", { from: 1, to: 999 })).toEqual({ from: 1, to: note.length });
  });

  it.each([
    [0, 0], [5, 5], [note.length, note.length], [note.length + 1, note.length + 9], [-9, -1],
  ])("rejects empty or out-of-note range %i..%i", (from, to) => {
    expect(() => resolveScopeRange(note, "selection", { from, to })).toThrow();
  });

  it.each([[NaN, 3], [1, NaN], [NaN, NaN], [1.5, 3], [0, 2.25]])(
    "rejects non-integer offsets %s..%s instead of capturing a NaN/fractional scope",
    (from, to) => {
      expect(() => captureScope("N.md", note, "selection", { from, to })).toThrow(/whole numbers/);
    },
  );

  it("rejects a boundary inside a surrogate pair but allows pair-aligned and combining-mark cuts", () => {
    expect(() => resolveScopeRange(note, "selection", { from: emoji + 1, to: note.length })).toThrow(/surrogate/);
    expect(() => resolveScopeRange(note, "selection", { from: 0, to: emoji + 1 })).toThrow(/surrogate/);
    expect(resolveScopeRange(note, "selection", { from: emoji, to: emoji + 2 })).toEqual({ from: emoji, to: emoji + 2 });
    const mark = note.indexOf("́");
    expect(resolveScopeRange(note, "selection", { from: 0, to: mark })).toEqual({ from: 0, to: mark });
  });

  it("round-trips an aligned emoji selection byte-for-byte", () => {
    const snapshot = captureScope("N.md", note, "selection", { from: emoji, to: emoji + 2 });
    expect(snapshot.originalScope).toBe("😀");
    const after = applyReplacement(snapshot, "🙂");
    expect(after).toBe(note.replace("😀", "🙂"));
    expect(Buffer.from(after, "utf8").toString("utf8")).toBe(after);
  });
});

describe("frontmatter detection", () => {
  it.each([
    ["---\na: 1\n---\nB", 13],
    ["---\r\na: 1\r\n...\r\nB", 16],
    ["---\na: 1\n---", 12],
    ["---\n---\n", 8],
    ["---  \n가: 나\n---  \n본문", 17],
  ])("%j ends at %i", (note, to) => {
    expect(findFrontmatterRange(note)).toEqual({ from: 0, to });
  });

  it.each(["---\n", "---", "---\na: 1\n", "﻿---\na: 1\n---\n", " ---\na: 1\n---\n", "----\na: 1\n---\n"])(
    "does not treat %j as frontmatter",
    (note) => {
      expect(findFrontmatterRange(note)).toBeNull();
    },
  );
});

describe("stale snapshot refusal", () => {
  const note = NOTES.lf!;
  const snapshot = captureScope("N.md", note, "body");

  it.each([
    ["other path", "M.md", note],
    ["NFC to NFD", "N.md", note.replace("서론", "서론".normalize("NFD"))],
    ["one added emoji", "N.md", `${note}😀`],
    ["CRLF conversion", "N.md", note.replace(/\n/g, "\r\n")],
    ["zero-width insertion", "N.md", note.replace("서론", "서​론")],
    ["frontmatter-only change", "N.md", note.replace("연구", "연구2")],
    ["trailing newline", "N.md", `${note}\n`],
  ])("refuses %s", (_label, path, current) => {
    expect(current === note && path === "N.md").toBe(false);
    expect(isSnapshotCurrent(snapshot, path, current)).toBe(false);
  });

  it("accepts only the identical path and text", () => {
    expect(isSnapshotCurrent(snapshot, "N.md", note)).toBe(true);
    expect(isSnapshotCurrent(snapshot, "N.md", String(note))).toBe(true);
    expect(snapshot.fullHash).toBe(hashText(note));
  });

  it("does not let a lone surrogate hash-collide with U+FFFD", () => {
    const lone = captureScope("N.md", "a\uD800b", "body");
    expect(lone.fullHash).toBe(hashText("a�b"));
    expect(isSnapshotCurrent(lone, "N.md", "a�b")).toBe(false);
  });
});

describe("replacement safety for Unicode input", () => {
  const snapshot = captureScope("N.md", NOTES.lf!, "body");
  const ok = (replacement: string) => validateReplacement(snapshot, replacement, 1000);

  it.each(["\uD83D", "\uDE00x", "a‮b", "a b", "a b", "a\u0085b", "a\u0000b", "a\u007Fb"])(
    "blocks %j", (replacement) => {
      expect(ok(replacement).ok).toBe(false);
    },
  );

  it.each(["한글 😀 👨‍👩‍👧 é", "a\r\nb\tc", "🇰🇷"])("allows ordinary %j without warnings", (replacement) => {
    const result = ok(replacement);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((w) => /invisible/.test(w))).toHaveLength(0 + (/‍/.test(replacement) ? 1 : 0));
  });

  it.each(["a​b", "aㅤb", "a b", "a﻿b", "a️b"])("warns about invisible %j", (replacement) => {
    const result = ok(replacement);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/invisible/);
  });

  it("counts the length limit in UTF-16 units", () => {
    expect(validateReplacement(snapshot, "😀😀", 3).ok).toBe(false);
    expect(validateReplacement(snapshot, "😀😀", 4).ok).toBe(true);
  });

  it("requires a frontmatter replacement to be one block that ends with a newline before a body", () => {
    const fm = captureScope("N.md", NOTES.lf!, "frontmatter");
    expect(validateReplacement(fm, "---\n제목: 😀\n---\n", 1000).ok).toBe(true);
    expect(validateReplacement(fm, "---\n제목: 😀\n---", 1000).ok).toBe(false);
    expect(validateReplacement(fm, "---\n제목: 😀\n---\n본문 추가", 1000).ok).toBe(false);
    expect(validateReplacement(fm, "﻿---\n제목\n---\n", 1000).ok).toBe(false);
  });
});

describe("review text exposes hidden characters", () => {
  it("never silently drops or reorders visible characters", () => {
    const input = "가​나‍😀ㅤ다 라 마﻿바́️\t\u0085\uD800";
    const visible = visibleReviewText(input);
    for (const code of ["200B", "200D", "3164", "00A0", "2028", "FEFF", "FE0F", "0009", "0085", "D800"]) {
      expect(visible).toContain(`⟦U+${code} `);
    }
    // Stripping the markers restores every ordinary character in order.
    expect(visible.replace(/⟦[^⟧]*⟧/gu, "")).toBe("가나😀다라마바́");
  });

  it("keeps paired surrogates, emoji ZWJ sequences, CR and LF intact", () => {
    expect(visibleReviewText("😀\r\n🇰🇷")).toBe("😀\r\n🇰🇷");
    expect(visibleReviewText("👨‍👩")).toBe("👨⟦U+200D ZERO WIDTH JOINER⟧👩");
  });

  it("labels trailing ordinary spaces but not interior ones", () => {
    expect(visibleReviewText("a b ")).toBe("a b⟦TRAILING SPACE⟧");
    expect(visibleReviewText("a  ")).toBe("a⟦2 TRAILING SPACES⟧");
  });

  it("is distinct for strings that differ only by an invisible character", () => {
    expect(visibleReviewText("한글")).not.toBe(visibleReviewText("한​글"));
    expect(visibleReviewText("a b")).not.toContain(" ");
  });
});

describe("line diff over Unicode and mixed line endings", () => {
  const cases: Array<[string, string]> = [
    ["", ""], ["가", ""], ["", "가\n"], ["가\r\n나", "가\n나"], ["가\r나", "가\r\n나"],
    ["a b\n", "a\nb\n"], ["😀\n\n\n", "😀\n"], ["x\r\n\r\n", "x\n\n"],
    ["가\n나\n다\n", "다\n가\n나\n"], ["\n", ""], ["\r", "\r\r"],
  ];
  it.each(cases)("reconstructs %j -> %j exactly", (before, after) => {
    const { operations, exact } = diffLines(before, after);
    expect(exact).toBe(true);
    expect(operations.filter((o) => o.kind !== "add").map(text).join("")).toBe(before);
    expect(operations.filter((o) => o.kind !== "remove").map(text).join("")).toBe(after);
  });

  it("does not split lines on U+2028/U+2029/U+0085 and distinguishes endings", () => {
    expect(diffLines("a b", "a b").operations).toHaveLength(1);
    expect(diffLines("a\u0085b c", "a\u0085b c").operations[0]?.lines).toHaveLength(1);
    expect(diffLines("a\r\n", "a\n").operations.some((o) => o.kind !== "equal")).toBe(true);
  });

  it("reconstructs deterministic pseudo-random line shuffles", () => {
    const pool = ["가", "나́", "😀", "", "x\r", "​"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const make = () => Array.from({ length: next() % 9 }, () => pool[next() % pool.length]! + ["\n", "\r\n", "\r", ""][next() % 4]!).join("");
    for (let i = 0; i < 150; i += 1) {
      const before = make();
      const after = make();
      const { operations } = diffLines(before, after);
      expect(operations.filter((o) => o.kind !== "add").map(text).join("")).toBe(before);
      expect(operations.filter((o) => o.kind !== "remove").map(text).join("")).toBe(after);
    }
  });
});
