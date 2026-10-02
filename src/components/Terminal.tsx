import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import clsx from "clsx";
import "@xterm/xterm/css/xterm.css";
import { useSettings } from "../state/settings";
import PreflightModal, { PreflightStatus } from "./PreflightModal";
import { AnalyzeCommandResponse, PreflightReport } from "../types/preflight";

const IS_DEV = import.meta.env.DEV;

type TerminalStatus = "connecting" | "ready" | "error";

type TerminalOutputPayload = {
  data: string;
  session_id: string;
};

type PreflightState = {
  status: PreflightStatus;
  command: string;
  report?: PreflightReport;
  message?: string;
};

const terminalTheme: ITerminalOptions["theme"] = {
  background: "#030604",
  foreground: "#f5f7fa",
  cursor: "#a3e635",
  cursorAccent: "#030604",
  selectionBackground: "rgba(163, 230, 53, 0.3)",
  selectionForeground: "#ffffff",
};

type TerminalProps = {
  onSessionChange?: (sessionId: string | null) => void;
  /** Whether this terminal is the visible tab; inactive tabs stay mounted but ignore app-wide commands. */
  active?: boolean;
  initialCwd?: string | null;
};

const Terminal = ({ onSessionChange, active = true, initialCwd }: TerminalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const { settings, updateSettings } = useSettings();
  const commandBufferRef = useRef<string>("");
  const preflightEnabledRef = useRef(settings.preflightCheck);
  const preflightModelRef = useRef(settings.preflightModel);
  const onSessionChangeRef = useRef(onSessionChange);
  const copyOnSelectRef = useRef(settings.copyOnSelect);
  const [preflightState, setPreflightState] = useState<PreflightState>({
    status: "hidden",
    command: "",
  });
  const preflightStatusRef = useRef<PreflightStatus>("hidden");
  const pendingPreflightActionRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);

  // In-buffer search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    copyOnSelectRef.current = settings.copyOnSelect;
  }, [settings.copyOnSelect]);

  useEffect(() => {
    preflightEnabledRef.current = settings.preflightCheck;
  }, [settings.preflightCheck]);

  useEffect(() => {
    preflightModelRef.current = settings.preflightModel;
  }, [settings.preflightModel]);

  useEffect(() => {
    onSessionChangeRef.current = onSessionChange;
  }, [onSessionChange]);

  useEffect(() => {
    preflightStatusRef.current = preflightState.status;
  }, [preflightState.status]);

  const sendResize = useCallback(async () => {
    const id = sessionIdRef.current;
    const term = termRef.current;
    const container = containerRef.current;
    if (!id || !term || !container) {
      return;
    }

    try {
      await invoke("resize_pty", {
        request: {
          session_id: id,
          cols: term.cols,
          rows: term.rows,
          pixel_width: Math.round(container.clientWidth),
          pixel_height: Math.round(container.clientHeight),
        },
      });
    } catch (error) {
      console.error("Failed to resize PTY", error);
    }
  }, []);

  const queueResize = useCallback(() => {
    if (resizeFrameRef.current) {
      cancelAnimationFrame(resizeFrameRef.current);
    }
    resizeFrameRef.current = requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      sendResize().catch((error) => console.error(error));
    });
  }, [sendResize]);

  useEffect(() => {
    activeRef.current = active;
    if (active) {
      // Regaining the foreground tab: re-sync dimensions and take keyboard focus.
      queueResize();
      termRef.current?.focus();
    }
  }, [active, queueResize]);

  const sendToPty = useCallback((payload: string) => {
    const id = sessionIdRef.current;
    if (!id) {
      return;
    }
    invoke("write_to_pty", {
      request: {
        session_id: id,
        data: payload,
      },
    }).catch((error) => console.error("write_to_pty failed", error));
  }, []);

  const resetPreflight = useCallback(() => {
    setPreflightState({ status: "hidden", command: "" });
  }, []);

  const triggerContextRefresh = useCallback(() => {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("termalime:refresh-context"));
    }, 100);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("termalime:refresh-context"));
    }, 400);
  }, []);

  const updateCommandBuffer = useCallback((chunk: string) => {
    for (const char of chunk) {
      if (char === "\r" || char === "\n") {
        commandBufferRef.current = "";
        continue;
      }
      if (char === "\u0003" || char === "\u0015") {
        commandBufferRef.current = "";
        continue;
      }
      if (char === "\u007f" || char === "\u0008") {
        commandBufferRef.current = commandBufferRef.current.slice(0, -1);
        continue;
      }
      if (char === "\u001b") {
        commandBufferRef.current = "";
        continue;
      }
      if (char >= " " && char !== "\u007f") {
        commandBufferRef.current += char;
      }
    }
  }, []);

  const startPreflightCheck = useCallback(
    (command: string, onAllow?: () => void) => {
      const model = preflightModelRef.current?.trim();
      if (IS_DEV) {
        console.debug("[preflight] analyzing command", { command, model });
      }

      pendingPreflightActionRef.current = onAllow ?? (() => sendToPty("\r"));

      setPreflightState({ status: "analyzing", command });
      let finished = false;
      const analysisTimeout = window.setTimeout(() => {
        if (finished) {
          return;
        }
        finished = true;
        if (IS_DEV) {
          console.warn("[preflight] analysis timed out", command);
        }
        setPreflightState({
          status: "error",
          command,
          message: "Analysis timed out. Cancel or run manually.",
        });
      }, 7000);

      invoke<AnalyzeCommandResponse>("analyze_command", {
        request: { command, model: model || undefined },
      })
        .then((response) => {
          if (finished) {
            return;
          }
          finished = true;
          window.clearTimeout(analysisTimeout);
          if (IS_DEV) {
            console.debug("[preflight] analyze_command response", response);
          }

          if (response.action === "run") {
            commandBufferRef.current = "";
            pendingPreflightActionRef.current?.();
            pendingPreflightActionRef.current = null;
            resetPreflight();
            triggerContextRefresh();
            return;
          }

          if (response.action === "review") {
            setPreflightState({
              status: "review",
              command,
              report: response.report,
              message: response.message,
            });
            return;
          }

          setPreflightState({
            status: "error",
            command,
            message: response.message ?? "Unable to analyze the command.",
          });
        })
        .catch((error) => {
          if (finished) {
            return;
          }
          finished = true;
          window.clearTimeout(analysisTimeout);
          if (IS_DEV) {
            console.error("[preflight] analyze_command failed", error);
          }
          setPreflightState({
            status: "error",
            command,
            message:
              typeof error === "string"
                ? error
                : (error as { message?: string }).message ?? "Unknown analysis failure.",
          });
        });
    },
    [resetPreflight, sendToPty],
  );

  const handlePreflightCancel = useCallback(() => {
    commandBufferRef.current = "";
    sendToPty("\u0003");
    pendingPreflightActionRef.current = null;
    resetPreflight();
  }, [resetPreflight, sendToPty]);

  const handlePreflightRun = useCallback(() => {
    commandBufferRef.current = "";
    const action = pendingPreflightActionRef.current ?? (() => sendToPty("\r"));
    pendingPreflightActionRef.current = null;
    action();
    resetPreflight();
    triggerContextRefresh();
  }, [resetPreflight, sendToPty, triggerContextRefresh]);

  const handlePastedCommand = useCallback(
    (raw: string) => {
      const preflightEnabled = preflightEnabledRef.current;
      const busy = preflightStatusRef.current !== "hidden";
      if (busy) {
        if (IS_DEV) {
          console.debug("[preflight] ignoring paste while modal active");
        }
        return;
      }

      const normalized = raw.replace(/\r/g, "\n");
      const trimmed = normalized
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" && ");

      if (!trimmed) {
        return;
      }

      const forwardToPty = () => {
        updateCommandBuffer(normalized);
        sendToPty(normalized);
        if (normalized.includes("\n") || normalized.includes("\r")) {
          triggerContextRefresh();
        }
      };

      if (!preflightEnabled) {
        forwardToPty();
        return;
      }

      startPreflightCheck(trimmed, forwardToPty);
    },
    [sendToPty, startPreflightCheck, updateCommandBuffer],
  );

  const handleExplainTerminal = useCallback(async () => {
    try {
      // 1. First priority: any text currently highlighted/selected by the user
      let lines = termRef.current?.getSelection()?.trim() || "";

      // 2. Second priority: rendered visible lines directly from active xterm buffer
      if (!lines && termRef.current) {
        const buf = termRef.current.buffer.active;
        const totalRows = buf.baseY + buf.cursorY;
        const collected: string[] = [];
        const start = Math.max(0, totalRows - 40);
        for (let y = start; y <= totalRows; y++) {
          const line = buf.getLine(y);
          if (line) {
            const str = line.translateToString(true);
            if (str.trim().length > 0) {
              collected.push(str);
            }
          }
        }
        lines = collected.slice(-30).join("\n").trim();
      }

      // 3. Third priority: backend snapshot context
      const id = sessionIdRef.current;
      if (!lines && id) {
        try {
          const context = await invoke<{ session_id: string; last_lines: string }>("get_terminal_context", {
            session_id: id,
            max_lines: 40,
          });
          lines = context.last_lines?.trim() || "";
        } catch (e) {
          console.warn("Backend terminal context fallback error:", e);
        }
      }

      if (!lines) {
        lines = "No recent terminal output available to inspect.";
      }

      if (!settings.showChat) {
        updateSettings({ showChat: true });
        // Give React a frame to mount Chatbot if it was closed
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      const prompt = `Please analyze the following recent terminal output. Explain any errors or failure causes, and provide the exact command to fix or proceed:\n\n\`\`\`\n${lines}\n\`\`\``;
      window.dispatchEvent(
        new CustomEvent("termalime:ask-assistant", {
          detail: { prompt, autoSend: true },
        })
      );
    } catch (err) {
      console.error("Failed to fetch terminal context for explanation", err);
    }
  }, [settings.showChat, updateSettings]);

  const findNext = useCallback(() => {
    if (!searchQuery) return;
    searchAddonRef.current?.findNext(searchQuery, {
      caseSensitive: searchCaseSensitive,
      incremental: false,
    });
  }, [searchQuery, searchCaseSensitive]);

  const findPrevious = useCallback(() => {
    if (!searchQuery) return;
    searchAddonRef.current?.findPrevious(searchQuery, {
      caseSensitive: searchCaseSensitive,
    });
  }, [searchQuery, searchCaseSensitive]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    searchAddonRef.current?.clearDecorations();
    termRef.current?.focus();
  }, []);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (val) {
      searchAddonRef.current?.findNext(val, {
        caseSensitive: searchCaseSensitive,
        incremental: true,
      });
    } else {
      searchAddonRef.current?.clearDecorations();
    }
  };

  const handleExplainTerminalRef = useRef(handleExplainTerminal);
  useEffect(() => {
    handleExplainTerminalRef.current = handleExplainTerminal;
  }, [handleExplainTerminal]);

  useEffect(() => {
    const handleRunCommand = (event: Event) => {
      if (!activeRef.current) {
        // Only the visible tab should execute app-wide command requests.
        return;
      }
      const customEvent = event as CustomEvent<string>;
      const command = customEvent.detail;
      if (!command) {
        return;
      }

      const normalized = command.replace(/\r/g, "\n");
      const trimmed = normalized
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" && ");

      const forwardToPty = () => {
        updateCommandBuffer(normalized + "\r");
        sendToPty(normalized + "\r");
      };

      if (!preflightEnabledRef.current) {
        forwardToPty();
        return;
      }

      startPreflightCheck(trimmed, forwardToPty);
    };

    const handleInsertCommand = (event: Event) => {
      if (!activeRef.current) return;
      const customEvent = event as CustomEvent<string>;
      const command = customEvent.detail;
      if (!command) return;
      updateCommandBuffer(command);
      sendToPty(command);
      termRef.current?.focus();
    };

    const handleExplainEvent = (event: Event) => {
      const custom = event as CustomEvent<{ sessionId?: string | null }>;
      const targetSession = custom?.detail?.sessionId;
      if (targetSession ? targetSession === sessionIdRef.current : activeRef.current) {
        void handleExplainTerminalRef.current();
      }
    };

    window.addEventListener("termalime:run-command", handleRunCommand);
    window.addEventListener("termalime:insert-command", handleInsertCommand);
    window.addEventListener("termalime:explain-terminal", handleExplainEvent);
    return () => {
      window.removeEventListener("termalime:run-command", handleRunCommand);
      window.removeEventListener("termalime:insert-command", handleInsertCommand);
      window.removeEventListener("termalime:explain-terminal", handleExplainEvent);
    };
  }, [sendToPty, startPreflightCheck, updateCommandBuffer]);

  useEffect(() => {
    let active = true;
    let spawnedSessionId: string | null = null;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: settings.cursorBlink ?? true,
      cursorStyle: settings.cursorStyle || "block",
      fontFamily: settings.terminalFontFamily || '"JetBrains Mono", "Fira Code", monospace',
      fontSize: settings.terminalFontSize,
      lineHeight: settings.terminalLineHeight || 1.2,
      letterSpacing: 0.5,
      scrollback: settings.scrollback || 5000,
      rows: 24,
      cols: 80,
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown") {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 50);
          return false;
        }
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "e") {
          event.preventDefault();
          void handleExplainTerminalRef.current();
          return false;
        }
      }
      return true;
    });

    if (containerRef.current) {
      term.open(containerRef.current);
      fitAddon.fit();
    }

    const disposeData = term.onData((data) => {
      const preflightBusy = preflightStatusRef.current !== "hidden";

      if (preflightBusy) {
        if (IS_DEV) {
          console.debug("[preflight] blocking user input while modal active", { data });
        }
        if (data === "\u0003") {
          handlePreflightCancel();
        }
        return;
      }

      updateCommandBuffer(data);
      sendToPty(data);

      if (data.includes("\r") || data.includes("\n")) {
        triggerContextRefresh();
      }
    });

    const disposeSelection = term.onSelectionChange(() => {
      if (copyOnSelectRef.current && term.hasSelection()) {
        const text = term.getSelection();
        if (text && text.trim().length > 0) {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      }
    });

    const handleDomPaste = (event: ClipboardEvent) => {
      const chunk = event.clipboardData?.getData("text");
      if (!chunk) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handlePastedCommand(chunk);
    };

    const containerEl = containerRef.current;
    containerEl?.addEventListener("paste", handleDomPaste, true);

    const observer = new ResizeObserver(() => queueResize());
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    const connect = async () => {
      setStatus("connecting");
      try {
        const id = await invoke<string>("spawn_pty", {
          request: initialCwd ? { cwd: initialCwd } : undefined,
        });
        if (!active) {
          invoke("close_pty", { session_id: id }).catch((err) =>
            console.error("Failed to close PTY session:", err)
          );
          return;
        }
        spawnedSessionId = id;
        sessionIdRef.current = id;
        onSessionChangeRef.current?.(id);
        setStatus("ready");
        fitAddon.fit();
        await sendResize();
        term.focus();
      } catch (error) {
        if (active) {
          console.error(error);
          setStatus("error");
          term.writeln(`\r\n[Error] ${String(error)}\r\n`);
        }
      }
    };

    connect().catch((error) => console.error(error));

    return () => {
      active = false;
      disposeData.dispose();
      disposeSelection.dispose();
      containerEl?.removeEventListener("paste", handleDomPaste, true);
      observer.disconnect();
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      onSessionChangeRef.current?.(null);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      sessionIdRef.current = null;
      
      if (spawnedSessionId) {
        invoke("close_pty", { session_id: spawnedSessionId }).catch((error) =>
          console.error("Failed to close PTY session on unmount", error),
        );
      }
    };
    // All of these callbacks are stable (their dependency chains bottom out in
    // refs), so this effect runs exactly once: the terminal and its PTY must
    // never be torn down by a settings change.
  }, [
    handlePreflightCancel,
    handlePastedCommand,
    queueResize,
    sendResize,
    sendToPty,
    updateCommandBuffer,
  ]);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;

    const attach = async () => {
      const unsub = await listen<TerminalOutputPayload>("terminal-output", (event) => {
        if (!active) {
          return;
        }
        if (event.payload.session_id !== sessionIdRef.current) {
          return;
        }
        termRef.current?.write(event.payload.data);
      });

      if (!active) {
        unsub();
      } else {
        unlisten = unsub;
      }
    };

    attach().catch((error) => console.error(error));

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!termRef.current) {
      return;
    }
    termRef.current.options.fontSize = settings.terminalFontSize;
    termRef.current.options.fontFamily = settings.terminalFontFamily || '"JetBrains Mono", "Fira Code", monospace';
    termRef.current.options.lineHeight = settings.terminalLineHeight || 1.2;
    termRef.current.options.cursorStyle = settings.cursorStyle || "block";
    termRef.current.options.cursorBlink = settings.cursorBlink ?? true;
    termRef.current.options.scrollback = settings.scrollback || 5000;
    termRef.current.refresh(0, termRef.current.rows - 1);
    queueResize();
  }, [
    queueResize,
    settings.terminalFontSize,
    settings.terminalFontFamily,
    settings.terminalLineHeight,
    settings.cursorStyle,
    settings.cursorBlink,
    settings.scrollback,
  ]);

  const preflightIndicatorTone =
    preflightState.status === "analyzing"
      ? "preflight-indicator preflight-indicator--busy"
      : preflightState.status === "review" || preflightState.status === "error"
        ? "preflight-indicator preflight-indicator--alert"
        : "preflight-indicator preflight-indicator--ready";

  const preflightIndicatorLabel =
    preflightState.status === "analyzing"
      ? "Preflight scanning"
      : preflightState.status === "review"
        ? "Review required"
        : preflightState.status === "error"
          ? "Preflight paused"
          : "Preflight armed";

  const preflightIndicatorIcon =
    preflightState.status === "analyzing" ? (
      <Loader2 size={13} className="icon-spin" />
    ) : preflightState.status === "review" || preflightState.status === "error" ? (
      <ShieldAlert size={13} />
    ) : (
      <ShieldCheck size={13} />
    );

  return (
    <div className="terminal-pane">
      {settings.preflightCheck && (
        <div className="terminal-pane__preflight">
          <div className={preflightIndicatorTone}>
            {preflightIndicatorIcon}
            <span>{preflightIndicatorLabel}</span>
          </div>
        </div>
      )}
      {searchOpen && (
        <div className="terminal-search-bar" role="search">
          <Search size={13} className="terminal-search-bar__icon" />
          <input
            ref={searchInputRef}
            type="text"
            className="terminal-search-bar__input"
            placeholder="Find in terminal..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) findPrevious();
                else findNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button
            type="button"
            className={clsx(
              "terminal-search-bar__btn",
              searchCaseSensitive && "terminal-search-bar__btn--active"
            )}
            onClick={() => setSearchCaseSensitive(!searchCaseSensitive)}
            title="Match Case"
          >
            Aa
          </button>
          <button
            type="button"
            className="terminal-search-bar__btn"
            onClick={findPrevious}
            title="Previous Match (Shift+Enter)"
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            className="terminal-search-bar__btn"
            onClick={findNext}
            title="Next Match (Enter)"
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            className="terminal-search-bar__btn"
            onClick={closeSearch}
            title="Close (Escape)"
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div ref={containerRef} className="terminal-host" />
      {status === "error" && (
        <div className="panel-overlay panel-overlay--error">
          <p>Unable to start the system shell.</p>
          <p>Check Tauri logs for more details.</p>
        </div>
      )}
      <PreflightModal
        command={preflightState.command}
        status={preflightState.status}
        report={preflightState.report}
        message={preflightState.message}
        onCancel={handlePreflightCancel}
        onRunAnyway={handlePreflightRun}
      />
    </div>
  );
};

export default Terminal;
