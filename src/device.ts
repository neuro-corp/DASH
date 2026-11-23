import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig, saveConfig } from "./config";

const DEVICE_ID_PATTERN = /^dsh_[A-Za-z0-9_-]{16,64}$/;
const HARDWARE_TIMEOUT_MS = 4000;

let cachedDeviceId: string | undefined;
let cachedSource: "env" | "config" | "hardware" | "random" | undefined;

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: HARDWARE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Reads a stable OS machine identifier.
 * - Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
 * - Linux:   /etc/machine-id (fallback /var/lib/dbus/machine-id)
 * - macOS:   IOPlatformUUID from IOKit
 */
export function readHardwareId(): string | null {
  try {
    if (process.platform === "win32") {
      const output = run("reg", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      const match = output?.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      return match?.[1] ?? null;
    }

    if (process.platform === "darwin") {
      const output = run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const match = output?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return match?.[1] ?? null;
    }

    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = fs.readFileSync(file, "utf8").trim();
        if (value) return value;
      } catch {
        // Try the next location.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Deterministic, opaque device ID derived from a hardware identifier. */
export function deriveDeviceId(rawHardwareId: string): string {
  const normalized = rawHardwareId.trim().toLowerCase();
  const digest = crypto
    .createHash("sha256")
    .update(`dash-device-v1:${normalized}`, "utf8")
    .digest("base64url");
  return `dsh_${digest.slice(0, 32)}`;
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

/**
 * Returns the device ID, creating and persisting it on first use.
 *
 * Priority: explicit env override -> saved config -> hardware derivation ->
 * random (persisted) fallback. Once saved the value never changes, even if the
 * hardware identifier later does.
 */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;

  const override = process.env.DASH_DEVICE_ID;
  if (isValidDeviceId(override)) {
    cachedDeviceId = override;
    cachedSource = "env";
    return cachedDeviceId;
  }

  let config: Record<string, any> = {};
  try {
    config = loadConfig() ?? {};
  } catch {
    config = {};
  }

  if (isValidDeviceId(config.deviceId)) {
    cachedDeviceId = config.deviceId;
    cachedSource = "config";
    return cachedDeviceId;
  }

  const hardwareId = readHardwareId();
  const deviceId = hardwareId
    ? deriveDeviceId(hardwareId)
    : `dsh_${crypto.randomBytes(18).toString("base64url")}`;
  cachedDeviceId = deviceId;
  cachedSource = hardwareId ? "hardware" : "random";

  try {
    saveConfig({ ...config, deviceId });
  } catch {
    // A read-only config directory must not prevent chatting; the ID is still
    // stable for this process and re-derived identically on the next run.
  }

  return cachedDeviceId;
}

export function getDeviceIdSource(): string | undefined {
  return cachedSource;
}

/** Test helper. */
export function resetDeviceIdCache(): void {
  cachedDeviceId = undefined;
  cachedSource = undefined;
}
