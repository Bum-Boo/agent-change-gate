import { hashText } from "./scope";

export const BATCH_RECOVERY_SCHEMA_VERSION = 1 as const;
export const MAX_BATCH_RECOVERY_ENTRIES = 20;
export const BATCH_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_BATCH_RECOVERY_PATH_CHARS = 1_024;
export const MAX_BATCH_RECOVERY_SCOPE_CHARS = 300_000;
export const MAX_BATCH_RECOVERY_TOTAL_SCOPE_CHARS = 1_000_000;
export const MAX_BATCH_RECOVERY_FILE_CHARS = 10_000_000;

export type BatchRecoveryScope = "body" | "frontmatter";
export type BatchRecoveryEntryState = "pending" | "written" | "rolled_back" | "conflict";
export type BatchRecoveryPhase = "prepared" | "applying" | "rolling_back" | "completed" | "recovery_required";

/**
 * A compact proof sufficient to classify and safely reverse one scope
 * replacement. It intentionally stores no after-text and no full before-text.
 */
export interface BatchRecoveryEntry {
  path: string;
  scope: BatchRecoveryScope;
  from: number;
  beforeScope: string;
  beforeFullHash: string;
  afterScopeLength: number;
  afterFullHash: string;
  state: BatchRecoveryEntryState;
}

export interface BatchRecoveryJournal {
  schemaVersion: typeof BATCH_RECOVERY_SCHEMA_VERSION;
  id: string;
  createdAt: number;
  updatedAt: number;
  phase: BatchRecoveryPhase;
  agentContextId: string;
  entries: BatchRecoveryEntry[];
}

export type BatchRecoveryClassification = "before" | "after" | "conflict";

export interface BatchRecoveryClassificationResult {
  classification: BatchRecoveryClassification;
  currentHash: string;
}

export type BatchRecoveryRestoreFailure =
  | "current_not_after"
  | "range_out_of_bounds"
  | "reconstructed_hash_mismatch";

export type BatchRecoveryRestoreResult =
  | {
    ok: true;
    restoredText: string;
    currentHash: string;
    restoredHash: string;
  }
  | {
    ok: false;
    reason: BatchRecoveryRestoreFailure;
    currentHash: string;
    reconstructedHash?: string;
  };

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9@._:-]{0,127}$/;
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const PHASES = new Set<BatchRecoveryPhase>([
  "prepared",
  "applying",
  "rolling_back",
  "completed",
  "recovery_required",
]);
const STATES = new Set<BatchRecoveryEntryState>([
  "pending",
  "written",
  "rolled_back",
  "conflict",
]);

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isCanonicalRecoveryPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_BATCH_RECOVERY_PATH_CHARS
    || UNSAFE_PATH_CHARACTERS.test(value)
    || value.startsWith("/")
    || value.includes("\\")
    || /^[a-zA-Z]:/u.test(value)
    || !/\.md$/iu.test(value)
  ) {
    return false;
  }

  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function hydrateEntry(input: unknown): BatchRecoveryEntry | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Partial<BatchRecoveryEntry>;
  if (
    !isCanonicalRecoveryPath(record.path)
    || (record.scope !== "body" && record.scope !== "frontmatter")
    || !isSafeIntegerInRange(record.from, 0, MAX_BATCH_RECOVERY_FILE_CHARS)
    || typeof record.beforeScope !== "string"
    || record.beforeScope.length > MAX_BATCH_RECOVERY_SCOPE_CHARS
    || typeof record.beforeFullHash !== "string"
    || !SHA256.test(record.beforeFullHash)
    || !isSafeIntegerInRange(record.afterScopeLength, 0, MAX_BATCH_RECOVERY_SCOPE_CHARS)
    || typeof record.afterFullHash !== "string"
    || !SHA256.test(record.afterFullHash)
    || record.beforeFullHash === record.afterFullHash
    || !STATES.has(record.state as BatchRecoveryEntryState)
  ) {
    return null;
  }

  return {
    path: record.path,
    scope: record.scope,
    from: record.from,
    beforeScope: record.beforeScope,
    beforeFullHash: record.beforeFullHash,
    afterScopeLength: record.afterScopeLength,
    afterFullHash: record.afterFullHash,
    state: record.state as BatchRecoveryEntryState,
  };
}

/**
 * Strictly reconstructs one active recovery journal from untrusted persisted
 * data. Expired, oversized, duplicate-path, or malformed journals are refused
 * as a whole so callers never act on a partial recovery record.
 */
export function hydrateBatchRecoveryJournal(
  input: unknown,
  now = Date.now(),
  retainExpiredCompleted = false,
): BatchRecoveryJournal | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Partial<BatchRecoveryJournal>;
  if (
    record.schemaVersion !== BATCH_RECOVERY_SCHEMA_VERSION
    || typeof record.id !== "string"
    || !SAFE_IDENTIFIER.test(record.id)
    || !isSafeIntegerInRange(record.createdAt, 0, Number.MAX_SAFE_INTEGER)
    || !isSafeIntegerInRange(record.updatedAt, record.createdAt, Number.MAX_SAFE_INTEGER)
    || !PHASES.has(record.phase as BatchRecoveryPhase)
    || (
      record.phase === "completed"
      && !retainExpiredCompleted
      && record.updatedAt < now - BATCH_RECOVERY_RETENTION_MS
    )
    || typeof record.agentContextId !== "string"
    || !SAFE_IDENTIFIER.test(record.agentContextId)
    || !Array.isArray(record.entries)
    || record.entries.length === 0
    || record.entries.length > MAX_BATCH_RECOVERY_ENTRIES
  ) {
    return null;
  }

  const entries: BatchRecoveryEntry[] = [];
  const paths = new Set<string>();
  let totalScopeChars = 0;
  for (const inputEntry of record.entries) {
    const entry = hydrateEntry(inputEntry);
    if (!entry) return null;
    const pathIdentity = entry.path.toLocaleLowerCase("en-US");
    if (paths.has(pathIdentity)) return null;
    paths.add(pathIdentity);
    totalScopeChars += entry.beforeScope.length;
    if (totalScopeChars > MAX_BATCH_RECOVERY_TOTAL_SCOPE_CHARS) return null;
    entries.push(entry);
  }

  return {
    schemaVersion: BATCH_RECOVERY_SCHEMA_VERSION,
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    phase: record.phase as BatchRecoveryPhase,
    agentContextId: record.agentContextId,
    entries,
  };
}

/** Classifies current full text without attempting a write or reconstruction. */
export function classifyBatchRecoveryEntry(
  entry: BatchRecoveryEntry,
  currentText: string,
): BatchRecoveryClassificationResult {
  const currentHash = hashText(currentText);
  return {
    currentHash,
    classification: currentHash === entry.beforeFullHash
      ? "before"
      : currentHash === entry.afterFullHash
        ? "after"
        : "conflict",
  };
}

/**
 * Prepares a guarded rollback in memory. The caller may write restoredText
 * only after this succeeds, and should still compare the current text again
 * inside its atomic host write callback.
 */
export function prepareBatchRecoveryRestore(
  entry: BatchRecoveryEntry,
  currentText: string,
): BatchRecoveryRestoreResult {
  const currentHash = hashText(currentText);
  if (currentHash !== entry.afterFullHash) {
    return { ok: false, reason: "current_not_after", currentHash };
  }
  if (
    entry.from > currentText.length
    || entry.afterScopeLength > currentText.length - entry.from
  ) {
    return { ok: false, reason: "range_out_of_bounds", currentHash };
  }

  const restoredText = `${currentText.slice(0, entry.from)}${entry.beforeScope}${currentText.slice(entry.from + entry.afterScopeLength)}`;
  const restoredHash = hashText(restoredText);
  if (restoredHash !== entry.beforeFullHash) {
    return {
      ok: false,
      reason: "reconstructed_hash_mismatch",
      currentHash,
      reconstructedHash: restoredHash,
    };
  }

  return { ok: true, restoredText, currentHash, restoredHash };
}
