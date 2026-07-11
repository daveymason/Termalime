import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
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
  background: "#05060a",
  foreground: "#f5f7fa",
  cursor: "#7dd3fc",
};

type TerminalProps = {
  onSessionChange?: (sessionId: string | null) => void;
  /** Whether this terminal is the visible tab; inactive tabs stay mounted but ignore app-wide commands. */
  active?: boolean;
};

const Terminal = ({ onSessionChange, active = true }: TerminalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const { settings } = useSettings();
  const commandBufferRef = useRef<string>("");
  const preflightEnabledRef = useRef(settings.preflightCheck);
  const preflightModelRef = useRef(settings.preflightModel);
  const onSessionChangeRef = useRef(onSessionChange);
  const [preflightState, setPreflightState] = useState<PreflightState>({
    status: "hidden",
    command: "",
  });
  const preflightStatusRef = useRef<PreflightStatus>("hidden");
  const pendingPreflightActionRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);

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
  }, [resetPreflight, sendToPty]);

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
      };

      if (!preflightEnabled) {
        forwardToPty();
        return;
      }

      startPreflightCheck(trimmed, forwardToPty);
    },
    [sendToPty, startPreflightCheck, updateCommandBuffer],
  );

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

    window.addEventListener("termalime:run-command", handleRunCommand);
    return () => {
      window.removeEventListener("termalime:run-command", handleRunCommand);
    };
  }, [sendToPty, startPreflightCheck, updateCommandBuffer]);

  useEffect(() => {
    let active = true;
    let spawnedSessionId: string | null = null;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: settings.terminalFontSize,
      letterSpacing: 0.5,
      rows: 24,
      cols: 80,
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

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
        const id = await invoke<string>("spawn_pty");
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
      containerEl?.removeEventListener("paste", handleDomPaste, true);
      observer.disconnect();
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      onSessionChangeRef.current?.(null);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      sessionIdRef.current = null;
      
      if (spawnedSessionId) {
        invoke("close_pty", { session_id: spawnedSessionId }).catch((err) =>
          console.error("Failed to close PTY session:", err)
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
    termRef.current.refresh(0, termRef.current.rows - 1);
    queueResize();
  }, [queueResize, settings.terminalFontSize]);

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
    <section className="panel panel--terminal">
      {settings.preflightCheck && (
        <header className="panel-header panel-header--stacked" style={{ borderBottom: "none", paddingBottom: 0, justifyContent: "flex-end", flexDirection: "row" }}>
          <div style={{ marginLeft: "auto" }}>
            <div className={preflightIndicatorTone}>
              {preflightIndicatorIcon}
              <span>{preflightIndicatorLabel}</span>
            </div>
          </div>
        </header>
      )}
      <div className="panel-content panel-content--terminal">
        <div ref={containerRef} className="terminal-host" />
        {status === "error" && (
          <div className="panel-overlay panel-overlay--error">
            <p>Unable to start the system shell.</p>
            <p>Check Tauri logs for more details.</p>
          </div>
        )}
      </div>
      <PreflightModal
        command={preflightState.command}
        status={preflightState.status}
        report={preflightState.report}
        message={preflightState.message}
        onCancel={handlePreflightCancel}
        onRunAnyway={handlePreflightRun}
      />
    </section>
  );
};

export default Terminal;
