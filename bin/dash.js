#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pkgPath = path.resolve(__dirname, "..", "package.json");

let version = "0.0.0";

try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  version = pkg.version || version;
} catch {
  // Continue with fallback version.
}

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(`dash version ${version}`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`dash - AI-powered coding agent for your terminal

Usage:
  dash [options] [prompt]

Options:
  -v, --version    Show version number
  -h, --help       Show help

Commands:
  /new          Start new chat
  /sessions     View past sessions
  /models       Manage AI models
  /providers    Manage API providers
  /updates      Check for updates
  /exit         Exit terminal
  /help         Show help
  /donate       Donate to support development

Examples:
  dash "create a todo app"
  dash --version
`);
  process.exit(0);
}

// Detect operating system and architecture
const platform = process.platform;
const arch = process.arch;

// Map platform and architecture to the correct platform package and executable.
// Supports all five: win32-x64, darwin-x64, darwin-arm64, linux-x64, linux-arm64
const platformMap = {
  win32: {
    packageName: "@neuro.corp/dash-win32-x64",
    executable: "dist/dash.exe"
  },
  darwin: {
    packageName: arch === "arm64"
      ? "@neuro.corp/dash-darwin-arm64"
      : "@neuro.corp/dash-darwin-x64",
    executable: "dist/dash"
  },
  linux: {
    packageName: arch === "arm64"
      ? "@neuro.corp/dash-linux-arm64"
      : "@neuro.corp/dash-linux-x64",
    executable: "dist/dash"
  }
};

// Determine the platform info; if platform is not supported, error out
let platformInfo;
if (platform in platformMap) {
  platformInfo = platformMap[platform];
} else {
  console.error(
    `Dash does not currently support ${platform} ${arch}.`
  );
  process.exit(1);
}

// Robust resolution of the platform package.
// Walk up from the script's directory to find the platform package in node_modules.
// This works whether Dash is installed globally or as a project dependency.
const packageName = platformInfo.packageName;
let packageDir = null;

let searchDir = __dirname;
for (let i = 0; i < 10; i++) {
  const candidate = path.join(searchDir, "node_modules", packageName);
  if (fs.existsSync(candidate)) {
    packageDir = candidate;
    break;
  }
  searchDir = path.dirname(searchDir);
}

if (!packageDir) {
  console.error(
    `Could not find the Dash platform package: ${packageName}\n` +
    `Try reinstalling Dash: npm install -g @neuro.corp/dash`
  );
  process.exit(1);
}

// Resolve the executable path inside the platform package
const executablePath = path.join(packageDir, platformInfo.executable);

// Verify executable exists and is a file
if (!fs.existsSync(executablePath)) {
  console.error(`Dash executable not found: ${executablePath}`);
  process.exit(1);
}

const stat = fs.statSync(executablePath);

if (!stat.isFile()) {
  console.error(`Expected an executable file: ${executablePath}`);
  process.exit(1);
}

if (platform === "win32") {
  let validPe = false;
  let fd;
  try {
    fd = fs.openSync(executablePath, "r");
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, header.length, 0) === header.length
        && header.toString("ascii", 0, 2) === "MZ") {
      const signature = Buffer.alloc(4);
      const peOffset = header.readUInt32LE(0x3c);
      validPe = fs.readSync(fd, signature, 0, 4, peOffset) === 4
        && signature.toString("binary") === "PE\0\0";
    }
  } catch {
    validPe = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  if (!validPe) {
    console.error(`Invalid Windows executable: ${executablePath}`);
    console.error("The platform package is incomplete or corrupted; reinstall Dash after updating the package.");
    process.exit(1);
  }
}

// On Unix platforms, verify the executable has execute permissions
if (platform !== "win32" && (stat.mode & 0o111) === 0) {
  console.error(
    `Dash executable does not have executable permissions: ${executablePath}`
  );
  process.exit(1);
}

// Execute the binary, forwarding all CLI arguments,
// preserving terminal input/output, and propagating exit code
import { spawn } from "node:child_process";
let child;
try {
  child = spawn(executablePath, args, { stdio: "inherit" });
} catch (error) {
  console.error(`Could not start Dash: ${error.message}`);
  process.exit(1);
}

child.on("error", (error) => {
  console.error(`Could not start Dash: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
