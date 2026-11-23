#!/usr/bin/env node
/**
 * Dash — Post-Installation Experience
 *
 * Lightweight, dependency-free script that runs after `npm install -g @neuro.corp/dash`.
 * Shows a branded ASCII logo, OS/architecture detection, and a friendly success message
 * with the next command to run. Designed to be unobtrusive and fast.
 */

const os = require('os');
const platform = process.platform;
const arch = process.arch;

// Map platform codes to human-readable names
const osNames = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};
const osName = osNames[platform] || platform;

// Simple ASCII-style Dash logo (monospace, no external deps)
const logo = `
 _   _      _ _       _     _
 | | | | ___| | | ___ | |__ (_)
 | |_| |/ _ \ | |/ _ \\ '_ \\| |
 |  _  |  __/ | |  __/ | | | |
 |_| |_|\\___|_|_|\\___|_| |_|_/
`.trim();

// Friendly welcome / install message
const welcome = `
🤖  Dash AI Agent — Neuro Corporation

Thank you for installing Dash, your AI-powered coding agent for the terminal.

📦  Platform: ${osName} ${arch}
🚀  Next command: \`dash\`

Happy coding! 🎉
`.trim();

// Output the branded message
process.stdout.write(logo + '\n' + welcome + '\n');

// That's it — no further action needed. npm will complete the install.