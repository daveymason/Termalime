import { MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  FileText,
  FolderTree,
  Globe,
  Leaf,
  Network,
  Plus,
  RotateCw,
  Server,
  Settings2,
  Shield,
  Sliders,
  Sparkles,
  Terminal,
  Trash2,
  Type,
  X,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { CursorStyle, PERSONA_DESCRIPTIONS, useSettings } from "../state/settings";
import { formatCo2, formatEnergy, formatWater, useEco } from "../state/eco";

const personaOrder = ["helpful", "concise", "neutral", "playful"] as const;

type SettingsTab = "terminal" | "ai" | "mcp" | "misc";

const MCP_PRESETS = [
  {
    id: "filesystem",
    name: "Filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    desc: "Grants Lime access to read and browse files in your active workspace.",
    icon: FolderTree,
  },
  {
    id: "memory",
    name: "Memory Graph",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    desc: "Persistent knowledge-graph memory across prompt sessions.",
    icon: Sparkles,
  },
  {
    id: "reasoning",
    name: "Reasoning Engine",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    desc: "Sequential problem-solving and deep multi-step logic engine.",
    icon: Bot,
  },
  {
    id: "fetch",
    name: "Web Fetch",
    command: "npx",
    args: ["-y", "mcp-fetch-server"],
    desc: "Fetches web URLs and converts HTML into clean markdown.",
    icon: Globe,
  },
];

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

interface McpServerInfo {
  id: string;
  command: string;
  args: string[];
  disabled: boolean;
  status: string;
  error: string | null;
  tool_count: number;
}

interface McpToolParamProperty {
  type?: string;
  description?: string;
  default?: any;
}

interface McpToolInfo {
  name: string;
  description?: string | null;
  input_schema?: {
    type?: string;
    properties?: Record<string, McpToolParamProperty>;
    required?: string[];
  };
}

interface McpConfigFile {
  mcpServers: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }
  >;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { settings, updateSettings, resetSettings } = useSettings();
  const { session, lifetime, resetLifetime } = useEco();
  const [activeTab, setActiveTab] = useState<SettingsTab>("terminal");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const preflightModelRef = useRef(settings.preflightModel);
  const preferredDefault = "gemma3:270m";

  // Host testing state
  const [testingHost, setTestingHost] = useState(false);
  const [hostStatus, setHostStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // MCP Servers state
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [loadingMcp, setLoadingMcp] = useState(false);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [showAddServer, setShowAddServer] = useState(false);
  const [newServerId, setNewServerId] = useState("");
  const [newServerCmd, setNewServerCmd] = useState("");
  const [newServerArgs, setNewServerArgs] = useState("");

  // MCP Tool Explorer state
  const [expandedServerTools, setExpandedServerTools] = useState<string | null>(null);
  const [serverToolsMap, setServerToolsMap] = useState<Record<string, McpToolInfo[]>>({});
  const [loadingToolsServerId, setLoadingToolsServerId] = useState<string | null>(null);

  // MCP Diagnostics & Stderr Log Viewer state
  const [diagnosticsServer, setDiagnosticsServer] = useState<McpServerInfo | null>(null);
  const [serverLogs, setServerLogs] = useState<string[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);

  useEffect(() => {
    preflightModelRef.current = settings.preflightModel;
  }, [settings.preflightModel]);

  const testHostConnection = async () => {
    setTestingHost(true);
    setHostStatus(null);
    try {
      const ok = await invoke<boolean>("check_ollama", { host: settings.ollamaHost });
      if (ok) {
        setHostStatus({ ok: true, message: `Connected to Ollama at ${settings.ollamaHost}` });
        const models = await invoke<string[]>("list_ollama_models", { host: settings.ollamaHost });
        setModelOptions(models);
        setModelsError(null);
      } else {
        setHostStatus({ ok: false, message: `Failed to reach Ollama at ${settings.ollamaHost}` });
      }
    } catch (err: any) {
      setHostStatus({
        ok: false,
        message: typeof err === "string" ? err : "Failed to connect to Ollama host",
      });
    } finally {
      setTestingHost(false);
    }
  };

  const loadMcp = useCallback(async () => {
    setLoadingMcp(true);
    try {
      const servers = await invoke<McpServerInfo[]>("mcp_get_servers_status");
      setMcpServers(servers);
    } catch (err) {
      console.warn("Failed to load MCP status", err);
    } finally {
      setLoadingMcp(false);
    }
  }, []);

  const handleAddServer = async () => {
    if (!newServerId.trim() || !newServerCmd.trim()) return;
    const serverId = newServerId.trim();
    setBusyServerId(serverId);
    try {
      const config = await invoke<McpConfigFile>("mcp_load_config");
      if (!config.mcpServers) config.mcpServers = {};
      const args = newServerArgs.trim() ? newServerArgs.trim().split(" ") : [];
      config.mcpServers[serverId] = {
        command: newServerCmd.trim(),
        args,
        disabled: false,
      };
      await invoke("mcp_save_config", { config });
      setNewServerId("");
      setNewServerCmd("");
      setNewServerArgs("");
      setShowAddServer(false);
      await invoke("mcp_restart_server", { server_id: serverId });
    } catch (err) {
      console.error("Failed to add MCP server", err);
    } finally {
      await loadMcp();
      setBusyServerId(null);
    }
  };

  const toggleMcpServer = async (id: string, disabled: boolean) => {
    setBusyServerId(id);
    try {
      await invoke("mcp_toggle_server", { server_id: id, disabled });
    } catch (err) {
      console.error("Failed to toggle MCP server", err);
    } finally {
      await loadMcp();
      setBusyServerId(null);
    }
  };

  const restartMcpServer = async (id: string) => {
    setBusyServerId(id);
    try {
      await invoke("mcp_restart_server", { server_id: id });
    } catch (err) {
      console.error("Failed to restart MCP server", err);
    } finally {
      await loadMcp();
      setBusyServerId(null);
    }
  };

  const deleteMcpServer = async (id: string) => {
    setBusyServerId(id);
    try {
      await invoke("mcp_delete_server", { server_id: id });
    } catch (err) {
      console.error("Failed to delete MCP server", err);
    } finally {
      await loadMcp();
      setBusyServerId(null);
    }
  };

  const toggleToolsDrawer = async (serverId: string) => {
    if (expandedServerTools === serverId) {
      setExpandedServerTools(null);
      return;
    }
    setExpandedServerTools(serverId);
    if (!serverToolsMap[serverId]) {
      setLoadingToolsServerId(serverId);
      try {
        const tools = await invoke<McpToolInfo[]>("mcp_get_server_tools", { server_id: serverId });
        setServerToolsMap((prev) => ({ ...prev, [serverId]: tools }));
      } catch (err) {
        console.error("Failed to fetch server tools", err);
      } finally {
        setLoadingToolsServerId(null);
      }
    }
  };

  const openDiagnostics = async (server: McpServerInfo) => {
    setDiagnosticsServer(server);
    setLoadingLogs(true);
    setLogsCopied(false);
    try {
      const logs = await invoke<string[]>("mcp_get_server_logs", { server_id: server.id });
      setServerLogs(logs);
    } catch (err) {
      console.error("Failed to fetch server logs", err);
      setServerLogs([`Error fetching logs: ${String(err)}`]);
    } finally {
      setLoadingLogs(false);
    }
  };

  const refreshDiagnostics = async () => {
    if (!diagnosticsServer) return;
    setLoadingLogs(true);
    try {
      const logs = await invoke<string[]>("mcp_get_server_logs", { server_id: diagnosticsServer.id });
      setServerLogs(logs);
    } catch (err) {
      console.error("Failed to refresh server logs", err);
    } finally {
      setLoadingLogs(false);
    }
  };

  const copyDiagnosticsLogs = () => {
    const textToCopy =
      diagnosticsServer?.id === "termalime"
        ? [
            "[termalime-native] Engine: In-process Rust MCP Server",
            "[termalime-native] Status: Ready (3 tools registered: terminal_run_command, workspace_search, workspace_read_file)",
            "[termalime-native] Latency: 0ms (Direct in-memory Rust async call, zero serialization overhead)",
            "[termalime-native] Architecture: Native Linux/Rust execution with zero external runtime dependencies.",
          ].join("\n")
        : serverLogs.join("\n") || "No logs captured.";
    navigator.clipboard.writeText(textToCopy);
    setLogsCopied(true);
    setTimeout(() => setLogsCopied(false), 2000);
  };

  const installPreset = async (preset: (typeof MCP_PRESETS)[number]) => {
    setBusyServerId(preset.id);
    try {
      const config = await invoke<McpConfigFile>("mcp_load_config");
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[preset.id] = {
        command: preset.command,
        args: preset.args,
        disabled: false,
      };
      await invoke("mcp_save_config", { config });
      await invoke("mcp_restart_server", { server_id: preset.id });
    } catch (err) {
      console.error("Failed to install MCP preset", err);
    } finally {
      await loadMcp();
      setBusyServerId(null);
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    invoke<string[]>("list_ollama_models", { host: settings.ollamaHost })
      .then((models) => {
        if (cancelled) {
          return;
        }
        setModelOptions(models);
        setModelsError(null);
        const current = preflightModelRef.current?.trim();
        if (current && models.includes(current)) {
          return;
        }
        if (models.includes(preferredDefault)) {
          preflightModelRef.current = preferredDefault;
          updateSettings({ preflightModel: preferredDefault });
          return;
        }
        if (models.length > 0 && current !== models[0]) {
          preflightModelRef.current = models[0];
          updateSettings({ preflightModel: models[0] });
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message =
          typeof error === "string" ? error : "Unable to fetch local Ollama models.";
        setModelsError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModels(false);
        }
      });

    loadMcp().catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [open, settings.ollamaHost, updateSettings, loadMcp]);

  const modal = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="settings-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.div
            className="settings-panel"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
          >
            <header className="settings-panel__header">
              <div>
                <p className="settings-panel__eyebrow">Control room</p>
                <h2>Termalime settings</h2>
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close settings">
                <X size={18} />
              </button>
            </header>

            <nav className="settings-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "terminal"}
                className={clsx("settings-tab", activeTab === "terminal" && "settings-tab--active")}
                onClick={() => setActiveTab("terminal")}
              >
                <Terminal size={15} />
                <span>Terminal</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "ai"}
                className={clsx("settings-tab", activeTab === "ai" && "settings-tab--active")}
                onClick={() => setActiveTab("ai")}
              >
                <Bot size={15} />
                <span>AI</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "mcp"}
                className={clsx("settings-tab", activeTab === "mcp" && "settings-tab--active")}
                onClick={() => setActiveTab("mcp")}
              >
                <Server size={15} />
                <span>MCP</span>
                {mcpServers.length > 0 && (
                  <span className="settings-tab-badge">{mcpServers.length}</span>
                )}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "misc"}
                className={clsx("settings-tab", activeTab === "misc" && "settings-tab--active")}
                onClick={() => setActiveTab("misc")}
              >
                <Leaf size={15} />
                <span>Misc</span>
              </button>
            </nav>

            <div className="settings-tab-content">
              {activeTab === "terminal" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  {/* Card 1: Typography & Text */}
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Type size={16} style={{ color: "var(--matrix-neon)" }} />
                          Typography &amp; Scaling
                        </h4>
                        <p className="settings-card__desc">
                          Configure monospace typeface, glyph scaling, and terminal line spacing.
                        </p>
                      </div>
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>Font Family</p>
                        <span className="settings-badge">Monospace</span>
                      </div>
                      <select
                        value={settings.terminalFontFamily}
                        onChange={(event) => updateSettings({ terminalFontFamily: event.currentTarget.value })}
                      >
                        <option value={'"JetBrains Mono", "Fira Code", monospace'}>JetBrains Mono (Default)</option>
                        <option value={'"Fira Code", monospace'}>Fira Code</option>
                        <option value={'"Cascadia Code", "Cascadia Mono", monospace'}>Cascadia Code</option>
                        <option value={'"Source Code Pro", monospace'}>Source Code Pro</option>
                        <option value={'monospace'}>System Monospace</option>
                      </select>
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>Font Size</p>
                        <span className="settings-badge">{settings.terminalFontSize}px</span>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={22}
                        value={settings.terminalFontSize}
                        onChange={(event) => updateSettings({ terminalFontSize: Number(event.currentTarget.value) })}
                      />
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>Line Height</p>
                        <span className="settings-badge">{settings.terminalLineHeight}</span>
                      </div>
                      <div className="segmented-control" role="group" aria-label="Terminal line height">
                        {[
                          { label: "Compact", value: 1.0 },
                          { label: "Standard", value: 1.2 },
                          { label: "Spacious", value: 1.4 },
                        ].map((lh) => (
                          <button
                            key={lh.value}
                            type="button"
                            className={clsx(
                              "segmented-btn",
                              settings.terminalLineHeight === lh.value && "segmented-btn--active"
                            )}
                            onClick={() => updateSettings({ terminalLineHeight: lh.value })}
                          >
                            {lh.label} ({lh.value})
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Card 2: Cursor & Animation */}
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Terminal size={16} style={{ color: "var(--matrix-neon)" }} />
                          Cursor &amp; Interaction
                        </h4>
                        <p className="settings-card__desc">
                          Tailor cursor shape, pulse animation, and instant mouse selection behavior.
                        </p>
                      </div>
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>Cursor Style</p>
                        <span className="settings-badge" style={{ textTransform: "capitalize" }}>
                          {settings.cursorStyle}
                        </span>
                      </div>
                      <div className="segmented-control" role="group" aria-label="Terminal cursor style">
                        {[
                          { id: "block", label: "█ Block" },
                          { id: "bar", label: "❘ Beam" },
                          { id: "underline", label: "  Underline" },
                        ].map((style) => (
                          <button
                            key={style.id}
                            type="button"
                            className={clsx(
                              "segmented-btn",
                              settings.cursorStyle === style.id && "segmented-btn--active"
                            )}
                            onClick={() => updateSettings({ cursorStyle: style.id as CursorStyle })}
                          >
                            {style.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="settings-grid">
                      <ToggleCard
                        title="Blinking cursor"
                        description="Smoothly pulses cursor in terminal prompts when awaiting input."
                        active={settings.cursorBlink}
                        onToggle={() => updateSettings({ cursorBlink: !settings.cursorBlink })}
                      />
                      <ToggleCard
                        title="Copy on select"
                        description="Automatically copies highlighted terminal text directly to clipboard."
                        active={settings.copyOnSelect}
                        onToggle={() => updateSettings({ copyOnSelect: !settings.copyOnSelect })}
                      />
                    </div>
                  </div>

                  {/* Card 3: Scrollback & Buffer */}
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Sliders size={16} style={{ color: "var(--matrix-neon)" }} />
                          Buffer &amp; History
                        </h4>
                        <p className="settings-card__desc">
                          Manage line retention depth for logs, long compilation outputs, and terminal replay.
                        </p>
                      </div>
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>Scrollback Lines</p>
                        <span className="settings-badge">{settings.scrollback.toLocaleString()} lines</span>
                      </div>
                      <div className="segmented-control" role="group" aria-label="Scrollback limit">
                        {[
                          { label: "1,000", value: 1000 },
                          { label: "5,000", value: 5000 },
                          { label: "10,000", value: 10000 },
                          { label: "50,000", value: 50000 },
                        ].map((sb) => (
                          <button
                            key={sb.value}
                            type="button"
                            className={clsx(
                              "segmented-btn",
                              settings.scrollback === sb.value && "segmented-btn--active"
                            )}
                            onClick={() => updateSettings({ scrollback: sb.value })}
                          >
                            {sb.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Card 4: Workspace Layout */}
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Sparkles size={16} style={{ color: "var(--matrix-neon)" }} />
                          Workspace Layout
                        </h4>
                        <p className="settings-card__desc">
                          Configure distraction-free viewports and companion side panels.
                        </p>
                      </div>
                    </div>

                    <div className="settings-grid">
                      <ToggleCard
                        title="Show Copilot panel"
                        description="Split-view companion chatbot. Hide for distraction-free, full-width terminal."
                        active={settings.showChat}
                        onToggle={() => updateSettings({ showChat: !settings.showChat })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "ai" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Network size={16} style={{ color: "var(--matrix-neon)" }} />
                          Local Ollama Gateway
                        </h4>
                        <p className="settings-card__desc">
                          Connect to localhost or a remote Ollama rig on your LAN.
                        </p>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <input
                        type="text"
                        value={settings.ollamaHost}
                        placeholder="http://127.0.0.1:11434"
                        onChange={(event) => updateSettings({ ollamaHost: event.currentTarget.value })}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="text-btn"
                        onClick={testHostConnection}
                        disabled={testingHost}
                        style={{ padding: "0.45rem 0.85rem", whiteSpace: "nowrap" }}
                      >
                        {testingHost ? "Testing…" : "Test connection"}
                      </button>
                    </div>
                    {hostStatus && (
                      <span className={clsx("settings-hint", hostStatus.ok ? "settings-hint--ok" : "settings-hint--error")}>
                        {hostStatus.message}
                      </span>
                    )}
                  </div>

                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Shield size={16} style={{ color: "#38bdf8" }} />
                          Safety &amp; Preflight Guard
                        </h4>
                        <p className="settings-card__desc">
                          Intercept risky commands, run heuristics, and escalate to local AI before execution.
                        </p>
                      </div>
                    </div>

                    <div className="settings-grid">
                      <ToggleCard
                        title="Preflight check commands"
                        description="Intercept dangerous bash patterns (rm, dd, sudo, chmod) and prompt for review."
                        active={settings.preflightCheck}
                        onToggle={() => updateSettings({ preflightCheck: !settings.preflightCheck })}
                      />
                      <ToggleCard
                        title="Attach terminal snapshot"
                        description="Send active scrollback tail with prompts so the assistant understands command errors."
                        active={settings.includeTerminalContext}
                        onToggle={() => updateSettings({ includeTerminalContext: !settings.includeTerminalContext })}
                      />
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>Preflight Guard Model</p>
                        <span>Lightweight model used to evaluate command safety instantly.</span>
                      </div>
                      <select
                        value={settings.preflightModel}
                        onChange={(event) => updateSettings({ preflightModel: event.currentTarget.value })}
                        disabled={modelOptions.length === 0}
                      >
                        {modelOptions.length === 0 ? (
                          <option value="" disabled>
                            No local models detected
                          </option>
                        ) : (
                          modelOptions.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))
                        )}
                      </select>
                      {loadingModels && <span className="settings-hint">Detecting local Ollama models…</span>}
                      {modelsError && <span className="settings-hint settings-hint--error">{modelsError}</span>}
                    </div>
                  </div>

                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Sparkles size={16} style={{ color: "#a855f7" }} />
                          Persona &amp; Directives
                        </h4>
                        <p className="settings-card__desc">
                          Tune the assistant's voice, personality, and foundational terminal instructions.
                        </p>
                      </div>
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>Tone &amp; Demeanor</p>
                        <span>Choose Copilot's personality</span>
                      </div>
                      <div className="persona-row">
                        {personaOrder.map((persona) => (
                          <button
                            key={persona}
                            type="button"
                            className={clsx("persona-pill", persona === settings.persona && "persona-pill--active")}
                            onClick={() => updateSettings({ persona })}
                          >
                            <div>
                              <p className="persona-pill__title">{persona.charAt(0).toUpperCase() + persona.slice(1)}</p>
                              <p className="persona-pill__desc">{PERSONA_DESCRIPTIONS[persona]}</p>
                            </div>
                            {persona === settings.persona && <Check size={16} />}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="settings-section" style={{ border: "none", padding: 0 }}>
                      <div className="settings-section__label">
                        <p>System Prompt</p>
                        <span>Give Termalime custom system rules or instructions.</span>
                      </div>
                      <textarea
                        value={settings.systemPrompt}
                        rows={3}
                        placeholder="You are Lime, an expert terminal AI assistant..."
                        onChange={(event) => updateSettings({ systemPrompt: event.currentTarget.value })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "mcp" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
                  <div className="mcp-intro-banner">
                    <div className="mcp-intro-banner__icon">
                      <Server size={20} />
                    </div>
                    <div className="mcp-intro-banner__text">
                      <h4>Model Context Protocol (MCP)</h4>
                      <p>
                        Connect Lime to local stdio tool servers. Tools are automatically discovered and made available to your local Ollama models. Managed via <code>~/.config/termalime/mcp.json</code>.
                      </p>
                    </div>
                  </div>

                  <div className="mcp-presets-container">
                    <span className="mcp-presets-title">Popular Starter Presets</span>
                    <div className="mcp-presets-grid">
                      {MCP_PRESETS.map((preset) => {
                        const Icon = preset.icon;
                        const isInstalled = mcpServers.some((s) => s.id === preset.id);
                        return (
                          <div key={preset.id} className="mcp-preset-card">
                            <div className="mcp-preset-card__top">
                              <div className="mcp-preset-card__name">
                                <Icon size={15} style={{ color: "var(--matrix-neon)" }} />
                                <span>{preset.name}</span>
                              </div>
                            </div>
                            <p className="mcp-preset-card__desc">{preset.desc}</p>
                            <button
                              type="button"
                              className="mcp-preset-card__btn"
                              disabled={isInstalled || busyServerId === preset.id}
                              onClick={() => installPreset(preset)}
                              style={isInstalled ? { opacity: 0.65, cursor: "default" } : {}}
                            >
                              {isInstalled ? (
                                <>
                                  <Check size={12} />
                                  <span>Installed</span>
                                </>
                              ) : (
                                <>
                                  <Plus size={12} />
                                  <span>{busyServerId === preset.id ? "Installing…" : "Install"}</span>
                                </>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Server size={16} style={{ color: "var(--matrix-neon)" }} />
                          Configured Servers ({mcpServers.length})
                        </h4>
                        <p className="settings-card__desc">
                          Active background tool processes providing tools to the AI assistant.
                        </p>
                      </div>
                      {!showAddServer && (
                        <button
                          type="button"
                          className="commands-footer-btn"
                          onClick={() => setShowAddServer(true)}
                        >
                          <Plus size={14} />
                          <span>Add Custom Server</span>
                        </button>
                      )}
                    </div>

                    <div className="mcp-servers-list">
                      {loadingMcp && <span className="settings-hint">Loading MCP servers…</span>}
                      {!loadingMcp && mcpServers.length === 0 && (
                        <div style={{ textAlign: "center", padding: "1.2rem", color: "rgba(255,255,255,0.45)", fontSize: "0.82rem" }}>
                          No custom servers configured yet. Pick a starter preset above or click &quot;Add Custom Server&quot;.
                        </div>
                      )}
                      {mcpServers.map((srv) => {
                        const isBusy = busyServerId === srv.id;
                        const isNative = srv.id === "termalime";
                        const isExpanded = expandedServerTools === srv.id;
                        const tools = serverToolsMap[srv.id] || [];
                        const isLoadingTools = loadingToolsServerId === srv.id;

                        return (
                          <div
                            key={srv.id}
                            className={clsx(
                              "mcp-server-card",
                              isNative && "mcp-server-card--native",
                              isExpanded && "mcp-server-card--expanded"
                            )}
                          >
                            <div className="mcp-server-item">
                              <div className="mcp-server-meta">
                                <span
                                  className={clsx("mcp-status-dot", `mcp-status--${srv.status}`)}
                                  title={`Status: ${srv.status}`}
                                />
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                    <strong style={{ color: "#f8fafc", fontSize: "0.86rem" }}>{srv.id}</strong>
                                    {isNative && (
                                      <span className="mcp-builtin-badge">
                                        <Zap size={10} /> Native Core Rust
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      className={clsx(
                                        "mcp-tool-count-btn",
                                        isExpanded && "mcp-tool-count-btn--active"
                                      )}
                                      onClick={() => toggleToolsDrawer(srv.id)}
                                      title="Inspect tool schemas"
                                    >
                                      <Code2 size={12} />
                                      <span>
                                        {srv.tool_count} {srv.tool_count === 1 ? "tool" : "tools"}
                                      </span>
                                      {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                    </button>
                                  </div>
                                  <code style={{ fontSize: "0.7rem", color: isNative ? "var(--matrix-neon)" : "rgba(255,255,255,0.5)" }}>
                                    {isNative
                                      ? "In-process zero-latency • Zero dependencies • Linux/Unix native"
                                      : `${srv.command} ${srv.args.join(" ")}`}
                                  </code>
                                </div>
                              </div>
                              <div className="mcp-server-actions">
                                <button
                                  type="button"
                                  className="text-btn mcp-action-btn"
                                  onClick={() => openDiagnostics(srv)}
                                  title="View server logs & stderr diagnostics"
                                >
                                  <FileText size={12} />
                                  <span>Logs</span>
                                </button>
                                {!isNative && (
                                  <>
                                    <button
                                      type="button"
                                      className="text-btn mcp-action-btn"
                                      disabled={isBusy}
                                      onClick={() => toggleMcpServer(srv.id, !srv.disabled)}
                                    >
                                      {srv.disabled ? "Enable" : "Disable"}
                                    </button>
                                    <button
                                      type="button"
                                      className="text-btn mcp-icon-btn"
                                      disabled={isBusy}
                                      onClick={() => restartMcpServer(srv.id)}
                                      title="Restart server"
                                    >
                                      <RotateCw size={13} className={clsx(isBusy && "icon-spin")} />
                                    </button>
                                    <button
                                      type="button"
                                      className="text-btn mcp-icon-btn mcp-icon-btn--delete"
                                      disabled={isBusy}
                                      onClick={() => deleteMcpServer(srv.id)}
                                      title="Delete server"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Tool Explorer & Schema Inspector Drawer */}
                            {isExpanded && (
                              <div className="mcp-tools-drawer">
                                <div className="mcp-tools-drawer-header">
                                  <span className="mcp-tools-drawer-title">
                                    Tool Explorer &amp; Schema Inspector ({tools.length})
                                  </span>
                                  <span className="mcp-tools-drawer-desc">
                                    Tools registered with Ollama for function calling &amp; automated execution.
                                  </span>
                                </div>

                                {isLoadingTools && (
                                  <div className="mcp-tools-loading">
                                    <RotateCw size={14} className="icon-spin" />
                                    <span>Querying MCP tool capabilities…</span>
                                  </div>
                                )}

                                {!isLoadingTools && tools.length === 0 && (
                                  <div className="mcp-tools-empty">
                                    No tools exposed by this server yet or server is initializing.
                                  </div>
                                )}

                                {!isLoadingTools && tools.length > 0 && (
                                  <div className="mcp-tools-grid">
                                    {tools.map((tool) => {
                                      const properties = tool.input_schema?.properties || {};
                                      const required = tool.input_schema?.required || [];
                                      const propKeys = Object.keys(properties);

                                      return (
                                        <div key={tool.name} className="mcp-tool-card">
                                          <div className="mcp-tool-top">
                                            <Code2 size={13} className="mcp-tool-icon" />
                                            <code className="mcp-tool-name">{tool.name}</code>
                                          </div>
                                          {tool.description && (
                                            <p className="mcp-tool-desc">{tool.description}</p>
                                          )}
                                          <div className="mcp-tool-params">
                                            <span className="mcp-params-label">Parameters:</span>
                                            {propKeys.length === 0 ? (
                                              <span className="mcp-no-params">No parameters required</span>
                                            ) : (
                                              <div className="mcp-params-list">
                                                {propKeys.map((propName) => {
                                                  const prop = properties[propName];
                                                  const isReq = required.includes(propName);
                                                  return (
                                                    <div key={propName} className="mcp-param-row">
                                                      <div className="mcp-param-head">
                                                        <code className="mcp-param-name">{propName}</code>
                                                        <span className="mcp-param-type">
                                                          {prop?.type || "any"}
                                                        </span>
                                                        <span
                                                          className={clsx(
                                                            "mcp-param-badge",
                                                            isReq ? "mcp-param-badge--req" : "mcp-param-badge--opt"
                                                          )}
                                                        >
                                                          {isReq ? "(required)" : "(optional)"}
                                                        </span>
                                                      </div>
                                                      {prop?.description && (
                                                        <p className="mcp-param-desc">{prop.description}</p>
                                                      )}
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {showAddServer && (
                      <div className="mcp-add-form">
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                          <input
                            type="text"
                            placeholder="Server ID (e.g. postgres)"
                            value={newServerId}
                            onChange={(e) => setNewServerId(e.target.value)}
                          />
                          <input
                            type="text"
                            placeholder="Command (e.g. npx)"
                            value={newServerCmd}
                            onChange={(e) => setNewServerCmd(e.target.value)}
                          />
                        </div>
                        <input
                          type="text"
                          placeholder="Arguments (e.g. -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb)"
                          value={newServerArgs}
                          onChange={(e) => setNewServerArgs(e.target.value)}
                        />
                        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.25rem" }}>
                          <button
                            type="button"
                            className="text-btn"
                            onClick={() => setShowAddServer(false)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="text-btn"
                            onClick={handleAddServer}
                            style={{ color: "var(--matrix-neon)", fontWeight: 600 }}
                          >
                            Save &amp; Start
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "misc" && (
                <>
                  <section className="settings-section">
                    <div className="settings-section__label">
                      <p>
                        <Leaf size={14} style={{ verticalAlign: "-2px", marginRight: "0.35rem" }} />
                        Eco impact
                      </p>
                      <span>
                        Estimated savings from answering prompts locally instead of calling a cloud LLM.
                      </span>
                    </div>
                    <div className="eco-stats">
                      <div className="eco-stat">
                        <span className="eco-stat__value">{formatCo2(lifetime.co2G)}</span>
                        <span className="eco-stat__label">CO₂ saved (all time)</span>
                      </div>
                      <div className="eco-stat">
                        <span className="eco-stat__value">{formatWater(lifetime.waterMl)}</span>
                        <span className="eco-stat__label">Water saved (all time)</span>
                      </div>
                      <div className="eco-stat">
                        <span className="eco-stat__value">{formatEnergy(lifetime.energyWh)}</span>
                        <span className="eco-stat__label">Energy saved (all time)</span>
                      </div>
                      <div className="eco-stat">
                        <span className="eco-stat__value">{lifetime.requests}</span>
                        <span className="eco-stat__label">Local requests</span>
                      </div>
                    </div>
                    <p className="settings-hint">
                      This session: {formatCo2(session.co2G)} CO₂, {formatWater(session.waterMl)} water
                      across {session.requests} requests.
                    </p>
                    <button className="text-btn" onClick={resetLifetime} style={{ alignSelf: "flex-start" }}>
                      Reset eco totals
                    </button>
                  </section>

                  <section className="settings-section" style={{ borderTop: "1px solid rgba(255, 255, 255, 0.08)", paddingTop: "1rem" }}>
                    <div className="settings-section__label">
                      <p>Factory reset</p>
                      <span>Reset all settings, prompt templates, and options to default values.</span>
                    </div>
                    <button className="text-btn" onClick={resetSettings} style={{ color: "#f87171", alignSelf: "flex-start" }}>
                      Reset all settings to defaults
                    </button>
                  </section>
                </>
              )}
            </div>

            <footer className="settings-panel__footer">
              <span className="settings-panel__hint">Changes save instantly.</span>
              <button className="text-btn" onClick={onClose} style={{ color: "var(--matrix-neon)", fontWeight: 600 }}>
                Done
              </button>
            </footer>
          </motion.div>
        </motion.div>
      )}

      {diagnosticsServer && (
        <motion.div
          className="mcp-log-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={() => setDiagnosticsServer(null)}
        >
          <motion.div
            className="mcp-log-modal"
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mcp-log-modal-header">
              <div className="mcp-log-modal-title-wrap">
                <Terminal size={17} style={{ color: "var(--matrix-neon)" }} />
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <h3>Server Diagnostics</h3>
                    <span className="mcp-modal-server-id">{diagnosticsServer.id}</span>
                    <span
                      className={clsx("mcp-status-dot", `mcp-status--${diagnosticsServer.status}`)}
                      title={`Status: ${diagnosticsServer.status}`}
                    />
                    <span className="mcp-modal-status-text">{diagnosticsServer.status}</span>
                  </div>
                  <code className="mcp-modal-cmd">
                    {diagnosticsServer.id === "termalime"
                      ? "In-process Native Rust Engine (Zero-dependency)"
                      : `${diagnosticsServer.command} ${diagnosticsServer.args.join(" ")}`}
                  </code>
                </div>
              </div>

              <div className="mcp-log-modal-actions">
                {diagnosticsServer.id !== "termalime" && (
                  <button
                    type="button"
                    className="text-btn mcp-modal-action-btn"
                    onClick={refreshDiagnostics}
                    disabled={loadingLogs}
                    title="Refresh live logs"
                  >
                    <RotateCw size={13} className={clsx(loadingLogs && "icon-spin")} />
                    <span>Refresh</span>
                  </button>
                )}
                <button
                  type="button"
                  className="text-btn mcp-modal-action-btn"
                  onClick={copyDiagnosticsLogs}
                  title="Copy logs to clipboard"
                >
                  {logsCopied ? (
                    <>
                      <Check size={13} style={{ color: "var(--matrix-neon)" }} />
                      <span style={{ color: "var(--matrix-neon)" }}>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy size={13} />
                      <span>Copy</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="icon-btn mcp-modal-close"
                  onClick={() => setDiagnosticsServer(null)}
                  aria-label="Close diagnostics"
                >
                  <X size={17} />
                </button>
              </div>
            </div>

            <div className="mcp-log-modal-body">
              {diagnosticsServer.id === "termalime" ? (
                <div className="mcp-native-diagnostics-box">
                  <div className="mcp-native-line">
                    <span className="mcp-native-tag">[termalime-native]</span> Engine: In-process Native Rust MCP Server
                  </div>
                  <div className="mcp-native-line">
                    <span className="mcp-native-tag">[termalime-native]</span> Binary: Termalime Desktop Client
                  </div>
                  <div className="mcp-native-line">
                    <span className="mcp-native-tag">[termalime-native]</span> Status: Operational &amp; Ready
                  </div>
                  <div className="mcp-native-line">
                    <span className="mcp-native-tag">[termalime-native]</span> Latency: &lt;1ms (In-memory asynchronous call, zero serialization delay)
                  </div>
                  <div className="mcp-native-line" style={{ marginTop: "0.6rem" }}>
                    <span className="mcp-native-tag">[termalime-native]</span> Registered Built-in Tools (3):
                  </div>
                  <div className="mcp-native-tool-item">
                    • <code>terminal_run_command</code>: Executes commands in bash/zsh with configurable timeout controls
                  </div>
                  <div className="mcp-native-tool-item">
                    • <code>workspace_search</code>: Fast native glob and ripgrep-style file tree discovery
                  </div>
                  <div className="mcp-native-tool-item">
                    • <code>workspace_read_file</code>: Zero-latency UTF-8 file inspector with line caps
                  </div>
                  <div className="mcp-native-footer">
                    ✓ Zero dependencies (Node.js &amp; npm NOT required). Pre-loaded and active out-of-the-box.
                  </div>
                </div>
              ) : loadingLogs ? (
                <div className="mcp-log-loading-box">
                  <RotateCw size={18} className="icon-spin" />
                  <span>Streaming stderr diagnostics from process…</span>
                </div>
              ) : serverLogs.length === 0 ? (
                <div className="mcp-log-empty-box">
                  <p>No stderr messages recorded.</p>
                  <span>The background process is running cleanly without throwing errors or warnings.</span>
                </div>
              ) : (
                <pre className="mcp-log-stream">
                  {serverLogs.map((line, idx) => (
                    <div key={idx} className="mcp-log-stream-row">
                      <span className="mcp-log-stream-num">{idx + 1}</span>
                      <span className="mcp-log-stream-text">{line}</span>
                    </div>
                  ))}
                </pre>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

interface ToggleCardProps {
  title: string;
  description: string;
  active: boolean;
  onToggle: () => void;
}

const ToggleCard = ({ title, description, active, onToggle }: ToggleCardProps) => (
  <button className={clsx("toggle-card", active && "toggle-card--active")} onClick={onToggle}>
    <div>
      <p className="toggle-card__title">{title}</p>
      <p className="toggle-card__desc">{description}</p>
    </div>
    <span className={clsx("toggle-card__switch", active && "toggle-card__switch--on")}></span>
  </button>
);

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="settings-fab" onClick={onClick}>
      <Settings2 size={18} />
      <span>Settings</span>
    </button>
  );
}
