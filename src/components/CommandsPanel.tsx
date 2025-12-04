import { MouseEvent, useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Edit2, Play, Plus, Save, TerminalSquare, Trash2, X } from "lucide-react";
import clsx from "clsx";

interface SavedCommand {
  id: string;
  name: string;
  command: string;
  description?: string;
}

const STORAGE_KEY = "termalime-saved-commands";

const createId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);

const loadCommands = (): SavedCommand[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

const saveCommands = (commands: SavedCommand[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(commands));
};

interface CommandsPanelProps {
  open: boolean;
  onClose: () => void;
  onRunCommand?: (command: string) => void;
}

export function CommandsPanel({ open, onClose, onRunCommand }: CommandsPanelProps) {
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", command: "", description: "" });

  useEffect(() => {
    if (open) {
      setCommands(loadCommands());
    }
  }, [open]);

  const handleSave = useCallback(() => {
    if (!editForm.name.trim() || !editForm.command.trim()) return;

    setCommands((prev) => {
      let updated: SavedCommand[];
      if (editingId) {
        updated = prev.map((cmd) =>
          cmd.id === editingId
            ? { ...cmd, name: editForm.name, command: editForm.command, description: editForm.description }
            : cmd
        );
      } else {
        updated = [
          ...prev,
          {
            id: createId(),
            name: editForm.name,
            command: editForm.command,
            description: editForm.description,
          },
        ];
      }
      saveCommands(updated);
      return updated;
    });

    setEditingId(null);
    setEditForm({ name: "", command: "", description: "" });
  }, [editForm, editingId]);

  const handleEdit = (cmd: SavedCommand) => {
    setEditingId(cmd.id);
    setEditForm({ name: cmd.name, command: cmd.command, description: cmd.description || "" });
  };

  const handleDelete = (id: string) => {
    setCommands((prev) => {
      const updated = prev.filter((cmd) => cmd.id !== id);
      saveCommands(updated);
      return updated;
    });
    if (editingId === id) {
      setEditingId(null);
      setEditForm({ name: "", command: "", description: "" });
    }
  };

  const handleRun = (command: string) => {
    onRunCommand?.(command);
    onClose();
  };

  const handleAddNew = () => {
    setEditingId(null);
    setEditForm({ name: "", command: "", description: "" });
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditForm({ name: "", command: "", description: "" });
  };

  const isFormVisible = editingId !== null || (editForm.name === "" && commands.length === 0);

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
            className="settings-panel commands-panel"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
          >
            <header className="settings-panel__header">
              <div>
                <p className="settings-panel__eyebrow">Quick access</p>
                <h2>Saved Commands</h2>
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close commands">
                <X size={18} />
              </button>
            </header>

            <section className="commands-list">
              {commands.length === 0 && !editingId && (
                <p className="commands-empty">
                  No saved commands yet. Add your first command below!
                </p>
              )}

              {commands.map((cmd) => (
                <div
                  key={cmd.id}
                  className={clsx("command-card", editingId === cmd.id && "command-card--editing")}
                >
                  <div className="command-card__info">
                    <p className="command-card__name">{cmd.name}</p>
                    <code className="command-card__code">{cmd.command}</code>
                    {cmd.description && (
                      <p className="command-card__desc">{cmd.description}</p>
                    )}
                  </div>
                  <div className="command-card__actions">
                    <button
                      className="command-action command-action--run"
                      onClick={() => handleRun(cmd.command)}
                      title="Run command"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      className="command-action"
                      onClick={() => handleEdit(cmd)}
                      title="Edit command"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      className="command-action command-action--danger"
                      onClick={() => handleDelete(cmd.id)}
                      title="Delete command"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </section>

            {(isFormVisible || editingId) && (
              <section className="command-form">
                <div className="command-form__row">
                  <input
                    type="text"
                    placeholder="Command name"
                    value={editForm.name}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                  />
                </div>
                <div className="command-form__row">
                  <input
                    type="text"
                    placeholder="Command (e.g., git status)"
                    value={editForm.command}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, command: e.target.value }))}
                  />
                </div>
                <div className="command-form__row">
                  <input
                    type="text"
                    placeholder="Description (optional)"
                    value={editForm.description}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, description: e.target.value }))}
                  />
                </div>
                <div className="command-form__actions">
                  <button
                    className="command-form__btn command-form__btn--save"
                    onClick={handleSave}
                    disabled={!editForm.name.trim() || !editForm.command.trim()}
                  >
                    <Save size={14} />
                    <span>{editingId ? "Update" : "Save"}</span>
                  </button>
                  {(editingId || editForm.name || editForm.command) && (
                    <button className="command-form__btn command-form__btn--cancel" onClick={handleCancel}>
                      Cancel
                    </button>
                  )}
                </div>
              </section>
            )}

            <footer className="settings-panel__footer">
              <button className="text-btn" onClick={handleAddNew}>
                <Plus size={14} />
                <span>Add new command</span>
              </button>
              <span className="settings-panel__hint">{commands.length} saved</span>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface CommandsButtonProps {
  onRunCommand?: (command: string) => void;
}

export default function CommandsButton({ onRunCommand }: CommandsButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="context-btn" onClick={() => setOpen(true)}>
        <TerminalSquare size={14} />
        <span>Commands</span>
      </button>
      <CommandsPanel open={open} onClose={() => setOpen(false)} onRunCommand={onRunCommand} />
    </>
  );
}
