import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import {
  Bot,
  Copy,
  Loader2,
  RefreshCcw,
  SendHorizonal,
  Trash2,
  UserRound,
  WifiOff,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { PERSONA_DESCRIPTIONS, useSettings } from "../state/settings";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  pending?: boolean;
  model?: string;
  timestamp: number;
};

type OllamaChunkPayload = {
  content?: string;
  done: boolean;
  error?: string;
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

const mergeStreamContent = (previous: string, incoming: string) => {
  if (!previous) {
    return incoming;
  }
  if (incoming.startsWith(previous)) {
    return incoming;
  }
  if (previous.startsWith(incoming)) {
    return previous;
  }

  const maxOverlap = Math.min(previous.length, incoming.length);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.slice(-size) === incoming.slice(0, size)) {
      overlap = size;
      break;
    }
  }
  return previous + incoming.slice(overlap);
};

interface ChatbotProps {
  sessionId?: string | null;
}

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
  const responseIdRef = useRef<string | null>(null);
  const responseBufferRef = useRef<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();

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
      const models = await invoke<string[]>("list_ollama_models");
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
        if (!models.includes(model)) {
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
  }, [model]);

  const refreshHealth = useCallback(async () => {
    setCheckingOllama(true);
    try {
      const healthy = await invoke<boolean>("check_ollama");
      setOllamaOnline(healthy);
      if (!healthy) {
        setChatError("Ollama isn't responding on localhost:11434.");
      } else {
        setChatError((prev) => (prev?.includes("Ollama") ? null : prev));
        await refreshModels();
      }
    } catch (error) {
      setOllamaOnline(false);
      setChatError(
        typeof error === "string"
          ? error
          : "Couldn't reach Ollama on localhost:11434.",
      );
    } finally {
      setCheckingOllama(false);
    }
  }, [refreshModels]);

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
        const previous = responseBufferRef.current;
        const incoming = payload.content;
        const nextContent = mergeStreamContent(previous, incoming);

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

      if (payload.done) {
        responseIdRef.current = null;
        responseBufferRef.current = "";
        setIsStreaming(false);
      }
    },
    [],
  );

  useEffect(() => {
    refreshHealth().catch((error) => console.error(error));
  }, [refreshHealth]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const attach = async () => {
      unlisten = await listen<OllamaChunkPayload>("ollama-chunk", (event) => {
        handleAssistantChunk(event.payload);
      });
    };

    attach().catch((error) => console.error(error));

    return () => {
      unlisten?.();
    };
  }, [handleAssistantChunk]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendPrompt = useCallback(async () => {
    const trimmed = input.trim();
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

    const personaDescription = PERSONA_DESCRIPTIONS[settings.persona];
    const personaPrompt = `Persona directive: Adopt the ${settings.persona} persona – ${personaDescription}`;
    const systemPrompt = settings.systemPrompt?.trim();

    const requestPayload: Record<string, unknown> = {
      prompt: trimmed,
      model,
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
    input,
    isStreaming,
    model,
    ollamaOnline,
    refreshHealth,
    refreshModels,
    sessionId,
    settings,
  ]);

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
            <article
              key={message.id}
              className={clsx("chat-message", `chat-message--${message.role}`)}
            >
              <div className="chat-message__actions" aria-label="Message actions">
                <button
                  type="button"
                  aria-label="Copy message"
                  title="Copy message"
                  onClick={() => handleCopyMessage(message)}
                  disabled={!message.content}
                >
                  <Copy size={14} />
                </button>
                <button
                  type="button"
                  aria-label="Delete message"
                  title="Delete message"
                  onClick={() => handleDeleteMessage(message.id)}
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
              <div className="chat-message__content">
                {message.role === "assistant" ? (
                  <div className="chat-markdown">
                    <ReactMarkdown>
                      {message.content || (message.pending ? "…" : "")}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p>{message.content}</p>
                )}
              </div>
              <footer className="chat-message__meta-line">
                <span>{formatTimestamp(message.timestamp)}</span>
              </footer>
            </article>
          ))}
          <div ref={bottomRef} />
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
                Streaming
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
