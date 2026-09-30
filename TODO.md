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

### Phase 3: Model Context Protocol (MCP) Client Core
*The heavy lift. Establishes the tool-discovery pipe between Ollama and the host OS.*
- [x] Add `rmcp` (`modelcontextprotocol/rust-sdk`) and `tokio` dependencies to `Cargo.toml`.
- [x] Implement an asynchronous MCP client in `src-tauri/src/mcp.rs`.
- [x] Manage MCP in Tauri state: Spin up `stdio` servers defined in `~/.config/termalime/mcp.json` as managed Tokio background tasks.
- [x] Expose Tauri IPC commands (`mcp_list_tools`, `mcp_call_tool`) to the frontend.
- [x] Design the Settings drawer/modal to manage MCP servers (add, toggle, test connection).
- [x] Parse tool definitions returned by MCP servers and format them into LLM tool-calling schemas.

### Phase 4: Workspace Context Discovery & Targeted Chips
*Gives the user manual control over injecting terminal state into the LLM context.*
- [x] Implement Rust backend commands to fetch CWD tree and git status.
- [x] Modify `pty.rs` to extract and expose the last command output from the active terminal buffer.
- [x] Build frontend state (`context.ts`) to manage active context payload.
- [x] Add clickable context chips above the chat input box (`+ Last Command Output`, `+ Git Status / Diff`, `+ CWD Tree`).

### Phase 5: Packaging & Distribution
*Shipping to the masses.*
- [x] **Ubuntu App Center (Snapcraft)**: Create `snap/snapcraft.yaml` recipe, register name, and add CI action.
- [x] **AppImage Enhancements**: Embed `.zsync` update info into build, publish delta files, and bundle `metainfo.xml`.
- [x] **Termalime.com updates**: Add MCP, Ubuntu App Center, AppImage, Ollama Host, Performance Telemetry, Workspace Context Discovery, and Keyboard Navigation Ergonomics sections to the roadmap. Add version 0.7.0 everywhere. 

### Phase 6: Manual Verification & QA Checklist (Boot & End-to-End Validation)
*Hands-on verification of all newly added subsystems in the running desktop app.*
- [x] **Desktop Boot & Lifecycle**:
  - [x] Boot application via `npm run tauri dev` or `target/debug/Termalime` without startup panics or WebKit errors.
  - [x] Confirm `~/.config/termalime/mcp.json` is initialized and loaded cleanly.
- [ ] **Terminal & PTY Subsystem**:
  - [ ] Terminal loads active shell (bash/zsh), receives keystrokes, and responds to standard commands.
  - [ ] Window resizing properly updates PTY rows and columns without text corruption.
  - [ ] New tab creation inherits active CWD.
- [ ] **Provider Gateway (Phase 1)**:
  - [ ] Open Settings drawer (`Ctrl+,` or cog button) and verify "Ollama Host Gateway" defaults to `http://127.0.0.1:11434`.
  - [ ] Click "Test Connection" — verify green checkmark and success confirmation when Ollama is running.
  - [ ] Test negative path: Change host to an invalid endpoint (e.g. `http://127.0.0.1:9999`) and click Test — verify error badge appears without application crash.
  - [ ] Revert to valid host and verify top-right model dropdown loads available models (`llama3.2:1b`, etc.).
- [ ] **Performance Telemetry (Phase 2)**:
  - [ ] Send a prompt in the chat panel (e.g. "Say hello and count to 5").
  - [ ] Confirm tokens stream smoothly without UI freezes.
  - [ ] Once response completes, verify telemetry badges appear at the bottom-right of the assistant card (`X.X tok/s`, `TTFT: Xms`, and total duration).
- [ ] **MCP Server Lifecycle & Tool Execution (Phase 3)**:
  - [ ] Navigate to Settings > "Model Context Protocol (MCP) Servers".
  - [ ] Verify server list displays and matches `~/.config/termalime/mcp.json`.
  - [ ] Add a sample MCP server (e.g. filesystem server via `npx -y @modelcontextprotocol/server-filesystem /tmp`).
  - [ ] Toggle server active/inactive and verify status badge updates.
  - [ ] Click "Restart" on a server and verify reconnects cleanly.
- [ ] **Workspace Context Discovery Chips (Phase 4)**:
  - [ ] Run a shell command in the terminal (e.g. `echo "Termalime v0.7 Protocol Test"`).
  - [ ] Click the `Last Output` chip above chat input — verify active highlight and check that prompt receives the command output.
  - [ ] Click the `Git Diff` chip — verify working tree status/diff is gathered.
  - [ ] Click the `Directory Tree` chip — verify workspace file tree is gathered.
- [x] **Packaging & Distribution Standards (Phase 5)**:
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
