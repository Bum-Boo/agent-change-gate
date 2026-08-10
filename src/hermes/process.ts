import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";

import type { AcpLaunchSpec } from "../core/types";

const MAX_PROCESS_OUTPUT = 512_000;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_ARGUMENT_LENGTH = 4_096;
const MAX_ARGUMENTS = 64;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SAFE_EXTRA_ENVIRONMENT = new Set([
  "HERMES_ACP_SKIP_CONFIGURED_MCP",
  "HERMES_HOME",
]);

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

function boundedString(value: unknown, label: string, maxLength: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if ((!allowEmpty && value.trim().length === 0) || value.length > maxLength || CONTROL_CHARACTER.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/**
 * Validate and clone an argv-only launch specification. Unknown fields are
 * rejected so `env`, `shell`, and other spawn options cannot be smuggled in.
 */
export function validateAcpLaunchSpec(value: unknown): AcpLaunchSpec {
  const record = plainRecord(value, "ACP launch specification");
  const allowedKeys = new Set(["args", "command"]);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new Error(`ACP launch specification contains unsupported field ${String(key)}.`);
    }
  }

  const command = boundedString(record.command, "ACP launch command", MAX_COMMAND_LENGTH, false).trim();
  if (!Array.isArray(record.args) || record.args.length > MAX_ARGUMENTS) {
    throw new Error(`ACP launch args must be an array of at most ${MAX_ARGUMENTS} strings.`);
  }
  const args = record.args.map((argument, index) => (
    boundedString(argument, `ACP launch argument ${index + 1}`, MAX_ARGUMENT_LENGTH, true)
  ));
  return { command, args };
}

export function restrictedProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowed = [
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
    "WSLENV",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NO_COLOR = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  for (const [key, value] of Object.entries(extra)) {
    if (!SAFE_EXTRA_ENVIRONMENT.has(key)) {
      throw new Error(`Process environment field ${key} is not allowed.`);
    }
    if (value === undefined) continue;
    env[key] = boundedString(value, `Process environment field ${key}`, MAX_ARGUMENT_LENGTH, true);
  }
  return env;
}

export function spawnRestricted(command: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const launch = validateAcpLaunchSpec({ command, args: [...args] });
  return spawn(launch.command, launch.args, {
    cwd: tmpdir(),
    env: restrictedProcessEnv(extraEnv),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function spawnAcpProcess(
  launchSpec: AcpLaunchSpec,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const launch = validateAcpLaunchSpec(launchSpec);
  return spawnRestricted(launch.command, launch.args, extraEnv);
}

export async function runRestricted(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawnRestricted(command, args, extraEnv);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, exitCode = -1): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr, exitCode });
    };

    const append = (current: string, chunk: Buffer): string => {
      if (settled) return current;
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_PROCESS_OUTPUT) {
        child.kill();
        finish(new Error("Child process output exceeded the safety limit."));
        return current;
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code ?? -1));

    timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Child process timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });
}

export function conciseProcessError(result: ProcessResult, fallback: string): string {
  const line = result.stderr
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return line?.slice(0, 500) || fallback;
}
