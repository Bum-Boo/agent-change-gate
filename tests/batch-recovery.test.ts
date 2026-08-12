import { describe, expect, it } from "vitest";

import {
  BATCH_RECOVERY_RETENTION_MS,
  BATCH_RECOVERY_SCHEMA_VERSION,
  classifyBatchRecoveryEntry,
  hydrateBatchRecoveryJournal,
  MAX_BATCH_RECOVERY_ENTRIES,
  MAX_BATCH_RECOVERY_SCOPE_CHARS,
  MAX_BATCH_RECOVERY_TOTAL_SCOPE_CHARS,
  prepareBatchRecoveryRestore,
  type BatchRecoveryEntry,
  type BatchRecoveryJournal,
} from "../src/core/batch-recovery";
import { hashText } from "../src/core/scope";

const NOW = 2_000_000_000_000;

interface RecoveryFixture {
  before: string;
  after: string;
  entry: BatchRecoveryEntry;
}

function fixture(
  beforeScope = "Old body",
  afterScope = "New body",
  prefix = "---\ntitle: A\n---\n",
): RecoveryFixture {
  const before = `${prefix}${beforeScope}`;
  const after = `${prefix}${afterScope}`;
  return {
    before,
    after,
    entry: {
      path: "Notes/A.md",
      scope: "body",
      from: prefix.length,
      beforeScope,
      beforeFullHash: hashText(before),
      afterScopeLength: afterScope.length,
      afterFullHash: hashText(after),
      state: "pending",
    },
  };
}

function journal(entries: BatchRecoveryEntry[] = [fixture().entry]): BatchRecoveryJournal {
  return {
    schemaVersion: BATCH_RECOVERY_SCHEMA_VERSION,
    id: "batch-11111111-2222-4333-8444-555555555555",
    createdAt: NOW - 2_000,
    updatedAt: NOW - 1_000,
    phase: "applying",
    agentContextId: "default@0123456789abcdef",
    entries,
  };
}

describe("batch recovery journal hydration", () => {
  it("reconstructs only known, bounded fields", () => {
    const value = journal();
    const input = {
      ...value,
      ignored: "not retained",
      entries: value.entries.map((entry) => ({ ...entry, ignored: { nested: true } })),
    };

    expect(hydrateBatchRecoveryJournal(input, NOW)).toEqual(value);
  });

  it("accepts every supported active phase and entry state", () => {
    const phases = ["prepared", "applying", "rolling_back", "completed", "recovery_required"] as const;
    const states = ["pending", "written", "rolled_back", "conflict"] as const;

    for (const phase of phases) {
      for (const state of states) {
        const value = journal([{ ...fixture().entry, state }]);
        value.phase = phase;
        expect(hydrateBatchRecoveryJournal(value, NOW)?.phase).toBe(phase);
        expect(hydrateBatchRecoveryJournal(value, NOW)?.entries[0]?.state).toBe(state);
      }
    }
  });

  it("expires only completed undo journals and retains unresolved recovery proof", () => {
    const expired = journal();
    expired.phase = "completed";
    expired.updatedAt = NOW - BATCH_RECOVERY_RETENTION_MS - 1;
    expired.createdAt = expired.updatedAt;
    expect(hydrateBatchRecoveryJournal(expired, NOW)).toBeNull();

    const boundary = journal();
    boundary.phase = "completed";
    boundary.updatedAt = NOW - BATCH_RECOVERY_RETENTION_MS;
    boundary.createdAt = boundary.updatedAt;
    expect(hydrateBatchRecoveryJournal(boundary, NOW)).not.toBeNull();

    const unresolved = journal();
    unresolved.phase = "recovery_required";
    unresolved.updatedAt = NOW - BATCH_RECOVERY_RETENTION_MS - 1;
    unresolved.createdAt = unresolved.updatedAt;
    expect(hydrateBatchRecoveryJournal(unresolved, NOW)).not.toBeNull();
  });

  it("enforces the hard entry limit and rejects an empty journal", () => {
    expect(hydrateBatchRecoveryJournal(journal([]), NOW)).toBeNull();

    const atLimit = Array.from({ length: MAX_BATCH_RECOVERY_ENTRIES }, (_, index) => ({
      ...fixture().entry,
      path: `Notes/${index}.md`,
    }));
    expect(hydrateBatchRecoveryJournal(journal(atLimit), NOW)?.entries).toHaveLength(MAX_BATCH_RECOVERY_ENTRIES);
    expect(hydrateBatchRecoveryJournal(journal([
      ...atLimit,
      { ...fixture().entry, path: "Notes/overflow.md" },
    ]), NOW)).toBeNull();
  });

  it("rejects duplicate paths case-insensitively", () => {
    expect(hydrateBatchRecoveryJournal(journal([
      fixture().entry,
      { ...fixture().entry, path: "notes/a.MD" },
    ]), NOW)).toBeNull();
  });

  it("enforces per-entry and aggregate scope-text bounds", () => {
    const oversized = {
      ...fixture().entry,
      beforeScope: "x".repeat(MAX_BATCH_RECOVERY_SCOPE_CHARS + 1),
    };
    expect(hydrateBatchRecoveryJournal(journal([oversized]), NOW)).toBeNull();

    const chunkLength = Math.floor(MAX_BATCH_RECOVERY_TOTAL_SCOPE_CHARS / 3);
    const aggregate = Array.from({ length: 4 }, (_, index) => ({
      ...fixture().entry,
      path: `Notes/large-${index}.md`,
      beforeScope: "x".repeat(chunkLength),
    }));
    expect(aggregate.reduce((sum, entry) => sum + entry.beforeScope.length, 0)).toBeGreaterThan(MAX_BATCH_RECOVERY_TOTAL_SCOPE_CHARS);
    expect(hydrateBatchRecoveryJournal(journal(aggregate), NOW)).toBeNull();
  });

  it.each([
    ["parent traversal", { path: "../A.md" }],
    ["absolute path", { path: "/Notes/A.md" }],
    ["Windows absolute path", { path: "C:/Notes/A.md" }],
    ["backslash path", { path: "Notes\\A.md" }],
    ["empty path segment", { path: "Notes//A.md" }],
    ["non-Markdown path", { path: "Notes/A.txt" }],
    ["unsupported scope", { scope: "selection" }],
    ["negative offset", { from: -1 }],
    ["fractional offset", { from: 1.5 }],
    ["negative after length", { afterScopeLength: -1 }],
    ["oversized after length", { afterScopeLength: MAX_BATCH_RECOVERY_SCOPE_CHARS + 1 }],
    ["bad before hash", { beforeFullHash: "not-a-hash" }],
    ["bad after hash", { afterFullHash: "A".repeat(64) }],
    ["ambiguous equal hashes", { afterFullHash: fixture().entry.beforeFullHash }],
    ["unknown state", { state: "maybe-written" }],
  ])("rejects an entry with %s", (_label, override) => {
    expect(hydrateBatchRecoveryJournal(journal([
      { ...fixture().entry, ...override } as BatchRecoveryEntry,
    ]), NOW)).toBeNull();
  });

  it("rejects malformed journal metadata and timestamps", () => {
    const valid = journal() as unknown as Record<string, unknown>;
    const invalids = [
      { ...valid, schemaVersion: 2 },
      { ...valid, id: "contains spaces" },
      { ...valid, agentContextId: "" },
      { ...valid, phase: "unknown" },
      { ...valid, createdAt: -1 },
      { ...valid, updatedAt: (valid.createdAt as number) - 1 },
      { ...valid, entries: "not an array" },
    ];
    for (const invalid of invalids) {
      expect(hydrateBatchRecoveryJournal(invalid, NOW)).toBeNull();
    }
  });
});

describe("batch recovery classification", () => {
  it("classifies exact before, exact after, and divergent content", () => {
    const value = fixture();
    expect(classifyBatchRecoveryEntry(value.entry, value.before)).toEqual({
      classification: "before",
      currentHash: value.entry.beforeFullHash,
    });
    expect(classifyBatchRecoveryEntry(value.entry, value.after)).toEqual({
      classification: "after",
      currentHash: value.entry.afterFullHash,
    });
    expect(classifyBatchRecoveryEntry(value.entry, `${value.after}\nexternal edit`)).toMatchObject({
      classification: "conflict",
    });
  });
});

describe("guarded batch recovery restore", () => {
  it("reconstructs the exact before text only from an exact after state", () => {
    const value = fixture();
    expect(prepareBatchRecoveryRestore(value.entry, value.after)).toEqual({
      ok: true,
      restoredText: value.before,
      currentHash: value.entry.afterFullHash,
      restoredHash: value.entry.beforeFullHash,
    });
  });

  it("refuses an already-restored or externally changed file", () => {
    const value = fixture();
    expect(prepareBatchRecoveryRestore(value.entry, value.before)).toMatchObject({
      ok: false,
      reason: "current_not_after",
      currentHash: value.entry.beforeFullHash,
    });
    expect(prepareBatchRecoveryRestore(value.entry, `${value.after}!`)).toMatchObject({
      ok: false,
      reason: "current_not_after",
    });
  });

  it("refuses an out-of-bounds scope even when the after hash matches", () => {
    const value = fixture();
    const malformed = {
      ...value.entry,
      from: value.after.length + 1,
    };
    expect(prepareBatchRecoveryRestore(malformed, value.after)).toEqual({
      ok: false,
      reason: "range_out_of_bounds",
      currentHash: value.entry.afterFullHash,
    });
  });

  it("refuses reconstruction when the reconstructed full hash is not the before proof", () => {
    const value = fixture();
    const wrongBeforeProof = {
      ...value.entry,
      beforeFullHash: hashText("different original"),
    };
    const result = prepareBatchRecoveryRestore(wrongBeforeProof, value.after);
    expect(result).toMatchObject({
      ok: false,
      reason: "reconstructed_hash_mismatch",
      currentHash: value.entry.afterFullHash,
      reconstructedHash: hashText(value.before),
    });
  });

  it("safely rolls back an insertion whose before scope was empty", () => {
    const value = fixture("", "Inserted body");
    expect(prepareBatchRecoveryRestore(value.entry, value.after)).toMatchObject({
      ok: true,
      restoredText: value.before,
      restoredHash: value.entry.beforeFullHash,
    });
  });

  it("preserves CRLF and Unicode exactly", () => {
    const value = fixture("옛 본문\r\n", "새 본문 👋\r\n", "---\r\ntitle: 한글\r\n---\r\n");
    const result = prepareBatchRecoveryRestore(value.entry, value.after);
    expect(result).toMatchObject({ ok: true, restoredText: value.before });
    if (result.ok) expect(hashText(result.restoredText)).toBe(value.entry.beforeFullHash);
  });
});
