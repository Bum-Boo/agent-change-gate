export type LineDiffKind = "equal" | "add" | "remove";

export type LineEnding = "" | "\n" | "\r" | "\r\n";

export interface LineDiffLine {
  /** Line content without its line terminator. */
  text: string;
  /** The original terminator, retained so exact input can be reconstructed. */
  ending: LineEnding;
}

export interface LineDiffOperation {
  kind: LineDiffKind;
  /** Zero-based line positions before this operation is applied. */
  oldStart: number;
  newStart: number;
  /** Present for a complete diff. Adjacent operations of the same kind are grouped. */
  lines: LineDiffLine[];
  /** Present only when oversized input was deliberately not split or copied. */
  omittedCharacters?: number;
}

export type LineDiffFallbackReason =
  | "input-size"
  | "line-count"
  | "complexity"
  | "operation-count";

export interface LineDiffResult {
  operations: LineDiffOperation[];
  /** True when the operations come from an exact longest-common-subsequence diff. */
  exact: boolean;
  /** True when operation payloads were omitted to protect the UI from oversized input. */
  truncated: boolean;
  fallbackReason?: LineDiffFallbackReason;
  beforeLineCount?: number;
  afterLineCount?: number;
}

export interface LineDiffOptions {
  /** Combined character limit checked before either input is split into lines. */
  maxInputCharacters?: number;
  /** Combined line limit. Tokenization stops as soon as this limit is exceeded. */
  maxLines?: number;
  /** Maximum cells allocated for the LCS matrix, including its sentinel row/column. */
  maxCells?: number;
  /** Maximum number of grouped operations produced by the exact diff. */
  maxOperations?: number;
}

interface ResolvedLimits {
  maxInputCharacters: number;
  maxLines: number;
  maxCells: number;
  maxOperations: number;
}

const DEFAULT_LIMITS: ResolvedLimits = {
  maxInputCharacters: 600_000,
  maxLines: 30_000,
  maxCells: 1_000_000,
  maxOperations: 10_000,
};

const HARD_LIMITS: ResolvedLimits = {
  maxInputCharacters: 2_000_000,
  maxLines: 100_000,
  maxCells: 2_000_000,
  maxOperations: 20_000,
};

function boundedOption(value: number | undefined, fallback: number, hardLimit: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  if (!Number.isFinite(value)) return hardLimit;
  return Math.min(hardLimit, Math.max(0, Math.floor(value)));
}

function resolveLimits(options: LineDiffOptions): ResolvedLimits {
  return {
    maxInputCharacters: boundedOption(
      options.maxInputCharacters,
      DEFAULT_LIMITS.maxInputCharacters,
      HARD_LIMITS.maxInputCharacters,
    ),
    maxLines: boundedOption(options.maxLines, DEFAULT_LIMITS.maxLines, HARD_LIMITS.maxLines),
    maxCells: boundedOption(options.maxCells, DEFAULT_LIMITS.maxCells, HARD_LIMITS.maxCells),
    maxOperations: boundedOption(
      options.maxOperations,
      DEFAULT_LIMITS.maxOperations,
      HARD_LIMITS.maxOperations,
    ),
  };
}

function omittedOperation(
  kind: "add" | "remove",
  characters: number,
): LineDiffOperation | null {
  if (characters === 0) return null;
  return {
    kind,
    oldStart: 0,
    newStart: 0,
    lines: [],
    omittedCharacters: characters,
  };
}

function truncatedFallback(
  beforeCharacters: number,
  afterCharacters: number,
  reason: "input-size" | "line-count",
): LineDiffResult {
  const operations = [
    omittedOperation("remove", beforeCharacters),
    omittedOperation("add", afterCharacters),
  ].filter((operation): operation is LineDiffOperation => operation !== null);
  return {
    operations,
    exact: false,
    truncated: true,
    fallbackReason: reason,
  };
}

interface TokenizedLines {
  lines: LineDiffLine[];
  exceeded: boolean;
}

function tokenizeLines(input: string, maximumLines: number): TokenizedLines {
  const lines: LineDiffLine[] = [];
  let lineStart = 0;

  for (let index = 0; index < input.length; index += 1) {
    const character = input.charCodeAt(index);
    if (character !== 10 && character !== 13) continue;

    let ending: LineEnding;
    if (character === 13 && input.charCodeAt(index + 1) === 10) {
      ending = "\r\n";
    } else {
      ending = character === 13 ? "\r" : "\n";
    }

    if (lines.length >= maximumLines) return { lines: [], exceeded: true };
    lines.push({ text: input.slice(lineStart, index), ending });
    if (ending === "\r\n") index += 1;
    lineStart = index + 1;
  }

  if (lineStart < input.length) {
    if (lines.length >= maximumLines) return { lines: [], exceeded: true };
    lines.push({ text: input.slice(lineStart), ending: "" });
  }
  return { lines, exceeded: false };
}

function sameLine(left: LineDiffLine, right: LineDiffLine): boolean {
  return left.text === right.text && left.ending === right.ending;
}

function appendOperation(
  operations: LineDiffOperation[],
  kind: LineDiffKind,
  lines: LineDiffLine[],
): void {
  if (lines.length === 0) return;
  const previous = operations.at(-1);
  if (previous?.kind === kind && previous.omittedCharacters === undefined) {
    previous.lines.push(...lines);
    return;
  }
  operations.push({ kind, oldStart: 0, newStart: 0, lines: [...lines] });
}

function assignLineStarts(operations: LineDiffOperation[]): void {
  let oldLine = 0;
  let newLine = 0;
  for (const operation of operations) {
    operation.oldStart = oldLine;
    operation.newStart = newLine;
    if (operation.kind !== "add") oldLine += operation.lines.length;
    if (operation.kind !== "remove") newLine += operation.lines.length;
  }
}

function commonBounds(before: LineDiffLine[], after: LineDiffLine[]): {
  prefix: number;
  suffix: number;
} {
  const sharedLength = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < sharedLength) {
    const beforeLine = before[prefix];
    const afterLine = after[prefix];
    if (!beforeLine || !afterLine || !sameLine(beforeLine, afterLine)) break;
    prefix += 1;
  }

  let suffix = 0;
  while (suffix < sharedLength - prefix) {
    const beforeLine = before[before.length - suffix - 1];
    const afterLine = after[after.length - suffix - 1];
    if (!beforeLine || !afterLine || !sameLine(beforeLine, afterLine)) break;
    suffix += 1;
  }
  return { prefix, suffix };
}

function replaceMiddle(
  before: LineDiffLine[],
  after: LineDiffLine[],
  prefix: number,
  suffix: number,
): LineDiffOperation[] {
  const operations: LineDiffOperation[] = [];
  appendOperation(operations, "equal", before.slice(0, prefix));
  appendOperation(operations, "remove", before.slice(prefix, before.length - suffix));
  appendOperation(operations, "add", after.slice(prefix, after.length - suffix));
  if (suffix > 0) appendOperation(operations, "equal", before.slice(before.length - suffix));
  assignLineStarts(operations);
  return operations;
}

function matrixSize(rows: number, columns: number, limit: number): number | null {
  if (rows > 0 && columns > Math.floor(limit / rows)) return null;
  const size = rows * columns;
  return size <= limit ? size : null;
}

function exactMiddle(
  before: LineDiffLine[],
  after: LineDiffLine[],
  prefix: number,
  suffix: number,
): LineDiffOperation[] {
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  const beforeCount = beforeEnd - prefix;
  const afterCount = afterEnd - prefix;
  const columns = afterCount + 1;
  const table = new Uint32Array((beforeCount + 1) * columns);

  for (let beforeIndex = beforeCount - 1; beforeIndex >= 0; beforeIndex -= 1) {
    const row = beforeIndex * columns;
    const nextRow = (beforeIndex + 1) * columns;
    for (let afterIndex = afterCount - 1; afterIndex >= 0; afterIndex -= 1) {
      const beforeLine = before[prefix + beforeIndex];
      const afterLine = after[prefix + afterIndex];
      if (beforeLine && afterLine && sameLine(beforeLine, afterLine)) {
        table[row + afterIndex] = (table[nextRow + afterIndex + 1] ?? 0) + 1;
      } else {
        table[row + afterIndex] = Math.max(
          table[nextRow + afterIndex] ?? 0,
          table[row + afterIndex + 1] ?? 0,
        );
      }
    }
  }

  const operations: LineDiffOperation[] = [];
  appendOperation(operations, "equal", before.slice(0, prefix));
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeCount || afterIndex < afterCount) {
    const beforeLine = before[prefix + beforeIndex];
    const afterLine = after[prefix + afterIndex];
    if (
      beforeIndex < beforeCount
      && afterIndex < afterCount
      && beforeLine
      && afterLine
      && sameLine(beforeLine, afterLine)
    ) {
      appendOperation(operations, "equal", [beforeLine]);
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    const removeScore = beforeIndex < beforeCount
      ? table[(beforeIndex + 1) * columns + afterIndex] ?? 0
      : -1;
    const addScore = afterIndex < afterCount
      ? table[beforeIndex * columns + afterIndex + 1] ?? 0
      : -1;
    if (beforeIndex < beforeCount && (afterIndex >= afterCount || removeScore >= addScore)) {
      if (beforeLine) appendOperation(operations, "remove", [beforeLine]);
      beforeIndex += 1;
    } else {
      if (afterLine) appendOperation(operations, "add", [afterLine]);
      afterIndex += 1;
    }
  }
  if (suffix > 0) appendOperation(operations, "equal", before.slice(beforeEnd));
  assignLineStarts(operations);
  return operations;
}

/**
 * Produces a minimal line diff while bounded by hard memory/work limits.
 *
 * If the LCS matrix would be too large, the unchanged prefix and suffix are
 * retained and the middle is represented as a complete remove/add pair. If
 * even tokenizing the inputs is unsafe, payloads are omitted and `truncated`
 * is set so a UI can show a size warning instead of rendering the text.
 */
export function diffLines(
  beforeText: string,
  afterText: string,
  options: LineDiffOptions = {},
): LineDiffResult {
  const limits = resolveLimits(options);
  if (
    beforeText.length > limits.maxInputCharacters
    || afterText.length > limits.maxInputCharacters - beforeText.length
  ) {
    return truncatedFallback(beforeText.length, afterText.length, "input-size");
  }

  const beforeTokenized = tokenizeLines(beforeText, limits.maxLines);
  if (beforeTokenized.exceeded) {
    return truncatedFallback(beforeText.length, afterText.length, "line-count");
  }
  const remainingLines = limits.maxLines - beforeTokenized.lines.length;
  const afterTokenized = tokenizeLines(afterText, remainingLines);
  if (afterTokenized.exceeded) {
    return truncatedFallback(beforeText.length, afterText.length, "line-count");
  }

  const before = beforeTokenized.lines;
  const after = afterTokenized.lines;
  const { prefix, suffix } = commonBounds(before, after);
  const beforeCount = before.length - prefix - suffix;
  const afterCount = after.length - prefix - suffix;
  const cells = matrixSize(beforeCount + 1, afterCount + 1, limits.maxCells);
  if (cells === null) {
    return {
      operations: replaceMiddle(before, after, prefix, suffix),
      exact: false,
      truncated: false,
      fallbackReason: "complexity",
      beforeLineCount: before.length,
      afterLineCount: after.length,
    };
  }

  const operations = exactMiddle(before, after, prefix, suffix);
  if (operations.length > limits.maxOperations) {
    return {
      operations: replaceMiddle(before, after, prefix, suffix),
      exact: false,
      truncated: false,
      fallbackReason: "operation-count",
      beforeLineCount: before.length,
      afterLineCount: after.length,
    };
  }
  return {
    operations,
    exact: true,
    truncated: false,
    beforeLineCount: before.length,
    afterLineCount: after.length,
  };
}
