import { SyntaxStyle } from "@opentui/core";
import { useMemo, useEffect, useState, useRef } from "react";
import { useRenderer } from "@opentui/react";
import { normalizeAssistantMarkdown } from "./markdown";
import { colors } from "./theme";
import type { AnsiChunk } from "./Syntax";
import { DiffView, extractOldNewCode, getLanguageFromPath } from "../components/chat/DiffView";

export type Message = {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  title?: string;
  id?: number;
  toolName?: string;
  toolPath?: string;
  toolStatus?: 'running' | 'success' | 'error';
  toolOutput?: string;
  toolDurationMs?: number;
  generationDurationMs?: number;
  streaming?: boolean;
};

function splitChunksByLines(chunks: AnsiChunk[], lineCount: number): AnsiChunk[][] {
  const perLine: AnsiChunk[][] = Array.from({ length: lineCount }, () => []);
  let lineIdx = 0;
  for (const chunk of chunks) {
    const segments = chunk.text.split('\n');
    for (let s = 0; s < segments.length; s++) {
      if (s > 0) {
        lineIdx++;
        if (lineIdx >= lineCount) return perLine;
      }
      const seg = segments[s] ?? '';
      if (seg) {
        (perLine[Math.min(lineIdx, lineCount - 1)] as AnsiChunk[]).push({ text: seg, fg: chunk.fg, bg: chunk.bg });
      }
    }
  }
  return perLine;
}

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function toolDetailPreview(output: string): string {
  const lines = output.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length <= 4) return output;
  return `${lines.slice(0, 4).join('\n')}\n… (${lines.length - 4} more lines)`;
}

function commandOutputText(output: string, status: Message['toolStatus']): string {
  if (!output) return status === 'running' ? 'Command is running…' : 'No output';
  try {
    const parsed = JSON.parse(output) as { output?: unknown; exitCode?: unknown; timedOut?: unknown };
    if (typeof parsed.output === 'string') {
      const result = parsed.output.trimEnd() || 'Command completed with no output.';
      const exitCode = typeof parsed.exitCode === 'number' ? `\nExit code: ${parsed.exitCode}` : '';
      const timeout = parsed.timedOut === true ? '\nCommand timed out.' : '';
      return `${result}${exitCode}${timeout}`;
    }
  } catch { /* Display plain-text tool errors directly. */ }
  return output;
}

function ShellCommandPanel({ message, label, terminalHeight }: { message: Message; label: string; terminalHeight: number }) {
  const [expanded, setExpanded] = useState(false);
  const [pulse, setPulse] = useState(false);
  const isRunning = message.toolStatus === 'running';
  const result = commandOutputText(message.toolOutput ?? '', message.toolStatus);
  const maxExpandedHeight = Math.max(5, terminalHeight - 8);
  const resultLines = result.split(/\r?\n/).length;
  const panelHeight = expanded ? Math.min(maxExpandedHeight, Math.max(5, resultLines + 3)) : 4;

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setPulse(value => !value), 400);
    return () => clearInterval(timer);
  }, [isRunning]);

  const statusColor = message.toolStatus === 'error' ? '#F85149' : '#A1A1AA';

  return (
    <box key={message.id} marginBottom={1} paddingX={2}>
      <box width="100%" height={panelHeight} style={{ backgroundColor: '#141414' }} paddingX={1} paddingTop={1} flexDirection="column" overflow="hidden">
        <box flexDirection="row" justifyContent="space-between" onMouseDown={() => setExpanded(value => !value)}>
          <text fg={colors.white}>
            {isRunning ? (
              <>
                <span fg={pulse ? '#FFB366' : '#C75F00'}>●</span>
                <span fg={pulse ? '#C75F00' : '#FFB366'}>● </span>
              </>
            ) : (
              <span fg={message.toolStatus === 'error' ? '#F85149' : '#3FB950'}>{message.toolStatus === 'error' ? '● ' : '● '}</span>
            )}
            {label} · {isRunning ? 'Running' : message.toolStatus === 'error' ? 'Failed' : 'Completed'}
            {formatDuration(message.toolDurationMs) ? ` · ${formatDuration(message.toolDurationMs)}` : ''}
          </text>
          <text fg="#A1A1AA">{expanded ? '− Collapse' : '+ Expand'}</text>
        </box>
        <text fg="#D4D4D8">$ {message.toolPath || label}</text>
        {expanded ? (
          <scrollbox flexGrow={1} height={Math.max(1, panelHeight - 3)}>
            <text fg={statusColor}>{result}</text>
          </scrollbox>
        ) : (
          <text fg={statusColor}>{result.split(/\r?\n/).find(line => line.trim()) ?? ' '}</text>
        )}
      </box>
    </box>
  );
}

type DiffRowInfo = { marker: '+' | '-' | ' '; content: string; lineNum: number };
type DiffViewLine = { tag: 'hunk'; header: string; collapsed?: boolean } | { tag: 'body'; row: DiffRowInfo };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function buildDiffView(output: string): DiffViewLine[] {
  const lines = output.split('\n');
  const out: DiffViewLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let sawHeader = false;
  let bodyIdx = 0;
  for (const line of lines) {
    const h = HUNK_RE.exec(line);
    if (h) {
      sawHeader = true;
      oldLine = parseInt(h[1] ?? '0', 10);
      newLine = parseInt(h[3] ?? '0', 10);
      out.push({ tag: 'hunk', header: line, collapsed: false });
      continue;
    }
    const marker: '+' | '-' | ' ' = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' ';
    const content = line.slice(1);
    let num: number;
    if (!sawHeader) {
      num = bodyIdx + 1;
      bodyIdx++;
    } else if (marker === '+') {
      num = newLine;
      newLine++;
    } else if (marker === '-') {
      num = oldLine;
      oldLine++;
    } else {
      num = newLine;
      oldLine++;
      newLine++;
    }
    out.push({ tag: 'body', row: { marker, content, lineNum: num } });
  }
  return out;
}

const toolLabels: Record<string, string> = {
  read_file: 'Read',
  read_many: 'Read batch',
  write_file: 'Write',
  edit_file: 'Edit',
  list_files: 'List',
  search_files: 'Search',
  find_files: 'Find',
  get_file_info: 'Info',
  ask_user: 'Ask',
  todo_write: 'Tasks',
  web_search: 'Web Search',
  multi_file_edit: 'Multi-file edit',
};

interface Props {
  messages: Message[];
  terminalWidth?: number;
  terminalHeight?: number;
  isThinking?: boolean;
  thinkingText?: string;
}
export function MessageList({ messages, terminalWidth = 80, terminalHeight = 24, isThinking, thinkingText }: Props) {
  const renderer = useRenderer();
  const syntaxStyle = useMemo(
    () => SyntaxStyle.fromStyles({
      'markup.heading.1': { fg: colors.white, bold: true },
      'markup.heading.2': { fg: colors.white, bold: true },
      'markup.heading.3': { fg: '#D0D0D0', bold: true },
      'markup.list': { fg: '#D0D0D0' },
      'markup.raw': { fg: '#637B9C' },
      default: { fg: '#EEEEEE' },
    }, renderer.nativeScene),
    [renderer],
  );

  const spinnerChars = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  useEffect(() => {
    if (!isThinking) return;
    const id = setInterval(() => setSpinnerIdx(i => (i + 1) % spinnerChars.length), 80);
    return () => clearInterval(id);
  }, [isThinking]);

  // Collapsed state for diff hunks in tool messages - useRef at top level
  // to avoid "Rendered more hooks than during the previous render" error.
  // The ref key is the message index to persist collapsed state across renders.
  const collapsedRef = useRef<Map<number, Set<number>>>(new Map());

  if (messages.length === 0) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <box>
          <text fg={colors.dim}>██████╗  █████╗ ███████╗██╗  ██╗</text>
          <text fg={colors.dim}>██╔══██╗██╔══██╗██╔════╝██║  ██║</text>
          <text fg={colors.dim}>██║  ██║███████║███████╗███████║</text>
          <text fg={colors.dim}>██║  ██║██╔══██║╚════██║██╔══██║</text>
          <text fg={colors.dim}>██████╔╝██║  ██║███████║██║  ██║</text>
          <text fg={colors.dim}>╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝</text>
        </box>
      </box>
    );
  }

  return (
    <scrollbox flexGrow={1} scrollY stickyScroll stickyStart="bottom" focusable>
      {messages.map((m, i) => {
        if (m.role === 'user') {
          return (
            <box key={m.id ?? i} marginBottom={1} paddingX={1} marginX={1} width="100%" alignItems="flex-start">
              <box width="99%" paddingX={1} paddingY={1} style={{ backgroundColor: '#303030' }}>
                <text fg="#E0E0E0">
                  {m.content}
                </text>
              </box>
            </box>
          );
        }
        if (m.role === 'assistant') {
          return (
            <box key={m.id ?? i} marginBottom={1} marginLeft={3} marginRight={2} paddingX={1}>
              <markdown
                content={normalizeAssistantMarkdown(m.content ?? '')}
                syntaxStyle={syntaxStyle}
                width="100%"
                conceal
                streaming={m.streaming === true}
              />
              {m.streaming !== true && formatDuration(m.generationDurationMs) && (
                <box width="100%" flexDirection="row" justifyContent="flex-end">
                  <text fg={colors.dim}>Took {formatDuration(m.generationDurationMs)}</text>
                </box>
              )}
            </box>
          );
        }
        if (m.role === 'tool') {
          const label = toolLabels[m.toolName ?? ''] ?? m.toolName ?? 'Tool';
          const isCodeTool = m.toolName === 'write_file' || m.toolName === 'edit_file' || m.toolName === 'multi_edit';
          const isShellTool = m.toolName === 'run_command' || m.toolName === 'run_background';

          // Handle diff output from code tools
          if (isCodeTool && m.toolStatus === 'success' && m.toolOutput) {
            // Extract oldCode and newCode from the tool output
            const extractResult = extractOldNewCode(m.toolOutput);
            const oldCode = extractResult.oldCode;
            const newCode = extractResult.newCode;
            const resolvedLanguage = m.toolPath ?
              getLanguageFromPath(m.toolPath) : undefined;

            // If this is a write_file creating a new file (empty diff),
            // display the content directly instead of a diff view
            if (m.toolName === 'write_file' && !oldCode && !newCode && m.toolOutput) {
              try {
                const parsed = JSON.parse(m.toolOutput) as Record<string, unknown>;
                const content = parsed.content || parsed.newContent || '';
                if (content) {
                  return (
                    <DiffView
                      key={m.id ?? i}
                      filePath={m.toolPath ?? 'untitled'}
                      oldCode={''}
                      newCode={typeof content === 'string' ? content : JSON.stringify(content)}
                      language={resolvedLanguage}
                      terminalWidth={terminalWidth}
                      contextLines={3}
                    />
                  );
                }
              } catch {}
            }

            // Display the diff using the new DiffView component
            return (
              <DiffView
                key={m.id ?? i}
                filePath={m.toolPath ?? 'untitled'}
                oldCode={oldCode}
                newCode={newCode}
                language={resolvedLanguage}
                terminalWidth={terminalWidth}
                contextLines={3}
              />
            );
          }

          // Handle shell command output (run_command, run_background)
          if (isShellTool) {
            return <ShellCommandPanel key={m.id ?? i} message={m} label={label} terminalHeight={terminalHeight} />;
          }

          // Handle web search display
          if (m.toolName === 'web_search') {
            let searchOutput: string;
            try {
              const parsed = JSON.parse(m.toolOutput ?? '{}') as { query: string; results: Array<{title: string; url: string}> };
              const query = parsed.query ?? '';
              const resultCount = parsed.results?.length ?? 0;
              // Truncate query if too long (max 40 chars with ellipsis)
              const displayQuery = query.length > 40 ? `${query.slice(0, 37)}…` : query;
              searchOutput = `Search "${displayQuery}" found "${resultCount}" results`;
            } catch {
              searchOutput = m.toolOutput ?? 'Web search completed';
            }

            return (
              <box key={m.id ?? i} marginBottom={1} paddingX={1}>
                <box width="100%" style={{ backgroundColor: '#0A0A0A' }} paddingX={1} paddingY={1} flexDirection="column">
                  <text fg={colors.white} bold marginBottom={1}>{label} {m.toolPath ?? ''}</text>
                  <text fg={colors.dim}>{searchOutput}</text>
                </box>
              </box>
            );
          }

          const prefix = m.toolStatus === 'success' ? '✓' : m.toolStatus === 'error' ? 'x' : '>';
          // Only show a concise error detail; avoid dumping the full tool output (which may be large JSON).
          const detail = m.toolStatus === 'error' && m.toolOutput
            ? toolDetailPreview(m.toolOutput)
            : undefined;
          return (
            <box key={m.id ?? i} marginBottom={1} marginLeft={1} paddingX={1} flexDirection="column">
              <text>
                <span fg={colors.dim}>{prefix} </span>
                <span fg={colors.white}>{label} </span>
                <span fg={colors.dim}>{m.toolPath ?? ''}</span>
                {formatDuration(m.toolDurationMs) ? (
                  <span fg={colors.dim}> · {formatDuration(m.toolDurationMs)}</span>
                ) : null}
                {detail ? (
                  <span fg={m.toolStatus === 'error' ? '#f85149' : colors.dim}>{toolDetailPreview(detail)}</span>
                ) : null}
              </text>
            </box>
          );
        }
        return null;
      })}
      {isThinking && (
        <box marginBottom={1} marginLeft={1} paddingX={1}>
          <text fg="#FAA937">
            {spinnerChars[spinnerIdx]} {thinkingText ?? 'Thinking...'}
          </text>
        </box>
      )}
    </scrollbox>
  );
}