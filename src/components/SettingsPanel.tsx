import { MouseEvent, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Settings2, X } from "lucide-react";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import { PERSONA_DESCRIPTIONS, useSettings } from "../state/settings";

const personaOrder = ["helpful", "concise", "neutral", "playful"] as const;

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { settings, updateSettings, resetSettings } = useSettings();
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const preflightModelRef = useRef(settings.preflightModel);
  const preferredDefault = "gemma3:270m";

  useEffect(() => {
    preflightModelRef.current = settings.preflightModel;
  }, [settings.preflightModel]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    invoke<string[]>("list_ollama_models")
      .then((models) => {
        if (cancelled) {
          return;
        }
        setModelOptions(models);
        setModelsError(null);
        const current = preflightModelRef.current?.trim();
        if (current && models.includes(current)) {
          return;
        }
        if (models.includes(preferredDefault)) {
          preflightModelRef.current = preferredDefault;
          updateSettings({ preflightModel: preferredDefault });
          return;
        }
        if (models.length > 0 && current !== models[0]) {
          preflightModelRef.current = models[0];
          updateSettings({ preflightModel: models[0] });
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message =
          typeof error === "string" ? error : "Unable to fetch local Ollama models.";
        setModelsError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModels(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, updateSettings]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="settings-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.div
            className="settings-panel"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
          >
            <header className="settings-panel__header">
              <div>
                <p className="settings-panel__eyebrow">Control room</p>
                <h2>Termalime settings</h2>
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close settings">
                <X size={18} />
              </button>
            </header>

            <section className="settings-section">
              <div className="settings-section__label">
                <p>Terminal font size</p>
                <span>{settings.terminalFontSize}px</span>
              </div>
              <input
                type="range"
                min={10}
                max={22}
                value={settings.terminalFontSize}
                onChange={(event) => updateSettings({ terminalFontSize: Number(event.currentTarget.value) })}
              />
            </section>

            <section className="settings-grid">
              <ToggleCard
                title="Show chat panel"
                description="Hide when you want a distraction-free terminal."
                active={settings.showChat}
                onToggle={() => updateSettings({ showChat: !settings.showChat })}
              />
              <ToggleCard
                title="Attach terminal snapshot"
                description="Send tail output with prompts so the assistant understands context."
                active={settings.includeTerminalContext}
                onToggle={() => updateSettings({ includeTerminalContext: !settings.includeTerminalContext })}
              />
              <ToggleCard
                title="Preflight check commands"
                description="Intercept risky commands, run heuristics, and escalate to the AI before execution."
                active={settings.preflightCheck}
                onToggle={() => updateSettings({ preflightCheck: !settings.preflightCheck })}
              />
            </section>

            <section className="settings-section">
              <div className="settings-section__label">
                <p>Preflight model</p>
                <span>Choose which Ollama model analyzes intercepted commands.</span>
              </div>
              <select
                value={settings.preflightModel}
                onChange={(event) => updateSettings({ preflightModel: event.currentTarget.value })}
                disabled={modelOptions.length === 0}
              >
                {modelOptions.length === 0 ? (
                  <option value="" disabled>
                    No local models detected
                  </option>
                ) : (
                  modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))
                )}
              </select>
              {loadingModels && <span className="settings-hint">Detecting local Ollama models…</span>}
              {modelsError && <span className="settings-hint settings-hint--error">{modelsError}</span>}
            </section>

            <section className="settings-section">
              <div className="settings-section__label">
                <p>Persona</p>
                <span>Choose the assistant’s tone</span>
              </div>
              <div className="persona-row">
                {personaOrder.map((persona) => (
                  <button
                    key={persona}
                    className={clsx("persona-pill", persona === settings.persona && "persona-pill--active")}
                    onClick={() => updateSettings({ persona })}
                  >
                    <div>
                      <p className="persona-pill__title">{persona.charAt(0).toUpperCase() + persona.slice(1)}</p>
                      <p className="persona-pill__desc">{PERSONA_DESCRIPTIONS[persona]}</p>
                    </div>
                    {persona === settings.persona && <Check size={16} />}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section__label">
                <p>System prompt</p>
                <span>Give Termalime a mission statement.</span>
              </div>
              <textarea
                value={settings.systemPrompt}
                rows={4}
                onChange={(event) => updateSettings({ systemPrompt: event.currentTarget.value })}
              />
            </section>

            <footer className="settings-panel__footer">
              <button className="text-btn" onClick={resetSettings}>
                Reset to defaults
              </button>
              <span className="settings-panel__hint">Changes save instantly.</span>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface ToggleCardProps {
  title: string;
  description: string;
  active: boolean;
  onToggle: () => void;
}

const ToggleCard = ({ title, description, active, onToggle }: ToggleCardProps) => (
  <button className={clsx("toggle-card", active && "toggle-card--active")} onClick={onToggle}>
    <div>
      <p className="toggle-card__title">{title}</p>
      <p className="toggle-card__desc">{description}</p>
    </div>
    <span className={clsx("toggle-card__switch", active && "toggle-card__switch--on")}></span>
  </button>
);

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="settings-fab" onClick={onClick}>
      <Settings2 size={18} />
      <span>Settings</span>
    </button>
  );
}
