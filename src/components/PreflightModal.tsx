import { Loader2, ShieldAlert, XCircle } from "lucide-react";
import clsx from "clsx";
import { PreflightReport } from "../types/preflight";

export type PreflightStatus = "hidden" | "analyzing" | "review" | "error";

interface PreflightModalProps {
  command: string;
  status: PreflightStatus;
  report?: PreflightReport;
  message?: string;
  onCancel: () => void;
  onRunAnyway: () => void;
}

const statusMeta = {
  analyzing: {
    icon: <Loader2 size={22} className="icon-spin" />,
    tone: "neutral" as const,
    title: "Analyzing potentially risky command…",
    description: "Termalime is checking heuristics and asking the AI for a second opinion.",
  },
  review: {
    icon: <ShieldAlert size={22} />,
    tone: "alert" as const,
    title: "⚠️ Command requires review",
    description: "Double-check the findings below before running it anyway.",
  },
  error: {
    icon: <XCircle size={22} />,
    tone: "error" as const,
    title: "Preflight check failed",
    description: "Run manually or retry after fixing the issue below.",
  },
};

export function PreflightModal({
  command,
  status,
  report,
  message,
  onCancel,
  onRunAnyway,
}: PreflightModalProps) {
  if (status === "hidden") {
    return null;
  }

  const meta = statusMeta[status];

  return (
    <div className="preflight-overlay" role="dialog" aria-modal>
      <div className="preflight-card">
        <header className={clsx("preflight-header", meta?.tone && `preflight-header--${meta.tone}`)}>
          <div className="preflight-header__icon">{meta?.icon}</div>
          <div>
            <p className="preflight-eyebrow">Preflight Check</p>
            <h3>{meta?.title}</h3>
            {meta?.description && <p className="preflight-desc">{meta.description}</p>}
          </div>
        </header>

        <section className="preflight-section">
          <p className="preflight-label">Command</p>
          <pre className="preflight-command">{command}</pre>
        </section>

        {status === "review" && report && (
          <>
            <section className="preflight-section">
              <p className="preflight-label">Summary</p>
              <p className="preflight-body">{report.summary}</p>
            </section>
            <section className="preflight-section">
              <p className="preflight-label">Risk reasoning</p>
              <p className="preflight-body">{report.risk_reason}</p>
            </section>
            {report.safe_alternative && (
              <section className="preflight-section">
                <p className="preflight-label">Safer approach</p>
                <p className="preflight-body">{report.safe_alternative}</p>
              </section>
            )}
          </>
        )}

        {status === "review" && message && (
          <section className="preflight-section">
            <p className="preflight-label">AI assessment</p>
            <p className="preflight-body">{message}</p>
          </section>
        )}

        {status === "error" && message && (
          <section className="preflight-section">
            <p className="preflight-label">Error</p>
            <p className="preflight-body">{message}</p>
          </section>
        )}

        <footer className="preflight-footer">
          <button className="text-btn" onClick={onCancel}>
            {status === "analyzing" ? "Cancel" : "Cancel command"}
          </button>
          <button
            className="preflight-run-btn"
            onClick={onRunAnyway}
            disabled={status === "analyzing"}
          >
            {status === "review" ? "Run anyway" : status === "error" ? "Run despite error" : "Allow"}
          </button>
        </footer>
      </div>
    </div>
  );
}
export default PreflightModal;
