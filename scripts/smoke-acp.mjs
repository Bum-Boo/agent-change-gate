import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

const profile = process.env.HERMES_PROFILE?.trim();
const executable = process.env.HERMES_EXECUTABLE?.trim();
const transport = process.env.HERMES_TRANSPORT?.trim() || "native";
const distribution = process.env.HERMES_WSL_DISTRIBUTION?.trim();

if (!profile || !executable) {
  throw new Error("Set HERMES_PROFILE and HERMES_EXECUTABLE before running the ACP smoke test.");
}
if (transport !== "native" && transport !== "wsl") {
  throw new Error("HERMES_TRANSPORT must be either native or wsl.");
}

const command = transport === "wsl" ? "wsl.exe" : executable;
const args = transport === "wsl"
  ? [
      ...(distribution ? ["-d", distribution] : []),
      "--exec",
      "env",
      "HERMES_ACP_SKIP_CONFIGURED_MCP=1",
      executable,
      "-p",
      profile,
      "acp",
    ]
  : ["-p", profile, "acp"];

const child = spawn(command, args, {
  cwd: tmpdir(),
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    WINDIR: process.env.WINDIR,
    NO_COLOR: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...(transport === "native" ? { HERMES_ACP_SKIP_CONFIGURED_MCP: "1" } : {}),
  },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
});

const unavailable = (method) => {
  throw RequestError.methodNotFound(method);
};
const app = client({ name: "agent-change-gate-smoke-test" })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    const rejection = params.options.find((option) => option.kind === "reject_always")
      ?? params.options.find((option) => option.kind === "reject_once");
    return rejection
      ? { outcome: { outcome: "selected", optionId: rejection.optionId } }
      : { outcome: { outcome: "cancelled" } };
  })
  .onRequest(methods.client.fs.readTextFile, () => unavailable(methods.client.fs.readTextFile))
  .onRequest(methods.client.fs.writeTextFile, () => unavailable(methods.client.fs.writeTextFile))
  .onRequest(methods.client.terminal.create, () => unavailable(methods.client.terminal.create))
  .onRequest(methods.client.terminal.output, () => unavailable(methods.client.terminal.output))
  .onRequest(methods.client.terminal.release, () => unavailable(methods.client.terminal.release))
  .onRequest(methods.client.terminal.waitForExit, () => unavailable(methods.client.terminal.waitForExit))
  .onRequest(methods.client.terminal.kill, () => unavailable(methods.client.terminal.kill));

const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
);
const connection = app.connect(stream);
const timeout = AbortSignal.timeout(20_000);

try {
  const initialized = await connection.agent.request(
    methods.agent.initialize,
    {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: "agent-change-gate-smoke-test",
        title: "Agent Change Gate ACP smoke test",
        version: manifest.version,
      },
    },
    { signal: timeout },
  );
  if (initialized.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Protocol mismatch: ${initialized.protocolVersion}`);
  }
  console.log(JSON.stringify({
    ok: true,
    protocolVersion: initialized.protocolVersion,
    agentName: initialized.agentInfo?.name ?? "unknown",
    agentVersion: initialized.agentInfo?.version ?? "unknown",
  }));
} catch (error) {
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0];
  if (detail) console.error(detail.slice(0, 500));
  throw error;
} finally {
  connection.close();
  child.kill();
}
