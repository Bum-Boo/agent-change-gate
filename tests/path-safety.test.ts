import { describe, expect, it } from "vitest";

import { isWorkspaceOutsideVault, windowsPathToWsl } from "../src/core/path-safety";

describe("custom ACP workspace boundary", () => {
  it("blocks a native workspace equal to or below the vault", () => {
    const vault = "C:\\Users\\Me\\Vault";
    expect(isWorkspaceOutsideVault(vault, vault, "native")).toBe(false);
    expect(isWorkspaceOutsideVault(vault, "C:\\Users\\Me\\Vault\\Notes", "native")).toBe(false);
    expect(isWorkspaceOutsideVault(vault, "C:\\Users\\Me\\Agent", "native")).toBe(true);
  });

  it("does not confuse a sibling with a matching path prefix", () => {
    expect(isWorkspaceOutsideVault("C:\\Vault", "C:\\Vault-copy", "native")).toBe(true);
    expect(isWorkspaceOutsideVault("/home/me/vault", "/home/me/vault-copy", "native")).toBe(true);
  });

  it("maps Windows vault paths before checking WSL workspaces", () => {
    expect(windowsPathToWsl("D:\\Notes\\Vault")).toBe("/mnt/d/Notes/Vault");
    expect(isWorkspaceOutsideVault("D:\\Notes\\Vault", "/mnt/d/Notes/Vault/tmp", "wsl")).toBe(false);
    expect(isWorkspaceOutsideVault("D:\\Notes\\Vault", "/mnt/d/notes/VAULT/tmp", "wsl")).toBe(false);
    expect(isWorkspaceOutsideVault("D:\\Notes\\Vault", "/home/me/agent", "wsl")).toBe(true);
  });
});
