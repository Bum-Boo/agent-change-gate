import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  type ActiveSession,
  type AnyMessage,
  type ClientConnection,
  type Stream,
} from "@agentclientprotocol/sdk";

import manifest from "../../manifest.json";
import type { AcpLaunchSpec, AgentProfile } from "../core/types";
import { spawnAcpProcess, validateAcpLaunchSpec } from "./process";

export const ACP_MAX_INBOUND_FRAME_BYTES = 1_048_576;
export const ACP_MAX_OUTBOUND_FRAME_BYTES = 4_194_304;
/** @deprecated Use the direction-specific frame limits. */
export const ACP_MAX_FRAME_BYTES = ACP_MAX_INBOUND_FRAME_BYTES;
export const ACP_MAX_FRAME_CHUNKS = 256;
export const ACP_MAX_FRAMES_PER_READ_CHUNK = 1_024;
export const ACP_MAX_READ_CHUNK_BYTES = 1_048_576;
export const ACP_MAX_TURN_TEXT_CHARS = 1_000_000;
export const ACP_MAX_TURN_TEXT_CHUNKS = ACP_MAX_TURN_TEXT_CHARS;
export const ACP_MAX_TURN_AUX_UPDATES = 4_096;
export const ACP_MAX_TURN_UPDATES = ACP_MAX_TURN_TEXT_CHUNKS + ACP_MAX_TURN_AUX_UPDATES;
export const ACP_TEXT_COALESCE_CHARS = 16_384;

export class AcpTransportBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTransportBoundsError";
  }
}

export class AcpTurnOutputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTurnOutputLimitError";
  }
}

class BoundedFrameBuffer {
  private parts: Uint8Array[] = [];
  private byteLength = 0;
  private chunkCount = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > ACP_MAX_READ_CHUNK_BYTES) {
      throw new AcpTransportBoundsError(
        `ACP input chunk exceeded ${ACP_MAX_READ_CHUNK_BYTES} bytes.`,
      );
    }
    const frames: Uint8Array[] = [];
    let frameCount = 0;
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
      frameCount += 1;
      if (frameCount > ACP_MAX_FRAMES_PER_READ_CHUNK) {
        throw new AcpTransportBoundsError(
          `ACP input chunk exceeded ${ACP_MAX_FRAMES_PER_READ_CHUNK} NDJSON frames.`,
        );
      }
      this.append(chunk.subarray(start, index));
      frames.push(this.take());
      start = index + 1;
    }
    if (start < chunk.byteLength) this.append(chunk.subarray(start));
    return frames;
  }

  flush(): Uint8Array | undefined {
    return this.byteLength > 0 ? this.take() : undefined;
  }

  private append(segment: Uint8Array): void {
    if (segment.byteLength === 0) return;
    const nextByteLength = this.byteLength + segment.byteLength;
    if (nextByteLength > ACP_MAX_INBOUND_FRAME_BYTES) {
      throw new AcpTransportBoundsError(
        `ACP inbound frame exceeded ${ACP_MAX_INBOUND_FRAME_BYTES} bytes.`,
      );
    }
    const nextChunkCount = this.chunkCount + 1;
    if (nextChunkCount > ACP_MAX_FRAME_CHUNKS) {
      throw new AcpTransportBoundsError(
        `ACP frame exceeded ${ACP_MAX_FRAME_CHUNKS} transport chunks.`,
      );
    }
    this.parts.push(new Uint8Array(segment));
    this.byteLength = nextByteLength;
    this.chunkCount = nextChunkCount;
  }

  private take(): Uint8Array {
    const frame = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const part of this.parts) {
      frame.set(part, offset);
      offset += part.byteLength;
    }
    this.parts = [];
    this.byteLength = 0;
    this.chunkCount = 0;
    return frame;
  }
}

/**
 * ACP-compatible NDJSON transport with bounded raw framing and sanitized parse
 * failures. It intentionally rejects a bad frame instead of logging payloads.
 */
export function boundedAcpNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let resumeInput: (() => void) | undefined;

  const waitForDemand = async (controller: ReadableStreamDefaultController<AnyMessage>): Promise<void> => {
    if ((controller.desiredSize ?? 1) > 0) return;
    await new Promise<void>((resolve) => {
      resumeInput = resolve;
      if ((controller.desiredSize ?? 1) > 0) {
        resumeInput = undefined;
        resolve();
      }
    });
  };

  const decodeFrame = (frame: Uint8Array): AnyMessage | null => {
    let line: string;
    try {
      line = decoder.decode(frame).trim();
    } catch {
      throw new AcpTransportBoundsError("ACP agent emitted invalid UTF-8 NDJSON.");
    }
    if (!line) return null;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      throw new AcpTransportBoundsError("ACP agent emitted malformed NDJSON.");
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new AcpTransportBoundsError("ACP agent emitted a non-object NDJSON frame.");
    }
    return message as AnyMessage;
  };

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const frames = new BoundedFrameBuffer();
      const reader = input.getReader();
      inputReader = reader;
      try {
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const frame of frames.push(value)) {
            const message = decodeFrame(frame);
            if (message) {
              controller.enqueue(message);
              await waitForDemand(controller);
            }
            if (cancelled) return;
          }
        }
        if (cancelled) return;
        const finalFrame = frames.flush();
        if (finalFrame) {
          const message = decodeFrame(finalFrame);
          if (message) controller.enqueue(message);
        }
        controller.close();
      } catch (error) {
        if (cancelled) return;
        const safeError = error instanceof AcpTransportBoundsError
          ? error
          : new AcpTransportBoundsError("ACP input stream failed.");
        controller.error(safeError);
        try {
          await reader.cancel(safeError);
        } catch {
          // The child stream may already have closed.
        }
      } finally {
        if (inputReader === reader) inputReader = undefined;
        reader.releaseLock();
      }
    },
    cancel(reason) {
      cancelled = true;
      resumeInput?.();
      resumeInput = undefined;
      return inputReader?.cancel(reason);
    },
    pull() {
      resumeInput?.();
      resumeInput = undefined;
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const encoded = encoder.encode(JSON.stringify(message));
      if (encoded.byteLength > ACP_MAX_OUTBOUND_FRAME_BYTES) {
        throw new AcpTransportBoundsError(
          `ACP outbound frame exceeded ${ACP_MAX_OUTBOUND_FRAME_BYTES} bytes.`,
        );
      }
      const framed = new Uint8Array(encoded.byteLength + 1);
      framed.set(encoded);
      framed[encoded.byteLength] = 0x0a;
      const writer = output.getWriter();
      try {
        await writer.write(framed);
      } finally {
        writer.releaseLock();
      }
    },
  });
  return { readable, writable };
}

export interface AcpConnectionOptions {
  timeoutMs: number;
  onStatus?: (status: string) => void;
}

interface ActiveTurn {
  controller: AbortController;
  session: ActiveSession | null;
  sessionStartup: Promise<ActiveSession> | null;
  promptCompletion: Promise<unknown> | null;
  promptStarted: boolean;
  cancelRequested: boolean;
  cancelNotification: Promise<void> | null;
}

const CANCEL_DRAIN_TIMEOUT_MS = 5_000;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;

class AcpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTimeoutError";
  }
}

export class AcpTurnCancelledError extends Error {
  constructor(message = "ACP turn was cancelled.") {
    super(message);
    this.name = "AcpTurnCancelledError";
  }
}

export class AcpConnectionRestartingError extends Error {
  constructor() {
    super("ACP agent connection is resetting after a completed turn; retry shortly.");
    this.name = "AcpConnectionRestartingError";
  }
}

function wslPrefix(distribution?: string): string[] {
  return distribution?.trim() ? ["-d", distribution.trim(), "--exec"] : ["--exec"];
}

function resolveLaunchSpec(profile: AgentProfile): AcpLaunchSpec {
  if (profile.launch) return validateAcpLaunchSpec(profile.launch);
  if (profile.source === "custom") {
    throw new Error(`Custom ACP agent ${profile.id} is missing a launch specification.`);
  }

  const hermesArgs = ["-p", profile.id, "acp"];
  if (profile.transport === "wsl") {
    return validateAcpLaunchSpec({
      command: "wsl.exe",
      args: [
        ...wslPrefix(profile.wslDistribution),
        "env",
        "HERMES_ACP_SKIP_CONFIGURED_MCP=1",
        profile.executable,
        ...hermesArgs,
      ],
    });
  }
  return validateAcpLaunchSpec({ command: profile.executable, args: hermesArgs });
}

function launchEnvironment(profile: AgentProfile): NodeJS.ProcessEnv {
  if (profile.source === "custom" || profile.transport !== "native") return {};
  return {
    ...(profile.home ? { HERMES_HOME: profile.home } : {}),
    HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
  };
}

function profileFingerprint(profile: AgentProfile): string {
  return JSON.stringify({
    home: profile.source === "custom" ? "" : profile.home,
    label: profile.label,
    launch: resolveLaunchSpec(profile),
    source: profile.source ?? "hermes",
    transport: profile.transport,
    workspace: profile.workspace,
  });
}

class AcpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly drainingSessions = new Set<ActiveSession>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly cancelledSessionIds = new Set<string>();
  private starting: Promise<void> | null = null;
  private stderrTail = "";
  private supportsSessionClose = false;
  private restartWhenIdle = false;
  private readonly launchSpec: AcpLaunchSpec;
  private readonly fingerprint: string;

  constructor(private readonly profile: AgentProfile) {
    this.launchSpec = resolveLaunchSpec(profile);
    this.fingerprint = profileFingerprint(profile);
  }

  matches(profile: AgentProfile): boolean {
    return this.fingerprint === profileFingerprint(profile);
  }

  async check(timeoutMs: number): Promise<void> {
    await this.ensureStarted({ timeoutMs });
  }

  async prompt(threadKey: string, prompt: string, options: AcpConnectionOptions): Promise<string> {
    if (this.restartWhenIdle) throw new AcpConnectionRestartingError();
    if (this.activeTurns.has(threadKey)) {
      throw new Error("This note thread already has an ACP turn in progress.");
    }
    const turn: ActiveTurn = {
      controller: new AbortController(),
      session: null,
      sessionStartup: null,
      promptCompletion: null,
      promptStarted: false,
      cancelRequested: false,
      cancelNotification: null,
    };
    this.activeTurns.set(threadKey, turn);
    try {
      return await this.runPrompt(threadKey, prompt, options, turn);
    } finally {
      if (this.activeTurns.get(threadKey) === turn) this.activeTurns.delete(threadKey);
      this.restartConnectionIfIdle();
    }
  }

  async cancel(threadKey: string): Promise<boolean> {
    const turn = this.activeTurns.get(threadKey);
    if (!turn) return false;
    turn.cancelRequested = true;
    if (turn.promptStarted && turn.session) {
      this.cancelledSessionIds.add(turn.session.sessionId);
      if (!turn.cancelNotification) {
        turn.cancelNotification = this.sendSessionCancel(turn.session);
      }
    }
    if (!turn.controller.signal.aborted) {
      turn.controller.abort(new AcpTurnCancelledError());
    }
    if (turn.cancelNotification) await turn.cancelNotification;
    return true;
  }

  dispose(): void {
    this.cleanup(true, true);
    this.starting = null;
  }

  private async runPrompt(
    threadKey: string,
    prompt: string,
    options: AcpConnectionOptions,
    turn: ActiveTurn,
  ): Promise<string> {
    let connection: ClientConnection | null = null;
    let session: ActiveSession | null = null;
    try {
      await this.withCancellation(this.ensureStarted(options), turn.controller.signal);
      if (turn.cancelRequested) throw new AcpTurnCancelledError();
      connection = this.connection;
      if (!connection) throw new Error("ACP connection is unavailable.");

      options.onStatus?.(`Starting ${this.profile.label} session…`);
      const sessionStartup = connection.agent
        .buildSession({ cwd: this.profile.workspace, mcpServers: [] })
        .start({ cancellationSignal: turn.controller.signal });
      turn.sessionStartup = sessionStartup;
      session = await this.withTimeout(
        sessionStartup,
        "ACP session startup",
        options.timeoutMs,
        turn.controller,
      );
      turn.sessionStartup = null;
      turn.session = session;
      if (connection !== this.connection || connection.signal.aborted) {
        throw new Error("ACP agent disconnected during session startup.");
      }
      if (turn.cancelRequested) throw new AcpTurnCancelledError();
      this.sessions.set(threadKey, session);

      if (turn.cancelRequested) throw new AcpTurnCancelledError();
      options.onStatus?.(`Waiting for ${this.profile.label}…`);
      if (turn.cancelRequested) throw new AcpTurnCancelledError();
      turn.promptStarted = true;
      const responsePromise = session.prompt(prompt, { cancellationSignal: turn.controller.signal });
      const textPromise = this.readBoundedText(session);
      const promptCompletion = Promise.all([responsePromise, textPromise]);
      turn.promptCompletion = promptCompletion;
      const [response, text] = await this.withTimeout(
        promptCompletion,
        "ACP prompt",
        options.timeoutMs,
        turn.controller,
      );
      if (response.stopReason === "cancelled" || turn.cancelRequested) {
        throw new AcpTurnCancelledError(
          turn.cancelRequested ? "ACP turn was cancelled." : "ACP agent cancelled the turn.",
        );
      }
      await this.releaseCompletedSession(threadKey, session);
      turn.session = null;
      return text;
    } catch (error) {
      const cancelled = turn.cancelRequested || error instanceof AcpTurnCancelledError;
      if (!cancelled && session) await this.sendSessionCancel(session, connection);
      if (session) {
        if (cancelled && turn.promptStarted && turn.promptCompletion) {
          this.detachSession(threadKey, session);
          this.drainCancelledSession(session, turn.promptCompletion);
        } else if (cancelled) {
          this.detachSession(threadKey, session);
          await this.releaseAgentSession(session);
        } else {
          this.dropSession(threadKey, session);
        }
        turn.session = null;
      } else if (cancelled && turn.sessionStartup) {
        void turn.sessionStartup.then(
          async (lateSession) => await this.releaseAgentSession(lateSession),
          () => undefined,
        );
      }
      if (!cancelled || error instanceof AcpTimeoutError) this.dispose();
      if (cancelled && !(error instanceof AcpTurnCancelledError)) {
        throw new AcpTurnCancelledError();
      }
      throw error;
    }
  }

  private dropSession(threadKey: string, session: ActiveSession): void {
    this.detachSession(threadKey, session);
    this.cancelledSessionIds.delete(session.sessionId);
    session.dispose();
  }

  private detachSession(threadKey: string, session: ActiveSession): void {
    if (this.sessions.get(threadKey) === session) this.sessions.delete(threadKey);
  }

  private async releaseCompletedSession(threadKey: string, session: ActiveSession): Promise<void> {
    this.detachSession(threadKey, session);
    await this.releaseAgentSession(session);
  }

  private async releaseAgentSession(session: ActiveSession): Promise<void> {
    const closed = await this.closeAgentSession(session);
    this.cancelledSessionIds.delete(session.sessionId);
    this.drainingSessions.delete(session);
    session.dispose();
    if (!closed) {
      this.restartWhenIdle = true;
      this.restartConnectionIfIdle();
    }
  }

  private async closeAgentSession(session: ActiveSession): Promise<boolean> {
    // ACP v1 has no unconditional session teardown. Only call the official
    // method when initialize advertises `close`. Without it, return false so
    // the process is reset once concurrent turns finish; local dispose alone
    // cannot release agent-owned session resources.
    if (!this.supportsSessionClose) return false;
    const connection = this.connection;
    if (!connection || connection.signal.aborted) return true;
    const controller = new AbortController();
    try {
      await this.withTimeout(
        connection.agent.request(methods.agent.session.close, { sessionId: session.sessionId }),
        "ACP session close",
        SESSION_CLOSE_TIMEOUT_MS,
        controller,
      );
      return true;
    } catch {
      return false;
    }
  }

  private drainCancelledSession(session: ActiveSession, completion: Promise<unknown>): void {
    this.drainingSessions.add(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gracePeriod = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CANCEL_DRAIN_TIMEOUT_MS);
      timer.unref?.();
    });
    const settled = completion.then(() => undefined, () => undefined);
    void Promise.race([settled, gracePeriod]).finally(async () => {
      if (timer) clearTimeout(timer);
      if (this.drainingSessions.has(session)) await this.releaseAgentSession(session);
    });
  }

  private async sendSessionCancel(
    session: ActiveSession,
    connection: ClientConnection | null = this.connection,
  ): Promise<void> {
    if (!connection || connection.signal.aborted) return;
    try {
      await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
    } catch {
      // The ACP process may already be gone.
    }
  }

  private async readBoundedText(session: ActiveSession): Promise<string> {
    const textBlocks: string[] = [];
    let pendingTextChunks: string[] = [];
    let pendingTextLength = 0;
    let textLength = 0;
    let textChunkCount = 0;
    let auxiliaryUpdateCount = 0;
    let updateCount = 0;
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === "stop") {
        if (pendingTextChunks.length > 0) textBlocks.push(pendingTextChunks.join(""));
        return textBlocks.join("");
      }

      updateCount += 1;
      if (updateCount > ACP_MAX_TURN_UPDATES) {
        throw new AcpTurnOutputLimitError(
          `ACP turn exceeded ${ACP_MAX_TURN_UPDATES} session updates.`,
        );
      }
      const { update } = message;
      if (
        update.sessionUpdate !== "agent_message_chunk"
        || update.content.type !== "text"
        || update.content.text.length === 0
      ) {
        auxiliaryUpdateCount += 1;
        if (auxiliaryUpdateCount > ACP_MAX_TURN_AUX_UPDATES) {
          throw new AcpTurnOutputLimitError(
            `ACP turn exceeded ${ACP_MAX_TURN_AUX_UPDATES} non-text or empty updates.`,
          );
        }
        continue;
      }
      textChunkCount += 1;
      if (textChunkCount > ACP_MAX_TURN_TEXT_CHUNKS) {
        throw new AcpTurnOutputLimitError(
          `ACP turn exceeded ${ACP_MAX_TURN_TEXT_CHUNKS} text chunks.`,
        );
      }
      const nextLength = textLength + update.content.text.length;
      if (nextLength > ACP_MAX_TURN_TEXT_CHARS) {
        throw new AcpTurnOutputLimitError(
          `ACP turn text exceeded ${ACP_MAX_TURN_TEXT_CHARS} characters.`,
        );
      }
      pendingTextChunks.push(update.content.text);
      pendingTextLength += update.content.text.length;
      textLength = nextLength;
      if (pendingTextLength >= ACP_TEXT_COALESCE_CHARS) {
        textBlocks.push(pendingTextChunks.join(""));
        pendingTextChunks = [];
        pendingTextLength = 0;
      }
    }
  }

  private cleanup(killChild: boolean, cancelActiveTurns: boolean): void {
    const connection = this.connection;
    if (cancelActiveTurns) {
      for (const turn of this.activeTurns.values()) {
        turn.cancelRequested = true;
        if (turn.promptStarted && turn.session) {
          this.cancelledSessionIds.add(turn.session.sessionId);
          if (!turn.cancelNotification) {
            turn.cancelNotification = this.sendSessionCancel(turn.session);
          }
        }
        if (!turn.controller.signal.aborted) {
          turn.controller.abort(new AcpTurnCancelledError("ACP connection was reset."));
        }
      }
    }
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    for (const session of this.drainingSessions) session.dispose();
    this.drainingSessions.clear();
    this.cancelledSessionIds.clear();
    this.supportsSessionClose = false;
    this.restartWhenIdle = false;
    this.connection = null;
    connection?.close();
    const child = this.child;
    this.child = null;
    if (killChild && child && child.exitCode === null && !child.killed) child.kill();
  }

  private restartConnectionIfIdle(): void {
    if (!this.restartWhenIdle || this.activeTurns.size > 0) return;
    this.cleanup(true, false);
    this.starting = null;
  }

  private async ensureStarted(options: AcpConnectionOptions): Promise<void> {
    if (this.connection && !this.connection.signal.aborted) return;
    if (this.starting) return await this.starting;
    this.cleanup(true, false);
    const starting = this.start(options.timeoutMs);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async start(timeoutMs: number): Promise<void> {
    this.stderrTail = "";
    const child = spawnAcpProcess(this.launchSpec, launchEnvironment(this.profile));
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_000);
    });
    const processEnded = (): void => {
      if (this.child === child) this.cleanup(false, false);
    };
    child.once("error", processEnded);
    child.once("close", processEnded);

    const unavailable = (method: string): never => {
      throw RequestError.methodNotFound(method);
    };
    const app = client({ name: "agent-change-gate" })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        if (this.cancelledSessionIds.has(params.sessionId)) {
          return { outcome: { outcome: "cancelled" } };
        }
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
    const stream = boundedAcpNdJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.connection = connection;
    void connection.closed.then(() => {
      if (this.connection === connection) this.cleanup(true, false);
    });

    try {
      const initialized = await this.withTimeout(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "agent-change-gate",
            title: "Agent Change Gate",
            version: manifest.version,
          },
        }),
        "ACP initialization",
        timeoutMs,
      );
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version: ${initialized.protocolVersion}`);
      }
      const closeCapability = initialized.agentCapabilities?.sessionCapabilities?.close;
      this.supportsSessionClose = closeCapability !== undefined && closeCapability !== null;
    } catch (error) {
      this.cleanup(true, false);
      const detail = this.stderrTail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-1)[0];
      if (detail) throw new Error(`ACP initialization failed: ${detail.slice(0, 500)}`);
      throw error;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number,
    controller?: AbortController,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new AcpTimeoutError(
          `${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
        );
        controller?.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const cancellation = new Promise<never>((_, reject) => {
      if (!controller) return;
      onAbort = () => {
        const reason = controller.signal.reason;
        reject(reason instanceof Error ? reason : new AcpTurnCancelledError());
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, timeout, cancellation]);
    } finally {
      if (timer) clearTimeout(timer);
      if (controller && onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private async withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new AcpTurnCancelledError();
    }
    let onAbort: (() => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new AcpTurnCancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, cancellation]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}

export class AcpPool {
  private readonly connections = new Map<string, AcpConnection>();

  async check(profile: AgentProfile, timeoutMs: number): Promise<void> {
    const connection = new AcpConnection(profile);
    try {
      await connection.check(timeoutMs);
    } finally {
      connection.dispose();
    }
  }

  async prompt(
    profile: AgentProfile,
    threadKey: string,
    prompt: string,
    options: AcpConnectionOptions,
  ): Promise<string> {
    return await this.connectionFor(profile).prompt(threadKey, prompt, options);
  }

  async cancel(profileId: string, threadKey: string): Promise<boolean> {
    return await this.connections.get(profileId)?.cancel(threadKey) ?? false;
  }

  private connectionFor(profile: AgentProfile): AcpConnection {
    let connection = this.connections.get(profile.id);
    if (connection && !connection.matches(profile)) {
      connection.dispose();
      this.connections.delete(profile.id);
      connection = undefined;
    }
    if (!connection) {
      connection = new AcpConnection(profile);
      this.connections.set(profile.id, connection);
    }
    return connection;
  }

  reset(profileId?: string): void {
    if (profileId) {
      this.connections.get(profileId)?.dispose();
      this.connections.delete(profileId);
      return;
    }
    for (const connection of this.connections.values()) connection.dispose();
    this.connections.clear();
  }
}

/** @deprecated Use AcpPool; retained for existing plugin integrations. */
export { AcpPool as HermesAcpPool };
