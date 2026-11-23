function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/**
 * Compact token counts for the footer using K, M, and B suffixes.
 *
 * Values below 1,000 stay exact; larger values use one decimal place only
 * when it adds information, while partial usage still shows progress (12.5K).
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count)) return '0';
  const rounded = Math.max(0, count);
  if (rounded >= 1_000_000_000) {
    return `${trimTrailingZero((rounded / 1_000_000_000).toFixed(1))}B`;
  }
  if (rounded >= 1_000_000) {
    return `${trimTrailingZero((rounded / 1_000_000).toFixed(1))}M`;
  }
  if (rounded >= 1_000) {
    return `${trimTrailingZero((rounded / 1_000).toFixed(1))}K`;
  }
  return Math.round(rounded).toString();
}

/**
 * Percentage for the footer.
 *
 * Small non-zero shares read as "<1%" instead of a misleading 0%; values
 * below 10% keep one decimal, everything else is rounded.
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  const clamped = Math.min(100, value);
  if (clamped < 1) return '<1%';
  if (clamped < 10) return `${trimTrailingZero(clamped.toFixed(1))}%`;
  return `${Math.round(clamped)}%`;
}
