import { randomUUID } from "node:crypto";

export interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  message?: string;
  data?: unknown;
}

interface PendingCommand {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Correlates pi RPC commands with their asynchronous stdout responses. */
export class RpcCommandTracker {
  private readonly pending = new Map<string, PendingCommand>();

  constructor(
    private readonly write: (line: string) => boolean,
    private readonly timeoutMs = 10_000,
  ) {}

  send(command: Record<string, unknown>): Promise<RpcResponse> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command timed out: ${String(command.type ?? "unknown")}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      if (!this.write(`${JSON.stringify({ ...command, id })}\n`)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("pi not running"));
      }
    });
  }

  accept(value: unknown): boolean {
    if (!isRpcResponse(value) || !value.id) return false;
    const pending = this.pending.get(value.id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.success) pending.resolve(value);
    else pending.reject(new Error(value.error ?? value.message ?? "pi rejected command"));
    return true;
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<RpcResponse>;
  return response.type === "response" && typeof response.success === "boolean";
}
