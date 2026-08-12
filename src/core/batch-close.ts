export type VaultBatchCloseDecision =
  | "block_applying"
  | "confirm_cancel_generation"
  | "confirm_discard_drafts"
  | "close";

export interface VaultBatchCloseState {
  applying: boolean;
  generating: boolean;
  discardableDrafts: number;
}

/**
 * Chooses the safest response to a user request to close the batch review.
 * Writes always take priority over generation, and active generation takes
 * priority over already-produced drafts.
 */
export function decideVaultBatchClose(state: VaultBatchCloseState): VaultBatchCloseDecision {
  if (state.applying) return "block_applying";
  if (state.generating) return "confirm_cancel_generation";
  if (state.discardableDrafts > 0) return "confirm_discard_drafts";
  return "close";
}

export interface VaultBatchRunState {
  preparing: boolean;
  generating: boolean;
  applying: boolean;
  closed: boolean;
}

export function canBeginVaultBatchRun(state: VaultBatchRunState): boolean {
  return !state.preparing && !state.generating && !state.applying && !state.closed;
}

export type VaultBatchTurnBlockReason =
  | "cancelled"
  | "recovery_locked"
  | "agent_changed"
  | null;

export interface VaultBatchTurnGuard {
  expectedRunToken: unknown;
  currentRunToken: unknown;
  cancelled: boolean;
  closed: boolean;
  recoveryLocked: boolean;
  expectedAgentContextId: string;
  currentAgentContextId: string | null;
}

/** Rechecks every mutable boundary immediately before a potentially billed turn. */
export function vaultBatchTurnBlockReason(state: VaultBatchTurnGuard): VaultBatchTurnBlockReason {
  if (
    state.expectedRunToken !== state.currentRunToken
    || state.cancelled
    || state.closed
  ) return "cancelled";
  if (state.recoveryLocked) return "recovery_locked";
  if (state.currentAgentContextId !== state.expectedAgentContextId) return "agent_changed";
  return null;
}

export interface VaultBatchSetupIdentity {
  agentContextId: string | null;
  instruction: string;
  paths: readonly string[];
  scope: "body" | "frontmatter";
}

/** Compares the complete user-controlled setup across asynchronous preparation boundaries. */
export function sameVaultBatchSetup(
  expected: Readonly<VaultBatchSetupIdentity>,
  current: Readonly<VaultBatchSetupIdentity>,
): boolean {
  return expected.agentContextId === current.agentContextId
    && expected.instruction === current.instruction
    && expected.scope === current.scope
    && expected.paths.length === current.paths.length
    && expected.paths.every((path, index) => path === current.paths[index]);
}
