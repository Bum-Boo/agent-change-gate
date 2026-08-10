import { findFrontmatterRange } from "./scope";
import type { ReplacementValidation, ScopeSnapshot } from "./types";

export type YamlParser = (yaml: string) => unknown;

const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const BIDI_FORMATTING = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const NON_ASCII_SEPARATOR = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function extractYamlBody(frontmatter: string): string {
  const lines = frontmatter.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return lines.slice(1, -1).join("\n");
}

export function validateReplacement(
  snapshot: ScopeSnapshot,
  replacement: string,
  maxChars: number,
  parseYaml?: YamlParser,
): ReplacementValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!replacement.trim()) {
    errors.push("The ACP agent returned an empty edit. Empty replacements are blocked.");
  }
  if (DISALLOWED_CONTROLS.test(replacement)) {
    errors.push("The proposed edit contains a disallowed control character.");
  }
  if (BIDI_FORMATTING.test(replacement)) {
    errors.push("The proposed edit contains bidirectional formatting controls that can spoof visual review.");
  }
  if (hasLoneSurrogate(replacement)) {
    errors.push("The proposed edit contains an unpaired UTF-16 surrogate that may change when written.");
  }
  if (/[\u2028\u2029]/u.test(replacement)) {
    errors.push("The proposed edit contains a Unicode line or paragraph separator that can spoof diff line boundaries.");
  }
  if (DEFAULT_IGNORABLE.test(replacement) || NON_ASCII_SEPARATOR.test(replacement)) {
    warnings.push("The proposal contains invisible or non-ASCII separator characters. They are shown as labeled Unicode markers in the diff.");
  }
  if (replacement.length > maxChars) {
    errors.push(`The proposed edit exceeds the ${maxChars.toLocaleString()} character limit.`);
  }

  if (snapshot.scope === "frontmatter") {
    const range = findFrontmatterRange(replacement);
    if (!range || replacement.slice(range.to).trim()) {
      errors.push("A frontmatter edit must be one complete YAML frontmatter block.");
    } else {
      if (snapshot.to < snapshot.fullText.length && !replacement.endsWith("\n")) {
        errors.push("A frontmatter replacement must end with a newline when a note body follows it.");
      }
      if (parseYaml) {
        try {
          parseYaml(extractYamlBody(replacement));
        } catch {
          errors.push("The proposed frontmatter is not valid YAML.");
        }
      }
    }
  }

  if (snapshot.scope === "body" && snapshot.from === 0 && /^---[\t ]*(?:\r?\n|$)/.test(replacement)) {
    warnings.push("This edit introduces YAML frontmatter into a note that did not have it.");
  }

  const originalLength = Math.max(1, snapshot.originalScope.length);
  const deletionRatio = 1 - replacement.length / originalLength;
  if (originalLength >= 200 && deletionRatio >= 0.5) {
    warnings.push(`Large deletion: the proposed scope is ${Math.round(deletionRatio * 100)}% shorter.`);
  }
  if (replacement === snapshot.originalScope) {
    warnings.push("The proposed edit is identical to the captured text.");
  }

  return { ok: errors.length === 0, errors, warnings };
}
