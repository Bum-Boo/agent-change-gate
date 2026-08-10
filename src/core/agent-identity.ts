import type { AgentProfile } from "./types";
import { hashText } from "./scope";

/**
 * Version local chat identity when a profile's launch target changes, so old
 * context cannot silently cross to a different executable, workspace, or transport.
 */
export function agentContextId(profile: AgentProfile): string {
  const launchFingerprint = hashText(JSON.stringify({
    id: profile.id,
    source: profile.source ?? "hermes",
    transport: profile.transport,
    executable: profile.executable,
    workspace: profile.workspace,
    home: profile.home,
    wslDistribution: profile.wslDistribution ?? "",
    launch: profile.launch
      ? { command: profile.launch.command, args: profile.launch.args }
      : null,
  })).slice(0, 16);
  return `${profile.id}@${launchFingerprint}`;
}
