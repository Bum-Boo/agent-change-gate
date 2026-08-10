import { describe, expect, it } from "vitest";

import {
  MAX_INSTRUCTION_CHARS,
  instructionError,
  shouldSubmitComposer,
} from "../src/core/input";

describe("composer keyboard handling", () => {
  it("does not send while a Korean IME composition is active", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("uses Enter to send and Shift+Enter for a newline", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("blocks empty and oversized instructions before persistence or transport", () => {
    expect(instructionError("   ")).toBe("Write a message first.");
    expect(instructionError("x".repeat(MAX_INSTRUCTION_CHARS))).toBeNull();
    expect(instructionError("x".repeat(MAX_INSTRUCTION_CHARS + 1))).toContain("character limit");
  });
});
