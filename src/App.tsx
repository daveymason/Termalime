import { useEffect } from "react";
import "./App.css";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Chatbot from "./components/Chatbot";
import Terminal from "./components/Terminal";

function App() {
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
            <Terminal />
          </Panel>
          <PanelResizeHandle className={handleClass} />
          <Panel minSize={chatMin} defaultSize={chatDefault} order={2}>
            <Chatbot />
          </Panel>
        </PanelGroup>
      </main>
    </div>
  );
}

export default App;
