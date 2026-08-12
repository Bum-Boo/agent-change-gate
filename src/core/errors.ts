export const MAX_USER_FACING_ERROR_FIELD_CHARS = 200;

const MAX_CLASSIFICATION_INPUT_CHARS = 2_048;

export type AcpErrorPhase = "launch" | "initialize" | "turn" | "reply";

export type UserFacingAcpErrorCategory =
  | "Agent launch failed"
  | "Agent initialization failed"
  | "Agent response timed out"
  | "ACP protocol error"
  | "Invalid agent reply"
  | "ACP request failed"
  | "Unexpected request failure";

export type AcpDiagnosticCode =
  | "ACG-ACP-LAUNCH"
  | "ACG-ACP-INIT"
  | "ACG-ACP-TIMEOUT"
  | "ACG-ACP-PROTOCOL"
  | "ACG-ACP-REPLY"
  | "ACG-ACP-RUNTIME"
  | "ACG-ACP-UNKNOWN";

export interface UserFacingAcpError {
  category: UserFacingAcpErrorCategory;
  nextAction: string;
  diagnosticCode: AcpDiagnosticCode;
}

export interface AcpErrorContext {
  phase?: AcpErrorPhase;
}

const CLASSIFICATIONS = {
  launch: {
    category: "Agent launch failed",
    nextAction: "Open plugin settings, verify the agent executable and arguments, then run the agent check again.",
    diagnosticCode: "ACG-ACP-LAUNCH",
  },
  initialize: {
    category: "Agent initialization failed",
    nextAction: "Check that the selected agent supports ACP and starts normally, then retry the agent check.",
    diagnosticCode: "ACG-ACP-INIT",
  },
  timeout: {
    category: "Agent response timed out",
    nextAction: "Retry once. If it repeats, increase the response timeout or reduce the request before trying again.",
    diagnosticCode: "ACG-ACP-TIMEOUT",
  },
  protocol: {
    category: "ACP protocol error",
    nextAction: "Update or reconfigure the ACP agent to a compatible version, then reconnect it.",
    diagnosticCode: "ACG-ACP-PROTOCOL",
  },
  reply: {
    category: "Invalid agent reply",
    nextAction: "Retry the request. If it repeats, ask the agent to return only the required response format.",
    diagnosticCode: "ACG-ACP-REPLY",
  },
  runtime: {
    category: "ACP request failed",
    nextAction: "Reconnect the selected agent and retry. If it repeats, run the agent check in plugin settings.",
    diagnosticCode: "ACG-ACP-RUNTIME",
  },
  unknown: {
    category: "Unexpected request failure",
    nextAction: "Retry once. If it repeats, restart the agent connection and report the diagnostic code.",
    diagnosticCode: "ACG-ACP-UNKNOWN",
  },
} as const satisfies Record<string, UserFacingAcpError>;

type ClassificationKey = keyof typeof CLASSIFICATIONS;

const LAUNCH_ERROR_CODES = new Set(["eacces", "enoent", "enoexec", "eperm"]);

const INVALID_REPLY_MARKERS = [
  "could not parse the acp agent response",
  "did not return a json object",
  "proposed an edit larger than",
  "proposed an edit without replacement text",
  "returned a message that is too large",
  "returned an edit proposal while",
  "returned an invalid response object",
  "returned an unsupported action",
  "returned more data than",
  "returned no text",
  "returned no user-facing message",
] as const;

const PROTOCOL_ERROR_MARKERS = [
  "invalid utf-8 ndjson",
  "malformed ndjson",
  "method not found",
  "non-object ndjson frame",
  "unsupported acp protocol version",
] as const;

interface ErrorFingerprint {
  code: string;
  message: string;
  name: string;
}

function boundedLower(value: string): string {
  return value.slice(0, MAX_CLASSIFICATION_INPUT_CHARS).toLocaleLowerCase("en-US");
}

/**
 * Read data properties without invoking accessors on an unknown thrown value.
 * Classification is best-effort; hostile or unusual values safely fall back
 * to the unknown category.
 */
function readDataString(value: unknown, key: string): string {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return "";
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
        return boundedLower(descriptor.value);
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    // Proxies and exotic thrown values must not break error handling.
  }
  return "";
}

function fingerprint(error: unknown): ErrorFingerprint {
  if (typeof error === "string") {
    return { code: "", message: boundedLower(error), name: "" };
  }
  return {
    code: readDataString(error, "code"),
    message: readDataString(error, "message"),
    name: readDataString(error, "name"),
  };
}

function containsAny(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => value.includes(marker));
}

function classifyFingerprint(
  value: ErrorFingerprint,
  context: Readonly<AcpErrorContext>,
): ClassificationKey {
  const combined = `${value.name}\n${value.message}`;

  if (
    value.name === "acptimeouterror"
    || value.code === "etimedout"
    || /\b(?:timed out|timeout)\b/u.test(combined)
  ) {
    return "timeout";
  }

  if (
    LAUNCH_ERROR_CODES.has(value.code)
    || value.name === "systemerror" && combined.includes("spawn")
    || value.message.startsWith("spawn ")
    || value.message.includes("acp launch specification")
    || value.message.includes("acp launch command")
    || value.message.includes("missing a launch specification")
  ) {
    return "launch";
  }

  if (
    value.name === "acptransportboundserror"
    || value.name === "requesterror"
    || containsAny(combined, PROTOCOL_ERROR_MARKERS)
    || combined.includes("acp inbound frame")
    || combined.includes("acp outbound frame")
    || combined.includes("acp input stream failed")
  ) {
    return "protocol";
  }

  if (
    value.name === "acpturnoutputlimiterror"
    || containsAny(value.message, INVALID_REPLY_MARKERS)
    || context.phase === "reply"
  ) {
    return "reply";
  }

  if (context.phase === "launch") return "launch";
  if (context.phase === "initialize" || value.message.includes("acp initialization")) {
    return "initialize";
  }
  if (
    context.phase === "turn"
    || value.name.startsWith("acp")
    || /(?:^|\s)acp(?:\s|$)/u.test(value.message)
  ) {
    return "runtime";
  }
  return "unknown";
}

/**
 * Convert any thrown ACP-related value to a bounded, redacted result suitable
 * for notices and diagnostics. Raw error text, stderr, paths, commands, account
 * identifiers, and credentials are never copied into the returned fields.
 */
export function classifyAcpError(
  error: unknown,
  context: Readonly<AcpErrorContext> = {},
): UserFacingAcpError {
  const key = classifyFingerprint(fingerprint(error), context);
  return { ...CLASSIFICATIONS[key] };
}
