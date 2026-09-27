# Termalime Roadmap & Action Items

## 🎯 v0.7 — Codename: Protocol (Current Branch: `v0.7-protocol`)

The objective of v0.7 is to turn Termalime into an open **Model Context Protocol (MCP)** client, connect the terminal to external tools and providers, and ground the model in real workspace context before giving it full agency in v0.8.

### 1. Model Context Protocol (MCP) Client Core
- [ ] Implement an asynchronous MCP client in Rust (`src-tauri/src/mcp.rs` or via a dedicated crate).
- [ ] Support standard `stdio` transport for running local MCP server processes (e.g. `npx -y @modelcontextprotocol/server-filesystem`).
- [ ] Add an `mcp.json` configuration loader in `~/.config/termalime/mcp.json` or through Tauri app data.
- [ ] Design a settings drawer / modal to manage MCP servers (add, toggle, test connection).
- [ ] Parse tool definitions returned by MCP servers and format them into LLM tool-calling schemas.

### 2. Multi-Model & Custom Provider Gateway
- [ ] Remove hardcoded `http://127.0.0.1:11434` endpoint in `src-tauri/src/lib.rs`.
- [ ] Add configurable Ollama Host / Base URL in Settings (support LAN servers, remote rigs, Tailscale).
- [ ] Add support for OpenAI-compatible and Anthropic API endpoints (API key, base URL, model name) so users can route tool-calling to frontier models when desired.

### 3. Workspace Context Discovery & Targeted Chips
- [ ] Add clickable context chips above the chat input box:
  - `+ Last Command Output` (attaches output of the previous shell execution without dumping the full scrollback).
  - `+ Git Status / Diff` (attaches unstaged changes or git summary).
  - `+ CWD Tree` (attaches compact file tree of the current working directory).
- [ ] Detect active project root (via git root or `.git` parent lookup) for better context resolution.

### 4. Performance & Execution Telemetry
- [ ] Replace hardcoded eco multipliers with real inference telemetry:
  - Extract `eval_count` and `eval_duration` from Ollama's stream chunk.
  - Calculate and display tokens-per-second (tok/s) and time-to-first-token (TTFT) on assistant messages.
  - Display tool call execution time (e.g. `filesystem:read_file (14ms)`).

### 5. Keyboard Navigation Ergonomics
- [ ] `Ctrl + \` (or `Ctrl + Alt + C`): Shift keyboard focus immediately from active xterm terminal to Chat input.
- [ ] `Escape` (when chat input is empty): Return focus to active terminal prompt.
- [ ] `Ctrl + 1..9`: Switch between terminal tabs without clicking.

### 6. Packaging, Ubuntu App Center & Delta Updates
- [ ] **Ubuntu App Center (Snapcraft)**:
  - [ ] Create `snap/snapcraft.yaml` recipe for Termalime (desktop interfaces, `pty` access, `x11`/`wayland`).
  - [ ] Register `termalime` name on [snapcraft.io](https://snapcraft.io).
  - [ ] Add automated Snap build & publish action (`canonical/action-snapcraft`) to CI workflow for instant Ubuntu App Center updates.
- [ ] **AppImage Enhancements**:
  - [ ] Embed AppImage update information (`gh-releases-zsync|daveymason|Termalime|latest|Termalime_*_amd64.AppImage.zsync`) into AppImage build.
  - [ ] Publish `.zsync` files alongside release AppImages to enable delta updates via `AppImageUpdate` and catalog integrators.
  - [ ] Bundle AppStream metadata XML (`metainfo.xml`) in `usr/share/metainfo/` for rich software center descriptions and screenshots.

---

## 🚀 Future Milestones

### v0.8 — Codename: Agentic
- [ ] Autonomous tool-calling loop (ReAct pattern: Think $\to$ Tool Call $\to$ Observe $\to$ Act).
- [ ] Self-executing bash/shell tool with user confirmation gates.
- [ ] Multi-step plan generation with checkable task steps in chat.
- [ ] Interrupt / cancel agent execution hotkey (`Ctrl + C` in agent mode).

### v0.9 — Codename: Enterprise
- [ ] Enterprise Cloud Gateway support (Azure OpenAI, AWS Bedrock, Google Cloud Vertex AI).
- [ ] SIEM audit logging for compliance (recording executed commands and AI prompts).
- [ ] Immutable Preflight security policies (centrally enforced, non-bypassable by client toggle).
- [ ] Fleet configuration distribution and SAML/SSO authentication.

### v1.0 — General Availability (GA)
- [ ] Cross-platform parity & certified code-signing (macOS notarization, Windows MSIX).
- [ ] Full OSC 133 semantic shell integration (exit code traps, prompt detection).
- [ ] Production documentation, plugin directory, and community theme repository.
