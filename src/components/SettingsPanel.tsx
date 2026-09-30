import { MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  Check,
  FolderTree,
  Globe,
  Leaf,
  Network,
  Plus,
  RotateCw,
  Server,
  Settings2,
  Shield,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { PERSONA_DESCRIPTIONS, useSettings } from "../state/settings";
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
  const [showAddServer, setShowAddServer] = useState(false);
  const [newServerId, setNewServerId] = useState("");
  const [newServerCmd, setNewServerCmd] = useState("");
  const [newServerArgs, setNewServerArgs] = useState("");

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
    try {
      const config = await invoke<McpConfigFile>("mcp_load_config");
      if (!config.mcpServers) config.mcpServers = {};
      const args = newServerArgs.trim() ? newServerArgs.trim().split(" ") : [];
      config.mcpServers[newServerId.trim()] = {
        command: newServerCmd.trim(),
        args,
        disabled: false,
      };
      await invoke("mcp_save_config", { config });
      setNewServerId("");
      setNewServerCmd("");
      setNewServerArgs("");
      setShowAddServer(false);
      await loadMcp();
      await invoke("mcp_restart_server", { server_id: newServerId.trim() });
    } catch (err) {
      console.error("Failed to add MCP server", err);
    } finally {
      await loadMcp();
    }
  };

  const toggleMcpServer = async (id: string, disabled: boolean) => {
    try {
      const config = await invoke<McpConfigFile>("mcp_load_config");
      if (config.mcpServers && config.mcpServers[id]) {
        config.mcpServers[id].disabled = disabled;
        await invoke("mcp_save_config", { config });
        await loadMcp();
        await invoke("mcp_restart_server", { server_id: id });
      }
    } catch (err) {
      console.error("Failed to toggle MCP server", err);
    } finally {
      await loadMcp();
    }
  };

  const restartMcpServer = async (id: string) => {
    try {
      await invoke("mcp_restart_server", { server_id: id });
    } catch (err) {
      console.error("Failed to restart MCP server", err);
    } finally {
      await loadMcp();
    }
  };

  const deleteMcpServer = async (id: string) => {
    try {
      const config = await invoke<McpConfigFile>("mcp_load_config");
      if (config.mcpServers && config.mcpServers[id]) {
        delete config.mcpServers[id];
        await invoke("mcp_save_config", { config });
        await invoke("mcp_restart_server", { server_id: id });
      }
    } catch (err) {
      console.error("Failed to delete MCP server", err);
    } finally {
      await loadMcp();
    }
  };

  const installPreset = async (preset: (typeof MCP_PRESETS)[number]) => {
    try {
      const config = await invoke<McpConfigFile>("mcp_load_config");
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[preset.id] = {
        command: preset.command,
        args: preset.args,
        disabled: false,
      };
      await invoke("mcp_save_config", { config });
      await loadMcp();
      await invoke("mcp_restart_server", { server_id: preset.id });
    } catch (err) {
      console.error("Failed to install MCP preset", err);
    } finally {
      await loadMcp();
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
                <>
                  <section className="settings-section">
                    <div className="settings-section__label">
                      <p>Terminal font size</p>
                      <span>{settings.terminalFontSize}px</span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={22}
                      value={settings.terminalFontSize}
                      onChange={(event) => updateSettings({ terminalFontSize: Number(event.currentTarget.value) })}
                    />
                  </section>

                  <section className="settings-grid">
                    <ToggleCard
                      title="Show chat panel"
                      description="Hide when you want a distraction-free terminal."
                      active={settings.showChat}
                      onToggle={() => updateSettings({ showChat: !settings.showChat })}
                    />
                  </section>
                </>
              )}

              {activeTab === "ai" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h4 className="settings-card__title">
                          <Network size={16} style={{ color: "#34d399" }} />
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
                      <span className={clsx("settings-hint", hostStatus.ok ? "text-emerald-400" : "settings-hint--error")}>
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
                        <span>Choose Lime Copilot's personality</span>
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
                                <Icon size={15} style={{ color: "#34d399" }} />
                                <span>{preset.name}</span>
                              </div>
                            </div>
                            <p className="mcp-preset-card__desc">{preset.desc}</p>
                            <button
                              type="button"
                              className="mcp-preset-card__btn"
                              disabled={isInstalled}
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
                                  <span>Install</span>
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
                          <Server size={16} style={{ color: "#34d399" }} />
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
                      {mcpServers.map((srv) => (
                        <div key={srv.id} className="mcp-server-item">
                          <div className="mcp-server-meta">
                            <span className={clsx("mcp-status-dot", `mcp-status--${srv.status}`)} title={`Status: ${srv.status}`} />
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                                <strong style={{ color: "#f8fafc", fontSize: "0.85rem" }}>{srv.id}</strong>
                                <span className="mcp-tool-count">
                                  {srv.tool_count} {srv.tool_count === 1 ? "tool" : "tools"}
                                </span>
                              </div>
                              <code style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.5)" }}>
                                {srv.command} {srv.args.join(" ")}
                              </code>
                            </div>
                          </div>
                          <div className="mcp-server-actions">
                            <button
                              type="button"
                              className="text-btn"
                              onClick={() => toggleMcpServer(srv.id, !srv.disabled)}
                              style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
                            >
                              {srv.disabled ? "Enable" : "Disable"}
                            </button>
                            <button
                              type="button"
                              className="text-btn"
                              onClick={() => restartMcpServer(srv.id)}
                              title="Restart server"
                              style={{ fontSize: "0.75rem", padding: "0.25rem 0.4rem" }}
                            >
                              <RotateCw size={13} />
                            </button>
                            <button
                              type="button"
                              className="text-btn"
                              onClick={() => deleteMcpServer(srv.id)}
                              title="Delete server"
                              style={{ fontSize: "0.75rem", padding: "0.25rem 0.4rem", color: "#f87171" }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
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
                            style={{ color: "#34d399", fontWeight: 600 }}
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
              <button className="text-btn" onClick={onClose} style={{ color: "#34d399", fontWeight: 600 }}>
                Done
              </button>
            </footer>
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
