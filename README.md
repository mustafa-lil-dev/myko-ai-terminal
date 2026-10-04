<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Myko" />
  <h1>Myko</h1>
  <p><strong>Private terminal-first AI development workspace.</strong></p>
  <p>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Supported platforms" />
    <img src="https://img.shields.io/badge/status-private%20product-blue" alt="Private product" />
  </p>
</div>

---

Myko is a desktop development workspace built with Tauri 2, Rust, and React. It brings a native terminal, code editor, file explorer, Git tools, web preview, themes, and an AI workspace together in one application.

Myko is distributed as a private product. It does not require an account and does not include application telemetry. AI requests use the provider or local model endpoint configured by the user.

## Product overview

- Native terminal with multiple tabs, splits, background output, and GPU rendering.
- Code editor with syntax highlighting, Vim mode, themes, AI completion, and AI-assisted edits.
- File explorer with search, keyboard navigation, rename and context actions.
- Git source control with staging, commits, branches, push, search, and a visual history graph.
- Local web preview for development servers and external URLs.
- Agentic AI workspace with tools, plans, sub-agents, project memory, custom agents, and approval gates.
- Customizable application themes, editor themes, background images, opacity, and blur.
- Windows local and WSL workspace environments.

## Features

### Terminal

- xterm.js terminal with WebGL rendering.
- Multiple terminal tabs with background streaming.
- GPU-accelerated block terminal with editor-like command input.
- Native PTY backend powered by `portable-pty`.
- Shell support for PowerShell, PowerShell 7 (`pwsh`), Command Prompt, Bash, Zsh, and Fish where installed.
- Horizontal and vertical split panels.
- Inline search, link detection, true-color output, and terminal serialization.
- Windows workspace environments for the local machine and installed WSL distributions.
- Process and background-session management.

### Code editor

- CodeMirror 6 editor.
- Language support for TypeScript, JavaScript, JSX, TSX, Rust, Python, Go, C, C++, Java, PHP, HTML, CSS, JSON, Markdown, Vue, and other common formats.
- Syntax highlighting and diagnostics.
- Multiple editor tabs and unsaved-change protection.
- Vim mode.
- Inline AI autocomplete, including local model support.
- AI edit diffs with hunk-by-hunk accept and reject controls.
- Built-in editor themes:
  - Atom One
  - Aura
  - Copilot
  - GitHub Dark and Light
  - Gruvbox Dark
  - Nord
  - Tokyo Night
  - Xcode Dark and Light

### File explorer

- Directory tree browsing.
- Catppuccin file icons.
- Fuzzy file search.
- Keyboard navigation.
- Inline rename.
- File and directory context actions.
- File attachments for AI prompts.
- Selection attachments from the editor and terminal.
- File watching so workspace changes can be reflected in the UI.

### Source control

- Repository and branch status.
- Stage and unstage files or hunks.
- Commit changes with `Ctrl+Enter` on Windows/Linux or `Cmd+Enter` on macOS.
- Push with upstream awareness.
- Detached `HEAD` display.
- Git history with a real commit graph, including merge lanes.
- Commit search and filtering.
- Open commits on the configured remote.
- Git command and error handling through the native backend.

### Web preview

- Detect local development servers.
- Open local servers in a preview tab.
- Preview external URLs.
- Native child webview support for external pages.
- Adjustable preview layout alongside the workspace.

### Themes and customization

- Built-in application theme presets.
- Custom application themes.
- Import and export custom themes.
- Background images.
- Adjustable background opacity and blur.
- Independent application and editor themes.
- Customizable keyboard shortcuts.
- Window and panel layout persistence.

### AI workspace

Myko supports both cloud providers and local model servers. Provider availability depends on the provider configuration and credentials.

Supported provider integrations include:

- OpenAI
- Anthropic
- Google Gemini
- Groq
- xAI
- Cerebras
- OpenRouter
- DeepSeek
- Mistral
- OpenAI-compatible endpoints
- LM Studio
- MLX
- Ollama

AI workspace capabilities include:

- Composer input with file references using `@path`.
- Reusable prompt snippets using `#handle`.
- Slash commands.
- Voice input where supported by the host system.
- File, editor-selection, and terminal-selection attachments.
- Project instructions and memory through `MYKO.md`.
- Plan mode for multi-step work.
- Todo tracking for agent tasks.
- Custom agents with their own instructions and tool subsets.
- Sub-agent execution.
- Read-file, write-file, edit-file, multi-edit, grep, and glob tools.
- Terminal command proposals with approval gating.
- Background processes.
- Streaming responses, reasoning display, tool status, and notifications.
- AI-generated edit diffs that can be reviewed before applying changes.

### Security and privacy

- API keys are stored through the operating system keychain.
- API keys are not stored in `localStorage`.
- Shell commands that can change the workspace require approval where configured.
- AI tools expose only the capabilities selected by the agent configuration.
- No application account is required.
- No application telemetry is included.
- Network traffic is sent only to the configured AI provider, local model server, updater, or requested preview/resource endpoint.

## Installation

Installers are produced by the Tauri release build. On Windows, use the NSIS `.exe` installer for the simplest installation experience. An MSI package is also generated when enabled by the build configuration.

### Windows

1. Run the Myko installer.
2. If Windows SmartScreen shows a warning for an unsigned build, select **More info** and then **Run anyway**.
3. Start Myko from the Start menu or installed shortcut.

The default Windows shell detection order is:

1. `pwsh.exe`
2. `powershell.exe`
3. `cmd.exe`

WSL distributions are available as workspace environments when installed on the machine.

### Linux

Available package formats depend on the build target:

- AppImage
- `.deb`
- `.rpm`

AppImage may require FUSE. If FUSE is unavailable, run:

```bash
./Myko_*.AppImage --appimage-extract-and-run
```

On Wayland systems with rendering issues, try:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Myko_*.AppImage
```

### macOS

Use the generated macOS application bundle or disk image for the target architecture. macOS builds require macOS 13 or newer.

## Configure AI

1. Open **Settings → AI**.
2. Select a provider.
3. Enter the provider API key or local endpoint.
4. Select a model.
5. Save the configuration and open the AI workspace.

For local inference, start LM Studio, MLX, or Ollama first and enter its compatible endpoint in Myko. Provider keys are stored in the operating system keychain and are not written to project files or browser storage.

## Development

### Prerequisites

- Node.js 24 or newer.
- pnpm 10 or newer.
- Rust stable toolchain.
- Tauri 2 platform prerequisites.
- WebView2 on Windows.
- Git for source-control features.

### Install dependencies

```bash
pnpm install
```

### Start the web development server

```bash
pnpm dev
```

This starts Vite at `http://localhost:1420`. It is useful for frontend work, but native Tauri APIs and plugins require the Tauri development command.

### Start the native desktop app

```bash
pnpm tauri dev
```

### Build the frontend

```bash
pnpm build
```

### Create installable packages

```bash
pnpm tauri build
```

On Windows, generated installers are placed under:

```text
src-tauri\target\release\bundle\
```

Typical outputs include:

```text
src-tauri\target\release\bundle\nsis\Myko_0.8.5_x64-setup.exe
src-tauri\target\release\bundle\msi\Myko_0.8.5_x64_en-US.msi
```

To create only an NSIS installer:

```bash
pnpm tauri build --bundles nsis
```

To create only an MSI installer:

```bash
pnpm tauri build --bundles msi
```

### Quality checks

```bash
pnpm check-types
pnpm format:check
pnpm lint
pnpm test
```

Useful additional commands:

```bash
pnpm format
pnpm lint:fix
pnpm test:watch
pnpm preview
pnpm analyze:bundle
pnpm analyze:eager
pnpm size
pnpm knip
```

Rust checks and tests run from the Tauri directory:

```bash
cd src-tauri
cargo check
cargo test
```

## Architecture

Myko uses a two-process desktop architecture:

- React and TypeScript provide the application interface.
- Vite bundles the frontend.
- Tauri provides the desktop shell and secure IPC.
- Rust handles PTY sessions, filesystem operations, Git, processes, networking, secrets, SSH, LSP support, workspace management, and agent-related native operations.
- CodeMirror provides the editor.
- xterm.js provides terminal rendering.
- Zustand provides client state management.
- The Vercel AI SDK provides streaming AI integrations.
- Tailwind CSS and Radix-based UI components provide the interface system.

Project documentation is kept in the `docs/` directory, including architecture notes for the AI subsystem, PTY integration, terminal renderer pool, security model, and process model.

## Project information

- Product: Myko
- Version: `0.8.5`
- Desktop framework: Tauri 2
- Frontend: React 19 and TypeScript
- Native backend: Rust
- Package manager: pnpm
- License and distribution: private
