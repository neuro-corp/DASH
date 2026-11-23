# DASH
### CLI Agent Source · V1.1.8

![DASH Banner](https://res.cloudinary.com/dznnkyjvh/image/upload/v1793004794/Blog/jxyq1orhgsllf6eu9gvh.png)

**DASH** is an AI-powered terminal coding agent developed by [Neuro](https://neuro-corp.com). This repository publishes the CLI agent source code under the Apache License, Version 2.0.

This is a curated CLI source repository. The private service/backend implementation, backend prompts, credentials, signing keys, and deployment configuration are not included. The Apache license applies to the source files in this repository; hosted services and separately distributed platform binaries remain subject to their own terms.

Designed for developers who want an intelligent coding assistant with control over their workspace and development environment.

## ✨ Features

- **AI-Powered Coding** – Understand, develop, debug, and refactor projects.
- **Workspace Intelligence** – Read files, explore folders, and understand project structures.
- **File Management** – Create, edit, organize, and manage files and directories.
- **Command Execution** – Execute terminal commands and development tools.
- **Internet Search** – Search the web for documentation, solutions, and technical information.
- **Project Development** – Build features, fix errors, and work on complete software projects.
- **Multiple AI Models** – Choose from supported AI models and providers.
- **Bring Your Own Provider** – Connect supported AI providers using your own API credentials.
  - Supported providers: NVIDIA, OpenAI, Google Gemini, Anthropic Claude, and xAI Grok.

## 🤖 Free AI Models

DASH includes its own **DASH AI Provider**, offering free access to the following models:

| AI Model | Availability |
|---|---|
| Nemotron 3.5 Lightning 30B | Free |
| Nemotron 3 Alpha 550B | Free |
| Muse Limer 30B | Free |

**Daily Free Usage Limit: 3 Million Tokens**

No need to purchase API credits for the included free models. Usage is subject to the daily allowance and service availability.

## 📦 Installation

Install DASH globally using npm:

```bash
npm install -g "@neuro.corp/dash"
```

## 🛠️ Build from source

Requirements: [Bun](https://bun.sh/) and Node.js 20 or newer.

```bash
bun install --frozen-lockfile
bun run dev
```

To compile the CLI for the current platform:

```bash
bun run build
```

The CLI can use the hosted DASH service or API credentials configured by the user. No credentials are included in this repository.

Verify installation:

```bash
dash --version
```

Start DASH:

```bash
dash
```

## 🚀 Getting Started

1. Install DASH.
2. Launch DASH from your terminal.
3. Select the DASH provider or configure your preferred supported AI provider.
4. Open your project directory.
5. Describe your development task and let DASH assist you.

**Example tasks:**
- Analyze my entire project structure.
- Build a responsive authentication system.
- Find and fix errors in my application.
- Refactor the existing codebase.
- Create a new feature with proper file organization.

## 🔄 Updating

Update DASH to the latest version:

```bash
npm install -g "@neuro.corp/dash@latest"
```

Check your installed version:

```bash
dash --version
```

You can also use the `/update` command inside DASH to check for available updates.

## 🔒 Security

DASH interacts with your local workspace and can execute development commands.

- Review generated code and file modifications.
- Keep API credentials and sensitive information secure.
- Use version control and backups.
- Review commands before executing them in sensitive environments.

Always test AI-generated code before deploying it to production.

## 🌐 Official Links

- **Website:** https://neuro-corp.com
- **DASH Product:** https://neuro-corp.com/products/dash
- **NPM Package:** https://www.npmjs.com/package/@neuro.corp/dash

---

**DASH** — Build Smarter. Develop Faster.

Developed by **[Neuro](https://neuro-corp.com)**.