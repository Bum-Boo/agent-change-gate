import { randomUUID } from "node:crypto";

import { hydrateAuditRecords, pruneAuditRecords } from "./audit";
import type {
  BoundedNoteChatSettings,
  ChatMessage,
  ChatRole,
  ChatThread,
  CustomAcpAgentDefinition,
  EditCheckpoint,
  PersistedData,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { validateCustomAcpAgentDefinition } from "../hermes/discovery";

export const MAX_STORED_THREADS = 200;
export const MAX_STORED_MESSAGE_CHARS = 2_000_000;
export const THREAD_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
export const MAX_CHECKPOINTS = 20;
export const MAX_CHECKPOINT_CHARS = 600_000;
export const MAX_TOTAL_CHECKPOINT_CHARS = 3_000_000;
export const MAX_CHECKPOINT_LINES = 4_000;
const MAX_MESSAGE_CHARS = 24_000;

export function createMessage(
  role: ChatRole,
  text: string,
  scope?: ChatMessage["scope"],
  scopeKey?: string,
): ChatMessage {
  return {
    id: randomUUID(),
    role,
    text,
    createdAt: Date.now(),
    ...(scope ? { scope } : {}),
    ...(scopeKey ? { scopeKey } : {}),
  };
}

export function threadKey(agentId: string, notePath: string): string {
  return `${encodeURIComponent(agentId)}::${encodeURIComponent(notePath)}`;
}

export function emptyData(): PersistedData {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      agentProfiles: [...DEFAULT_SETTINGS.agentProfiles],
      customAcpAgents: [...(DEFAULT_SETTINGS.customAcpAgents ?? [])],
    },
    threads: {},
    checkpoints: {},
    auditLog: [],
  };
}

function cleanSettings(input: unknown): BoundedNoteChatSettings {
  const record = input && typeof input === "object" ? (input as Partial<BoundedNoteChatSettings>) : {};
  const launchMode = record.launchMode === "wsl" || record.launchMode === "native" ? record.launchMode : "auto";
  const profileId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const cleanString = (value: unknown, fallback: string, maxLength: number): string => (
    typeof value === "string" ? value.trim().slice(0, maxLength) : fallback
  );
  const customAcpAgents: CustomAcpAgentDefinition[] = [];
  if (Array.isArray(record.customAcpAgents)) {
    for (const definition of record.customAcpAgents.slice(0, 64)) {
      try {
        customAcpAgents.push(validateCustomAcpAgentDefinition(definition));
      } catch {
        // Damaged or legacy definitions are dropped instead of reaching spawn.
      }
    }
  }
  return {
    hermesEnabled: typeof record.hermesEnabled === "boolean"
      ? record.hermesEnabled
      : DEFAULT_SETTINGS.hermesEnabled,
    launchMode,
    wslDistribution: cleanString(record.wslDistribution, DEFAULT_SETTINGS.wslDistribution, 128),
    hermesExecutable: cleanString(record.hermesExecutable, DEFAULT_SETTINGS.hermesExecutable, 4_096),
    hermesHome: cleanString(record.hermesHome, DEFAULT_SETTINGS.hermesHome, 4_096),
    agentProfiles: Array.isArray(record.agentProfiles)
      ? [...new Set(record.agentProfiles.filter((item): item is string => typeof item === "string" && profileId.test(item)))].slice(0, 64)
      : [],
    customAcpAgents,
    defaultAgent: typeof record.defaultAgent === "string" && profileId.test(record.defaultAgent)
      ? record.defaultAgent
      : DEFAULT_SETTINGS.defaultAgent,
    promptTimeoutMs: clampNumber(record.promptTimeoutMs, 15_000, 600_000, DEFAULT_SETTINGS.promptTimeoutMs),
    maxContextChars: clampNumber(record.maxContextChars, 2_000, 300_000, DEFAULT_SETTINGS.maxContextChars),
    historyLimit: clampNumber(record.historyLimit, 4, 100, DEFAULT_SETTINGS.historyLimit),
  };
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(maximum, Math.max(minimum, value)))
    : fallback;
}

export function hydrateData(input: unknown): PersistedData {
  const data = emptyData();
  if (!input || typeof input !== "object") return data;
  const record = input as Partial<PersistedData>;
  data.settings = cleanSettings(record.settings);
  data.auditLog = hydrateAuditRecords(record.auditLog);
  if (record.threads && typeof record.threads === "object") {
    for (const key of Object.keys(record.threads).slice(0, 1_000)) {
      const value = record.threads[key];
      if (!value || typeof value !== "object") continue;
      const thread = value as Partial<ChatThread>;
      if (
        typeof thread.agentId !== "string"
        || thread.agentId.length > 128
        || typeof thread.notePath !== "string"
        || thread.notePath.length === 0
        || thread.notePath.length > 4_096
        || threadKey(thread.agentId, thread.notePath) !== key
        || !Array.isArray(thread.messages)
      ) continue;
      const messages = thread.messages
        .filter((message): message is ChatMessage => Boolean(
          message
          && typeof message.id === "string"
          && message.id.length <= 100
          && (message.role === "user" || message.role === "assistant" || message.role === "system")
          && typeof message.text === "string"
          && message.text.length <= MAX_MESSAGE_CHARS
          && typeof message.createdAt === "number"
          && Number.isFinite(message.createdAt)
          && (message.scope === undefined || message.scope === "body" || message.scope === "selection" || message.scope === "frontmatter")
          && (message.scopeKey === undefined || /^[a-f0-9]{64}$/.test(message.scopeKey))
        ))
        .map((message): ChatMessage => ({
          id: message.id,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          ...(message.scope ? { scope: message.scope } : {}),
          ...(message.scopeKey ? { scopeKey: message.scopeKey } : {}),
        }))
        .slice(-data.settings.historyLimit);
      data.threads[key] = {
        key,
        agentId: thread.agentId,
        notePath: thread.notePath,
        messages,
        updatedAt: typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
          ? thread.updatedAt
          : Date.now(),
      };
    }
  }
  if (record.checkpoints && typeof record.checkpoints === "object") {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
    for (const key of Object.keys(record.checkpoints).slice(0, 1_000)) {
      const value = record.checkpoints[key];
      if (!value || typeof value !== "object") continue;
      const checkpoint = value as Partial<PersistedData["checkpoints"][string]>;
      if (
        checkpoint.notePath !== key
        || key.length === 0
        || key.length > 4_096
        || typeof checkpoint.before !== "string"
        || typeof checkpoint.after !== "string"
        || typeof checkpoint.createdAt !== "number"
        || !Number.isFinite(checkpoint.createdAt)
        || checkpoint.createdAt < cutoff
        || !canStoreCheckpoint(checkpoint.before, checkpoint.after)
      ) continue;
      data.checkpoints[key] = {
        notePath: key,
        before: checkpoint.before,
        after: checkpoint.after,
        createdAt: checkpoint.createdAt,
      };
    }
  }
  prunePersistedState(data);
  return data;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    count += 1;
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
    lineStart = index + 1;
  }
  if (lineStart < text.length) count += 1;
  return count;
}

export function canStoreCheckpoint(before: string, after: string): boolean {
  return before.length <= MAX_CHECKPOINT_CHARS
    && after.length <= MAX_CHECKPOINT_CHARS - before.length
    && lineCount(before) + lineCount(after) <= MAX_CHECKPOINT_LINES;
}

export function pruneCheckpoints(data: PersistedData, now = Date.now()): void {
  const cutoff = now - 30 * 24 * 60 * 60 * 1_000;
  const candidates = Object.values(data.checkpoints)
    .filter((checkpoint) => (
      checkpoint.createdAt >= cutoff
      && canStoreCheckpoint(checkpoint.before, checkpoint.after)
    ))
    .sort((left, right) => right.createdAt - left.createdAt);
  const retained: Record<string, EditCheckpoint> = {};
  let totalChars = 0;
  for (const checkpoint of candidates) {
    const chars = checkpoint.before.length + checkpoint.after.length;
    if (Object.keys(retained).length >= MAX_CHECKPOINTS || totalChars + chars > MAX_TOTAL_CHECKPOINT_CHARS) {
      continue;
    }
    retained[checkpoint.notePath] = checkpoint;
    totalChars += chars;
  }
  data.checkpoints = retained;
}

export function storeCheckpoint(data: PersistedData, checkpoint: EditCheckpoint): boolean {
  delete data.checkpoints[checkpoint.notePath];
  if (!canStoreCheckpoint(checkpoint.before, checkpoint.after)) {
    pruneCheckpoints(data);
    return false;
  }
  data.checkpoints[checkpoint.notePath] = checkpoint;
  pruneCheckpoints(data);
  return data.checkpoints[checkpoint.notePath] === checkpoint;
}

export function pruneThreads(data: PersistedData, now = Date.now()): void {
  const cutoff = now - THREAD_RETENTION_MS;
  const candidates = Object.values(data.threads)
    .filter((thread) => thread.updatedAt >= cutoff)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const retained: Record<string, ChatThread> = {};
  let totalChars = 0;
  for (const thread of candidates) {
    if (Object.keys(retained).length >= MAX_STORED_THREADS) break;
    if (thread.messages.length === 0) continue;
    if (thread.messages.length > data.settings.historyLimit) {
      thread.messages.splice(0, thread.messages.length - data.settings.historyLimit);
    }
    const messages = thread.messages;
    let chars = messages.reduce((sum, message) => sum + message.text.length, 0);
    while (
      messages.length > 0
      && totalChars + chars > MAX_STORED_MESSAGE_CHARS
    ) {
      chars -= messages.shift()?.text.length ?? 0;
    }
    if (messages.length === 0) continue;
    retained[thread.key] = thread;
    totalChars += chars;
  }
  data.threads = retained;
}

export function prunePersistedState(data: PersistedData, now = Date.now()): void {
  pruneThreads(data, now);
  pruneCheckpoints(data, now);
  pruneAuditRecords(data.auditLog, now);
}

export function getOrCreateThread(
  data: PersistedData,
  agentId: string,
  notePath: string,
): ChatThread {
  const key = threadKey(agentId, notePath);
  const existing = data.threads[key];
  if (existing && existing.agentId === agentId && existing.notePath === notePath) {
    return existing;
  }
  pruneThreads(data);
  const created: ChatThread = {
    key,
    agentId,
    notePath,
    messages: [],
    updatedAt: Date.now(),
  };
  data.threads[key] = created;
  return created;
}

export function appendMessage(thread: ChatThread, message: ChatMessage, historyLimit: number): void {
  thread.messages.push(message);
  if (thread.messages.length > historyLimit) {
    thread.messages.splice(0, thread.messages.length - historyLimit);
  }
  thread.updatedAt = Date.now();
}
