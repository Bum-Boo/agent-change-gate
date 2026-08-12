import { describe, expect, it } from "vitest";

import {
  canBeginVaultBatchRun,
  decideVaultBatchClose,
  sameVaultBatchSetup,
  vaultBatchTurnBlockReason,
} from "../src/core/batch-close";

describe("vault batch close decisions", () => {
  it("blocks every close path while reviewed edits are being applied", () => {
    expect(decideVaultBatchClose({
      applying: true,
      generating: true,
      discardableDrafts: 3,
    })).toBe("block_applying");
  });

  it("requires cancel-and-close confirmation during draft generation", () => {
    expect(decideVaultBatchClose({
      applying: false,
      generating: true,
      discardableDrafts: 2,
    })).toBe("confirm_cancel_generation");
  });

  it("requires confirmation before unapplied drafts are discarded", () => {
    expect(decideVaultBatchClose({
      applying: false,
      generating: false,
      discardableDrafts: 1,
    })).toBe("confirm_discard_drafts");
  });

  it("closes immediately when no write, generation, or unapplied draft remains", () => {
    expect(decideVaultBatchClose({
      applying: false,
      generating: false,
      discardableDrafts: 0,
    })).toBe("close");
  });
});

describe("vault batch immutable setup", () => {
  const expected = {
    agentContextId: "agent-a@hash",
    instruction: "Normalize headings",
    paths: ["A.md", "Folder/B.md"],
    scope: "body" as const,
  };

  it("accepts only the exact agent, instruction, scope, and ordered path snapshot", () => {
    expect(sameVaultBatchSetup(expected, { ...expected })).toBe(true);
    expect(sameVaultBatchSetup(expected, { ...expected, agentContextId: "agent-b@hash" })).toBe(false);
    expect(sameVaultBatchSetup(expected, { ...expected, instruction: "Different" })).toBe(false);
    expect(sameVaultBatchSetup(expected, { ...expected, scope: "frontmatter" })).toBe(false);
    expect(sameVaultBatchSetup(expected, { ...expected, paths: ["A.md"] })).toBe(false);
    expect(sameVaultBatchSetup(expected, { ...expected, paths: ["Folder/B.md", "A.md"] })).toBe(false);
  });
});

describe("vault batch run guards", () => {
  it("permits only one preparation, generation, or apply operation at a time", () => {
    expect(canBeginVaultBatchRun({ preparing: false, generating: false, applying: false, closed: false })).toBe(true);
    expect(canBeginVaultBatchRun({ preparing: true, generating: false, applying: false, closed: false })).toBe(false);
    expect(canBeginVaultBatchRun({ preparing: false, generating: true, applying: false, closed: false })).toBe(false);
    expect(canBeginVaultBatchRun({ preparing: false, generating: false, applying: true, closed: false })).toBe(false);
    expect(canBeginVaultBatchRun({ preparing: false, generating: false, applying: false, closed: true })).toBe(false);
  });

  it("blocks a turn when its immutable run token no longer owns the review", () => {
    expect(vaultBatchTurnBlockReason({
      expectedRunToken: Symbol("old"),
      currentRunToken: Symbol("new"),
      cancelled: false,
      closed: false,
      recoveryLocked: false,
      expectedAgentContextId: "agent-a",
      currentAgentContextId: "agent-a",
    })).toBe("cancelled");
  });

  it("blocks a turn after cancellation, recovery lock, or agent identity change", () => {
    const token = Symbol("run");
    const base = {
      expectedRunToken: token,
      currentRunToken: token,
      cancelled: false,
      closed: false,
      recoveryLocked: false,
      expectedAgentContextId: "agent-a",
      currentAgentContextId: "agent-a",
    };
    expect(vaultBatchTurnBlockReason({ ...base, cancelled: true })).toBe("cancelled");
    expect(vaultBatchTurnBlockReason({ ...base, recoveryLocked: true })).toBe("recovery_locked");
    expect(vaultBatchTurnBlockReason({ ...base, currentAgentContextId: "agent-b" })).toBe("agent_changed");
    expect(vaultBatchTurnBlockReason(base)).toBeNull();
  });
});
