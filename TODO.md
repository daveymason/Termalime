# Termalime Roadmap & Action Items

## 🎯 v0.7 — Codename: Protocol (Current Branch: `v0.7-protocol`)

The objective of v0.7 is to turn Termalime into an open **Model Context Protocol (MCP)** client, connect the terminal to external tools and providers, and ground the model in real workspace context before giving it full agency in v0.8.

### Phase 1: Local Provider Gateway (Foundation)
*Unblocks network constraints and standardizes how we communicate with Ollama via Rust.*
- [x] Remove hardcoded `http://127.0.0.1:11434` endpoint in `src-tauri/src/lib.rs` and route requests through `reqwest` to bypass frontend CORS.
- [x] Add configurable Ollama Host via a single input field in Settings (or fallback to `OLLAMA_HOST` env var) to unblock LAN and remote rig setups.

### Phase 2: Performance Telemetry (Transparency)
*Gives us baseline visibility into model speeds before we introduce tool-calling latency.*
- [x] Extract `eval_count` and `eval_duration` from Ollama's stream chunk in `chat.ts`.
- [x] Calculate and display tokens-per-second (tok/s) and time-to-first-token (TTFT) on assistant messages.
- [x] Build the UI placeholder to display tool call execution times (e.g. `filesystem:read_file (14ms)`).

### Phase 3: Model Context Protocol (MCP) Client Core & Native Tools
*The heavy lift. Establishes the tool-discovery pipe between Ollama and the host OS with zero-dependency native execution.*
- [x] Add `rmcp` (`modelcontextprotocol/rust-sdk`) and `tokio` dependencies to `Cargo.toml`.
- [x] Implement an asynchronous MCP client in `src-tauri/src/mcp.rs`.
- [x] Manage MCP in Tauri state: Spin up `stdio` servers defined in `~/.config/termalime/mcp.json` as managed Tokio background tasks.
- [x] Expose Tauri IPC commands (`mcp_list_tools`, `mcp_call_tool`, `mcp_get_server_tools`, `mcp_get_server_logs`) to the frontend.
- [x] Design the Settings drawer/modal to manage MCP servers (add, toggle, test connection).
- [x] Parse tool definitions returned by MCP servers and format them into LLM tool-calling schemas.
- [x] **Native Rust MCP Tools (Zero-Dependency Engine)**:
  - Built-in `termalime` server running directly in-process within Termalime's binary without requiring Node.js or npm.
  - `terminal_run_command`: Executes commands in bash/zsh with configurable timeout controls.
  - `workspace_search`: Fast native glob/ripgrep file finding across active directories.
  - `workspace_read_file`: Zero-latency UTF-8 file inspector with line caps.
- [x] **Tool Explorer & Schema Inspector**:
  - Expandable accordion drawer on each MCP server card in Settings.
  - Live inspection of discovered tool names, human-readable descriptions, and input parameter schemas (`type`, `(required)` / `(optional)` badges).
- [x] **Server Diagnostics & Stderr Log Viewer**:
  - Live background `stderr` capture ring buffer (250 lines) per spawned server process.
  - High-visibility diagnostic modal with monospace terminal stream, live refresh, and one-click "Copy Logs".

### Phase 4: Workspace Context Discovery & Real-Time Environment Sync
*Grounded terminal awareness without noisy UI clutter.*
- [x] Implement Rust backend commands to fetch CWD tree and git status.
- [x] Modify `pty.rs` to extract and expose the last command output from the active terminal buffer.
- [x] Build frontend state (`context.ts`) to manage active context payload.
- [x] Real-time terminal `/proc/{pid}/cwd` shell process tracking and git branch detection in bottom status bar.
- [x] Instant event-driven status bar refresh on command execution (`Enter` / newline) and tab switches.
- [x] Discard noisy context pills/chips in favor of clean Copilot input bar and `Explain Terminal` shortcut (`Ctrl+Shift+E`).

### Phase 5: UI Modernization & Control Room Customization
*Minimalist Don Norman design principles, decluttered containers, and rich terminal settings.*
- [x] **Container De-cluttering**: Removed excess bounding walls, thick lime borders, and cluttered wrappers for a sleek, immersive dark Matrix aesthetic.
- [x] **Model Selector Redesign**: Replaced awkward header dropdown with an elegant, compact trigger button in the chat footer with model status indicator.
- [x] **Model Selector Modal (`ModelSelectorModal.tsx`)**: Search filter, category badges, subtle active indicators, and fast keyboard navigation.
- [x] **Terminal Customization Suite**:
  - **Typography**: Monospace font family selector (`JetBrains Mono`, `Fira Code`, `Cascadia Code`, `Source Code Pro`, `System Monospace`), font size range slider (10-22px), and line height segmented control.
  - **Cursor Styling**: Shape picker (`█ Block`, `❘ Beam`, `_ Underline`) and cursor blinking toggle.
  - **Ergonomics**: Linux/X11-style "Copy on select" toggle (auto-copies highlighted terminal text to clipboard).
  - **Buffer Depth**: Scrollback history limit picker (`1,000`, `5,000`, `10,000`, `50,000` lines).
  - **Distraction-Free Layout**: Single-click toggle to show or hide the Copilot chat panel.
- [x] **Telemetry Refinement**: Formatted Time-to-First-Token (TTFT) in seconds with maximum two decimal places (`X.XXs TTFT`).

### Phase 6: Packaging & Distribution
*Shipping to the masses.*
- [x] **Ubuntu App Center (Snapcraft)**: Create `snap/snapcraft.yaml` recipe, register name, and add CI action.
- [x] **AppImage Enhancements**: Embed `.zsync` update info into build, publish delta files, and bundle `metainfo.xml`.
- [x] **Termalime.com updates**: Add MCP, Ubuntu App Center, AppImage, Ollama Host, Performance Telemetry, Workspace Context Discovery, and Keyboard Navigation Ergonomics sections to the roadmap. Add version 0.7.0 everywhere. 

### Phase 7: Manual Verification & QA Checklist (Boot & End-to-End Validation)
*Hands-on verification of all newly added subsystems in the running desktop app.*
- [x] **Desktop Boot & Lifecycle**:
  - [x] Boot application via `npm run tauri dev` or `target/debug/Termalime` without startup panics or WebKit errors.
  - [x] Confirm `~/.config/termalime/mcp.json` is initialized and loaded cleanly.
- [x] **Terminal & PTY Subsystem**:
  - [x] Terminal loads active shell (bash/zsh), receives keystrokes, and responds to standard commands.
  - [x] Window resizing properly updates PTY rows and columns without text corruption.
  - [x] New tab creation inherits active CWD.
  - [x] Terminal navigation (`cd <dir>`) immediately updates status bar CWD and git branch badge.
- [x] **Control Room Terminal Settings**:
  - [x] Changing font family, font size, or line height updates xterm live.
  - [x] Switching cursor style (`Block`, `Beam`, `Underline`) updates the cursor shape.
  - [x] Toggling "Copy on select" copies highlighted terminal text to clipboard.
- [x] **Provider Gateway (Phase 1)**:
  - [x] Open Settings drawer (`Ctrl+,` or cog button) and verify "Ollama Host Gateway" defaults to `http://127.0.0.1:11434`.
  - [x] Click "Test Connection" — verify green checkmark and success confirmation when Ollama is running.
  - [x] Test negative path: Change host to an invalid endpoint (e.g. `http://127.0.0.1:9999`) and click Test — verify error badge appears without application crash.
  - [x] Revert to valid host and verify bottom model selector button loads available models.
- [x] **Performance Telemetry (Phase 2)**:
  - [x] Send a prompt in the chat panel (e.g. "Say hello and count to 5").
  - [x] Confirm tokens stream smoothly without UI freezes.
  - [x] Once response completes, verify telemetry badges appear at the bottom-right of the assistant card (`X.X tok/s`, `X.XXs TTFT`, and total duration).
- [x] **MCP Server Lifecycle & Tool Execution (Phase 3)**:
  - [x] Navigate to Settings > "Model Context Protocol (MCP) Servers".
  - [x] Verify `termalime` Native Core Rust card appears at top of the server list with status green.
  - [x] Click "Tools (3)" on `termalime` to expand the Tool Explorer drawer; inspect schemas for `terminal_run_command`, `workspace_search`, and `workspace_read_file` (parameters, types, and `(required)` badges).
  - [x] Click "Logs" on any server to open the Server Diagnostics modal; confirm live stderr stream or native in-process operational readout, and test "Copy Logs".
  - [x] Install a starter MCP preset (e.g. Filesystem) and verify tool count updates dynamically.
  - [x] Toggle server active/inactive and verify status badge updates.
  - [x] Click "Restart" on a server and verify reconnects cleanly.
- [x] **Packaging & Distribution Standards (Phase 6)**:
  - [x] Validate `snap/snapcraft.yaml` syntax and confinement permissions.
  - [x] Validate `com.termalime.Termalime.metainfo.xml` via `appstreamcli validate` (0 errors).
  - [x] Verify release builds for desktop app (`npm run build`) and website (`npm run build`).

---

## 🚀 Future Milestones

### v0.8 — Codename: Agentic
- [ ] Introduce **Ask Mode vs. Act Mode** toggle in the chatbar:
  - **Ask Mode (Fast/One-Shot)**: Leverages v0.7 context chips for instant, low-latency responses without tool loops (ideal for 1b/3b models).
  - **Act Mode (ReAct Loop + MCP)**: Unlocks full `Thought -> Call Tool -> Observe -> Act` loop for complex reasoning.
- [ ] Visual UI for Tool Executions: Display MCP tool calls as collapsible accordions in the chat window (e.g., `▼ Tool: filesystem.read_file() -> 14ms`).
- [ ] Self-executing bash/shell tool with in-stream permission gates (e.g., `[Run: git checkout -b fix-auth] [Approve] [Reject]`).
- [ ] Multi-step plan generation with checkable task steps in chat.
- [ ] Interrupt / cancel agent execution hotkey (`Ctrl + C` in agent mode).

### v0.9 — Codename: Enterprise
- [ ] Add support for OpenAI-compatible and Anthropic API endpoints (API key, base URL, model name) so users can route tool-calling to frontier models when desired.
- [ ] Enterprise Cloud Gateway support (Azure OpenAI, AWS Bedrock, Google Cloud Vertex AI).
- [ ] SIEM audit logging for compliance (recording executed commands and AI prompts).
- [ ] Immutable Preflight security policies (centrally enforced, non-bypassable by client toggle).
- [ ] Fleet configuration distribution and SAML/SSO authentication.

### v1.0 — General Availability (GA)
- [ ] Cross-platform parity & certified code-signing (macOS notarization, Windows MSIX).
- [ ] Full OSC 133 semantic shell integration (exit code traps, prompt detection).
- [ ] Production documentation, plugin directory, and community theme repository.
