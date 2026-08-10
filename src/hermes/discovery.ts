import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type {
  AcpLaunchSpec,
  AgentDiagnostics,
  AgentProfile,
  BoundedNoteChatSettings,
  CustomAcpAgentDefinition,
  HermesDiagnostics,
} from "../core/types";
import {
  conciseProcessError,
  runRestricted,
  validateAcpLaunchSpec,
  type ProcessResult,
} from "./process";

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export interface DiscoveryResult {
  profiles: AgentProfile[];
  diagnostics: HermesDiagnostics;
}

export interface AcpDiscoveryResult {
  profiles: AgentProfile[];
  diagnostics: AgentDiagnostics;
}

interface HermesRuntime {
  transport: "wsl" | "native";
  command: string;
  executable: string;
  prefix: string[];
  workspace: string;
  wslDistribution?: string;
  extraEnv?: NodeJS.ProcessEnv;
}

function wslPrefix(distribution: string): string[] {
  return distribution.trim() ? ["-d", distribution.trim(), "--exec"] : ["--exec"];
}

async function tryResult(command: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<ProcessResult | null> {
  try {
    return await runRestricted(command, args, 12_000, extraEnv);
  } catch {
    return null;
  }
}

async function detectWsl(settings: BoundedNoteChatSettings): Promise<HermesRuntime | null> {
  if (process.platform !== "win32") return null;
  const prefix = wslPrefix(settings.wslDistribution);
  const homeResult = await tryResult("wsl.exe", [...prefix, "printenv", "HOME"]);
  if (!homeResult || homeResult.exitCode !== 0 || !homeResult.stdout.trim().startsWith("/")) return null;
  const linuxHome = homeResult.stdout.trim().split(/\r?\n/)[0] ?? "";

  const candidates: string[] = [];
  if (settings.hermesExecutable.trim()) candidates.push(settings.hermesExecutable.trim());
  const whichResult = await tryResult("wsl.exe", [...prefix, "which", "hermes"]);
  if (whichResult?.exitCode === 0 && whichResult.stdout.trim()) {
    candidates.push(whichResult.stdout.trim().split(/\r?\n/)[0] ?? "");
  }
  candidates.push(
    `${linuxHome}/.local/bin/hermes`,
    `${linuxHome}/.hermes/hermes-agent/venv/bin/hermes`,
    "/usr/local/bin/hermes",
  );

  for (const executable of [...new Set(candidates.filter(Boolean))]) {
    const result = await tryResult("wsl.exe", [...prefix, executable, "--version"]);
    if (result?.exitCode === 0) {
      return {
        transport: "wsl",
        command: "wsl.exe",
        executable,
        prefix,
        workspace: "/tmp",
        wslDistribution: settings.wslDistribution.trim() || undefined,
      };
    }
  }
  return null;
}

async function detectNative(settings: BoundedNoteChatSettings): Promise<HermesRuntime | null> {
  const executable = settings.hermesExecutable.trim() || "hermes";
  const extraEnv = settings.hermesHome.trim() ? { HERMES_HOME: settings.hermesHome.trim() } : undefined;
  const result = await tryResult(executable, ["--version"], extraEnv);
  if (!result || result.exitCode !== 0) return null;
  return {
    transport: "native",
    command: executable,
    executable,
    prefix: [],
    workspace: tmpdir() || homedir() || path.parse(process.cwd()).root,
    extraEnv,
  };
}

async function detectRuntime(settings: BoundedNoteChatSettings): Promise<HermesRuntime | null> {
  if (settings.launchMode === "wsl") return await detectWsl(settings);
  if (settings.launchMode === "native") return await detectNative(settings);
  return (await detectWsl(settings)) ?? (await detectNative(settings));
}

export function parseProfileList(output: string): string[] {
  const profiles: string[] = [];
  for (const rawLine of output.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const match = /^\s*[◆*]?\s*([a-z0-9][a-z0-9_-]{0,63})\s+/.exec(rawLine);
    const id = match?.[1];
    if (id && PROFILE_ID.test(id) && !profiles.includes(id)) profiles.push(id);
  }
  return profiles;
}

function commandFor(runtime: HermesRuntime, hermesArgs: string[]): AcpLaunchSpec {
  if (runtime.transport === "wsl") {
    return { command: runtime.command, args: [...runtime.prefix, runtime.executable, ...hermesArgs] };
  }
  return { command: runtime.command, args: hermesArgs };
}

function hermesAcpLaunch(runtime: HermesRuntime, profileId: string): AcpLaunchSpec {
  const hermesArgs = ["-p", profileId, "acp"];
  if (runtime.transport === "wsl") {
    return {
      command: runtime.command,
      args: [
        ...runtime.prefix,
        "env",
        "HERMES_ACP_SKIP_CONFIGURED_MCP=1",
        runtime.executable,
        ...hermesArgs,
      ],
    };
  }
  return { command: runtime.command, args: hermesArgs };
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function cleanDisplayString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`${label} is invalid.`);
  }
  return cleaned;
}

/** Validate and clone one persisted custom ACP agent definition. */
export function validateCustomAcpAgentDefinition(value: unknown): CustomAcpAgentDefinition {
  const record = plainRecord(value, "Custom ACP agent definition");
  const allowedKeys = new Set(["id", "label", "launch", "transport", "workspace"]);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new Error(`Custom ACP agent definition contains unsupported field ${String(key)}.`);
    }
  }

  const id = cleanDisplayString(record.id, "Custom ACP agent ID", 64);
  if (!PROFILE_ID.test(id)) {
    throw new Error("Custom ACP agent ID must use lowercase letters, numbers, underscores, or hyphens.");
  }
  const label = cleanDisplayString(record.label, "Custom ACP agent label", 128);
  const transport = record.transport === undefined ? "native" : record.transport;
  if (transport !== "native" && transport !== "wsl") {
    throw new Error("Custom ACP agent transport must be native or wsl.");
  }
  const workspace = cleanDisplayString(record.workspace, "Custom ACP agent workspace", 4_096);
  const workspaceIsAbsolute = transport === "wsl" ? workspace.startsWith("/") : path.isAbsolute(workspace);
  if (!workspaceIsAbsolute) {
    throw new Error(`Custom ACP agent workspace must be an absolute ${transport} path.`);
  }

  return {
    id,
    label,
    workspace,
    transport,
    launch: validateAcpLaunchSpec(record.launch),
  };
}

export function customAcpAgentProfile(value: unknown, wslDistribution = ""): AgentProfile {
  const definition = validateCustomAcpAgentDefinition(value);
  const transport = definition.transport ?? "native";
  const launch = transport === "wsl"
    ? validateAcpLaunchSpec({
        command: "wsl.exe",
        args: [
          ...wslPrefix(wslDistribution),
          definition.launch.command,
          ...definition.launch.args,
        ],
      })
    : definition.launch;
  return {
    id: definition.id,
    label: definition.label,
    home: "",
    workspace: definition.workspace,
    transport,
    executable: definition.launch.command,
    wslDistribution: transport === "wsl" && wslDistribution.trim()
      ? wslDistribution.trim()
      : undefined,
    source: "custom",
    launch,
  };
}

export function discoverCustomAcpAgents(values: readonly unknown[], wslDistribution = ""): AgentProfile[] {
  if (values.length > 64) throw new Error("At most 64 custom ACP agents may be configured.");
  const profiles = values.map((value) => customAcpAgentProfile(value, wslDistribution));
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.id)) throw new Error(`Duplicate custom ACP agent ID: ${profile.id}.`);
    seen.add(profile.id);
  }
  return profiles;
}

export async function discoverHermes(settings: BoundedNoteChatSettings): Promise<DiscoveryResult> {
  const runtime = await detectRuntime(settings);
  if (!runtime) {
    return {
      profiles: [],
      diagnostics: {
        ok: false,
        message: "Hermes was not found. Set the Hermes executable in plugin settings.",
      },
    };
  }

  let profileIds = settings.agentProfiles.filter((id) => PROFILE_ID.test(id));
  if (profileIds.length === 0) {
    const listCommand = commandFor(runtime, ["profile", "list"]);
    const result = await runRestricted(listCommand.command, listCommand.args, 20_000, runtime.extraEnv);
    if (result.exitCode !== 0) {
      return {
        profiles: [],
        diagnostics: {
          ok: false,
          message: conciseProcessError(result, "Hermes profile discovery failed."),
          executable: runtime.executable,
          transport: runtime.transport,
        },
      };
    }
    profileIds = parseProfileList(result.stdout);
  }

  const profiles = profileIds.map<AgentProfile>((id) => ({
    id,
    label: id,
    home: settings.hermesHome.trim(),
    workspace: runtime.workspace,
    transport: runtime.transport,
    executable: runtime.executable,
    wslDistribution: runtime.wslDistribution,
    source: "hermes",
    launch: hermesAcpLaunch(runtime, id),
  }));
  return {
    profiles,
    diagnostics: {
      ok: profiles.length > 0,
      message: profiles.length > 0
        ? `Found ${profiles.length} Hermes profile${profiles.length === 1 ? "" : "s"}.`
        : "Hermes is installed, but no agent profiles were found.",
      executable: runtime.executable,
      transport: runtime.transport,
      profiles: profileIds,
    },
  };
}

/** Discover first-class Hermes profiles and merge validated custom ACP agents. */
export async function discoverAcpAgents(
  settings: BoundedNoteChatSettings,
  customDefinitions: readonly unknown[] = settings.customAcpAgents ?? [],
): Promise<AcpDiscoveryResult> {
  const customProfiles = discoverCustomAcpAgents(customDefinitions, settings.wslDistribution);
  const hermes = settings.hermesEnabled
    ? await discoverHermes(settings)
    : {
        profiles: [],
        diagnostics: {
          ok: false,
          message: "Hermes discovery is disabled.",
        },
      } satisfies DiscoveryResult;
  const hermesIds = new Set(hermes.profiles.map((profile) => profile.id));
  for (const profile of customProfiles) {
    if (hermesIds.has(profile.id)) {
      throw new Error(`ACP agent ID ${profile.id} conflicts with a Hermes profile.`);
    }
  }
  const profiles = [...hermes.profiles, ...customProfiles];
  const customCount = customProfiles.length;
  const hermesCount = hermes.profiles.length;
  return {
    profiles,
    diagnostics: {
      ok: profiles.length > 0,
      message: profiles.length > 0
        ? `Found ${hermesCount} Hermes and ${customCount} custom ACP agent${profiles.length === 1 ? "" : "s"}.`
        : hermes.diagnostics.message,
      executable: hermes.diagnostics.executable,
      transport: hermes.diagnostics.transport,
      profiles: profiles.map((profile) => profile.id),
    },
  };
}

export async function checkHermesProfile(profile: AgentProfile): Promise<HermesDiagnostics> {
  if (profile.source === "custom") {
    throw new Error("checkHermesProfile cannot check a custom ACP agent.");
  }
  const legacyHermesArgs = ["-p", profile.id, "acp"];
  const baseLaunch = profile.launch ?? (
    profile.transport === "wsl"
      ? {
          command: "wsl.exe",
          args: [
            ...wslPrefix(profile.wslDistribution ?? ""),
            "env",
            "HERMES_ACP_SKIP_CONFIGURED_MCP=1",
            profile.executable,
            ...legacyHermesArgs,
          ],
        }
      : { command: profile.executable, args: legacyHermesArgs }
  );
  const launch = validateAcpLaunchSpec(baseLaunch);
  const extraEnv = profile.transport === "native"
    ? {
        ...(profile.home ? { HERMES_HOME: profile.home } : {}),
        HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
      }
    : undefined;
  const result = await runRestricted(launch.command, [...launch.args, "--check"], 30_000, extraEnv);
  return {
    ok: result.exitCode === 0,
    message: result.exitCode === 0
      ? result.stdout.trim() || "Hermes ACP check passed."
      : conciseProcessError(result, "Hermes ACP check failed."),
    executable: profile.executable,
    transport: profile.transport,
    profiles: [profile.id],
  };
}
