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
};

const Terminal = ({ onSessionChange }: TerminalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState("Spawning PTY…");
  const { settings } = useSettings();
  const commandBufferRef = useRef<string>("");
  const preflightEnabledRef = useRef(settings.preflightCheck);
  const [preflightState, setPreflightState] = useState<PreflightState>({
    status: "hidden",
    command: "",
  });
  const preflightStatusRef = useRef<PreflightStatus>("hidden");
  const pendingPreflightActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    preflightEnabledRef.current = settings.preflightCheck;
  }, [settings.preflightCheck]);

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
      const model = settings.preflightModel?.trim();
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
    [resetPreflight, sendToPty, settings.preflightModel],
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

    term.writeln("Connecting to local shell…\r\n");

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
      setStatusMessage("Spawning PTY…");
      try {
    const id = await invoke<string>("spawn_pty");
  sessionIdRef.current = id;
        setSessionId(id);
    onSessionChange?.(id);
        setStatus("ready");
        setStatusMessage("Connected");
        fitAddon.fit();
        await sendResize();
      } catch (error) {
        console.error(error);
        setStatus("error");
        setStatusMessage("Failed to start shell");
        term.writeln(`\r\n[Error] ${String(error)}\r\n`);
      }
    };

  connect().catch((error) => console.error(error));

    return () => {
  disposeData.dispose();
  containerEl?.removeEventListener("paste", handleDomPaste, true);
      observer.disconnect();
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      onSessionChange?.(null);
      term.dispose();
    };
  }, [
    handlePreflightCancel,
    handlePastedCommand,
    onSessionChange,
    queueResize,
    sendResize,
    sendToPty,
    updateCommandBuffer,
  ]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let unlisten: UnlistenFn | undefined;

    const attach = async () => {
      unlisten = await listen<TerminalOutputPayload>("terminal-output", (event) => {
        if (event.payload.session_id !== sessionIdRef.current) {
          return;
        }
        termRef.current?.write(event.payload.data);
      });
    };

  attach().catch((error) => console.error(error));

    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!termRef.current) {
      return;
    }
    termRef.current.options.fontSize = settings.terminalFontSize;
    termRef.current.refresh(0, termRef.current.rows - 1);
    queueResize();
  }, [queueResize, settings.terminalFontSize]);

  const statusTone =
    status === "ready"
      ? "status-dot--ready"
      : status === "error"
        ? "status-dot--error"
        : "status-dot--warning";

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
      <header className="panel-header panel-header--stacked">
        <div className="panel-heading panel-heading--stacked">
          <div className="panel-heading__title-main">
            <p className="panel-label">Terminal</p>
          </div>
          <div className="panel-subtitle panel-subtitle--status">
            <span className={`status-dot ${statusTone}`} />
            <span className="status-text">{statusMessage}</span>
          </div>
        </div>
        {settings.preflightCheck && (
          <div className={preflightIndicatorTone}>
            {preflightIndicatorIcon}
            <span>{preflightIndicatorLabel}</span>
          </div>
        )}
      </header>
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
