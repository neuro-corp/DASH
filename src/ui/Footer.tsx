import { useEffect, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { getInstalledVersion } from "../updateChecker";
import { contextUsagePercent } from "../context-window";
import { formatPercent, formatTokenCount } from "../token-format";

const spinnerChars = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

export type FooterQuota = {
  used: number;
  limit: number;
  estimated?: boolean;
};

const WARNING_COLOR = "#FAA937";
const DANGER_COLOR = "#E06C75";

function usageColor(percent: number): string {
  if (percent >= 95) return DANGER_COLOR;
  if (percent >= 80) return WARNING_COLOR;
  return "gray";
}

export function Footer({
  tokenCount = 0,
  tokenCountEstimated = false,
  taskRunning = false,
  stopPending = false,
  quota = null,
  contextTokens = 0,
  contextWindow = 0,
  contextReserve = 0,
}: {
  tokenCount?: number;
  tokenCountEstimated?: boolean;
  taskRunning?: boolean;
  stopPending?: boolean;
  quota?: FooterQuota | null;
  contextTokens?: number;
  contextWindow?: number;
  contextReserve?: number;
}) {
  const { width } = useTerminalDimensions();
  const showRight = width >= 60;
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  useEffect(() => {
    if (!taskRunning) return;
    const id = setInterval(() => setSpinnerIdx(i => (i + 1) % spinnerChars.length), 80);
    return () => clearInterval(id);
  }, [taskRunning]);

  const quotaPercent = quota && quota.limit > 0 ? (quota.used / quota.limit) * 100 : 0;
  // The prompt can only use the window minus the completion reservation, so
  // percentages (and their warning colours) are measured against that share.
  const promptCapacity = Math.max(1, contextWindow - Math.max(0, contextReserve));
  const contextPercent = contextWindow > 0 ? contextUsagePercent(contextTokens, promptCapacity) : 0;
  const hasContext = contextWindow > 0;

  return (
    <box height={3} flexDirection="row" justifyContent="space-between" marginX={2} paddingX={1} paddingTop={1} paddingBottom={1}>
      {taskRunning
        ? (
          <box flexDirection="row" gap={1}>
            <text fg={WARNING_COLOR}>{spinnerChars[spinnerIdx]}</text>
            <text fg={stopPending ? '#c4c5d5' : 'gray'} wrap={false}>{stopPending ? 'click esc again to stop' : 'esc to stop'}</text>
          </box>
        )
        : <text fg="gray">Enter sent · Ctrl+Enter new line</text>}
      {showRight && (
        <text fg="gray" dim>
          {quota ? (
            <>
              {`${quota.estimated ? '' : ''}${formatTokenCount(quota.used)}`}
              {`/${formatTokenCount(quota.limit)}`}
              {` (${formatPercent(quotaPercent)})`}
            </>
          ) : (
            <>
              {`${tokenCountEstimated ? '' : ''}${formatTokenCount(tokenCount)}`}
              {` Tokens${tokenCountEstimated ? '' : ''}`}
            </>
          )}
          {hasContext && (
            <>
              {` ~ `}
              {`CTX ${formatPercent(contextPercent)}`}
            </>
          )}
          {` | `}
          {`V${getInstalledVersion()}`}
        </text>
      )}
    </box>
  );
}