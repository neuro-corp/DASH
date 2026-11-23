import { describe, expect, it } from "bun:test";
import { formatPercent, formatTokenCount } from "./token-format";

describe("footer token formatting", () => {
  it("keeps small counts exact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("uses K, M and B suffixes without noisy decimals", () => {
    expect(formatTokenCount(1_000)).toBe("1K");
    expect(formatTokenCount(12_500)).toBe("12.5K");
    expect(formatTokenCount(128_000)).toBe("128K");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
    expect(formatTokenCount(2_000_000_000)).toBe("2B");
  });

  it("formats daily usage percentages without misleading zeroes", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.4)).toBe("<1%");
    expect(formatPercent(5.25)).toBe("5.3%");
    expect(formatPercent(64.6)).toBe("65%");
    expect(formatPercent(150)).toBe("100%");
  });
});
