import { MouseEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  Check,
  Cpu,
  Loader2,
  RefreshCcw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import clsx from "clsx";

interface ModelSelectorModalProps {
  open: boolean;
  onClose: () => void;
  models: string[];
  selectedModel: string;
  onSelectModel: (model: string) => void;
  onRefresh: () => Promise<void>;
  loading: boolean;
  ollamaOnline: boolean | null;
  ollamaHost?: string;
}

export function ModelSelectorModal({
  open,
  onClose,
  models,
  selectedModel,
  onSelectModel,
  onRefresh,
  loading,
  ollamaOnline,
  ollamaHost = "http://127.0.0.1:11434",
}: ModelSelectorModalProps) {
  const [search, setSearch] = useState("");

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [models, search]);

  const modal = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="settings-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.div
            className="settings-panel model-modal-panel"
            initial={{ y: 30, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 25, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
          >
            <header className="settings-panel__header">
              <div>
                <p className="settings-panel__eyebrow">Local Ollama Runtime</p>
                <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
                  <Bot size={18} style={{ color: "rgba(163, 230, 53, 0.85)" }} />
                  <h2>Select Model</h2>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onRefresh()}
                  disabled={loading}
                  title="Refresh installed models"
                  aria-label="Refresh models"
                >
                  <RefreshCcw size={15} className={clsx(loading && "icon-spin")} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={onClose}
                  aria-label="Close model selector"
                >
                  <X size={17} />
                </button>
              </div>
            </header>

            <div className="model-modal__search-wrap">
              <Search size={14} className="model-modal__search-icon" />
              <input
                type="text"
                className="model-modal__search-input"
                placeholder="Filter models by name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              {search && (
                <button
                  type="button"
                  className="model-modal__search-clear"
                  onClick={() => setSearch("")}
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <section className="model-modal__list">
              {ollamaOnline === false && (
                <div className="model-modal__notice model-modal__notice--error">
                  <p>Ollama is currently offline.</p>
                  <span>Start the daemon via <code>ollama serve</code> to load your local models.</span>
                </div>
              )}

              {models.length === 0 && ollamaOnline !== false && !loading && (
                <div className="model-modal__notice">
                  <Terminal size={22} style={{ color: "var(--lime-neon)", opacity: 0.7 }} />
                  <p>No models detected in your Ollama library.</p>
                  <span>Run <code>ollama pull &lt;model&gt;</code> in the terminal to download one.</span>
                </div>
              )}

              {loading && models.length === 0 && (
                <div className="model-modal__notice">
                  <Loader2 size={20} className="icon-spin" style={{ color: "var(--lime-neon)" }} />
                  <p>Querying local models...</p>
                </div>
              )}

              {filteredModels.map((m) => {
                const isSelected = m === selectedModel;
                return (
                  <div
                    key={m}
                    className={clsx(
                      "model-card",
                      isSelected && "model-card--selected"
                    )}
                    onClick={() => {
                      onSelectModel(m);
                      onClose();
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectModel(m);
                        onClose();
                      }
                    }}
                  >
                    <div className="model-card__icon-badge">
                      <Cpu size={15} />
                    </div>
                    <div className="model-card__info">
                      <span className="model-card__name">{m}</span>
                      <span className="model-card__meta">
                        {isSelected ? "Active model" : "Click to activate"}
                      </span>
                    </div>
                    {isSelected && (
                      <div className="model-card__check" title="Currently selected">
                        <Check size={14} />
                        <span>Active</span>
                      </div>
                    )}
                  </div>
                );
              })}

              {models.length > 0 && filteredModels.length === 0 && (
                <p className="model-modal__empty">No models match "{search}"</p>
              )}
            </section>

            <footer className="model-modal__footer">
              <span className="model-modal__host">
                Host: <code>{ollamaHost}</code>
              </span>
              <span className="model-modal__count">
                {models.length} model{models.length === 1 ? "" : "s"} installed
              </span>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

export default ModelSelectorModal;
