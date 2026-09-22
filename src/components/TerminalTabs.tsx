import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Terminal from "./Terminal";

type TerminalTab = {
  id: number;
  label: string;
  initialCwd?: string | null;
};

type TerminalTabsProps = {
  onActiveSessionChange?: (sessionId: string | null) => void;
};

const TerminalTabs = ({ onActiveSessionChange }: TerminalTabsProps) => {
  const [tabs, setTabs] = useState<TerminalTab[]>([{ id: 1, label: "Term 1" }]);
  const [activeId, setActiveId] = useState(1);
  const [editingTabId, setEditingTabId] = useState<number | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const nextTabIdRef = useRef(2);
  // Session ids arrive asynchronously (after each PTY spawns), and unmount
  // cleanups fire after state updates, so track open tabs and the active id
  // in refs to keep those callbacks in sync with the latest close/switch.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const sessionsRef = useRef(new Map<number, string | null>());

  const activate = (tabId: number) => {
    activeIdRef.current = tabId;
    setActiveId(tabId);
    onActiveSessionChange?.(sessionsRef.current.get(tabId) ?? null);
  };

  const handleSessionChange = (tabId: number, sessionId: string | null) => {
    if (!tabsRef.current.some((tab) => tab.id === tabId)) {
      // A closed tab unmounting; its PTY teardown is already underway.
      return;
    }
    sessionsRef.current.set(tabId, sessionId);
    if (tabId === activeIdRef.current) {
      onActiveSessionChange?.(sessionId);
    }
  };

  const addTab = async () => {
    let currentCwd: string | null = null;
    try {
      const activeSession = sessionsRef.current.get(activeIdRef.current);
      const sys = await invoke<{ cwd: string | null }>("get_system_context", {
        session_id: activeSession,
      });
      if (sys?.cwd) {
        currentCwd = sys.cwd;
      }
    } catch {
      // fallback to default cwd
    }

    const id = nextTabIdRef.current++;
    const next = [...tabs, { id, label: `Term ${id}`, initialCwd: currentCwd }];
    tabsRef.current = next;
    setTabs(next);
    activate(id);
  };

  const closeTab = (tabId: number) => {
    if (tabs.length <= 1) {
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const next = tabs.filter((tab) => tab.id !== tabId);
    tabsRef.current = next;
    sessionsRef.current.delete(tabId);
    setTabs(next);
    if (activeIdRef.current === tabId) {
      activate(next[Math.min(index, next.length - 1)].id);
    }
  };

  const handleSaveRename = (tabId: number) => {
    const trimmed = editingLabel.trim();
    if (trimmed) {
      setTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? { ...tab, label: trimmed } : tab))
      );
    }
    setEditingTabId(null);
  };

  return (
    <div className="terminal-tabs">
      <div className="terminal-tabs__bar" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className={
              tab.id === activeId ? "terminal-tab terminal-tab--active" : "terminal-tab"
            }
            onClick={() => activate(tab.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingTabId(tab.id);
              setEditingLabel(tab.label);
            }}
          >
            {editingTabId === tab.id ? (
              <input
                type="text"
                className="terminal-tab__rename-input"
                value={editingLabel}
                autoFocus
                onChange={(e) => setEditingLabel(e.target.value)}
                onBlur={() => handleSaveRename(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSaveRename(tab.id);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingTabId(null);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span title="Double-click to rename">{tab.label}</span>
            )}
            {tabs.length > 1 && (
              <span
                className="terminal-tab__close"
                role="button"
                aria-label={`Close ${tab.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={12} />
              </span>
            )}
          </div>
        ))}
        <button
          type="button"
          className="terminal-tab terminal-tab--add"
          aria-label="New terminal tab"
          title="New terminal tab (inherits current directory)"
          onClick={addTab}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="terminal-tabs__panes">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={
              tab.id === activeId
                ? "terminal-tabs__pane terminal-tabs__pane--active"
                : "terminal-tabs__pane"
            }
          >
            <Terminal
              active={tab.id === activeId}
              initialCwd={tab.initialCwd}
              onSessionChange={(sessionId) => handleSessionChange(tab.id, sessionId)}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default TerminalTabs;
