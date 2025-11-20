import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Persona = "helpful" | "concise" | "neutral" | "playful";

export interface Settings {
  terminalFontSize: number;
  showChat: boolean;
  includeTerminalContext: boolean;
  systemPrompt: string;
  persona: Persona;
  preflightCheck: boolean;
  preflightModel: string;
}

export const PERSONA_DESCRIPTIONS: Record<Persona, string> = {
  helpful: "Warm mentor – precise, thorough, and encouraging.",
  concise: "Succinct analyst – minimal words, prioritizes commands.",
  neutral: "Balanced operator – neutral tone and factual guidance.",
  playful: "Playful pair – imaginative, witty but still accurate.",
};

export const DEFAULT_SETTINGS: Settings = {
  terminalFontSize: 14,
  showChat: true,
  includeTerminalContext: true,
  systemPrompt:
    "You are Termalime, an AI pair-programmer focused on shell workflows. Provide safe, actionable guidance and explain risky commands before running them.",
  persona: "helpful",
  preflightCheck: false,
  preflightModel: "gemma3:270m",
};

interface SettingsContextValue {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;
}

const STORAGE_KEY = "termalime:settings";

const SettingsContext = createContext<SettingsContextValue | null>(null);

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const SettingsProvider = ({ children }: { children: ReactNode }) => {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn("Failed to persist settings", error);
    }
  }, [settings]);

  const value = useMemo<SettingsContextValue>(() => {
    const updateSettings = (patch: Partial<Settings>) => {
      setSettings((prev) => ({ ...prev, ...patch }));
    };
    const resetSettings = () => setSettings(DEFAULT_SETTINGS);
    return { settings, updateSettings, resetSettings };
  }, [settings]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

export const useSettings = (): SettingsContextValue => {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
};
