# YPA — Your Personal Agent

**A self-hosted workspace for coding agents, AI models, tools, and workflows.**

<p align="center">
  <img src=".github/screenshots/hero.png" alt="YPA with a live chat beside the node-based workflow editor" width="900">
  <br>
  <sub>Turn a live conversation into an editable workflow.</sub>
</p>

YPA gives Claude Code, Codex, Gemini CLI, API models, local models, and partner agents a shared interface. You can switch between them without starting a new conversation, run tools through MCP, keep shell sessions alive, and turn successful chats into reusable workflows.

YPA is the small, practical intersection between Claude Code, VS Code, and a self-hosted agent host. It keeps the useful parts: a live chat, a working directory, tools, harnesses, shells, browser access, and enough UI to control them. It avoids becoming a giant agent platform that is harder to operate than the work it is supposed to help with. The goal is not to loop an agent for its own sake; the goal is to choose exactly what gets looped, where it runs, and what context it keeps.

Run YPA on your test PCs, development servers, spare machines, VMs, or lab nodes across macOS, Windows, and Linux. Keep your private main computer out of the agent runtime if you want to. From the main machine, open YPA in a browser or installed web app, using the display name you configured locally. The same interface is designed to work on a 4K desktop and on a small older phone.

YPA is intentionally lightweight. It does little by itself, but it tries to do the right little things: keep the stream alive, preserve context, connect tools and harnesses, and let the system be edited while it is running. Bridge modules can be rewritten and reloaded without dropping an active conversation, so YPA can work on itself while you keep the thread. Any model or API route with tool-call support can be connected.

If you want to try it, start with [First steps](#first-steps-recommended).

YPA is local-first. It runs on hardware you control, from a small home server to a cloud VM. Private files, memory, and tools can stay on that machine. Cloud models remain available when they are the better choice. YPA does not require a hosted YPA service, but external model and search providers receive the data you send to them.

YPA supports both API keys and installed provider tools. When a first-party CLI supports account login, YPA can use that CLI with the user's existing account. Exact access and billing depend on the provider and its current terms.

Current integrations include Claude Code, Codex CLI, Gemini CLI, Claude and OpenAI-compatible APIs, OpenRouter, Grok routes, Hermes, GGUF models, and partner agents such as Open Claw. Support varies by route and platform.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#project-status)
[![Core: Go 1.25](https://img.shields.io/badge/core-Go_1.25-00ADD8.svg)](https://go.dev/)
[![Bridge: Bun 1.2](https://img.shields.io/badge/bridge-Bun_1.2-black.svg)](https://bun.sh/)

---

## Why YPA exists

Coding agents are useful, but each one usually keeps its own history, tools, and settings. Moving between them means copying context and managing several separate interfaces.

YPA provides one place to manage that work. It can route a conversation to different harnesses and models while keeping the session, working directory, and tools together.

Agents are organized in two groups:

- **Personnel** are named agents with a role, model, prompt, and tool set.
- **Partners** are external agents or harnesses connected as peers, such as Open Claw or Hermes.

YPA can also work on its own code. Bridge modules can reload while a conversation is active. Rewind snapshots provide a way back when an edit fails.

<img src=".github/screenshots/pet.png" alt="YPA pet companion beside a live conversation" align="right" width="230">

### Conversation companion

An optional pet companion follows the live conversation with a separate model. It can summarize recent work, explain what changed, or suggest the next step without interrupting the main agent.

### Intended users

YPA is currently for people who already understand coding agents, command-line tools, and the risks of giving an agent write or shell access.

The current release does not show a permission prompt for every action. Run it in a dedicated account, container, virtual machine, or separate computer. Do not assume that a working directory alone is a complete security boundary: a harness or tool may have access to anything allowed by its operating-system account.

YPA runs on Linux, macOS, and Windows.

## Interface

YPA keeps the active session and stream when you change layouts or views. The view overlay provides quick access to split view, workflows, code, layout controls, and the main menu.

### Layouts

- **Full** — header, collapsible sections, and optional split views.
- **Messenger** — session list on the left and chat on the right.
- **Zen** — a focused single-column chat.

### Views

- **Chat** — the conversation only.
- **Split** — chat and workflow graph side by side.
- **Code** — editor, files, GitHub, rewind, terminal, browser, and debug panels alongside chat.
- **Workflow** — a node editor with chat, tool, condition, agent, workflow, and trigger nodes.

<table>
  <tr>
    <td width="33%"><img src=".github/screenshots/full.png" alt="Full layout"><br><sub><b>Full</b> — main workspace</sub></td>
    <td width="33%"><img src=".github/screenshots/code.png" alt="Code view"><br><sub><b>Code</b> — editor and development tools</sub></td>
    <td width="33%"><img src=".github/screenshots/workflow.png" alt="Workflow editor"><br><sub><b>Workflow</b> — node-based automation</sub></td>
  </tr>
  <tr>
    <td><img src=".github/screenshots/split.png" alt="Split view"><br><sub><b>Split</b> — workflow and chat</sub></td>
    <td><img src=".github/screenshots/messenger.png" alt="Messenger layout"><br><sub><b>Messenger</b> — sessions and chat</sub></td>
    <td><img src=".github/screenshots/zen.png" alt="Zen layout"><br><sub><b>Zen</b> — focused chat</sub></td>
  </tr>
</table>

### Themes

Appearance is configured on three independent axes:

- **Color** — 14 color families, each with dark and bright variants.
- **Design** — Console, Atelier, or Patchbay.
- **Layout** — Full, Messenger, or Zen.

<table>
  <tr>
    <td width="33%"><img src=".github/screenshots/theme-atelier.png" alt="Atelier theme"><br><sub><b>Atelier</b></sub></td>
    <td width="33%"><img src=".github/screenshots/theme-console.png" alt="Console theme"><br><sub><b>Console</b></sub></td>
    <td width="33%"><img src=".github/screenshots/theme-patchbay.png" alt="Patchbay theme"><br><sub><b>Patchbay</b></sub></td>
  </tr>
</table>

The color families are Default, Minimal, Ocean, Sunset, High Contrast, Kinetic, Kawaii, Neural, Ochre, Fable, Prism, Void, Smoke, and Shade.

<table>
  <tr>
    <td width="50%"><b>Smoke</b><br><img src=".github/screenshots/color-smoke-bright.png" alt="Smoke bright theme"><br><img src=".github/screenshots/color-smoke-dark.png" alt="Smoke dark theme"></td>
    <td width="50%"><b>Prism</b><br><img src=".github/screenshots/color-prism-bright.png" alt="Prism bright theme"><br><img src=".github/screenshots/color-prism-dark.png" alt="Prism dark theme"></td>
  </tr>
  <tr>
    <td width="50%"><b>Minimal</b><br><img src=".github/screenshots/color-minimal-bright.png" alt="Minimal bright theme"><br><img src=".github/screenshots/color-minimal-dark.png" alt="Minimal dark theme"></td>
    <td width="50%"><b>Void</b><br><img src=".github/screenshots/color-void-bright.png" alt="Void bright theme"><br><img src=".github/screenshots/color-void-dark.png" alt="Void dark theme"></td>
  </tr>
  <tr>
    <td width="50%"><b>Ocean</b><br><img src=".github/screenshots/color-ocean-bright.png" alt="Ocean bright theme"><br><img src=".github/screenshots/color-ocean-dark.png" alt="Ocean dark theme"></td>
    <td width="50%"><b>Sunset</b><br><img src=".github/screenshots/color-sunset-bright.png" alt="Sunset bright theme"><br><img src=".github/screenshots/color-sunset-dark.png" alt="Sunset dark theme"></td>
  </tr>
</table>

## Main features

| Capability | Description |
|---|---|
| **Multi-harness routing** | Use Claude Code, Codex CLI, Gemini CLI, APIs, and local models from one session. |
| **Stateful shell sessions** | Named shells keep their directory, environment variables, and running processes between turns. |
| **Background triggers** | Run schedules, website monitors, and file watchers on the server without an open browser tab. |
| **Per-directory knowledge** | Keep dependency data and synthesis notes for each working directory and expose them through MCP. |
| **Personnel** | Configure named agents with their own role, model, tools, and system prompt. |
| **Browser automation** | Use a persistent Chromium browser through Playwright and CDP. |
| **Cost tracking** | Record token use and estimated cost per turn, with routing-layer budgets. |
| **Workflows** | Convert a chat into a visual graph and run it manually or from a trigger. |

## Live module reloads

Bridge modules can reload without ending the active conversation. The loader waits for in-flight requests before replacing a module.

- Module manifests declare a reload mode: `safe`, `idle-only`, or `never`.
- Sessions and streams remain in Go while the Bun bridge restarts.
- Shell sessions remain available across bridge-layer reloads.

This is an alpha feature. A bad module can still fail, and changes to the Go core may require a core restart.

## Rewind

YHA Rewind stores edit snapshots by working directory. You can restore the previous edit, move back several steps, or select a specific snapshot.

```text
/rewind       restore the previous snapshot
/rewind 3     move back three snapshots
/rewind <id>  restore a specific snapshot
```

Rewind reduces the cost of a failed agent edit, but it is not a replacement for Git or regular backups.

## Persistence and reconnects

YPA keeps draft and stream state in two places:

- The browser stores the current draft and view state.
- The server stores messages, turns, and the stream cursor.

After a short disconnect, the client attempts to resume from the last acknowledged stream sequence. The interface reports live, reconnecting, and offline states instead of treating every connection as healthy.

## Local and remote access

YPA can run on a Raspberry Pi, mini PC, laptop, desktop, Mac, or cloud VM. Hardware needs depend mainly on the agents and local models you choose.

The public Go service listens on port `8443` and forwards bridge requests internally. Tailscale can provide remote access without exposing the service directly to the public internet. Tailscale Funnel is optional and disabled by default.

WorkOS authentication is available when its environment variables are configured. A local installation without authentication should not be exposed to an untrusted network.

## Architecture

**YPA** is the user-facing product. **YHA** is the internal host and service layer.

YPA is the default product name. A local installation can use a different display name through its environment configuration.

| Component | Runtime | Role |
|---|---|---|
| `go-core/cmd/yha-core` | Go 1.25 | Public front door, live streams, supervision, and core services |
| `go-core/cmd/yha-rewind` | Go 1.25 | Edit snapshots and recovery |
| `go-core/cmd/yha-tui-daemon` | Go 1.25 | Local daemon for the terminal interface |
| `go-core/cmd/yha` | Go 1.25 | Bubble Tea terminal interface |
| `bridge/` | Bun 1.2 | Harness routing, MCP pool, tools, and reloadable modules |
| `frontend/` | React 19 + Vite + bun:sqlite | Web client served through the stack |

Go handles long-running services and live connections. Bun hosts the parts designed for quick changes and module reloads.

## Project status

YPA is **alpha software maintained primarily by one developer**. The public repository is suitable for testing and review, but interfaces, configuration, and storage formats may change between releases.

Core features such as multi-harness routing, MCP tools, stateful shells, cost tracking, module reloads, and rewind are present. Some areas still need more testing, documentation, and platform-specific work.

## Requirements

- Bun 1.2 or newer
- Go 1.25 or newer
- Git and GitHub CLI for cloning, updates, and repository workflows
- Node.js when you want PM2-based process management
- At least one supported harness, local model, or API provider
- Tailscale for optional remote access between machines

Provider CLIs and API keys are optional unless a selected route needs them. For example, Claude-routed flows require Claude Code to be installed and authenticated.

## First steps (recommended)

An installer is planned. Until then, the most reliable path is to let a coding harness help with the setup: install Claude Code and/or Codex, open this repository, and ask it to install and run YPA for you. Treat the harness as a bootstrap tool: useful for installation, even if YPA is the interface you intend to use afterward.

1. Install the developer tools you need:
   - Claude Code and/or Codex CLI
   - Git and GitHub CLI
   - Go
   - Bun
   - Node.js, only if you want PM2 support
   - Tailscale, if you want private remote access to nodes
2. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/yourpersonalagent/ypa.git
   cd ypa
   bun install
   cd bridge && bun install && cd ..
   ```

3. Start the full stack:

   ```bash
   ./yha.sh dev
   ```

   On Windows:

   ```powershell
   .\yha.ps1 dev
   ```

4. Open the URL printed by the launcher, usually <http://localhost:8443>.
5. Optional but recommended for exposed or shared access: create a [WorkOS](https://workos.com/pricing) account, add an application, and configure its homepage and redirect URL. User Management/Auth is currently free for typical personal setups, but confirm current WorkOS pricing before relying on it. Use a local callback such as `http://localdomain/auth/callback`, or a Tailscale Funnel callback such as `https://your-tailnet-name.ts.net/auth/callback`.
6. Log in, then add the API keys and harnesses you want to use. Common first configuration:
   - Add an NVIDIA API key if you want NVIDIA-backed routes.
   - Enable **Auto-title** in the Context Generator if you want automatic session names.
   - In Preferences → Harness, add one instance for each harness/account combination you use. For example, two Claude subscriptions should be configured as two instances.
   - Press the harness auth button to copy the login command, then run it in a terminal. You can also run it from YPA with a `#bash` command.
   - In Preferences → System, set the standard folder to the directory where your projects live or where YPA should create new projects.
7. Choose a model or harness and tell YPA what you want to build.

Before giving a harness access to important files, use a dedicated OS account, VM, container, or spare machine and keep regular Git commits or backups. YPA includes rewind snapshots, but they are not a security boundary and not a replacement for version control.

## Typical setups

| Setup | Description | Notes |
|---|---|---|
| **Single developer machine** | Run YPA locally and open it at `localhost:8443`. | Fastest path for testing. Use caution if the same account has access to private files. |
| **Spare workstation or mini PC** | Run YPA on a secondary Mac, Windows, or Linux machine and access it from your main computer. | Recommended for daily agent work because the agent runtime is separated from the private main PC. |
| **Development nodes** | Install YPA on multiple lab machines, build servers, or project boxes. | Use one node per environment, GPU, OS, customer project, or risk level. |
| **Tailscale private access** | Keep YPA off the public internet and connect through your tailnet. | Good default for remote access across laptops, servers, and home lab machines. |
| **Tailscale Funnel access** | Expose YPA through a Tailscale HTTPS URL. | Configure WorkOS auth first and treat the node as internet reachable. |
| **Cloud VM** | Run YPA near cloud resources or for always-on workflows. | Lock down networking, secrets, OS users, and provider credentials. |

## Quick start

```bash
git clone https://github.com/yourpersonalagent/ypa.git
cd ypa
bun install
cp bridge/config.example.json bridge/config.json
bun start
```

Open <http://localhost:8443>.

`bun start` runs the Bun bridge. Use the platform launcher for the full stack.

## Running the full stack

### Linux, macOS

```bash
./yha.sh dev             # development mode with file watching
./yha.sh build           # production frontend and all services
./yha.sh restart-bridge  # restart Bun while Go keeps the live stream
./yha.sh restart-core    # restart the Go core
./yha.sh go-reload       # replace the Go core without a public-port gap
./yha.sh tui             # open the terminal interface
```

### Windows

```powershell
.\yha.ps1 dev
.\yha.ps1 build
.\yha.ps1 restart-bridge
.\yha.ps1 restart-core
.\yha.ps1 tui
.\yha.ps1 status
.\yha.ps1 stop
```

The launchers build the four Go binaries and start the required services. On first run they also create a shared bridge key in `bridge/.env`.

To enable Tailscale Funnel explicitly:

```bash
YHA_ENABLE_FUNNEL=1 ./yha.sh dev
```

## Terminal interface

Run `./yha.sh tui` or `.\yha.ps1 tui` to open the Bubble Tea terminal interface. It connects to YHA TUI Daemon over a local socket and can reconnect after an SSH session ends.

The TUI includes:

- **Dashboard** — service state, resource use, URLs, Git state, and recent jobs.
- **Chat** — conversations and model routing.
- **Sessions** — session search, filtering, export, and live state.
- **Notes** — notes collected across sessions.
- **Rewind** — snapshots and restore actions.
- **MCP** — MCP servers, tools, and lifecycle controls.
- **Security** — authentication, budget, MCP, Tailscale, and secret-file signals.

If the daemon is unavailable, the TUI shows an offline state and keeps trying to reconnect.

## Contributing

Issues and technical discussion are especially useful while the project is still changing quickly. Please open an issue before starting a large pull request so the approach can be discussed first.

## License

Copyright (C) 2026 YPA Project Contributors.

YPA is released under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, the license requires you to offer the corresponding source code to its users.
