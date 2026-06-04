import type { QueryContext } from "../../infra/query-context.js";
import { getTaskById } from "./storage.js";

export async function getAccessibleTask(ctx: QueryContext, taskId: string) {
  return getTaskById(ctx, taskId);
}
