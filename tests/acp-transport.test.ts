import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AnyMessage } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ACP_MAX_FRAME_CHUNKS,
  ACP_MAX_FRAMES_PER_READ_CHUNK,
  ACP_MAX_INBOUND_FRAME_BYTES,
  ACP_MAX_OUTBOUND_FRAME_BYTES,
  ACP_MAX_TURN_TEXT_CHARS,
  AcpPool,
  AcpTurnOutputLimitError,
  HermesAcpPool,
  boundedAcpNdJsonStream,
} from "../src/hermes/acp-client";
import { DEFAULT_SETTINGS, type CustomAcpAgentDefinition } from "../src/core/types";
import {
  customAcpAgentProfile,
  discoverAcpAgents,
  discoverCustomAcpAgents,
  validateCustomAcpAgentDefinition,
} from "../src/hermes/discovery";
import { restrictedProcessEnv, validateAcpLaunchSpec } from "../src/hermes/process";

async function boundedStreamFailure(chunks: Uint8Array[]): Promise<Error> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const stream = boundedAcpNdJsonStream(new WritableStream<Uint8Array>(), input);
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) throw new Error("Expected the bounded stream to fail.");
    }
  } catch (error) {
    return error instanceof Error ? error : new Error("Unknown stream failure.");
  } finally {
    reader.releaseLock();
  }
}

async function writeBoundedMessage(message: AnyMessage): Promise<Uint8Array> {
  let written: Uint8Array | undefined;
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      written = chunk;
    },
  });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const writer = boundedAcpNdJsonStream(output, input).writable.getWriter();
  try {
    await writer.write(message);
  } finally {
    writer.releaseLock();
  }
  if (!written) throw new Error("Expected one encoded ACP frame.");
  return written;
}

function rawNodeAgentProfile(id: string, script: string) {
  return customAcpAgentProfile({
    id,
    label: id,
    workspace: path.resolve("test-workspace"),
    launch: { command: process.execPath, args: ["-e", script] },
  });
}

function internalConnectionState(pool: AcpPool, profileId: string) {
  const connections = (pool as unknown as {
    connections: Map<string, {
      child: unknown;
      connection: unknown;
      sessions: Map<string, unknown>;
    }>;
  }).connections;
  return connections.get(profileId);
}

describe("ACP launch validation", () => {
  it("accepts and clones an argv-only launch", () => {
    const input = { command: process.execPath, args: ["agent.mjs", "value with spaces"] };
    const launch = validateAcpLaunchSpec(input);

    expect(launch).toEqual(input);
    expect(launch).not.toBe(input);
    expect(launch.args).not.toBe(input.args);
  });

  it("rejects shell and environment spawn options", () => {
    expect(() => validateAcpLaunchSpec({ command: "agent", args: [], shell: true }))
      .toThrow(/unsupported field shell/i);
    expect(() => validateAcpLaunchSpec({ command: "agent", args: [], env: { API_TOKEN: "value" } }))
      .toThrow(/unsupported field env/i);
  });

  it("allows only the fixed non-secret Hermes environment additions", () => {
    expect(restrictedProcessEnv({ HERMES_ACP_SKIP_CONFIGURED_MCP: "1" }))
      .toMatchObject({ HERMES_ACP_SKIP_CONFIGURED_MCP: "1" });
    expect(() => restrictedProcessEnv({ API_TOKEN: "not-a-real-token" }))
      .toThrow(/API_TOKEN is not allowed/i);
  });
});

describe("bounded ACP NDJSON framing", () => {
  it("rejects a huge unterminated frame before buffering beyond the byte limit", async () => {
    const first = new Uint8Array(Math.ceil(ACP_MAX_INBOUND_FRAME_BYTES / 2)).fill(0x78);
    const second = new Uint8Array(Math.floor(ACP_MAX_INBOUND_FRAME_BYTES / 2) + 1).fill(0x78);
    const error = await boundedStreamFailure([first, second]);

    expect(error).toMatchObject({ name: "AcpTransportBoundsError" });
    expect(error.message).toBe(
      `ACP inbound frame exceeded ${ACP_MAX_INBOUND_FRAME_BYTES} bytes.`,
    );
  });

  it("rejects excessive transport fragmentation for one frame", async () => {
    const chunks = Array.from(
      { length: ACP_MAX_FRAME_CHUNKS + 1 },
      () => Uint8Array.of(0x7b),
    );
    const error = await boundedStreamFailure(chunks);

    expect(error.message).toBe(
      `ACP frame exceeded ${ACP_MAX_FRAME_CHUNKS} transport chunks.`,
    );
  });

  it("bounds newline-only frame floods within one raw chunk", async () => {
    const flood = new Uint8Array(ACP_MAX_INBOUND_FRAME_BYTES).fill(0x0a);
    const error = await boundedStreamFailure([flood]);

    expect(error.message).toBe(
      `ACP input chunk exceeded ${ACP_MAX_FRAMES_PER_READ_CHUNK} NDJSON frames.`,
    );
  });

  it("fails malformed JSON without logging or returning its payload", async () => {
    const payloadMarker = "DO_NOT_ECHO_MALFORMED_PAYLOAD";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const error = await boundedStreamFailure([
        new TextEncoder().encode(`{${payloadMarker}\n`),
      ]);

      expect(error.message).toBe("ACP agent emitted malformed NDJSON.");
      expect(error.message).not.toContain(payloadMarker);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects JSON array batches on the stable AnyMessage transport", async () => {
    const error = await boundedStreamFailure([
      new TextEncoder().encode('[{"jsonrpc":"2.0","method":"example"}]\n'),
    ]);

    expect(error.message).toBe("ACP agent emitted a non-object NDJSON frame.");
  });

  it("accepts the worst-case configured CJK scope, instruction, and history payload", async () => {
    const scope = "한".repeat(300_000);
    const instruction = "계".repeat(24_000);
    const history = "력".repeat(48_000);
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "cjk-bound-test",
        prompt: [{ type: "text", text: `${instruction}${history}${scope}` }],
      },
    } as AnyMessage;

    const encoded = await writeBoundedMessage(message);
    expect(encoded.byteLength).toBeGreaterThan(ACP_MAX_INBOUND_FRAME_BYTES);
    expect(encoded.byteLength).toBeLessThanOrEqual(ACP_MAX_OUTBOUND_FRAME_BYTES + 1);
    expect(encoded.at(-1)).toBe(0x0a);
  });

  it("still rejects an outbound frame beyond the separate 4 MiB cap", async () => {
    const message = {
      jsonrpc: "2.0",
      id: 2,
      method: "example/oversized",
      params: { text: "x".repeat(ACP_MAX_OUTBOUND_FRAME_BYTES) },
    } as AnyMessage;

    await expect(writeBoundedMessage(message)).rejects.toThrow(
      `ACP outbound frame exceeded ${ACP_MAX_OUTBOUND_FRAME_BYTES} bytes.`,
    );
  });
});

describe("custom ACP agents", () => {
  const definition = {
    id: "example-agent",
    label: "Example agent",
    workspace: path.resolve("test-workspace"),
    transport: "native",
    launch: { command: process.execPath, args: ["agent.mjs"] },
  } satisfies CustomAcpAgentDefinition;

  it("normalizes a validated definition into a generic agent profile", () => {
    const validated = validateCustomAcpAgentDefinition(definition);
    const profile = customAcpAgentProfile(definition);

    expect(validated).toEqual(definition);
    expect(profile).toMatchObject({
      id: "example-agent",
      source: "custom",
      executable: process.execPath,
      launch: definition.launch,
    });
  });

  it("wraps a WSL agent command as literal wsl.exe argv", () => {
    const profile = customAcpAgentProfile({
      ...definition,
      transport: "wsl",
      workspace: "/tmp/acp-workspace",
      launch: { command: "/usr/local/bin/example-agent", args: ["acp", "value with spaces"] },
    });

    expect(profile.executable).toBe("/usr/local/bin/example-agent");
    expect(profile.launch).toEqual({
      command: "wsl.exe",
      args: ["--exec", "/usr/local/bin/example-agent", "acp", "value with spaces"],
    });
  });

  it("uses the configured WSL distribution for custom ACP agents", () => {
    const profile = customAcpAgentProfile({
      ...definition,
      transport: "wsl",
      workspace: "/tmp/acp-workspace",
      launch: { command: "/usr/local/bin/example-agent", args: ["acp"] },
    }, "Ubuntu-24.04");

    expect(profile.launch?.args).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--exec",
      "/usr/local/bin/example-agent",
      "acp",
    ]);
  });

  it("rejects relative workspaces, unknown fields, and duplicate IDs", () => {
    expect(() => validateCustomAcpAgentDefinition({ ...definition, workspace: "relative/path" }))
      .toThrow(/absolute native path/i);
    expect(() => validateCustomAcpAgentDefinition({ ...definition, env: { API_TOKEN: "value" } }))
      .toThrow(/unsupported field env/i);
    expect(() => discoverCustomAcpAgents([definition, definition]))
      .toThrow(/duplicate custom ACP agent ID/i);
  });

  it("supports custom-only discovery without probing Hermes", async () => {
    const result = await discoverAcpAgents({
      ...DEFAULT_SETTINGS,
      hermesEnabled: false,
      customAcpAgents: [definition],
    });
    expect(result.profiles.map((profile) => profile.id)).toEqual(["example-agent"]);
    expect(result.diagnostics.message).toContain("0 Hermes and 1 custom ACP agent");
  });
});

describe("ACP pool compatibility", () => {
  it("checks a custom agent with ACP initialize only", async () => {
    const pool = new AcpPool();
    const profile = customAcpAgentProfile({
      id: "sdk-example",
      label: "SDK example",
      workspace: path.resolve("test-workspace"),
      launch: {
        command: process.execPath,
        args: [path.resolve("node_modules/@agentclientprotocol/sdk/dist/examples/agent.js")],
      },
    });
    try {
      await expect(pool.check(profile, 5_000)).resolves.toBeUndefined();
      expect(internalConnectionState(pool, profile.id)).toBeUndefined();
    } finally {
      pool.reset();
    }
  });

  it("checks with a separate ephemeral process without disturbing a pooled connection", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-change-gate-check-"));
    const marker = path.join(directory, "initializations.txt");
    const script = [
      "const{appendFileSync}=require('node:fs');",
      "const marker=",
      JSON.stringify(marker),
      ";const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "let pending='';let sessionCount=0;process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(chunk)=>{pending+=chunk;for(;;){",
      "const newline=pending.indexOf('\\n');if(newline<0)break;",
      "const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line)continue;",
      "const message=JSON.parse(line);",
      "if(message.method==='initialize'){appendFileSync(marker,String(process.pid)+'\\n');send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,agentCapabilities:{sessionCapabilities:{close:{}}}}});}",
      "else if(message.method==='session/new')send({jsonrpc:'2.0',id:message.id,result:{sessionId:'ephemeral-'+(++sessionCount)}});",
      "else if(message.method==='session/prompt'){const sessionId=message.params.sessionId;",
      "send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:sessionId}}}});",
      "send({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});}",
      "else if(message.method==='session/close')send({jsonrpc:'2.0',id:message.id,result:{}});",
      "}});",
    ].join("");
    const pool = new AcpPool();
    const profile = rawNodeAgentProfile("ephemeral-check", script);
    try {
      await expect(pool.prompt(profile, "first", "First", { timeoutMs: 5_000 }))
        .resolves.toBe("ephemeral-1");
      const pooledConnection = internalConnectionState(pool, profile.id);
      expect(readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);

      await expect(pool.check(profile, 5_000)).resolves.toBeUndefined();
      expect(internalConnectionState(pool, profile.id)).toBe(pooledConnection);
      expect(readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(2);

      await expect(pool.prompt(profile, "second", "Second", { timeoutMs: 5_000 }))
        .resolves.toBe("ephemeral-2");
      expect(readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
    } finally {
      pool.reset();
      if (existsSync(marker)) unlinkSync(marker);
      if (existsSync(directory)) rmdirSync(directory);
    }
  });

  it("creates a fresh ACP session for every prompt and retains none", async () => {
    const script = [
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "let pending='';let sessionCount=0;let closeCount=0;process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(chunk)=>{pending+=chunk;for(;;){",
      "const newline=pending.indexOf('\\n');if(newline<0)break;",
      "const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line)continue;",
      "const message=JSON.parse(line);",
      "if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,agentCapabilities:{loadSession:false,sessionCapabilities:{close:{}}}}});",
      "else if(message.method==='session/new')send({jsonrpc:'2.0',id:message.id,result:{sessionId:'fresh-'+(++sessionCount)}});",
      "else if(message.method==='session/prompt'){const sessionId=message.params.sessionId;",
      "send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:sessionId+'|closed='+closeCount}}}});",
      "send({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});}",
      "else if(message.method==='session/close'){closeCount++;send({jsonrpc:'2.0',id:message.id,result:{}});}",
      "}});",
    ].join("");
    const pool = new AcpPool();
    const profile = rawNodeAgentProfile("fresh-sessions", script);
    try {
      await expect(pool.prompt(profile, "same-thread", "First", { timeoutMs: 5_000 }))
        .resolves.toBe("fresh-1|closed=0");
      expect(internalConnectionState(pool, profile.id)?.sessions.size).toBe(0);
      await expect(pool.prompt(profile, "same-thread", "Second", { timeoutMs: 5_000 }))
        .resolves.toBe("fresh-2|closed=1");
      expect(internalConnectionState(pool, profile.id)?.sessions.size).toBe(0);
    } finally {
      pool.reset();
    }
  });

  it("releases a session cancelled after startup but before prompt dispatch", async () => {
    const script = [
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "let pending='';let closeCount=0;let promptCount=0;process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(chunk)=>{pending+=chunk;for(;;){",
      "const newline=pending.indexOf('\\n');if(newline<0)break;",
      "const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line)continue;",
      "const message=JSON.parse(line);",
      "if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,agentCapabilities:{sessionCapabilities:{close:{}}}}});",
      "else if(message.method==='session/new')send({jsonrpc:'2.0',id:message.id,result:{sessionId:'pre-prompt-session'}});",
      "else if(message.method==='session/close'){closeCount++;send({jsonrpc:'2.0',id:message.id,result:{}});}",
      "else if(message.method==='session/prompt'){promptCount++;const sessionId=message.params.sessionId;",
      "send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'closed='+closeCount+'|prompts='+promptCount}}}});",
      "send({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});}",
      "}});",
    ].join("");
    const pool = new AcpPool();
    const profile = rawNodeAgentProfile("pre-prompt-cancel", script);
    let cancellation: Promise<boolean> | undefined;
    try {
      const firstError = await pool.prompt(profile, "cancel-before-prompt", "Do not send this.", {
        timeoutMs: 5_000,
        onStatus: (status) => {
          if (status.startsWith("Waiting for") && !cancellation) {
            cancellation = pool.cancel(profile.id, "cancel-before-prompt");
          }
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(firstError).toMatchObject({ name: "AcpTurnCancelledError" });
      await expect(cancellation).resolves.toBe(true);
      await expect(pool.prompt(profile, "next-thread", "Now prompt.", { timeoutMs: 5_000 }))
        .resolves.toBe("closed=1|prompts=1");
      expect(internalConnectionState(pool, profile.id)?.sessions.size).toBe(0);
    } finally {
      pool.reset();
    }
  });

  it("resets a close-incapable agent after concurrent turns finish", async () => {
    const script = [
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "let pending='';let sessionCount=0;process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(chunk)=>{pending+=chunk;for(;;){",
      "const newline=pending.indexOf('\\n');if(newline<0)break;",
      "const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line)continue;",
      "const message=JSON.parse(line);",
      "if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,agentCapabilities:{loadSession:false}}});",
      "else if(message.method==='session/new')send({jsonrpc:'2.0',id:message.id,result:{sessionId:'fallback-'+(++sessionCount)}});",
      "else if(message.method==='session/prompt'){const sessionId=message.params.sessionId;",
      "send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:sessionId}}}});",
      "const promptText=message.params.prompt[0]?.text||'';",
      "setTimeout(()=>send({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}}),promptText==='Fast'?20:150);}",
      "}});",
    ].join("");
    const pool = new AcpPool();
    const profile = rawNodeAgentProfile("close-fallback", script);
    try {
      const first = pool.prompt(profile, "first-thread", "Fast", { timeoutMs: 5_000 });
      const second = pool.prompt(profile, "second-thread", "Slow", { timeoutMs: 5_000 });

      const firstResult = await first;
      await expect(pool.prompt(profile, "blocked-thread", "Blocked", { timeoutMs: 5_000 }))
        .rejects.toMatchObject({ name: "AcpConnectionRestartingError" });
      const results = [firstResult, await second];
      expect(new Set(results)).toEqual(new Set(["fallback-1", "fallback-2"]));
      const state = internalConnectionState(pool, profile.id);
      expect(state?.child).toBeNull();
      expect(state?.connection).toBeNull();
      expect(state?.sessions.size).toBe(0);
      await expect(pool.prompt(profile, "after-reset", "After", { timeoutMs: 5_000 }))
        .resolves.toBe("fallback-1");
    } finally {
      pool.reset();
    }
  });

  it("coalesces more than 2,048 valid one-character text deltas", async () => {
    const deltaCount = 5_000;
    const script = [
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "let pending='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(chunk)=>{pending+=chunk;for(;;){",
      "const newline=pending.indexOf('\\n');if(newline<0)break;",
      "const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line)continue;",
      "const message=JSON.parse(line);",
      "if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,agentCapabilities:{loadSession:false}}});",
      "else if(message.method==='session/new')send({jsonrpc:'2.0',id:message.id,result:{sessionId:'delta-session'}});",
      "else if(message.method==='session/prompt'){for(let index=0;index<",
      String(deltaCount),
      ";index++)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'delta-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'}}}});",
      "send({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});}",
      "}});",
    ].join("");
    const pool = new AcpPool();
    const profile = rawNodeAgentProfile("small-deltas", script);
    try {
      await expect(pool.prompt(profile, "delta-thread", "Stream deltas.", { timeoutMs: 10_000 }))
        .resolves.toBe("x".repeat(deltaCount));
      expect(internalConnectionState(pool, profile.id)?.connection).toBeNull();
    } finally {
      pool.reset();
    }
  });

  it("bounds cumulative turn text before joining chunks and tears down the process", async () => {
    const textChunkLength = 25_000;
    const textChunkCount = Math.ceil(ACP_MAX_TURN_TEXT_CHARS / textChunkLength) + 2;
    const script = [
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "let pending='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(chunk)=>{pending+=chunk;for(;;){",
      "const newline=pending.indexOf('\\n');if(newline<0)break;",
      "const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line)continue;",
      "const message=JSON.parse(line);",
      "if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,agentCapabilities:{loadSession:false}}});",
      "else if(message.method==='session/new')send({jsonrpc:'2.0',id:message.id,result:{sessionId:'bounded-session'}});",
      "else if(message.method==='session/prompt'){const text='x'.repeat(",
      String(textChunkLength),
      ");for(let index=0;index<",
      String(textChunkCount),
      ";index++)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'bounded-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});",
      "send({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});}",
      "}});",
    ].join("");
    const pool = new AcpPool();
    const profile = rawNodeAgentProfile("oversized-text", script);
    try {
      const error = await pool.prompt(profile, "oversized-thread", "Generate too much text.", {
        timeoutMs: 10_000,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AcpTurnOutputLimitError);
      expect(error).toMatchObject({
        message: `ACP turn text exceeded ${ACP_MAX_TURN_TEXT_CHARS} characters.`,
      });
      const state = internalConnectionState(pool, profile.id);
      expect(state?.child).toBeNull();
      expect(state?.connection).toBeNull();
      expect(state?.sessions.size).toBe(0);
      await expect(pool.cancel(profile.id, "oversized-thread")).resolves.toBe(false);
    } finally {
      pool.reset();
    }
  });

  it.each([
    {
      id: "huge-unterminated",
      script: `process.stdout.write('x'.repeat(${ACP_MAX_INBOUND_FRAME_BYTES + 1}));setInterval(()=>{},1000);`,
      expected: `ACP inbound frame exceeded ${ACP_MAX_INBOUND_FRAME_BYTES} bytes.`,
      marker: "",
    },
    {
      id: "malformed-frame",
      script: `process.stdout.write(${JSON.stringify("{DO_NOT_ECHO_FRAME_PAYLOAD\n")});setInterval(()=>{},1000);`,
      expected: "ACP agent emitted malformed NDJSON.",
      marker: "DO_NOT_ECHO_FRAME_PAYLOAD",
    },
  ])("kills an agent after rejecting its $id stdout", async ({ id, script, expected, marker }) => {
    const pool = new AcpPool();
    const profile = rawNodeAgentProfile(id, script);
    try {
      const error = await pool.check(profile, 5_000).then(
        () => null,
        (caught: unknown) => caught instanceof Error ? caught : new Error("Unknown check failure."),
      );

      expect(error).toMatchObject({ message: expected });
      expect(error?.message).not.toContain(marker || "never-present");
      expect(error?.message.length).toBeLessThan(200);
      const state = internalConnectionState(pool, profile.id);
      expect(state).toBeUndefined();
    } finally {
      pool.reset();
    }
  });

  it("returns a cancelled turn promptly while the agent drains in the background", async () => {
    const pool = new AcpPool();
    const profile = customAcpAgentProfile({
      id: "sdk-cancel",
      label: "SDK cancellation fixture",
      workspace: path.resolve("test-workspace"),
      launch: {
        command: process.execPath,
        args: [path.resolve("node_modules/@agentclientprotocol/sdk/dist/examples/agent.js")],
      },
    });
    let markPromptStarted: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    try {
      const promptResult = pool.prompt(profile, "cancel-thread", "Wait for cancellation.", {
        timeoutMs: 5_000,
        onStatus: (status) => {
          if (status.startsWith("Waiting for")) markPromptStarted?.();
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await promptStarted;

      const startedAt = performance.now();
      await expect(pool.cancel(profile.id, "cancel-thread")).resolves.toBe(true);
      const error = await promptResult;

      expect(error).toMatchObject({ name: "AcpTurnCancelledError" });
      expect(performance.now() - startedAt).toBeLessThan(750);
      await expect(pool.cancel(profile.id, "cancel-thread")).resolves.toBe(false);
    } finally {
      pool.reset();
    }
  });

  it("returns false when there is no active turn to cancel", async () => {
    const pool = new AcpPool();
    await expect(pool.cancel("missing-agent", "missing-thread")).resolves.toBe(false);
    expect(new HermesAcpPool()).toBeInstanceOf(AcpPool);
  });
});
