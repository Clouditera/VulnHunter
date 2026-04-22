/**
 * Unit tests for bridge-proxy.ts — session-level singleton WS + fan-out + event buffer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Use globalThis to share state with hoisted vi.mock factory
(globalThis as any).__bridgeProxyTestInstances = [];

vi.mock("ws", () => {
  const { EventEmitter } = require("node:events");

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sent: string[] = [];

    constructor(url?: string) {
      super();
      if (url) {
        (globalThis as any).__bridgeProxyTestInstances.push(this);
        setTimeout(() => this.emit("open"), 5);
      }
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 3;
      this.emit("close");
    }
  }
  return { WebSocket: FakeWebSocket };
});

vi.mock("../../src/features/chat/storage.js", () => ({
  appendMessage: vi.fn(async () => ({ id: "msg-1", seq: 1 })),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  connectBridgeProxy,
  subscribeFrontendClient,
  disconnectBridgeProxy,
} from "../../src/features/chat/bridge-proxy.js";
import { WebSocket } from "ws";

function getInstances(): any[] {
  return (globalThis as any).__bridgeProxyTestInstances;
}

describe("bridge-proxy", () => {
  beforeEach(() => {
    (globalThis as any).__bridgeProxyTestInstances = [];
    disconnectBridgeProxy("test-session");
  });

  afterEach(() => {
    disconnectBridgeProxy("test-session");
  });

  it("connectBridgeProxy resolves when WS opens", async () => {
    await connectBridgeProxy("test-session", "http://bridge:8080", 5000);
    expect(getInstances()).toHaveLength(1);
  });

  it("connectBridgeProxy reuses existing connection", async () => {
    await connectBridgeProxy("test-session", "http://bridge:8080", 5000);
    await connectBridgeProxy("test-session", "http://bridge:8080", 5000);
    expect(getInstances()).toHaveLength(1);
  });

  it("subscribeFrontendClient replays buffered events", async () => {
    await connectBridgeProxy("test-session", "http://bridge:8080", 5000);
    const bridgeWs = getInstances()[0];

    bridgeWs.emit("message", Buffer.from(JSON.stringify({ type: "message_start", message: { role: "assistant" } })));
    bridgeWs.emit("message", Buffer.from(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta" } })));

    // Late-joining client
    const clientWs = new WebSocket() as any;
    subscribeFrontendClient("test-session", clientWs);

    expect(clientWs.sent).toHaveLength(2);
    const event = JSON.parse(clientWs.sent[0]);
    expect(event.session_id).toBe("test-session");
    expect(event.type).toBe("message_start");
  });

  it("fan-out sends to multiple clients", async () => {
    await connectBridgeProxy("test-session", "http://bridge:8080", 5000);

    const client1 = new WebSocket() as any;
    const client2 = new WebSocket() as any;
    subscribeFrontendClient("test-session", client1);
    subscribeFrontendClient("test-session", client2);

    const bridgeWs = getInstances()[0];
    bridgeWs.emit("message", Buffer.from(JSON.stringify({ type: "agent_start" })));

    const c1 = client1.sent.filter((s: string) => JSON.parse(s).type === "agent_start");
    const c2 = client2.sent.filter((s: string) => JSON.parse(s).type === "agent_start");
    expect(c1).toHaveLength(1);
    expect(c2).toHaveLength(1);
  });

  it("disconnectBridgeProxy cleans up", async () => {
    await connectBridgeProxy("test-session", "http://bridge:8080", 5000);
    const client = new WebSocket() as any;
    subscribeFrontendClient("test-session", client);

    disconnectBridgeProxy("test-session");
    expect(client.readyState).toBe(3); // CLOSED
  });
});
