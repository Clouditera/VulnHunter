/** Placeholder tabs — to be built in Phase 4+ */
import { useOutletContext } from "react-router-dom";
import type { Task } from "../../../../shared/api/client.js";

function Placeholder({ label, testid }: { label: string; testid: string }) {
  const { task } = useOutletContext<{ task: Task }>();
  void task;
  return (
    <div
      data-testid={testid}
      style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "13px", textAlign: "center" }}
    >
      <div style={{ fontSize: "32px", marginBottom: "12px" }}>🚧</div>
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: "8px" }}>Coming in Phase 4+</div>
    </div>
  );
}

export function ReportsTab() { return <Placeholder label="Reports" testid="task-detail-panel-reports" />; }
export function PocTab() { return <Placeholder label="POC/EXP" testid="task-detail-panel-poc" />; }
export function WorkspaceTab() { return <Placeholder label="Workspace" testid="task-detail-panel-workspace" />; }
