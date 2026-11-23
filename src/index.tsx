import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./ui/App";
import { getInstalledVersion } from "./updateChecker";

const debug = process.env.DASH_DEBUG === "1";
const debugLog = (message: string) => {
  if (debug) process.stderr.write(`[dash] ${message}\n`);
};

async function main() {
  const args = process.argv.slice(2);
  const hasVersion = args.includes('--version') || args.includes('-v');
  const hasHelp = args.includes('--help') || args.includes('-h');

  if (hasVersion) {
    console.log(`dash version ${getInstalledVersion()}`);
    process.exit(0);
  }

  if (hasHelp) {
    console.log(`dash - AI-powered coding agent for your terminal

Usage:
  dash [options] [prompt]

Options:
  -v, --version    Show version number
  -h, --help       Show help
`);
    process.exit(0);
  }
  debugLog("entry point starting");
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
  });
  debugLog("renderer created");
  const root = createRoot(renderer);
  root.render(<App />);
  debugLog("UI mounted, waiting for close");
  await renderer.closed;
  debugLog("renderer closed");
  renderer.destroy();
}

main().catch(err => {
  debugLog("startup failed");
  console.error(err);
  process.exit(1);
});
