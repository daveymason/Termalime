import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { SettingsProvider } from "./state/settings";
import { EcoProvider } from "./state/eco";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <EcoProvider>
        <App />
      </EcoProvider>
    </SettingsProvider>
  </React.StrictMode>,
);
