import { DiffView as TerminalDiffView, extractOldNewCode } from "../components/chat/DiffView";

/** Compatibility wrapper for consumers that provide a unified diff string. */
export function DiffView({ diff, filePath = "diff" }: { diff: string; filePath?: string }) {
  const { oldCode, newCode } = extractOldNewCode(diff);
  return <TerminalDiffView filePath={filePath} oldCode={oldCode} newCode={newCode} />;
}