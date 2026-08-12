import { hashText } from "./scope";

export const MAX_BATCH_FILES = 20;
export const MAX_BATCH_FILE_CHARACTERS = 120_000;
export const MAX_BATCH_TOTAL_CHARACTERS = 500_000;
export const MAX_BATCH_PROPOSALS = 20;
export const MAX_BATCH_PATH_CHARACTERS = 1_024;

export interface BatchLimits {
  maxFiles: number;
  maxFileCharacters: number;
  maxTotalCharacters: number;
  maxProposals: number;
}

export const DEFAULT_BATCH_LIMITS: Readonly<BatchLimits> = Object.freeze({
  maxFiles: MAX_BATCH_FILES,
  maxFileCharacters: MAX_BATCH_FILE_CHARACTERS,
  maxTotalCharacters: MAX_BATCH_TOTAL_CHARACTERS,
  maxProposals: MAX_BATCH_PROPOSALS,
});

export const DEFAULT_BATCH_EXCLUDED_PREFIXES = Object.freeze([
  ".git",
  ".obsidian",
  ".trash",
]);

export interface VaultBatchFile {
  path: string;
  content: string;
}

export interface BatchCandidate extends VaultBatchFile {
  contentHash: string;
}

export interface BatchSelectionOptions {
  /** Defaults to Markdown files only. Use an empty array to allow every extension. */
  includeExtensions?: readonly string[];
  /** When present, candidates must be at or below one of these vault-relative paths. */
  includePrefixes?: readonly string[];
  /** Added to the protected default prefixes; defaults cannot be removed. */
  excludePrefixes?: readonly string[];
  /** Limits may only lower the exported hard limits. */
  limits?: Partial<BatchLimits>;
}

export type BatchSelectionExclusionReason = "extension" | "outside_include" | "excluded_prefix";

export interface BatchSelectionExclusion {
  path: string;
  reason: BatchSelectionExclusionReason;
}

export type BatchDiagnosticCode =
  | "invalid_limit"
  | "invalid_path"
  | "invalid_prefix"
  | "invalid_file"
  | "duplicate_path"
  | "file_too_large"
  | "too_many_files"
  | "batch_too_large"
  | "empty_batch"
  | "too_many_proposals"
  | "invalid_proposal"
  | "unknown_path"
  | "path_case_mismatch"
  | "before_content_mismatch"
  | "before_hash_mismatch"
  | "empty_replacement"
  | "unchanged_replacement"
  | "replacement_too_large";

export interface BatchDiagnostic {
  code: BatchDiagnosticCode;
  message: string;
  path?: string;
  index?: number;
}

export interface BatchCandidateSelection {
  ok: boolean;
  candidates: BatchCandidate[];
  excluded: BatchSelectionExclusion[];
  diagnostics: BatchDiagnostic[];
  totalCharacters: number;
  limits: BatchLimits;
}

/**
 * A host-created binding between one captured file and one ACP turn's plain
 * replacement text. The ACP response must never be parsed as this tuple: only
 * its replacement field is placed in the second slot by the host.
 */
export type HostBoundBatchProposal = readonly [
  target: BatchCandidate,
  replacement: unknown,
];

export interface BatchEditProposal {
  path: string;
  before: string;
  beforeHash: string;
  replacement: string;
}

export interface ValidatedBatchEdit extends BatchEditProposal {}

export interface BatchProposalValidation {
  ok: boolean;
  proposals: ValidatedBatchEdit[];
  diagnostics: BatchDiagnostic[];
  totalReplacementCharacters: number;
  limits: BatchLimits;
}

export type BatchStaleReason =
  | "invalid_proposal_path"
  | "duplicate_proposal_path"
  | "invalid_current_path"
  | "duplicate_current_path"
  | "missing"
  | "path_case_mismatch"
  | "changed";

export interface BatchStaleDiagnostic {
  path: string;
  reason: BatchStaleReason;
  message: string;
  expectedHash?: string;
  currentHash?: string;
}

export interface BatchWrite {
  path: string;
  before: string;
  beforeHash: string;
  replacement: string;
}

export interface BatchTransactionPreflight {
  ok: boolean;
  writes: BatchWrite[];
  stale: BatchStaleDiagnostic[];
}

const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Converts an Obsidian-style vault-relative path to forward slashes. Absolute
 * paths, parent traversal, control characters, and visually deceptive bidi
 * controls are rejected rather than repaired.
 */
export function normalizeVaultBatchPath(path: string): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_BATCH_PATH_CHARACTERS) {
    return null;
  }
  if (UNSAFE_PATH_CHARACTERS.test(path)) return null;

  const slashPath = path.replace(/\\/g, "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:/.test(slashPath)) return null;

  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }

  const normalized = parts.join("/");
  return normalized.length > 0 && normalized.length <= MAX_BATCH_PATH_CHARACTERS
    ? normalized
    : null;
}

function pathIdentity(path: string): string {
  // Obsidian supports Windows and default macOS vaults, where case aliases can
  // address the same file. Fail closed across platforms rather than guessing.
  return path.toLowerCase();
}

function isAtOrBelow(path: string, prefix: string): boolean {
  const pathKey = pathIdentity(path);
  const prefixKey = pathIdentity(prefix);
  return pathKey === prefixKey || pathKey.startsWith(`${prefixKey}/`);
}

function diagnostic(
  code: BatchDiagnosticCode,
  message: string,
  path?: string,
  index?: number,
): BatchDiagnostic {
  return { code, message, ...(path === undefined ? {} : { path }), ...(index === undefined ? {} : { index }) };
}

function resolveLimits(
  requested: Partial<BatchLimits> | undefined,
  diagnostics: BatchDiagnostic[],
): BatchLimits {
  const resolved: BatchLimits = { ...DEFAULT_BATCH_LIMITS };
  const maxima: BatchLimits = { ...DEFAULT_BATCH_LIMITS };

  for (const key of Object.keys(maxima) as Array<keyof BatchLimits>) {
    const value = requested?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maxima[key]) {
      diagnostics.push(diagnostic(
        "invalid_limit",
        `${key} must be a positive safe integer no greater than ${maxima[key].toLocaleString()}.`,
      ));
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

function normalizePrefixes(
  prefixes: readonly string[] | undefined,
  diagnostics: BatchDiagnostic[],
): string[] {
  const normalized: string[] = [];
  for (const prefix of prefixes ?? []) {
    const path = normalizeVaultBatchPath(prefix);
    if (!path) {
      diagnostics.push(diagnostic("invalid_prefix", "A batch path prefix is not vault-relative or is unsafe.", prefix));
      continue;
    }
    if (!normalized.some((existing) => pathIdentity(existing) === pathIdentity(path))) {
      normalized.push(path);
    }
  }
  return normalized;
}

function normalizeExtensions(extensions: readonly string[] | undefined): string[] {
  const source = extensions ?? [".md"];
  return source.map((extension) => {
    const lowered = extension.toLowerCase();
    return lowered.startsWith(".") ? lowered : `.${lowered}`;
  });
}

function hasIncludedExtension(path: string, extensions: readonly string[]): boolean {
  if (extensions.length === 0) return true;
  const lowered = path.toLowerCase();
  return extensions.some((extension) => lowered.endsWith(extension));
}

/**
 * Produces a deterministic, fail-closed snapshot of eligible vault files.
 * Any unsafe/duplicate/oversized eligible input invalidates the whole result;
 * ordinary filter exclusions remain visible but are not errors.
 */
export function selectBatchCandidates(
  files: readonly VaultBatchFile[],
  options: BatchSelectionOptions = {},
): BatchCandidateSelection {
  const diagnostics: BatchDiagnostic[] = [];
  const excluded: BatchSelectionExclusion[] = [];
  const limits = resolveLimits(options.limits, diagnostics);
  const includePrefixes = normalizePrefixes(options.includePrefixes, diagnostics);
  const excludePrefixes = normalizePrefixes(
    [...DEFAULT_BATCH_EXCLUDED_PREFIXES, ...(options.excludePrefixes ?? [])],
    diagnostics,
  );
  const extensions = normalizeExtensions(options.includeExtensions);
  const candidates: BatchCandidate[] = [];
  const seen = new Set<string>();

  files.forEach((file, index) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      diagnostics.push(diagnostic("invalid_file", "Each batch candidate must have string path and content fields.", undefined, index));
      return;
    }

    const path = normalizeVaultBatchPath(file.path);
    if (!path) {
      diagnostics.push(diagnostic("invalid_path", "A candidate path is not a safe vault-relative path.", file.path, index));
      return;
    }

    const identity = pathIdentity(path);
    if (seen.has(identity)) {
      diagnostics.push(diagnostic("duplicate_path", "The candidate set contains the same path more than once.", path, index));
      return;
    }
    seen.add(identity);

    if (excludePrefixes.some((prefix) => isAtOrBelow(path, prefix))) {
      excluded.push({ path, reason: "excluded_prefix" });
      return;
    }
    if (includePrefixes.length > 0 && !includePrefixes.some((prefix) => isAtOrBelow(path, prefix))) {
      excluded.push({ path, reason: "outside_include" });
      return;
    }
    if (!hasIncludedExtension(path, extensions)) {
      excluded.push({ path, reason: "extension" });
      return;
    }
    if (file.content.length > limits.maxFileCharacters) {
      diagnostics.push(diagnostic(
        "file_too_large",
        `The file exceeds the ${limits.maxFileCharacters.toLocaleString()} character per-file limit.`,
        path,
        index,
      ));
      return;
    }

    candidates.push({ path, content: file.content, contentHash: hashText(file.content) });
  });

  candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const totalCharacters = candidates.reduce((total, candidate) => total + candidate.content.length, 0);

  if (candidates.length > limits.maxFiles) {
    diagnostics.push(diagnostic(
      "too_many_files",
      `The candidate set contains ${candidates.length.toLocaleString()} files; the limit is ${limits.maxFiles.toLocaleString()}.`,
    ));
  }
  if (totalCharacters > limits.maxTotalCharacters) {
    diagnostics.push(diagnostic(
      "batch_too_large",
      `The candidate set contains ${totalCharacters.toLocaleString()} characters; the limit is ${limits.maxTotalCharacters.toLocaleString()}.`,
    ));
  }

  return {
    ok: diagnostics.length === 0,
    candidates: diagnostics.length === 0 ? candidates : [],
    excluded,
    diagnostics,
    totalCharacters,
    limits,
  };
}

/**
 * Binds one ACP turn's replacement text to the file the host selected for that
 * turn. Paths and before-state supplied by an agent are intentionally ignored.
 */
export function bindBatchProposal(
  target: BatchCandidate,
  replacement: unknown,
): HostBoundBatchProposal {
  return [target, replacement];
}

/**
 * Validates host-bound, one-turn-per-file proposals against the exact captured
 * snapshot. The replacement is the only agent-controlled field.
 */
export function validateBatchProposals(
  bindings: readonly HostBoundBatchProposal[],
  candidates: readonly BatchCandidate[],
  requestedLimits?: Partial<BatchLimits>,
): BatchProposalValidation {
  const diagnostics: BatchDiagnostic[] = [];
  const limits = resolveLimits(requestedLimits, diagnostics);
  const candidateByIdentity = new Map<string, BatchCandidate>();

  for (const candidate of candidates) {
    const normalized = normalizeVaultBatchPath(candidate.path);
    if (!normalized || normalized !== candidate.path || candidate.contentHash !== hashText(candidate.content)) {
      diagnostics.push(diagnostic("invalid_file", "The captured candidate snapshot is malformed.", candidate.path));
      continue;
    }
    const identity = pathIdentity(normalized);
    if (candidateByIdentity.has(identity)) {
      diagnostics.push(diagnostic("duplicate_path", "The captured candidate snapshot contains a duplicate path.", normalized));
      continue;
    }
    candidateByIdentity.set(identity, candidate);
  }

  if (bindings.length === 0) {
    diagnostics.push(diagnostic("empty_batch", "A batch edit must contain at least one proposal."));
  }
  if (bindings.length > limits.maxProposals) {
    diagnostics.push(diagnostic(
      "too_many_proposals",
      `The host collected ${bindings.length.toLocaleString()} proposals; the limit is ${limits.maxProposals.toLocaleString()}.`,
    ));
  }

  const validated: ValidatedBatchEdit[] = [];
  const seen = new Set<string>();
  let totalReplacementCharacters = 0;

  bindings.forEach((binding, index) => {
    if (!Array.isArray(binding) || binding.length !== 2) {
      diagnostics.push(diagnostic("invalid_proposal", "Each proposal must be bound by the host to one captured candidate.", undefined, index));
      return;
    }
    const [target, replacement] = binding;
    if (
      !target
      || typeof target !== "object"
      || typeof target.path !== "string"
      || typeof target.content !== "string"
      || typeof target.contentHash !== "string"
      || typeof replacement !== "string"
    ) {
      diagnostics.push(diagnostic("invalid_proposal", "A host-bound proposal requires one captured candidate and one replacement string.", undefined, index));
      return;
    }

    const path = normalizeVaultBatchPath(target.path);
    if (!path) {
      diagnostics.push(diagnostic("invalid_path", "A host-bound target is not a safe vault-relative path.", target.path, index));
      return;
    }

    const identity = pathIdentity(path);
    if (seen.has(identity)) {
      diagnostics.push(diagnostic("duplicate_path", "The batch proposes more than one edit for the same path.", path, index));
      return;
    }
    seen.add(identity);

    const candidate = candidateByIdentity.get(identity);
    if (!candidate) {
      diagnostics.push(diagnostic("unknown_path", "The proposal targets a path outside the captured candidate set.", path, index));
      return;
    }
    if (candidate.path !== path) {
      diagnostics.push(diagnostic("path_case_mismatch", "The host-bound target does not exactly match the captured path casing.", path, index));
    }
    if (target.content !== candidate.content) {
      diagnostics.push(diagnostic("before_content_mismatch", "The host-bound before content does not exactly match the captured file.", path, index));
    }
    if (target.contentHash !== candidate.contentHash || target.contentHash !== hashText(target.content)) {
      diagnostics.push(diagnostic("before_hash_mismatch", "The host-bound before hash does not exactly identify the captured file.", path, index));
    }
    if (!replacement.trim()) {
      diagnostics.push(diagnostic("empty_replacement", "Empty or whitespace-only replacements are blocked.", path, index));
    }
    if (replacement === target.content) {
      diagnostics.push(diagnostic("unchanged_replacement", "A batch proposal must change the captured file.", path, index));
    }
    if (replacement.length > limits.maxFileCharacters) {
      diagnostics.push(diagnostic(
        "replacement_too_large",
        `The replacement exceeds the ${limits.maxFileCharacters.toLocaleString()} character per-file limit.`,
        path,
        index,
      ));
    }

    totalReplacementCharacters += replacement.length;
    validated.push({
      path: candidate.path,
      before: candidate.content,
      beforeHash: candidate.contentHash,
      replacement,
    });
  });

  if (totalReplacementCharacters > limits.maxTotalCharacters) {
    diagnostics.push(diagnostic(
      "batch_too_large",
      `The replacements contain ${totalReplacementCharacters.toLocaleString()} characters; the limit is ${limits.maxTotalCharacters.toLocaleString()}.`,
    ));
  }

  return {
    ok: diagnostics.length === 0,
    proposals: diagnostics.length === 0 ? validated : [],
    diagnostics,
    totalReplacementCharacters,
    limits,
  };
}

/**
 * Rechecks every target immediately before a caller writes anything. If even
 * one file is missing or changed, writes is empty and all detected stale paths
 * are returned. The caller must still serialize the following filesystem
 * writes and provide rollback because a filesystem cannot be made atomic here.
 */
export function preflightBatchTransaction(
  proposals: readonly ValidatedBatchEdit[],
  currentFiles: readonly VaultBatchFile[],
): BatchTransactionPreflight {
  const stale: BatchStaleDiagnostic[] = [];
  const currentByIdentity = new Map<string, { path: string; content: string }>();

  for (const current of currentFiles) {
    const path = normalizeVaultBatchPath(current.path);
    if (!path || typeof current.content !== "string") {
      stale.push({
        path: typeof current.path === "string" ? current.path : "<invalid>",
        reason: "invalid_current_path",
        message: "A current file path is not a safe vault-relative path.",
      });
      continue;
    }
    const identity = pathIdentity(path);
    if (currentByIdentity.has(identity)) {
      stale.push({ path, reason: "duplicate_current_path", message: "The current file set contains a duplicate path." });
      continue;
    }
    currentByIdentity.set(identity, { path, content: current.content });
  }

  const seenProposals = new Set<string>();
  const writes: BatchWrite[] = [];
  for (const proposal of proposals) {
    const path = normalizeVaultBatchPath(proposal.path);
    if (!path) {
      stale.push({ path: proposal.path, reason: "invalid_proposal_path", message: "A proposal path is not vault-relative or is unsafe." });
      continue;
    }
    const identity = pathIdentity(path);
    if (seenProposals.has(identity)) {
      stale.push({ path, reason: "duplicate_proposal_path", message: "The transaction contains the same proposal path more than once." });
      continue;
    }
    seenProposals.add(identity);

    const current = currentByIdentity.get(identity);
    if (!current) {
      stale.push({
        path,
        reason: "missing",
        message: "The target file no longer exists in the preflight snapshot.",
        expectedHash: proposal.beforeHash,
      });
      continue;
    }
    if (current.path !== path) {
      stale.push({
        path,
        reason: "path_case_mismatch",
        message: "The current path casing no longer exactly matches the reviewed proposal.",
        expectedHash: proposal.beforeHash,
        currentHash: hashText(current.content),
      });
      continue;
    }

    const currentHash = hashText(current.content);
    if (
      current.content !== proposal.before
      || currentHash !== proposal.beforeHash
      || hashText(proposal.before) !== proposal.beforeHash
    ) {
      stale.push({
        path,
        reason: "changed",
        message: "The target file changed after the batch proposal was captured.",
        expectedHash: proposal.beforeHash,
        currentHash,
      });
      continue;
    }
    writes.push({ ...proposal, path });
  }

  return { ok: stale.length === 0, writes: stale.length === 0 ? writes : [], stale };
}
