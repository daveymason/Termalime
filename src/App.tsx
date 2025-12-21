import { useEffect, useState } from "react";
import "./App.css";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Chatbot from "./components/Chatbot";
import Terminal from "./components/Terminal";
import { SettingsPanel } from "./components/SettingsPanel";
import ContextBar from "./components/ContextBar";
import { useSettings } from "./state/settings";

function App() {
  const { settings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  useEffect(() => {
    const splash = document.getElementById("splash");
    if (!splash) return;

    splash.classList.add("splash-hide");
    const timeout = window.setTimeout(() => splash.remove(), 600);

    return () => window.clearTimeout(timeout);
  }, []);

  const direction: "horizontal" = "horizontal";
  const terminalDefault = 65;
  const chatDefault = 35;
  const terminalMin = 55;
  const chatMin = 30;
  const handleClass = "resize-handle";

  return (
    <div className="app-shell">
      <main className="app-main">
        <PanelGroup
          direction={direction}
          className="app-panels"
          autoSaveId="Termalime-layout"
          style={{ height: "100%", width: "100%" }}
        >
          <Panel minSize={terminalMin} defaultSize={terminalDefault} order={1}>
            <Terminal onSessionChange={setTerminalSessionId} />
          </Panel>
          {settings.showChat && (
            <>
              <PanelResizeHandle className={handleClass} />
              <Panel minSize={chatMin} defaultSize={chatDefault} order={2}>
                <Chatbot sessionId={terminalSessionId ?? undefined} />
              </Panel>
            </>
          )}
        </PanelGroup>
      </main>
      <ContextBar 
        onSettingsClick={() => setSettingsOpen(true)} 
        sessionId={terminalSessionId}
      />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
