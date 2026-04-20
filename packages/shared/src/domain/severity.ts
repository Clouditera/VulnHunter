export type Severity = "high" | "medium" | "low" | "info";

export const SEVERITY_NUMERIC: Record<Severity, number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};
