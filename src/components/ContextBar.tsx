import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Cpu,
  Droplets,
  GitBranch,
  Leaf,
  MemoryStick,
  Monitor,
  Network,
  Settings2,
  Terminal as TerminalIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import CommandsButton from "./CommandsPanel";
import { formatCo2, formatWater, useEco } from "../state/eco";

interface ContextBarProps {
  onSettingsClick: () => void;
  sessionId?: string | null;
}

interface SystemContext {
  hostname: string | null;
  username: string | null;
  localIp: string | null;
  gitBranch: string | null;
  cwd: string | null;
  shell: string | null;
  cpuUsage?: number;
  memoryUsage?: number;
}

const ContextBar = ({ onSettingsClick, sessionId }: ContextBarProps) => {
  const [context, setContext] = useState<SystemContext>({
    hostname: null,
    username: null,
    localIp: null,
    gitBranch: null,
    cwd: null,
    shell: null,
  });

  const fetchContext = useCallback(async () => {
    try {
      const data = await invoke<SystemContext>("get_system_context", {
        session_id: sessionId,
      });
      setContext(data);
    } catch (error) {
      console.warn("Failed to fetch system context:", error);
    }
  }, [sessionId]);

  // Poll for context updates; skip ticks while the window is hidden so a
  // backgrounded app doesn't keep burning CPU on polling.
  useEffect(() => {
    fetchContext();
    const interval = setInterval(() => {
      if (!document.hidden) {
        fetchContext();
      }
    }, 5000); // Update every 5 seconds
    return () => clearInterval(interval);
  }, [fetchContext]);

  const { session, lifetime } = useEco();

  return (
    <footer className="context-bar">
      <div className="context-bar__section context-bar__section--buttons">
        <button className="context-btn" onClick={onSettingsClick}>
          <Settings2 size={14} />
          <span>Settings</span>
        </button>
        <CommandsButton onRunCommand={(cmd) => window.dispatchEvent(new CustomEvent("termalime:run-command", { detail: cmd }))} />
      </div>

      <div className="context-bar__divider" />

      <div className="context-bar__section context-bar__section--meta">
        {context.gitBranch && (
          <div className="context-item" title="Git branch">
            <GitBranch size={13} />
            <span>{context.gitBranch}</span>
          </div>
        )}

        {context.hostname && (
          <div className="context-item" title="Hostname">
            <Monitor size={13} />
            <span>{context.hostname}</span>
          </div>
        )}

        {context.username && (
          <div className="context-item context-item--muted" title="User">
            <span>@{context.username}</span>
          </div>
        )}

        {context.localIp && (
          <div className="context-item" title="Local IP">
            <Network size={13} />
            <span>{context.localIp}</span>
          </div>
        )}

        {context.shell && (
          <div className="context-item" title="Shell">
            <TerminalIcon size={13} />
            <span>{context.shell}</span>
          </div>
        )}
      </div>

      {(context.cpuUsage !== undefined || context.memoryUsage !== undefined) && (
        <>
          <div className="context-bar__divider" />
          <div className="context-bar__section context-bar__section--sys">
            {context.cpuUsage !== undefined && (
              <div className="context-item" title={`CPU Usage: ${context.cpuUsage.toFixed(1)}%`}>
                <Cpu size={13} />
                <span>{context.cpuUsage.toFixed(0)}%</span>
              </div>
            )}

            {context.memoryUsage !== undefined && (
              <div className="context-item" title={`Memory Usage: ${context.memoryUsage.toFixed(1)}%`}>
                <MemoryStick size={13} />
                <span>{context.memoryUsage.toFixed(0)}%</span>
              </div>
            )}

            <div
              className="context-item context-item--eco"
              title={`CO₂ saved by running locally instead of a cloud LLM — session: ${formatCo2(
                session.co2G,
              )} (${session.requests} requests), all time: ${formatCo2(lifetime.co2G)}`}
            >
              <Leaf size={13} />
              <span>{formatCo2(session.co2G)}</span>
            </div>

            <div
              className="context-item context-item--eco"
              title={`Water saved by running locally instead of a cloud LLM — session: ${formatWater(
                session.waterMl,
              )}, all time: ${formatWater(lifetime.waterMl)}`}
            >
              <Droplets size={13} />
              <span>{formatWater(session.waterMl)}</span>
            </div>
          </div>
        </>
      )}

      {context.cwd && (
        <div className="context-bar__section context-bar__section--path">
          <span className="context-path" title={context.cwd}>
            {context.cwd}
          </span>
          <button
            className="context-copy-btn"
            title="Copy path"
            onClick={() => navigator.clipboard.writeText(context.cwd!)}
          >
            <Copy size={12} />
          </button>
        </div>
      )}
    </footer>
  );
};

export default ContextBar;
