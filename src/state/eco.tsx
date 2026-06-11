import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Per-request savings payload emitted by the backend (`eco-savings` event). */
export interface EcoSavingsPayload {
  tokens: number;
  energy_wh: number;
  co2_g: number;
  water_ml: number;
}

export interface EcoTotals {
  requests: number;
  tokens: number;
  energyWh: number;
  co2G: number;
  waterMl: number;
}

interface EcoContextValue {
  /** Savings accumulated since the app was opened. */
  session: EcoTotals;
  /** Savings accumulated across all sessions (persisted). */
  lifetime: EcoTotals;
  /** Most recent single request, for "last prompt saved X" displays. */
  lastRequest: EcoSavingsPayload | null;
  resetLifetime: () => void;
}

const STORAGE_KEY = "termalime:eco-totals";

export const EMPTY_TOTALS: EcoTotals = {
  requests: 0,
  tokens: 0,
  energyWh: 0,
  co2G: 0,
  waterMl: 0,
};

const loadLifetimeTotals = (): EcoTotals => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return EMPTY_TOTALS;
    }
    const parsed = JSON.parse(raw) as Partial<EcoTotals>;
    return { ...EMPTY_TOTALS, ...parsed };
  } catch {
    return EMPTY_TOTALS;
  }
};

const persistLifetimeTotals = (totals: EcoTotals) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(totals));
  } catch (error) {
    console.warn("Failed to persist eco totals", error);
  }
};

const accumulate = (totals: EcoTotals, payload: EcoSavingsPayload): EcoTotals => ({
  requests: totals.requests + 1,
  tokens: totals.tokens + payload.tokens,
  energyWh: totals.energyWh + payload.energy_wh,
  co2G: totals.co2G + payload.co2_g,
  waterMl: totals.waterMl + payload.water_ml,
});

const EcoContext = createContext<EcoContextValue | null>(null);

export const EcoProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<EcoTotals>(EMPTY_TOTALS);
  const [lifetime, setLifetime] = useState<EcoTotals>(() => loadLifetimeTotals());
  const [lastRequest, setLastRequest] = useState<EcoSavingsPayload | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;

    const attach = async () => {
      const unsub = await listen<EcoSavingsPayload>("eco-savings", (event) => {
        if (!active) {
          return;
        }
        setLastRequest(event.payload);
        setSession((prev) => accumulate(prev, event.payload));
        setLifetime((prev) => {
          const next = accumulate(prev, event.payload);
          persistLifetimeTotals(next);
          return next;
        });
      });

      if (!active) {
        unsub();
      } else {
        unlisten = unsub;
      }
    };

    attach().catch((error) => console.error(error));

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const resetLifetime = useCallback(() => {
    setLifetime(EMPTY_TOTALS);
    setSession(EMPTY_TOTALS);
    setLastRequest(null);
    persistLifetimeTotals(EMPTY_TOTALS);
  }, []);

  const value = useMemo<EcoContextValue>(
    () => ({ session, lifetime, lastRequest, resetLifetime }),
    [session, lifetime, lastRequest, resetLifetime],
  );

  return <EcoContext.Provider value={value}>{children}</EcoContext.Provider>;
};

export const useEco = (): EcoContextValue => {
  const ctx = useContext(EcoContext);
  if (!ctx) {
    throw new Error("useEco must be used within an EcoProvider");
  }
  return ctx;
};

export const formatCo2 = (grams: number): string => {
  if (grams >= 1000) {
    return `${(grams / 1000).toFixed(2)} kg`;
  }
  if (grams >= 1) {
    return `${grams.toFixed(1)} g`;
  }
  return `${Math.round(grams * 1000)} mg`;
};

export const formatWater = (ml: number): string => {
  if (ml >= 1000) {
    return `${(ml / 1000).toFixed(2)} L`;
  }
  return `${ml.toFixed(1)} mL`;
};

export const formatEnergy = (wh: number): string => {
  if (wh >= 1000) {
    return `${(wh / 1000).toFixed(2)} kWh`;
  }
  return `${wh.toFixed(2)} Wh`;
};
