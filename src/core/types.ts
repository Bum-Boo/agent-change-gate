import type { ScopeAuditRecord } from "./audit";

export type LaunchMode = "auto" | "wsl" | "native";
export type AcpTransport = "wsl" | "native";
export type AgentSource = "hermes" | "custom";
export type ChatRole = "user" | "assistant" | "system";
export type ChatTask = "ask" | "edit";
export type ScopeKind = "selection" | "body" | "frontmatter";

/**
 * An argv-only ACP process launch. Environment variables and a shell are
 * intentionally not configurable here; callers always spawn this directly.
 */
export interface AcpLaunchSpec {
  command: string;
  args: string[];
}

/** A serializable definition for a non-Hermes ACP-compatible agent. */
export interface CustomAcpAgentDefinition {
  id: string;
  label: string;
  workspace: string;
  transport?: AcpTransport;
  launch: AcpLaunchSpec;
}

export interface BoundedNoteChatSettings {
  hermesEnabled: boolean;
  launchMode: LaunchMode;
  wslDistribution: string;
  hermesExecutable: string;
  hermesHome: string;
  agentProfiles: string[];
  customAcpAgents?: CustomAcpAgentDefinition[];
  defaultAgent: string;
  promptTimeoutMs: number;
  maxContextChars: number;
  historyLimit: number;
}

export const DEFAULT_SETTINGS: BoundedNoteChatSettings = {
  hermesEnabled: true,
  launchMode: "auto",
  wslDistribution: "",
  hermesExecutable: "",
  hermesHome: "",
  agentProfiles: [],
  customAcpAgents: [],
  defaultAgent: "default",
  promptTimeoutMs: 120_000,
  maxContextChars: 120_000,
  historyLimit: 40,
};

export interface AgentProfile {
  id: string;
  label: string;
  home: string;
  workspace: string;
  transport: AcpTransport;
  executable: string;
  wslDistribution?: string;
  source?: AgentSource;
  launch?: AcpLaunchSpec;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  scope?: ScopeKind;
  /** Hash of scope kind, range, and content used to isolate opt-in history. */
  scopeKey?: string;
}

export interface ChatThread {
  key: string;
  agentId: string;
  notePath: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface EditCheckpoint {
  notePath: string;
  before: string;
  after: string;
  createdAt: number;
}

export interface PersistedData {
  settings: BoundedNoteChatSettings;
  threads: Record<string, ChatThread>;
  checkpoints: Record<string, EditCheckpoint>;
  auditLog: ScopeAuditRecord[];
}

export interface ScopeSnapshot {
  notePath: string;
  scope: ScopeKind;
  fullText: string;
  fullHash: string;
  from: number;
  to: number;
  originalScope: string;
  capturedAt: number;
}

export interface AgentPromptInput {
  task: ChatTask;
  instruction: string;
  notePath: string;
  scope: ScopeKind;
  noteContent: string;
  priorMessages: ChatMessage[];
}

export interface AgentReply {
  action: "reply" | "propose_edit";
  message: string;
  replacement?: string;
  summary?: string;
  warnings: string[];
}

export interface ReplacementValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface AgentDiagnostics {
  ok: boolean;
  message: string;
  executable?: string;
  transport?: AcpTransport;
  profiles?: string[];
}

/** @deprecated Use AgentDiagnostics for transport-agnostic code. */
export type HermesDiagnostics = AgentDiagnostics;
