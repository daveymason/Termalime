import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalStatus = "connecting" | "ready" | "error";

type TerminalOutputPayload = {
  data: string;
  session_id: string;
};

const terminalTheme: ITerminalOptions["theme"] = {
  background: "#05060a",
  foreground: "#f5f7fa",
  cursor: "#7dd3fc",
};

const Terminal = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState("Spawning PTY…");

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
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
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
      const id = sessionIdRef.current;
      if (!id) {
        return;
      }
      invoke("write_to_pty", {
        request: {
          session_id: id,
          data,
        },
      }).catch((error) => console.error("write_to_pty failed", error));
    });

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
      observer.disconnect();
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      term.dispose();
    };
  }, [queueResize, sendResize]);

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

  const statusTone =
    status === "ready"
      ? "status-dot--ready"
      : status === "error"
        ? "status-dot--error"
        : "status-dot--warning";

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
    </section>
  );
};

export default Terminal;
