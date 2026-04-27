import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * Subscribe once to the server's SSE notification channel and invalidate
 * React Query caches as state-change events arrive.
 *
 * Backend contract (see packages/service/src/features/notifications):
 *   GET /api/notifications (text/event-stream)
 *     data: {"type":"task_state", "taskId":"...", "state":"running"|...}
 *     data: {"type":"findings_indexed", "taskId":"...", "count":N}
 *     data: {"type":"chat_worker_state", "sessionId":"...", "state":"..."}
 *
 * Mount this hook exactly once (in AppLayout). It replaces the
 * `refetchInterval` polling previously scattered across the tasks list,
 * task detail, findings, and dashboard queries.
 *
 * EventSource automatically handles reconnect-with-backoff on transient
 * network failures, so we don't implement that ourselves.
 */
export function useNotifications() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/notifications", { withCredentials: true });

    es.onmessage = (ev) => {
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      handleEvent(qc, payload as NotificationEvent);
    };

    // EventSource auto-reconnects on `error`, so we just log for debug.
    // Browser prints a generic event without details on network blips.
    es.onerror = () => {
      // Intentionally silent — auto-reconnect will re-establish.
    };

    return () => es.close();
  }, [qc]);
}

type NotificationEvent =
  | { type: "task_state"; taskId: string; state: string }
  | { type: "findings_indexed"; taskId: string; count: number }
  | { type: "chat_worker_state"; sessionId: string; state: string }
  | { type: string; [k: string]: unknown };

function handleEvent(qc: QueryClient, evt: NotificationEvent) {
  switch (evt.type) {
    case "task_state": {
      // Dashboard aggregates across all tasks and the tasks list page.
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      if ("taskId" in evt && typeof evt.taskId === "string") {
        qc.invalidateQueries({ queryKey: ["task", evt.taskId] });
        qc.invalidateQueries({ queryKey: ["task-wiki", evt.taskId] });
      }
      return;
    }
    case "findings_indexed": {
      if ("taskId" in evt && typeof evt.taskId === "string") {
        qc.invalidateQueries({ queryKey: ["findings", evt.taskId] });
        qc.invalidateQueries({ queryKey: ["task", evt.taskId] });
      }
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      return;
    }
    case "finding_review_updated": {
      if ("taskId" in evt && typeof evt.taskId === "string") {
        qc.invalidateQueries({ queryKey: ["findings", evt.taskId] });
        qc.invalidateQueries({ queryKey: ["finding-review-events", evt.taskId] });
      }
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      return;
    }
    case "chat_worker_state": {
      // Chat sessions list shows a worker-running badge; refresh it.
      qc.invalidateQueries({ queryKey: ["chat-sessions"] });
      if ("sessionId" in evt && typeof evt.sessionId === "string") {
        qc.invalidateQueries({
          queryKey: ["chat-session", evt.sessionId],
        });
      }
      return;
    }
    default:
      return;
  }
}
