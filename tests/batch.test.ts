import { describe, expect, it } from "vitest";

import {
  bindBatchProposal,
  normalizeVaultBatchPath,
  preflightBatchTransaction,
  selectBatchCandidates,
  validateBatchProposals,
  type BatchCandidate,
} from "../src/core/batch";
import { hashText } from "../src/core/scope";

function candidate(path: string, content: string): BatchCandidate {
  return { path, content, contentHash: hashText(content) };
}

describe("vault batch path safety", () => {
  it("normalizes relative separators and dot segments", () => {
    expect(normalizeVaultBatchPath("./Folder\\Nested//Note.md")).toBe("Folder/Nested/Note.md");
  });

  it.each([
    "../Secret.md",
    "Folder/../../Secret.md",
    "C:\\Vault\\Note.md",
    "/Vault/Note.md",
    "\\\\server\\share\\Note.md",
    "Folder/\u202eHidden.md",
    "",
  ])("rejects an unsafe or non-relative path: %s", (path) => {
    expect(normalizeVaultBatchPath(path)).toBeNull();
  });
});

describe("bounded batch candidate selection", () => {
  it("selects deterministic Markdown candidates while reporting protected and filtered paths", () => {
    const result = selectBatchCandidates([
      { path: "Z.md", content: "z" },
      { path: ".obsidian/plugins/example/data.md", content: "private" },
      { path: "Assets/image.png", content: "binary-ish" },
      { path: "Projects/A.md", content: "a" },
      { path: "Archive/Old.md", content: "old" },
    ], {
      includePrefixes: ["Projects", "Z.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.candidates.map((file) => file.path)).toEqual(["Projects/A.md", "Z.md"]);
    expect(result.excluded).toEqual(expect.arrayContaining([
      { path: ".obsidian/plugins/example/data.md", reason: "excluded_prefix" },
      { path: "Assets/image.png", reason: "outside_include" },
      { path: "Archive/Old.md", reason: "outside_include" },
    ]));
  });

  it("fails closed on path traversal and case-insensitive duplicate aliases", () => {
    const result = selectBatchCandidates([
      { path: "../outside.md", content: "bad" },
      { path: "Notes/A.md", content: "one" },
      { path: "notes\\a.md", content: "two" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["invalid_path", "duplicate_path"]));
  });

  it("rejects too many eligible files rather than silently truncating the vault", () => {
    const result = selectBatchCandidates([
      { path: "A.md", content: "a" },
      { path: "B.md", content: "b" },
    ], { limits: { maxFiles: 1 } });

    expect(result.ok).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "too_many_files" }));
  });

  it("enforces both per-file and aggregate character limits", () => {
    const perFile = selectBatchCandidates(
      [{ path: "Large.md", content: "12345" }],
      { limits: { maxFileCharacters: 4 } },
    );
    expect(perFile.diagnostics).toContainEqual(expect.objectContaining({ code: "file_too_large", path: "Large.md" }));

    const aggregate = selectBatchCandidates([
      { path: "A.md", content: "123" },
      { path: "B.md", content: "456" },
    ], { limits: { maxTotalCharacters: 5 } });
    expect(aggregate.diagnostics).toContainEqual(expect.objectContaining({ code: "batch_too_large" }));
    expect(aggregate.candidates).toEqual([]);
  });
});

describe("batch proposal validation", () => {
  const candidates = [candidate("A.md", "alpha"), candidate("Folder/B.md", "bravo")];

  it("does not accept an agent-returned multi-path object as a host binding", () => {
    const untrustedAgentObject = {
      proposals: [
        { path: "A.md", replacement: "ALPHA" },
        { path: "Folder/B.md", replacement: "BRAVO" },
      ],
    };
    const result = validateBatchProposals(
      [untrustedAgentObject as unknown as ReturnType<typeof bindBatchProposal>],
      candidates,
    );

    expect(result.ok).toBe(false);
    expect(result.proposals).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_proposal" }));
  });

  it("accepts unique proposals bound to exact captured content and hashes", () => {
    const result = validateBatchProposals([
      bindBatchProposal(candidates[0]!, "ALPHA"),
      bindBatchProposal({ ...candidates[1]!, path: "Folder\\B.md" }, "BRAVO"),
    ], candidates);

    expect(result.ok).toBe(true);
    expect(result.proposals.map((proposal) => proposal.path)).toEqual(["A.md", "Folder/B.md"]);
  });

  it("blocks traversal, unknown targets, and duplicate aliases", () => {
    const result = validateBatchProposals([
      bindBatchProposal(candidate("../A.md", "alpha"), "one"),
      bindBatchProposal(candidates[0]!, "two"),
      bindBatchProposal({ ...candidates[0]!, path: "a.md" }, "three"),
      bindBatchProposal(candidate("Unknown.md", "x"), "y"),
    ], candidates);

    expect(result.ok).toBe(false);
    expect(result.proposals).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "invalid_path",
      "duplicate_path",
      "unknown_path",
    ]));
  });

  it("requires exact before content and hash identity", () => {
    const result = validateBatchProposals([
      bindBatchProposal(candidate("A.md", "changed"), "new"),
      bindBatchProposal({ ...candidates[1]!, contentHash: hashText("wrong") }, "newer"),
    ], candidates);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "before_content_mismatch",
      "before_hash_mismatch",
    ]));
  });

  it("blocks empty, no-op, excessive-count, and oversized replacements", () => {
    const invalidReplacement = validateBatchProposals([
      bindBatchProposal(candidates[0]!, "   "),
      bindBatchProposal(candidates[1]!, "bravo"),
    ], candidates, { maxTotalCharacters: 6 });
    expect(invalidReplacement.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "empty_replacement",
      "unchanged_replacement",
      "batch_too_large",
    ]));

    const excessiveCount = validateBatchProposals([
      bindBatchProposal(candidates[0]!, "one"),
      bindBatchProposal(candidates[1]!, "two"),
    ], candidates, { maxProposals: 1 });
    expect(excessiveCount.diagnostics).toContainEqual(expect.objectContaining({ code: "too_many_proposals" }));

    const oversized = validateBatchProposals([
      bindBatchProposal(candidates[0]!, "12345"),
    ], candidates, { maxFileCharacters: 4 });
    expect(oversized.diagnostics).toContainEqual(expect.objectContaining({ code: "replacement_too_large" }));
  });
});

describe("all-or-nothing batch transaction preflight", () => {
  const proposals = [
    { path: "A.md", before: "alpha", beforeHash: hashText("alpha"), replacement: "ALPHA" },
    { path: "B.md", before: "bravo", beforeHash: hashText("bravo"), replacement: "BRAVO" },
  ];

  it("returns every reviewed write only when every current file is identical", () => {
    const result = preflightBatchTransaction(proposals, [
      { path: "A.md", content: "alpha" },
      { path: "B.md", content: "bravo" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.stale).toEqual([]);
    expect(result.writes.map((write) => write.path)).toEqual(["A.md", "B.md"]);
  });

  it("returns no writes when one of many files is stale", () => {
    const result = preflightBatchTransaction(proposals, [
      { path: "A.md", content: "alpha" },
      { path: "B.md", content: "changed elsewhere" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.stale).toEqual([
      expect.objectContaining({ path: "B.md", reason: "changed", expectedHash: hashText("bravo") }),
    ]);
  });

  it("reports every missing or changed target before refusing the transaction", () => {
    const result = preflightBatchTransaction(proposals, [
      { path: "A.md", content: "changed" },
    ]);

    expect(result.writes).toEqual([]);
    expect(result.stale.map((item) => [item.path, item.reason])).toEqual([
      ["A.md", "changed"],
      ["B.md", "missing"],
    ]);
  });
});
