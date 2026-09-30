import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderTree,
  GitBranch,
  Loader2,
  Play,
  RefreshCcw,
  SendHorizonal,
  TerminalSquare,
  Trash2,
  UserRound,
  WifiOff,
} from "lucide-react";
import { FormEvent, KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { PERSONA_DESCRIPTIONS, useSettings } from "../state/settings";
import { ContextChipsState, DEFAULT_CONTEXT_CHIPS, gatherActiveContext } from "../state/context";

type ChatRole = "user" | "assistant";

export type TelemetryData = {
  tokPerSec?: number;
  evalCount?: number;
  evalDurationMs?: number;
  ttftMs?: number;
  totalDurationMs?: number;
};

export type ToolExecution = {
  id: string;
  serverName: string;
  toolName: string;
  durationMs?: number;
  status: "running" | "success" | "error";
  details?: string;
};

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  pending?: boolean;
  model?: string;
  timestamp: number;
  telemetry?: TelemetryData;
  toolCalls?: ToolExecution[];
};

type OllamaToolCall = {
  function: {
    name: string;
    arguments: any;
  };
};

type OllamaChunkPayload = {
  content?: string;
  done: boolean;
  error?: string;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  total_duration?: number;
  tool_calls?: OllamaToolCall[];
};

type TerminalContextPayload = {
  session_id: string;
  last_lines: string;
};

const createId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);

interface ChatbotProps {
  sessionId?: string | null;
}

type MessageItemProps = {
  message: ChatMessage;
  onCopy: (message: ChatMessage) => void;
  onDelete: (messageId: string) => void;
};

type CodeBlockProps = React.HTMLAttributes<HTMLElement> & {
  className?: string;
  children?: React.ReactNode;
};

const CodeBlock = ({ className, children, ...props }: CodeBlockProps) => {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const rawText = String(children ?? "").replace(/\n$/, "");
  const isInline = !match && !rawText.includes("\n");

  if (isInline) {
    return (
      <code className="chat-inline-code" {...props}>
        {children}
      </code>
    );
  }

  const lang = match ? match[1] : "sh";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy code snippet", err);
    }
  };

  const handleRun = () => {
    window.dispatchEvent(
      new CustomEvent("termalime:run-command", { detail: rawText.trim() })
    );
  };

  const handleInsert = () => {
    window.dispatchEvent(
      new CustomEvent("termalime:insert-command", { detail: rawText.trim() })
    );
  };

  return (
    <div className="chat-code-block">
      <div className="chat-code-block__header">
        <span className="chat-code-block__lang">{lang}</span>
        <div className="chat-code-block__actions">
          <button
            type="button"
            className="chat-code-btn"
            onClick={handleCopy}
            title="Copy command snippet"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
          <button
            type="button"
            className="chat-code-btn"
            onClick={handleInsert}
            title="Insert into active terminal at prompt"
          >
            <TerminalSquare size={12} />
            <span>Insert</span>
          </button>
          <button
            type="button"
            className="chat-code-btn chat-code-btn--run"
            onClick={handleRun}
            title="Run command in terminal (guarded by Preflight)"
          >
            <Play size={12} />
            <span>Run</span>
          </button>
        </div>
      </div>
      <pre className="chat-code-block__pre">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
};

const markdownComponents = {
  code: CodeBlock,
};

const MessageItem = memo(({ message, onCopy, onDelete }: MessageItemProps) => {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <article className={clsx("chat-message", `chat-message--${message.role}`)}>
      <div className="chat-message__actions" aria-label="Message actions">
        <button
          type="button"
          aria-label="Copy message"
          title="Copy message"
          onClick={() => onCopy(message)}
          disabled={!message.content}
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          aria-label="Delete message"
          title="Delete message"
          onClick={() => onDelete(message.id)}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <header className="chat-message__meta">
        {message.role === "assistant" ? <Bot size={14} /> : <UserRound size={14} />}
        <span>
          {message.role === "assistant" ? message.model ?? "Ollama" : "You"}
        </span>
        {message.pending && <span className="typing-dot">●</span>}
      </header>

      {/* Phase 2 & 3: MCP Tool Call Accordions */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="tool-call-list">
          {message.toolCalls.map((tool) => (
            <div key={tool.id} className="tool-call-card">
              <div className="tool-call-header" onClick={() => toggleTool(tool.id)}>
                <span className="tool-call-title">
                  {expandedTools[tool.id] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <code>{tool.serverName}:{tool.toolName}</code>
                </span>
                <span className="tool-call-duration">
                  {tool.durationMs != null ? `(${tool.durationMs}ms)` : `running…`}
                </span>
              </div>
              {expandedTools[tool.id] && tool.details && (
                <pre className="tool-call-details">{tool.details}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="chat-message__content">
        {message.role === "assistant" ? (
          <div className="chat-markdown">
            <ReactMarkdown components={markdownComponents}>
              {message.content || (message.pending ? "…" : "")}
            </ReactMarkdown>
          </div>
        ) : (
          <p>{message.content}</p>
        )}
      </div>
      <footer className="chat-message__meta-line">
        <span>{formatTimestamp(message.timestamp)}</span>
        {message.telemetry && (
          <span className="chat-telemetry">
            {message.telemetry.tokPerSec != null && message.telemetry.tokPerSec > 0 && (
              <span className="telemetry-badge telemetry-badge--toks" title="Generation speed">
                ⚡ {message.telemetry.tokPerSec.toFixed(1)} tok/s
              </span>
            )}
            {message.telemetry.ttftMs != null && message.telemetry.ttftMs > 0 && (
              <span className="telemetry-badge" title="Time to first token">
                {message.telemetry.ttftMs}ms TTFT
              </span>
            )}
          </span>
        )}
      </footer>
    </article>
  );
});

MessageItem.displayName = "MessageItem";

const Chatbot = ({ sessionId }: ChatbotProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [contextChips, setContextChips] = useState<ContextChipsState>(DEFAULT_CONTEXT_CHIPS);
  const responseIdRef = useRef<string | null>(null);
  const responseBufferRef = useRef<string>("");
  const promptStartTimeRef = useRef<number>(0);
  const firstTokenReceivedRef = useRef<boolean>(false);
  const ttftMsRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef(model);
  const { settings } = useSettings();

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const handleCopyMessage = useCallback(async (message: ChatMessage) => {
    const text = message.content?.trim();
    if (!text) {
      return;
    }

    const fallbackCopy = () => {
      if (typeof document === "undefined") {
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "readonly");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    };

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy();
      }
    } catch (error) {
      console.error("Unable to copy message", error);
      fallbackCopy();
    }
  }, []);

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      setMessages((prev) => prev.filter((message) => message.id !== messageId));

      if (responseIdRef.current === messageId) {
        responseIdRef.current = null;
        responseBufferRef.current = "";
        setIsStreaming(false);
      }
    },
    [setIsStreaming],
  );

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const models = await invoke<string[]>("list_ollama_models", { host: settings.ollamaHost });
      setModelOptions(models);
      if (models.length === 0) {
        setModel("");
        setChatError((prev) =>
          prev && !prev.includes("No local Ollama")
            ? prev
            : "No local Ollama models found. Run `ollama pull <model>` and retry.",
        );
      } else {
        setChatError((prev) => (prev?.includes("No local Ollama") ? null : prev));
        if (!models.includes(modelRef.current)) {
          setModel(models[0]);
        }
      }
    } catch (error) {
      console.error(error);
      setChatError(
        typeof error === "string"
          ? error
          : "Couldn't load the list of local Ollama models.",
      );
    } finally {
      setLoadingModels(false);
    }
  }, [settings.ollamaHost]);

  const refreshHealth = useCallback(async (): Promise<boolean> => {
    setCheckingOllama(true);
    try {
      const healthy = await invoke<boolean>("check_ollama", { host: settings.ollamaHost });
      setOllamaOnline(healthy);
      if (!healthy) {
        setChatError(`Ollama isn't responding on ${settings.ollamaHost || "http://127.0.0.1:11434"}.`);
        return false;
      } else {
        setChatError((prev) => (prev?.includes("Ollama") ? null : prev));
        await refreshModels();
        return true;
      }
    } catch (error) {
      setOllamaOnline(false);
      setChatError(
        typeof error === "string"
          ? error
          : `Couldn't reach Ollama on ${settings.ollamaHost || "http://127.0.0.1:11434"}.`,
      );
      return false;
    } finally {
      setCheckingOllama(false);
    }
  }, [settings.ollamaHost, refreshModels]);

  const handleAssistantChunk = useCallback(
    (payload: OllamaChunkPayload) => {
      const activeResponseId = responseIdRef.current;

      if (payload.error) {
        responseBufferRef.current = "";
        setChatError(payload.error);
        setIsStreaming(false);
        setOllamaOnline(false);
        if (activeResponseId) {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === activeResponseId
                ? {
                  ...message,
                  pending: false,
                  content: message.content || payload.error || "Ollama error",
                }
                : message,
            ),
          );
        }
        responseIdRef.current = null;
        return;
      }

      if (payload.content && activeResponseId) {
        setChatError(null);
        setOllamaOnline(true);
        if (!firstTokenReceivedRef.current && promptStartTimeRef.current > 0) {
          firstTokenReceivedRef.current = true;
          ttftMsRef.current = Date.now() - promptStartTimeRef.current;
        }

        const nextContent = responseBufferRef.current + payload.content;
        responseBufferRef.current = nextContent;

        setMessages((prev) =>
          prev.map((message) =>
            message.id === activeResponseId
              ? {
                ...message,
                content: nextContent,
                pending: !payload.done,
              }
              : message,
          ),
        );
      }

      // Handle tool calls returned by model (Phase 3)
      if (payload.tool_calls && payload.tool_calls.length > 0 && activeResponseId) {
        for (const tc of payload.tool_calls) {
          const rawName = tc.function.name;
          const parts = rawName.split("__");
          const serverName = parts[0] || "mcp";
          const toolName = parts.slice(1).join("__") || rawName;
          const toolCallId = createId();

          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id !== activeResponseId) return msg;
              const existing = msg.toolCalls || [];
              if (existing.some((t) => t.toolName === toolName && t.serverName === serverName)) {
                return msg;
              }
              return {
                ...msg,
                toolCalls: [
                  ...existing,
                  {
                    id: toolCallId,
                    serverName,
                    toolName,
                    status: "running",
                  },
                ],
              };
            }),
          );
        }
      }

      if (payload.done) {
        let tokPerSec: number | undefined;
        let evalDurationMs: number | undefined;
        if (payload.eval_duration && payload.eval_count) {
          const durationSec = payload.eval_duration / 1e9;
          if (durationSec > 0) {
            tokPerSec = payload.eval_count / durationSec;
          }
          evalDurationMs = Math.round(payload.eval_duration / 1e6);
        }
        const ttftMs =
          ttftMsRef.current ??
          (payload.prompt_eval_duration ? Math.round(payload.prompt_eval_duration / 1e6) : undefined);
        const totalDurationMs = payload.total_duration
          ? Math.round(payload.total_duration / 1e6)
          : undefined;

        const telemetry: TelemetryData = {
          tokPerSec,
          evalCount: payload.eval_count,
          evalDurationMs,
          ttftMs,
          totalDurationMs,
        };

        if (activeResponseId) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === activeResponseId
                ? {
                    ...msg,
                    pending: false,
                    telemetry,
                  }
                : msg,
            ),
          );
        }

        responseIdRef.current = null;
        responseBufferRef.current = "";
        setIsStreaming(false);
      }
    },
    [],
  );

  // Auto-retry connection on startup with exponential backoff
  useEffect(() => {
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 5;
    const baseDelay = 1000; // 1 second

    const attemptConnection = async () => {
      if (cancelled) return;

      const success = await refreshHealth();

      if (!success && !cancelled && retryCount < maxRetries) {
        retryCount++;
        const delay = baseDelay * Math.pow(1.5, retryCount - 1); // 1s, 1.5s, 2.25s, 3.4s, 5s
        setTimeout(() => {
          attemptConnection().catch((error) => console.error(error));
        }, delay);
      }
    };

    attemptConnection().catch((error) => console.error(error));

    return () => {
      cancelled = true;
    };
  }, [refreshHealth]);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    let unlistenTool: UnlistenFn | undefined;

    const attach = async () => {
      const unsub = await listen<OllamaChunkPayload>("ollama-chunk", (event) => {
        if (!active) {
          return;
        }
        handleAssistantChunk(event.payload);
      });

      const unsubTool = await listen<{
        raw_name: string;
        server_name: string;
        tool_name: string;
        duration_ms: number;
        is_error: boolean;
        content: string;
      }>("mcp-tool-result", (event) => {
        if (!active) return;
        const data = event.payload;
        setMessages((prev) =>
          prev.map((msg) =>
            msg.toolCalls &&
            msg.toolCalls.some(
              (t) => t.toolName === data.tool_name || t.serverName === data.server_name
            )
              ? {
                  ...msg,
                  toolCalls: msg.toolCalls.map((t) =>
                    t.toolName === data.tool_name || (t.serverName === data.server_name && t.status === "running")
                      ? {
                          ...t,
                          durationMs: data.duration_ms,
                          status: data.is_error ? "error" : "success",
                          details: data.content,
                        }
                      : t,
                  ),
                }
              : msg,
          ),
        );
      });

      if (!active) {
        unsub();
        unsubTool();
      } else {
        unlisten = unsub;
        unlistenTool = unsubTool;
      }
    };

    attach().catch((error) => console.error(error));

    return () => {
      active = false;
      unlisten?.();
      unlistenTool?.();
    };
  }, [handleAssistantChunk]);

  useEffect(() => {
    // Smooth scrolling restarts its animation on every streamed chunk, so
    // fall back to an instant scroll while a response is streaming.
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
  }, [messages, isStreaming]);

  const sendPrompt = useCallback(async (customPrompt?: string) => {
    const rawPrompt = typeof customPrompt === "string" ? customPrompt : input;
    const trimmed = rawPrompt.trim();
    if (!trimmed || isStreaming) {
      return;
    }

    if (ollamaOnline === false) {
      setChatError("Ollama is offline. Start it and retry.");
      if (!checkingOllama) {
        refreshHealth().catch((error) => console.error(error));
      }
      return;
    }

    if (!model) {
      setChatError("No local Ollama models are available yet.");
      if (!checkingOllama) {
        refreshModels().catch((error) => console.error(error));
      }
      return;
    }

    const timestamp = Date.now();
    promptStartTimeRef.current = timestamp;
    firstTokenReceivedRef.current = false;
    ttftMsRef.current = null;

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: trimmed,
      timestamp,
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      pending: true,
      model,
      timestamp,
    };

    responseIdRef.current = assistantMessage.id;
    responseBufferRef.current = "";
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setIsStreaming(true);
    setChatError(null);

    let terminalContext: string | null = null;
    if (settings.includeTerminalContext && sessionId) {
      try {
        const context = await invoke<TerminalContextPayload>("get_terminal_context", {
          session_id: sessionId,
          max_lines: 250,
        });
        const trimmedContext = context.last_lines?.trim();
        if (trimmedContext) {
          terminalContext = trimmedContext;
        }
      } catch (error) {
        console.warn("Unable to fetch terminal context", error);
      }
    }

    try {
      const extraContext = await gatherActiveContext(sessionId, contextChips);
      if (extraContext.trim()) {
        terminalContext = terminalContext
          ? `${terminalContext}\n\n${extraContext.trim()}`
          : extraContext.trim();
      }
    } catch (error) {
      console.warn("Unable to gather workspace context", error);
    }

    const personaDescription = PERSONA_DESCRIPTIONS[settings.persona];
    const personaPrompt = `Persona directive: Adopt the ${settings.persona} persona – ${personaDescription}`;
    const systemPrompt = settings.systemPrompt?.trim();

    const previousHistory = messages
      .filter(
        (m) =>
          !m.pending &&
          m.content.trim().length > 0 &&
          (m.role === "user" || m.role === "assistant")
      )
      .slice(-16)
      .map((m) => ({
        role: m.role,
        content: m.content.trim(),
      }));

    const requestPayload: Record<string, unknown> = {
      prompt: trimmed,
      model,
      host: settings.ollamaHost,
      history: previousHistory,
    };

    if (systemPrompt) {
      requestPayload.system_prompt = systemPrompt;
    }

    if (personaPrompt) {
      requestPayload.persona_prompt = personaPrompt;
    }

    if (terminalContext) {
      requestPayload.terminal_context = terminalContext;
    }

    try {
      await invoke("ask_ollama", {
        request: requestPayload,
      });
      setOllamaOnline(true);
    } catch (error) {
      console.error(error);
      setIsStreaming(false);
      setOllamaOnline(false);
      responseIdRef.current = null;
      setChatError(
        typeof error === "string"
          ? error
          : (error as { message?: string }).message ?? "Unable to reach Ollama",
      );
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessage.id
            ? {
              ...message,
              content: "Failed to reach Ollama.",
              pending: false,
            }
            : message,
        ),
      );
    }
  }, [
    checkingOllama,
    contextChips,
    input,
    isStreaming,
    model,
    ollamaOnline,
    refreshHealth,
    refreshModels,
    sessionId,
    settings,
  ]);

  useEffect(() => {
    const handleAskAssistant = async (event: Event) => {
      const custom = event as CustomEvent<{ prompt: string; autoSend?: boolean }>;
      const promptText = custom.detail?.prompt?.trim();
      if (!promptText) return;

      // Always populate the input field so user sees the prompt immediately
      setInput(promptText);

      // Auto-focus the chat input textarea
      setTimeout(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(".chat-input textarea");
        textarea?.focus();
      }, 50);

      if (custom.detail?.autoSend !== false) {
        // If no model is selected yet, try to select one from modelOptions or fetch models
        let targetModel = modelRef.current;
        if (!targetModel && modelOptions.length > 0) {
          targetModel = modelOptions[0];
          setModel(targetModel);
        } else if (!targetModel) {
          try {
            const models = await invoke<string[]>("list_ollama_models");
            if (models.length > 0) {
              setModelOptions(models);
              setModel(models[0]);
              targetModel = models[0];
            }
          } catch {
            // Error will be surfaced in sendPrompt
          }
        }
        void sendPrompt(promptText);
      }
    };
    window.addEventListener("termalime:ask-assistant", handleAskAssistant);
    return () => {
      window.removeEventListener("termalime:ask-assistant", handleAskAssistant);
    };
  }, [modelOptions, sendPrompt]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void sendPrompt();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  };

  const statusTone =
    ollamaOnline === false
      ? "status-dot--error"
      : ollamaOnline === null || isStreaming
        ? "status-dot--warning"
        : "status-dot--ready";

  const statusText =
    ollamaOnline === false
      ? "Offline"
      : isStreaming
        ? "Thinking"
        : ollamaOnline === null
          ? "Checking"
          : "Ready";

  const sendDisabled =
    isStreaming ||
    input.trim().length === 0 ||
    ollamaOnline === false ||
    (!loadingModels && modelOptions.length === 0) ||
    !model;

  return (
    <section className="panel panel--chatbot">
      <header className="panel-header panel-header--chat">
        <div className="panel-heading panel-heading--chat">
          <div className="panel-heading__title-main">
            <Bot size={18} />
            <div className="panel-heading__title-stack">
              <p className="panel-label">Lime Copilot</p>
              <p className="panel-subtitle panel-subtitle--status">
                <span className={`status-dot ${statusTone}`} />
                <span className="status-text">{statusText}</span>
              </p>
            </div>
          </div>
        </div>
        <div className="panel-header__controls panel-header__controls--chat">
          <div className="model-select model-select--compact">
            <label htmlFor="model-select" className="sr-only">
              Model
            </label>
            <div className="model-select__input">
              <select
                id="model-select"
                value={model}
                onChange={(event) => setModel(event.currentTarget.value)}
                disabled={
                  loadingModels ||
                  ollamaOnline === false ||
                  modelOptions.length === 0
                }
              >
                {modelOptions.length === 0 ? (
                  <option value="">No models</option>
                ) : (
                  modelOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                onClick={() => refreshModels().catch((error) => console.error(error))}
                disabled={loadingModels || ollamaOnline === false}
                aria-label="Refresh models"
              >
                {loadingModels ? (
                  <Loader2 size={14} className="icon-spin" />
                ) : (
                  <RefreshCcw size={14} />
                )}
              </button>
            </div>
          </div>
        </div>
      </header>
      <div className="panel-content panel-content--chatbot">
        {ollamaOnline === false && (
          <div className="chat-alert">
            <WifiOff size={16} />
            <div>
              <p>Ollama is offline. Start the daemon and retry.</p>
              <button
                type="button"
                onClick={() => refreshHealth().catch((error) => console.error(error))}
                disabled={checkingOllama}
              >
                {checkingOllama ? (
                  <span className="icon-spin">Checking…</span>
                ) : (
                  <span className="chat-alert__action">
                    <RefreshCcw size={14} /> Retry
                  </span>
                )}
              </button>
            </div>
          </div>
        )}
        <div className="chat-scroll">
          {messages.length === 0 && (
            <div className="placeholder">
              Send a prompt to start a conversation with your local Ollama model.
            </div>
          )}
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              onCopy={handleCopyMessage}
              onDelete={handleDeleteMessage}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="chat-context-chips">
          <button
            type="button"
            className={clsx("chat-chip", contextChips.lastCommand && "chat-chip--active")}
            onClick={() => setContextChips((prev) => ({ ...prev, lastCommand: !prev.lastCommand }))}
            title="Attach output of the most recent terminal command"
          >
            <TerminalSquare size={12} />
            <span>Last Output</span>
          </button>
          <button
            type="button"
            className={clsx("chat-chip", contextChips.gitStatus && "chat-chip--active")}
            onClick={() => setContextChips((prev) => ({ ...prev, gitStatus: !prev.gitStatus }))}
            title="Attach git status and working tree diff"
          >
            <GitBranch size={12} />
            <span>Git Diff</span>
          </button>
          <button
            type="button"
            className={clsx("chat-chip", contextChips.cwdTree && "chat-chip--active")}
            onClick={() => setContextChips((prev) => ({ ...prev, cwdTree: !prev.cwdTree }))}
            title="Attach workspace directory structure"
          >
            <FolderTree size={12} />
            <span>Directory Tree</span>
          </button>
        </div>

        <form className="chat-input" onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder="Ask Lime..."
            rows={3}
            onKeyDown={handleKeyDown}
            disabled={ollamaOnline === false}
          />
          <button type="submit" disabled={sendDisabled}>
            {isStreaming ? (
              <span className="chat-button__content">
                <Loader2 size={16} className="icon-spin" />
              </span>
            ) : (
              <span className="chat-button__content">
                <SendHorizonal size={16} />
              </span>
            )}
          </button>
        </form>
        {chatError && <p className="chat-error">{chatError}</p>}
      </div>
    </section>
  );
};

export default Chatbot;
