import { afterEach, describe, expect, it } from "bun:test";
import {
  deriveDeviceId,
  getDeviceId,
  getDeviceIdSource,
  isValidDeviceId,
  resetDeviceIdCache,
} from "./device";

afterEach(() => {
  delete process.env.DASH_DEVICE_ID;
  resetDeviceIdCache();
});

describe("device identity", () => {
  it("derives a stable ID from the same hardware identifier", () => {
    const first = deriveDeviceId("8f3a2b1c-1111-2222-3333-444455556666");
    const second = deriveDeviceId("8F3A2B1C-1111-2222-3333-444455556666");
    expect(first).toBe(second);
    expect(first).toMatch(/^dsh_[A-Za-z0-9_-]{32}$/);
  });

  it("derives different IDs for different machines", () => {
    const a = deriveDeviceId("machine-a");
    const b = deriveDeviceId("machine-b");
    expect(a).not.toBe(b);
  });

  it("does not leak the raw hardware identifier", () => {
    const raw = "8f3a2b1c-1111-2222-3333-444455556666";
    expect(deriveDeviceId(raw)).not.toContain(raw);
    expect(deriveDeviceId(raw)).not.toContain("8f3a2b1c");
  });

  it("validates the ID shape", () => {
    expect(isValidDeviceId("dsh_abcdefghijklmnop0123456789ABCDEF")).toBe(true);
    expect(isValidDeviceId("dsh_short")).toBe(false);
    expect(isValidDeviceId("nvidia-123")).toBe(false);
    expect(isValidDeviceId(undefined)).toBe(false);
    expect(isValidDeviceId(42)).toBe(false);
  });

  it("honours the DASH_DEVICE_ID override and caches it", () => {
    process.env.DASH_DEVICE_ID = "dsh_env_override_000000000001";
    const first = getDeviceId();
    expect(first).toBe("dsh_env_override_000000000001");
    expect(getDeviceId()).toBe(first);
    expect(getDeviceIdSource()).toBe("env");
  });
});
