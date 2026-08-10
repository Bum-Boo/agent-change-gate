import { describe, expect, it } from "vitest";

import { visibleReviewText } from "../src/core/review-text";

describe("visible review text", () => {
  it("labels bidi, zero-width, control, tab, and trailing-space characters", () => {
    const visible = visibleReviewText("a\u202Eb\u200Dc\u0007\t  ");

    expect(visible).toContain("U+202E RIGHT-TO-LEFT OVERRIDE");
    expect(visible).toContain("U+200D ZERO WIDTH JOINER");
    expect(visible).toContain("U+0007 CONTROL");
    expect(visible).toContain("U+0009 TAB");
    expect(visible).toContain("2 TRAILING SPACES");
  });

  it("leaves ordinary visible text unchanged", () => {
    expect(visibleReviewText("ordinary 한글 text")).toBe("ordinary 한글 text");
  });

  it("labels Unicode separators, soft hyphens, and lone surrogates", () => {
    const visible = visibleReviewText("line\u2028break\u00ADx\uD800");
    expect(visible).toContain("U+2028 LINE SEPARATOR");
    expect(visible).toContain("U+00AD SOFT HYPHEN");
    expect(visible).toContain("U+D800 LONE SURROGATE");
  });
});
