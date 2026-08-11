import { randomUUID } from "node:crypto";

import type { ChatTask, ScopeKind } from "./types";

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_AUDIT_RECORDS = 500;
const EMPTY_HISTORY_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export type AuditOutcome =
  | "sent"
  | "replied"
  | "proposed"
  | "applied"
  | "discarded"
  | "blocked"
  | "stale"
  | "cancelled"
  | "rolled_back"
  | "recovery_required"
  | "not_applied"
  | "error";

export interface ScopeAuditRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  agentId: string;
  notePath: string;
  scope: ScopeKind;
  task: ChatTask;
  scopeChars: number;
  scopeHash: string;
  historyChars: number;
  historyHash: string;
  outcome: AuditOutcome;
}

export type NewScopeAuditRecord = Omit<
  ScopeAuditRecord,
  "id" | "createdAt" | "updatedAt" | "outcome"
>;

const OUTCOMES = new Set<AuditOutcome>([
  "sent",
  "replied",
  "proposed",
  "applied",
  "discarded",
  "blocked",
  "stale",
  "cancelled",
  "rolled_back",
  "recovery_required",
  "not_applied",
  "error",
]);

export function createAuditRecord(
  input: NewScopeAuditRecord,
  now = Date.now(),
): ScopeAuditRecord {
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    agentId: input.agentId,
    notePath: input.notePath,
    scope: input.scope,
    task: input.task,
    scopeChars: input.scopeChars,
    scopeHash: input.scopeHash,
    historyChars: input.historyChars,
    historyHash: input.historyHash,
    outcome: "sent",
  };
}

export function appendAuditRecord(
  records: ScopeAuditRecord[],
  record: ScopeAuditRecord,
  now = Date.now(),
): void {
  const cutoff = now - AUDIT_RETENTION_MS;
  const retained = records
    .filter((item) => item.updatedAt >= cutoff && item.id !== record.id)
    .slice(-(MAX_AUDIT_RECORDS - 1));
  records.splice(0, records.length, ...retained, record);
}

export function pruneAuditRecords(records: ScopeAuditRecord[], now = Date.now()): void {
  const cutoff = now - AUDIT_RETENTION_MS;
  const retained = records
    .filter((record) => record.updatedAt >= cutoff)
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_AUDIT_RECORDS);
  records.splice(0, records.length, ...retained);
}

export function updateAuditOutcome(
  records: ScopeAuditRecord[],
  id: string,
  outcome: AuditOutcome,
  now = Date.now(),
): boolean {
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  record.outcome = outcome;
  record.updatedAt = Math.max(record.createdAt, now);
  return true;
}

export function hydrateAuditRecords(input: unknown, now = Date.now()): ScopeAuditRecord[] {
  if (!Array.isArray(input)) return [];
  const cutoff = now - AUDIT_RETENTION_MS;
  const records: ScopeAuditRecord[] = [];
  const seen = new Set<string>();

  for (const value of input) {
    if (!value || typeof value !== "object") continue;
    const record = value as Partial<ScopeAuditRecord>;
    const historyChars = record.historyChars === undefined ? 0 : record.historyChars;
    const historyHash = record.historyHash === undefined ? EMPTY_HISTORY_HASH : record.historyHash;
    if (
      typeof record.id !== "string"
      || record.id.length === 0
      || record.id.length > 100
      || seen.has(record.id)
      || typeof record.createdAt !== "number"
      || !Number.isFinite(record.createdAt)
      || typeof record.updatedAt !== "number"
      || !Number.isFinite(record.updatedAt)
      || record.updatedAt < cutoff
      || record.updatedAt < record.createdAt
      || typeof record.agentId !== "string"
      || record.agentId.length === 0
      || record.agentId.length > 128
      || typeof record.notePath !== "string"
      || record.notePath.length === 0
      || record.notePath.length > 4_096
      || (record.scope !== "selection" && record.scope !== "body" && record.scope !== "frontmatter")
      || (record.task !== "ask" && record.task !== "edit")
      || typeof record.scopeChars !== "number"
      || !Number.isInteger(record.scopeChars)
      || record.scopeChars < 0
      || record.scopeChars > 300_000
      || typeof record.scopeHash !== "string"
      || !/^[a-f0-9]{64}$/.test(record.scopeHash)
      || typeof historyChars !== "number"
      || !Number.isInteger(historyChars)
      || historyChars < 0
      || historyChars > 48_000
      || typeof historyHash !== "string"
      || !/^[a-f0-9]{64}$/.test(historyHash)
      || !OUTCOMES.has(record.outcome as AuditOutcome)
    ) continue;

    seen.add(record.id);
    records.push({
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      agentId: record.agentId,
      notePath: record.notePath,
      scope: record.scope,
      task: record.task,
      scopeChars: record.scopeChars,
      scopeHash: record.scopeHash,
      historyChars,
      historyHash,
      outcome: record.outcome as AuditOutcome,
    });
  }

  return records
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_AUDIT_RECORDS);
}
