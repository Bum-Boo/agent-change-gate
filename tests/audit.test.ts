import { describe, expect, it } from "vitest";

import {
  appendAuditRecord,
  AUDIT_RETENTION_MS,
  createAuditRecord,
  hydrateAuditRecords,
  MAX_AUDIT_RECORDS,
  pruneAuditRecords,
  updateAuditOutcome,
} from "../src/core/audit";

const SCOPE_HASH = "a".repeat(64);

function draft() {
  return {
    agentId: "hermes:default",
    notePath: "Projects/Launch.md",
    scope: "selection" as const,
    task: "edit" as const,
    scopeChars: 42,
    scopeHash: SCOPE_HASH,
    historyChars: 0,
    historyHash: "b".repeat(64),
  };
}

describe("scope audit records", () => {
  it("stores metadata evidence without instruction or note content fields", () => {
    const record = createAuditRecord(draft(), 1_000);
    expect(record).toMatchObject({
      createdAt: 1_000,
      updatedAt: 1_000,
      outcome: "sent",
      scopeChars: 42,
      scopeHash: SCOPE_HASH,
    });
    expect(Object.keys(record)).not.toContain("instruction");
    expect(Object.keys(record)).not.toContain("content");
  });

  it("updates the terminal request outcome", () => {
    const record = createAuditRecord(draft(), 1_000);
    const records = [record];
    expect(updateAuditOutcome(records, record.id, "applied", 2_000)).toBe(true);
    expect(record.outcome).toBe("applied");
    expect(record.updatedAt).toBe(2_000);
  });

  it("bounds records and removes expired entries", () => {
    const now = AUDIT_RETENTION_MS + 10_000;
    const records = [createAuditRecord(draft(), 1)];
    for (let index = 0; index < MAX_AUDIT_RECORDS + 5; index += 1) {
      appendAuditRecord(records, createAuditRecord(draft(), now + index), now + index);
    }
    expect(records).toHaveLength(MAX_AUDIT_RECORDS);
    expect(records.some((record) => record.createdAt === 1)).toBe(false);
  });

  it("rejects malformed persisted records", () => {
    const valid = createAuditRecord(draft(), 10_000);
    expect(hydrateAuditRecords([
      valid,
      { ...valid, id: "bad-hash", scopeHash: "raw note text" },
      { ...valid, id: "bad-status", outcome: "approved-ish" },
    ], 10_000)).toEqual([valid]);
  });

  it("prunes expired receipts during ordinary state saves", () => {
    const now = AUDIT_RETENTION_MS + 20_000;
    const expired = createAuditRecord(draft(), 1);
    const current = createAuditRecord(draft(), now);
    const records = [expired, current];

    pruneAuditRecords(records, now);

    expect(records).toEqual([current]);
  });
});
