import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import Terminal from "./Terminal";

type TerminalTab = {
  id: number;
  label: string;
};

type TerminalTabsProps = {
  onActiveSessionChange?: (sessionId: string | null) => void;
};

const TerminalTabs = ({ onActiveSessionChange }: TerminalTabsProps) => {
  const [tabs, setTabs] = useState<TerminalTab[]>([{ id: 1, label: "Term 1" }]);
  const [activeId, setActiveId] = useState(1);
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

  const addTab = () => {
    const id = nextTabIdRef.current++;
    const next = [...tabs, { id, label: `Term ${id}` }];
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

  return (
    <div className="terminal-tabs">
      <div className="terminal-tabs__bar" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            className={
              tab.id === activeId ? "terminal-tab terminal-tab--active" : "terminal-tab"
            }
            onClick={() => activate(tab.id)}
          >
            <span>{tab.label}</span>
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
          </button>
        ))}
        <button
          type="button"
          className="terminal-tab terminal-tab--add"
          aria-label="New terminal tab"
          title="New terminal tab"
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
              onSessionChange={(sessionId) => handleSessionChange(tab.id, sessionId)}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default TerminalTabs;
