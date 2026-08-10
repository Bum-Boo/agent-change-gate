import process from "node:process";

import { describe, expect, it } from "vitest";

import { runRestricted } from "../src/hermes/process";

describe("restricted process output", () => {
  it("fails closed when a discovery child floods stdout", async () => {
    await expect(runRestricted(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(600000))"],
      10_000,
    )).rejects.toThrow(/output exceeded/i);
  });
});
