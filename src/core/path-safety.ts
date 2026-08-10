import path from "node:path";

import type { AcpTransport } from "./types";

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
}

function isInside(root: string, candidate: string, windows: boolean): boolean {
  const paths = windows ? path.win32 : path.posix;
  const normalizedRoot = paths.resolve(root);
  const normalizedCandidate = paths.resolve(candidate);
  const relative = paths.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
}

export function windowsPathToWsl(value: string): string | null {
  const match = /^([a-z]):[\\/](.*)$/i.exec(value);
  if (!match?.[1]) return null;
  const remainder = (match[2] ?? "").replaceAll("\\", "/");
  return `/mnt/${match[1].toLowerCase()}/${remainder}`.replace(/\/+$/, "");
}

/**
 * Rejects the obvious case where a custom ACP session cwd is the vault or one
 * of its descendants. This is a configuration guard, not a symlink-aware OS
 * sandbox and must not be described as one.
 */
export function isWorkspaceOutsideVault(
  vaultBasePath: string,
  workspace: string,
  transport: AcpTransport,
): boolean {
  if (transport === "wsl") {
    const wslVault = windowsPathToWsl(vaultBasePath);
    if (!wslVault) return true;
    const windowsMount = /^\/mnt\/[a-z](?:\/|$)/i.test(workspace);
    return !isInside(
      windowsMount ? wslVault.toLowerCase() : wslVault,
      windowsMount ? workspace.toLowerCase() : workspace,
      false,
    );
  }
  const windows = isWindowsPath(vaultBasePath) || isWindowsPath(workspace);
  return !isInside(vaultBasePath, workspace, windows);
}
