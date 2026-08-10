const REVIEW_INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF\t]|\p{Default_Ignorable_Code_Point}|\p{Zl}|\p{Zp}|\p{Zs}/gu;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const SEPARATOR = /[\p{Zl}\p{Zp}\p{Zs}]/u;

const NAMES: Readonly<Record<number, string>> = {
  0x0009: "TAB",
  0x00ad: "SOFT HYPHEN",
  0x061c: "ARABIC LETTER MARK",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x2060: "WORD JOINER",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE",
};

function marker(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0x0020) return character;
  const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
  const fallback = DEFAULT_IGNORABLE.test(character)
    ? "DEFAULT IGNORABLE"
    : SEPARATOR.test(character)
      ? "SEPARATOR"
      : codePoint >= 0xd800 && codePoint <= 0xdfff
        ? "LONE SURROGATE"
        : "CONTROL";
  return `⟦U+${hex} ${NAMES[codePoint] ?? fallback}⟧`;
}

/** Makes review-spoofing and whitespace characters visible without changing the proposed text. */
export function visibleReviewText(text: string): string {
  const visible = text.replace(REVIEW_INVISIBLE, marker);
  return visible.replace(/ +$/u, (spaces) => (
    spaces.length === 1 ? "⟦TRAILING SPACE⟧" : `⟦${spaces.length} TRAILING SPACES⟧`
  ));
}
