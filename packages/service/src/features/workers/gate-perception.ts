/**
 * Shared gate-perception helpers (engine-native gate, spec §6).
 *
 * Both the scheduler's live path (fresh spawn → EventTail route handler)
 * and the reconciler's restart path re-arm the same handler and share the
 * same gate-file + evidence primitives, so a service restart can never
 * leave a gate-phase task without a consumer for its route events.
 */

import { setEngineEventHandler } from "../events/event-tail.js";

export interface GateRouteContext {
  taskId: string;
  token: string;
  hostWorkDir: string;
  /** Invoked with the route target on the first terminal route event. */
  onRoute: (target: string) => void;
}

/**
 * Arm the one-shot engine route handler for a gate-phase fresh task.
 * Malformed/foreign events are ignored (handler stays armed); the first
 * onboard route to cycle_join|exit detaches and hands off to onRoute.
 */
export function armGateRouteHandler(ctx: GateRouteContext): void {
  setEngineEventHandler(ctx.taskId, (raw) => {
    if (raw.event !== "route" || raw.stage !== "onboard") return;
    const target = raw.target;
    if (target !== "cycle_join" && target !== "exit") return;
    setEngineEventHandler(ctx.taskId, null); // one-shot: first terminal route wins
    ctx.onRoute(target);
  });
}
