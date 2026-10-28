# DASH — Coding Agent

![Dash — AI-powered terminal coding agent](https://res.cloudinary.com/dznnkyjvh/image/upload/v1793004794/Blog/jxyq1orhgsllf6eu9gvh.png)

**Dash is an AI-powered terminal coding agent that helps developers understand codebases, edit files, execute development tools, and manage coding tasks directly from the command line.**

Built by [Neuro](https://neuro-corp.com), Dash brings AI-assisted software development into your terminal with an interactive interface, project-aware context, and controlled tool execution.

Use Dash to explore unfamiliar projects, troubleshoot errors, implement code changes, and streamline your development workflow.

## Why Dash?

Dash is designed for developers who want an AI coding assistant that works directly in their development environment.

- **AI coding agent** — Delegate software development tasks to an AI assistant in your terminal.
- **Project-aware context** — Explore codebases and reuse indexed workspace information.
- **Intelligent file operations** — Read, edit, and update project files with structured results.
- **Tool execution** — Perform development tasks using the agent's available tools.
- **Multiple AI providers** — Configure supported providers and choose available models.
- **Interactive terminal interface** — Follow conversations, execution status, errors, and results.
- **Session management** — Continue work using saved sessions and conversation history.
- **Task tracking** — Monitor progress across multi-step coding tasks.
- **Approval controls** — Review actions that require authorization.
- **Token usage insights** — Understand available model usage and token-consumption information.

Feature availability depends on the installed version, selected AI provider, and configuration.

## Installation

### Requirements

- Node.js and npm.
- An API key for a supported AI provider.

### Install with npm

```bash
npm install -g @neuro.corp/dash
```

### Start Dash

```bash
dash
```

Launch Dash from the root directory of the project you want to work on.

## Getting Started

1. Install Dash globally.
2. Launch Dash in your project directory.
3. Configure a supported AI provider and API key.
4. Select an available model.
5. Describe the coding task you want to accomplish.
6. Review the agent's tool activity, file changes, and results.

For the best results, provide a clear objective and specific acceptance criteria. Review important code changes and run the relevant tests before deploying them.

## What Can You Do with Dash?

### Understand an Existing Codebase

Ask Dash to explain your project's architecture, identify important modules, or trace how a feature works.

### Debug Errors

Investigate error messages, locate the relevant code, and explore potential fixes.

### Write and Refactor Code

Request targeted code changes, improvements to existing functions, and refactoring that preserves expected behavior.

### Manage Development Tasks

Use the agent's available tools to inspect files, make changes, and work through multi-step programming tasks.

### Review Changes

Inspect file modifications, tool results, and available execution or verification information before accepting the outcome.

## Example Prompts

```text
Explain the architecture of this project.
```

```text
Find the cause of this error and suggest a fix.
```

```text
Refactor this function without changing its behavior.
```

```text
Add input validation to the registration endpoint.
```

```text
Review the current changes and identify potential bugs.
```

Dash's results depend on the selected AI model, available tools, project context, and task requirements. AI-generated changes should be reviewed before use in production.

## Configuration and API Keys

Dash uses supported AI provider configurations to generate responses.

Depending on the provider and version, you may configure:

- AI provider credentials.
- Model selection.
- Generation settings.
- Agent execution settings.

Keep API keys private. Never publish credentials in repositories, screenshots, logs, or issue reports.

Refer to the official documentation for provider-specific configuration instructions.

## Releases

This repository is the official public GitHub presence for Dash releases and product information. It does not publish Dash's proprietary source code.

Visit the **[Releases](../../releases)** section to find available versions and release notes.

For release-specific installation requirements, compatibility information, and changes, consult the notes accompanying each version.

## Roadmap

Dash is focused on making AI-assisted development more reliable, efficient, and transparent.

Areas of ongoing development include:

- More reliable AI tool execution and file editing.
- Improved project context and workspace indexing.
- Reduced token consumption and better usage visibility.
- Clearer execution states and verification feedback.
- Improved terminal UI/UX.
- Better handling of complex, multi-step coding tasks.

The roadmap may evolve as development progresses.

## Support

Need help with Dash or want to report an issue?

**Email:** [support@neuro-corp.com](mailto:support@neuro-corp.com)

When requesting support, include your Dash version, operating system, relevant error messages, and steps to reproduce the problem. Never send API keys or other sensitive credentials.

## License and Proprietary Software

Dash is proprietary software developed by Neuro. Its source code is not publicly distributed through this repository.

Access to releases does not grant permission to reproduce, modify, redistribute, or commercially exploit the software beyond the rights expressly granted by its applicable license or written authorization.

See the repository's `LICENSE` file for the applicable terms.

---

**Dash by [Neuro](https://neuro-corp.com)**

*Build, debug, and improve software with an AI coding agent in your terminal.*
