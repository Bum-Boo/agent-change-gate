import { describe, expect, it } from "vitest";

import {
  MAX_USER_FACING_ERROR_FIELD_CHARS,
  classifyAcpError,
  type AcpErrorContext,
} from "../src/core/errors";

function withCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function displayedText(error: unknown, context?: AcpErrorContext): string {
  return Object.values(classifyAcpError(error, context)).join(" ");
}

describe("safe ACP error classification", () => {
  it("classifies launch failures without exposing the executable or arguments", () => {
    const result = classifyAcpError(
      withCode("spawn C:\\Users\\Private\\agent.exe --token sk-live-secret ENOENT", "ENOENT"),
      { phase: "launch" },
    );

    expect(result).toEqual({
      category: "Agent launch failed",
      nextAction: "Open plugin settings, verify the agent executable and arguments, then run the agent check again.",
      diagnosticCode: "ACG-ACP-LAUNCH",
    });
    expect(Object.values(result).join(" ")).not.toContain("Private");
    expect(Object.values(result).join(" ")).not.toContain("sk-live-secret");
  });

  it("classifies initialization stderr without exposing paths, tokens, or email addresses", () => {
    const result = classifyAcpError(
      new Error("ACP initialization failed: /home/alice/private/config token=secret-123 alice@example.com"),
      { phase: "initialize" },
    );

    expect(result.category).toBe("Agent initialization failed");
    expect(result.diagnosticCode).toBe("ACG-ACP-INIT");
    expect(Object.values(result).join(" ")).not.toMatch(/alice|secret-123|example\.com|\/home\//u);
  });

  it("classifies timeout errors before their operation phase", () => {
    const error = new Error("ACP prompt timed out after 15 seconds for user@example.com");
    error.name = "AcpTimeoutError";

    expect(classifyAcpError(error, { phase: "turn" })).toMatchObject({
      category: "Agent response timed out",
      diagnosticCode: "ACG-ACP-TIMEOUT",
    });
  });

  it("classifies transport and version failures as protocol errors", () => {
    const transport = new Error("ACP agent emitted malformed NDJSON: sk-secret");
    transport.name = "AcpTransportBoundsError";

    expect(classifyAcpError(transport)).toMatchObject({
      category: "ACP protocol error",
      diagnosticCode: "ACG-ACP-PROTOCOL",
    });
    expect(classifyAcpError(new Error("Unsupported ACP protocol version: private-value"))).toMatchObject({
      category: "ACP protocol error",
      diagnosticCode: "ACG-ACP-PROTOCOL",
    });
  });

  it("classifies parser and bounded-output failures as invalid replies", () => {
    const parserFailure = new Error("Could not parse the ACP agent response: token sk-private");
    const outputFailure = new Error("ACP turn text exceeded the configured limit for C:\\Private\\Note.md");
    outputFailure.name = "AcpTurnOutputLimitError";

    expect(classifyAcpError(parserFailure)).toMatchObject({
      category: "Invalid agent reply",
      diagnosticCode: "ACG-ACP-REPLY",
    });
    expect(classifyAcpError(outputFailure)).toMatchObject({
      category: "Invalid agent reply",
      diagnosticCode: "ACG-ACP-REPLY",
    });
    expect(classifyAcpError(new SyntaxError("secret JSON body"), { phase: "reply" })).toMatchObject({
      category: "Invalid agent reply",
      diagnosticCode: "ACG-ACP-REPLY",
    });
  });

  it("classifies other ACP failures separately from wholly unknown values", () => {
    expect(classifyAcpError(new Error("ACP agent disconnected at /private/path"), { phase: "turn" })).toMatchObject({
      category: "ACP request failed",
      diagnosticCode: "ACG-ACP-RUNTIME",
    });
    expect(classifyAcpError({ private: "sk-secret", reason: "user@example.com" })).toEqual({
      category: "Unexpected request failure",
      nextAction: "Retry once. If it repeats, restart the agent connection and report the diagnostic code.",
      diagnosticCode: "ACG-ACP-UNKNOWN",
    });
  });

  it("never reflects secret-bearing input across any category", () => {
    const secretFragments = [
      "C:\\Users\\Private\\agent.exe",
      "sk-live-123456",
      "hermes -p confidential acp",
      "person@example.com",
    ];
    const secretText = secretFragments.join(" ");
    const cases: Array<[unknown, AcpErrorContext | undefined]> = [
      [withCode(`spawn ${secretText}`, "ENOENT"), { phase: "launch" }],
      [new Error(`ACP initialization failed: ${secretText}`), { phase: "initialize" }],
      [new Error(`ACP prompt timed out: ${secretText}`), { phase: "turn" }],
      [new Error(`Unsupported ACP protocol version: ${secretText}`), undefined],
      [new Error(`Could not parse the ACP agent response: ${secretText}`), { phase: "reply" }],
      [new Error(`ACP connection failed: ${secretText}`), { phase: "turn" }],
      [secretText, undefined],
    ];

    for (const [error, context] of cases) {
      const text = displayedText(error, context);
      for (const fragment of secretFragments) expect(text).not.toContain(fragment);
    }
  });

  it("returns only bounded fields even for huge or hostile thrown values", () => {
    const huge = classifyAcpError(new Error(`ACP initialization failed: ${"x".repeat(1_000_000)}`));
    for (const value of Object.values(huge)) {
      expect(value.length).toBeLessThanOrEqual(MAX_USER_FACING_ERROR_FIELD_CHARS);
    }

    const hostile = Object.create(null, {
      message: { get: () => { throw new Error("getter should not run"); } },
      name: { get: () => { throw new Error("getter should not run"); } },
    }) as unknown;
    expect(classifyAcpError(hostile).diagnosticCode).toBe("ACG-ACP-UNKNOWN");
  });
});
