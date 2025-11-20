export type AnalyzeAction = "run" | "review" | "error";

export interface PreflightReport {
  summary: string;
  is_risky: boolean;
  risk_reason: string;
  safe_alternative?: string;
}

export interface AnalyzeCommandResponse {
  action: AnalyzeAction;
  report?: PreflightReport;
  message?: string;
  score?: number;
}

export interface AnalyzeCommandPayload {
  command: string;
  model?: string;
}
