import { describe, expect, it } from "vitest";

import { parseProfileList } from "../src/hermes/discovery";

describe("Hermes profile discovery parser", () => {
  it("extracts only canonical profile IDs from the human table", () => {
    const output = `
 Profile          Model                        Gateway
 ───────────────  ───────────────────────────  ───────────
  default         gpt-5.6-luna                 stopped
 ◆scribe          gpt-5.6-sol                  running
  contentresearcher gpt-5.6-terra              running
  Invalid.Name    model                        running
`;
    expect(parseProfileList(output)).toEqual(["default", "scribe", "contentresearcher"]);
  });
});
