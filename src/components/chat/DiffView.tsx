import { useMemo } from "react";
import { colors } from "../../ui/theme";
import { syntaxColors, highlightCodeForFile, languageFromPath } from "../../ui/Syntax";
import type { AnsiChunk } from "../../ui/Syntax";
import { truncateText } from "../../ui/truncate";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Marker = "+" | "-" | " ";

interface DiffRow {
  marker: Marker;
  content: string;
  /** line number in the old file (0 if the line was added) */
  oldNum: number;
  /** line number in the new file (0 if the line was removed) */
  newNum: number;
}

type DisplayItem =
  | { kind: "row"; row: DiffRow; chunks: AnsiChunk[] }
  | { kind: "gap"; hidden: number };

/* -------------------------------------------------------------------------- */
/*  Theme (pure black, no borders)                                            */
/* -------------------------------------------------------------------------- */

const THEME = {
  bg: "#141414",
  addedBg: "#0b1f13",
  removedBg: "#2a1114",
  added: "#3fb950",
  removed: "#f85149",
  gutter: "#5c5c66",
  gutterChanged: "#8b8b96",
  gap: "#4a4a52",
};

const TAB_SIZE = 2;
const MAX_LCS_CELLS = 4_000_000;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function splitLines(code: string): string[] {
  if (code === "") return [];
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  // "a\nb\n" -> ["a","b",""]: drop the phantom trailing line
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Expand tabs to spaces so columns line up exactly. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) {
    if (ch === "\t") out += " ".repeat(TAB_SIZE - (out.length % TAB_SIZE));
    else out += ch;
  }
  return out;
}

/**
 * Keep leading indentation intact. Regular spaces at the start of a rendered
 * span can get trimmed/collapsed, so indentation is turned into non-breaking
 * spaces (same width in the terminal).
 */
function preserveIndent(chunks: AnsiChunk[]): AnsiChunk[] {
  let stillIndenting = true;
  return chunks.map(chunk => {
    if (!stillIndenting) return chunk;
    const text = String(chunk.text ?? "");
    const match = /^ +/.exec(text);
    if (!match) {
      stillIndenting = false;
      return chunk;
    }
    const indent = match[0].length;
    if (indent === text.length) {
      // whole chunk is whitespace, the next chunk may continue the indent
      return { ...chunk, text: "\u00A0".repeat(indent) };
    }
    stillIndenting = false;
    return { ...chunk, text: "\u00A0".repeat(indent) + text.slice(indent) };
  });
}

/** Cut chunks to a max column width, adding … when truncated. */
function fitChunks(chunks: AnsiChunk[], maxWidth: number): AnsiChunk[] {
  const out: AnsiChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const text = String(chunk.text ?? "");
    if (used + text.length <= maxWidth) {
      out.push(chunk);
      used += text.length;
      continue;
    }
    const remaining = maxWidth - used;
    if (remaining > 1) {
      out.push({ ...chunk, text: text.slice(0, remaining - 1) + "…" });
    } else if (remaining === 1) {
      out.push({ ...chunk, text: "…" });
    }
    return out;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Diff engine                                                               */
/* -------------------------------------------------------------------------- */

function computeDiffRows(oldCode: string, newCode: string): DiffRow[] {
  const a = splitLines(oldCode);
  const b = splitLines(newCode);

  // Trim common prefix / suffix (fast path + smaller LCS table)
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: Array<{ marker: Marker; content: string }> = [];
  for (let i = 0; i < start; i++) ops.push({ marker: " ", content: a[i]! });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_LCS_CELLS) {
    // Too large for LCS: show as full replace
    for (const line of midA) ops.push({ marker: "-", content: line });
    for (const line of midB) ops.push({ marker: "+", content: line });
  } else if (n === 0 || m === 0) {
    for (const line of midA) ops.push({ marker: "-", content: line });
    for (const line of midB) ops.push({ marker: "+", content: line });
  } else {
    // lcs[i][j] = LCS length of midA[i:] and midB[j:]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? lcs[(i + 1) * w + (j + 1)]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + (j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ marker: " ", content: midA[i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + (j + 1)]!) {
        ops.push({ marker: "-", content: midA[i]! });
        i++;
      } else {
        ops.push({ marker: "+", content: midB[j]! });
        j++;
      }
    }
    while (i < n) ops.push({ marker: "-", content: midA[i++]! });
    while (j < m) ops.push({ marker: "+", content: midB[j++]! });
  }

  for (let i = endA; i < a.length; i++) ops.push({ marker: " ", content: a[i]! });

  // Assign line numbers
  let oldNum = 1;
  let newNum = 1;
  return ops.map(op => {
    if (op.marker === "-") return { ...op, oldNum: oldNum++, newNum: 0 };
    if (op.marker === "+") return { ...op, oldNum: 0, newNum: newNum++ };
    return { ...op, oldNum: oldNum++, newNum: newNum++ };
  });
}

/** Keep changed rows plus `context` rows before and after; collapse the rest. */
function buildDisplay(
  rows: DiffRow[],
  context: number,
  filePath: string,
  contentWidth: number
): DisplayItem[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.marker === " ") return;
    const from = Math.max(0, idx - context);
    const to = Math.min(rows.length - 1, idx + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  });

  const items: DisplayItem[] = [];
  let hidden = 0;
  rows.forEach((row, idx) => {
    if (!keep[idx]) {
      hidden++;
      return;
    }
    if (hidden > 0) {
      items.push({ kind: "gap", hidden });
      hidden = 0;
    }
    const expanded = expandTabs(row.content);
    const chunks = highlightCodeForFile(expanded, filePath, syntaxColors.Default);
    items.push({
      kind: "row",
      row,
      chunks: fitChunks(preserveIndent(chunks), contentWidth),
    });
  });
  if (hidden > 0) items.push({ kind: "gap", hidden });
  return items;
}

/* -------------------------------------------------------------------------- */
/*  Path / output parsing (unchanged API)                                     */
/* -------------------------------------------------------------------------- */

/** Get language from file path extension */
export function getLanguageFromPath(filePath: string): string | undefined {
  return languageFromPath(filePath);
}

/** Parse unified diff to extract oldCode and newCode */
function parseUnifiedDiffToOldNew(diff: string): { oldCode: string; newCode: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }

  return { oldCode: oldLines.join("\n"), newCode: newLines.join("\n") };
}

/** Extract oldCode and newCode from tool output */
export function extractOldNewCode(toolOutput: string): { oldCode: string; newCode: string } {
  try {
    const parsed = JSON.parse(toolOutput) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.oldCode === "string" && typeof parsed.newCode === "string") {
        return { oldCode: parsed.oldCode, newCode: parsed.newCode };
      }
      if (parsed.operation === "create" && typeof parsed.content === "string") {
        return { oldCode: "", newCode: parsed.content };
      }
      if (typeof parsed.diff === "string" && parsed.diff.length > 0) {
        return parseUnifiedDiffToOldNew(parsed.diff);
      }
      if (typeof parsed.message === "string") {
        const msg = parsed.message;
        if (
          msg.startsWith("--- ") ||
          msg.includes("@@ ") ||
          msg.split("\n").some(l => l.startsWith("+++") || l.startsWith("---"))
        ) {
          return parseUnifiedDiffToOldNew(msg);
        }
      }
    }
  } catch {}

  if (
    toolOutput.startsWith("--- ") ||
    toolOutput.includes("@@ ") ||
    toolOutput.split("\n").some(line => line.startsWith("+++") || line.startsWith("---"))
  ) {
    return parseUnifiedDiffToOldNew(toolOutput);
  }

  return { oldCode: toolOutput, newCode: "" };
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function DiffView({
  filePath,
  oldCode,
  newCode,
  language,
  terminalWidth = 80,
  contextLines = 3,
  diff,
}: DiffViewProps) {
  const safeWidth = Number.isFinite(terminalWidth) && terminalWidth > 0 ? terminalWidth : 80;

  const languageLabel = language ?? getLanguageFromPath(filePath) ?? "text";

  const { rows, items, gutterWidth, contentWidth } = useMemo(() => {
    let finalOld = oldCode ?? "";
    let finalNew = newCode ?? "";
    if (diff && (!finalOld || !finalNew)) {
      const extracted = extractOldNewCode(diff);
      finalOld = extracted.oldCode;
      finalNew = extracted.newCode;
    }

    const allRows = computeDiffRows(finalOld, finalNew);
    const maxNum = allRows.reduce((mx, r) => Math.max(mx, r.oldNum, r.newNum), 0);
    const gw = Math.max(3, String(maxNum).length);

    // outer paddingX(1)*2 + inner paddingX(1)*2 + gutter + space + marker + space
    const cw = Math.max(10, safeWidth - 4 - gw - 1 - 2 - 1);

    return {
      rows: allRows,
      items: buildDisplay(allRows, contextLines ?? 3, filePath, cw),
      gutterWidth: gw,
      contentWidth: cw,
    };
  }, [oldCode, newCode, diff, contextLines, filePath, safeWidth]);

  const additions = rows.filter(r => r.marker === "+").length;
  const deletions = rows.filter(r => r.marker === "-").length;

  if (additions === 0 && deletions === 0) return null;

  const headerPathWidth = Math.max(10, safeWidth - 4 - 24);

  return (
    <box width="100%" marginBottom={1} paddingX={1}>
      <box
        width="100%"
        paddingX={1}
        paddingY={1}
        flexDirection="column"
        style={{ backgroundColor: THEME.bg }}
      >
        {/* Header */}
        <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <text fg={colors.dim} bold wrap={false}>
            {truncateText(filePath, headerPathWidth)}
          </text>
          <box flexDirection="row" gap={1}>
            <text fg={colors.dim} wrap={false}>{languageLabel}</text>
            <text fg={THEME.added} wrap={false}>+{additions}</text>
            <text fg={THEME.removed} wrap={false}>−{deletions}</text>
          </box>
        </box>

        {/* Body */}
        {items.map((item, index) => {
          if (item.kind === "gap") {
            const label = `⋯ ${item.hidden} unchanged line${item.hidden === 1 ? "" : "s"}`;
            return (
              <box key={`gap-${index}`} width="100%" flexDirection="row">
                <text fg={THEME.gap} wrap={false}>
                  {" ".repeat(gutterWidth + 3)}{label}
                </text>
              </box>
            );
          }

          const { row, chunks } = item;
          const isAdded = row.marker === "+";
          const isRemoved = row.marker === "-";
          const changed = isAdded || isRemoved;
          const lineNumber = isRemoved ? row.oldNum : row.newNum;
          const markerColor = isRemoved ? THEME.removed : isAdded ? THEME.added : THEME.gutter;
          const rowBg = isRemoved ? THEME.removedBg : isAdded ? THEME.addedBg : THEME.bg;

          return (
            <box
              key={`row-${index}`}
              width="100%"
              flexDirection="row"
              style={{ backgroundColor: rowBg }}
            >
              <text fg={changed ? THEME.gutterChanged : THEME.gutter} wrap={false}>
                {String(lineNumber).padStart(gutterWidth, " ")}{" "}
              </text>
              <text fg={markerColor} wrap={false}>
                {isAdded ? "+" : isRemoved ? "−" : " "}{" "}
              </text>
              <text wrap={false}>
                {chunks.length === 0 ? (
                  <span fg={colors.white}> </span>
                ) : (
                  chunks.map((chunk, ci) => (
                    <span key={ci} fg={chunk.fg ?? colors.white}>
                      {String(chunk.text ?? "")}
                    </span>
                  ))
                )}
              </text>
            </box>
          );
        })}
      </box>
    </box>
  );
}

/** Props for the DiffView component */
export interface DiffViewProps {
  /** The file path/name */
  filePath: string;
  /** Content before the change */
  oldCode: string;
  /** Content after the change */
  newCode: string;
  /** Inferred from the file extension if not given */
  language?: string;
  /** Current terminal width, supplied by the parent to avoid per-diff resize listeners. */
  terminalWidth?: number;
  /** Unchanged lines shown before/after each change. Default 3 */
  contextLines?: number;
  /** Unified diff format (fallback for backward compatibility) */
  diff?: string;
}