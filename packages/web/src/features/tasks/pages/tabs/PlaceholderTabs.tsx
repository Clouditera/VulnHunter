/** Placeholder tabs — to be built in Phase 4+ */
import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import type { Task } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";

function Placeholder({ labelKey, testid }: { labelKey: string; testid: string }) {
  const { task } = useOutletContext<{ task: Task }>();
  void task;
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  return (
    <div
      data-testid={testid}
      style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "13px", textAlign: "center" }}
    >
      <div style={{ fontSize: "32px", marginBottom: "12px" }}>🚧</div>
      <div style={{ fontWeight: 600 }}>{i18n.t(labelKey)}</div>
      <div style={{ marginTop: "8px" }}>{i18n.t("placeholder.comingSoon")}</div>
    </div>
  );
}

export function ReportsTab() { return <Placeholder labelKey="placeholder.reports" testid="task-detail-panel-reports" />; }
// PocTab moved to its own file (PocTab.tsx) in Phase 6.
// WorkspaceTab moved to its own file (WorkspaceTab.tsx) in Phase 6.
