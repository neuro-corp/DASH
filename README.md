# DASH - Coding Agent

![Dash — AI-powered developer tool](https://res.cloudinary.com/dznnkyjvh/image/upload/v1793004794/Blog/jxyq1orhgsllf6eu9gvh.png)

**An AI-powered terminal developer tool by Neuro Corporation.**

Dash brings AI-assisted development into your terminal, helping you work with code, explore projects, edit files, and execute development tasks through an interactive interface.

Built for developers who want an AI assistant integrated into their coding workflow.

## Features

- **AI-powered development** — Work with an AI agent directly from your terminal.
- **Project awareness** — Explore project files and reuse indexed workspace context.
- **File operations** — Read files, make edits, apply multiple changes, and review diffs.
- **Tool execution** — Let the agent use available tools to perform development tasks.
- **Multiple AI providers** — Configure supported providers and select available models.
- **Interactive terminal UI** — Follow conversations, tool results, task progress, and errors.
- **Session management** — Work with saved conversations and session history.
- **Task tracking** — Follow multi-step work through the task list.
- **Approval controls** — Review actions that require user authorization.
- **Token usage visibility** — Inspect available usage information to better understand AI consumption.

Features and provider availability may vary by version and configuration.

## Installation

### Prerequisites

- Node.js and npm, or another supported package-management setup.
- An API key for a supported AI provider.

### Install Dash

Install the published package globally:

```bash
npm install -g @neuro.corp/dash
```

Verify that the installation completed successfully:

```bash
dash --version
```

If your installed version does not support `--version`, check the package's documented CLI commands instead.

## Getting Started

Launch Dash from your terminal:

```bash
dash
```

For a project-specific session, open your terminal in the project directory before launching Dash.

1. Start Dash.
2. Configure your AI provider and API key using the available configuration interface.
3. Select a supported model.
4. Describe the development task you want the agent to perform.
5. Review tool activity, proposed changes, and execution results.
6. Verify the final changes in your project.

**Tip:** Start with a small task, such as explaining a file or making a targeted code change, before asking the agent to modify multiple parts of a project.

## Example Tasks

You can use Dash to assist with development tasks such as:

```text
Explain the architecture of this project.
```

```text
Find the source of this error and explain how to fix it.
```

```text
Refactor this function without changing its behavior.
```

```text
Add input validation to the user registration endpoint.
```

```text
Review the current changes and identify potential bugs.
```

These are examples of tasks you can request from the agent; actual results depend on your configured model, available tools, and project context.

## Configuration

Dash requires a supported AI provider configuration to generate responses.

Depending on the provider and version, configuration may include:

- Provider selection.
- API credentials.
- Model selection.
- Generation settings.
- Agent behavior and execution settings.

Keep API keys private. Do not commit secrets to GitHub or include them in source code, logs, or public issue reports.

Use the configuration mechanisms supported by your installed version. Consult the project documentation for provider-specific setup instructions.

## Working with Projects

For the best results:

- Launch Dash from the root of the project you want to work on.
- Give the agent a clear objective and expected outcome.
- Ask it to inspect relevant code before making changes.
- Review proposed file modifications and diffs.
- Run the relevant tests after code changes.
- Check the actual results rather than relying only on the agent's final explanation.

AI-generated changes can contain errors. Review important changes before using them in production.

## Development

Dash is developed by Neuro Corporation.

To work on the source code, clone the repository and inspect its package scripts and development documentation.

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd <YOUR_REPOSITORY_DIRECTORY>
```

Install dependencies using the package manager and lockfile specified by the project. For a Bun-based development setup, this may be:

```bash
bun install
```

Run the available development, test, and type-check commands defined in `package.json`.

## Roadmap

Dash is being developed with a focus on making AI-assisted development more reliable, transparent, and efficient.

Areas of ongoing improvement include:

- More reliable file editing and tool execution.
- Better project and workspace context management.
- Lower and more transparent token consumption.
- Clearer tool status, verification, and error reporting.
- Improved terminal UI/UX.
- Better handling of long-running development tasks.

The roadmap may change as development progresses.

## Contributing

Contributions, bug reports, and suggestions are welcome.

Before submitting a contribution:

1. Check existing issues to avoid duplicate reports.
2. Describe the problem or proposed improvement clearly.
3. Include reproducible steps for bug reports.
4. Run relevant tests before submitting changes.
5. Keep pull requests focused and easy to review.

## Support and Feedback

For issues, feature requests, or questions, use the repository's GitHub Issues page once it is enabled.

When reporting a bug, include your Dash version, operating system, relevant error output, and steps to reproduce the issue. Never include API keys or other secrets.

## License

See the [LICENSE](LICENSE) file in this repository for the applicable license and terms of use.

## Built by Neuro Corporation

Dash is part of the work at **Neuro Corporation**, focused on building software and AI-powered developer tools.

If Dash is useful to you, consider giving the repository a ⭐ on GitHub and sharing feedback to help improve the project.
