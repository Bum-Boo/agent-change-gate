import { describe, expect, it } from "vitest";

import { captureScope } from "../src/core/scope";
import { validateReplacement } from "../src/core/safety";

describe("replacement safety", () => {
  it("blocks empty replacements", () => {
    const snapshot = captureScope("Note.md", "content", "body");
    expect(validateReplacement(snapshot, "   ", 10_000).ok).toBe(false);
  });

  it("blocks malformed frontmatter replacements", () => {
    const snapshot = captureScope("Note.md", "---\ntitle: A\n---\nBody", "frontmatter");
    expect(validateReplacement(snapshot, "title: Missing fences", 10_000).ok).toBe(false);
    expect(validateReplacement(snapshot, "---\ntitle: B\n---\n", 10_000).ok).toBe(true);
    const parseYaml = (yaml: string): void => {
      if (yaml.includes("[")) throw new Error("Invalid YAML");
    };
    expect(validateReplacement(snapshot, "---\ntitle: [\n---\n", 10_000, parseYaml).ok).toBe(false);
    expect(validateReplacement(snapshot, "---\ntitle: B\n---", 10_000, parseYaml).ok).toBe(false);
  });

  it("warns on large deletion without silently rejecting a reviewed edit", () => {
    const snapshot = captureScope("Note.md", "x".repeat(500), "body");
    const result = validateReplacement(snapshot, "short", 10_000);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Large deletion/);
  });

  it("blocks oversized, control-bearing, and bidi-spoofing output", () => {
    const snapshot = captureScope("Note.md", "content", "body");
    expect(validateReplacement(snapshot, "x".repeat(101), 100).ok).toBe(false);
    expect(validateReplacement(snapshot, "bad\u0000text", 100).ok).toBe(false);
    expect(validateReplacement(snapshot, "bad\u0007text", 100).ok).toBe(false);
    expect(validateReplacement(snapshot, "visible\u202Efdp.exe", 100).ok).toBe(false);
    expect(validateReplacement(snapshot, "line\u2028break", 100).ok).toBe(false);
    expect(validateReplacement(snapshot, "bad\uD800text", 100).ok).toBe(false);
    expect(validateReplacement(snapshot, "bad\uD800", 100).ok).toBe(false);
  });

  it("warns when zero-width formatting will be made visible in the diff", () => {
    const snapshot = captureScope("Note.md", "content", "body");
    const result = validateReplacement(snapshot, "family\u200Dtext", 100);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/invisible/i);
  });
});
