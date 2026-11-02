// @vitest-environment jsdom

/**
 * HALL-86 / VulnHunter#58 — New Chat 带附件发送首条消息不得创建两个会话。
 *
 * Root cause: `ChatInput.submit()` materializes the draft session via
 * `onEnsureSession()` to upload attachments, then calls the *stale* `onSend`
 * closure (a `useCallback` captured before the state update). That closure
 * still saw `draftSession`/`activeId === "draft"` and ran `createSession()`
 * a second time — attachments landed on session A while the conversation ran
 * on session B, so the agent container never saw `/workspace/attachments/`
 * and the service-side per-session artifact check rejected the references.
 *
 * These tests pin the fixed contract:
 *   1. a stale `sendPrompt` closure given the already-materialized session id
 *      must NOT create a second session;
 *   2. text-only first send from a draft still creates exactly one session;
 *   3. follow-up sends in the materialized session create none;
 *   4. `ChatInput.submit()` hands the upload session id to `onSend`.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/*  API mock                                                                  */
/* -------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => {
  const state = { created: 0 };
  return {
    state,
    list: vi.fn(async () => ({ sessions: [] })),
    create: vi.fn(async () => {
      state.created += 1;
      const now = new Date().toISOString();
      return {
        session: {
          id: `sess-${state.created}`,
          title: "",
          created_at: now,
          updated_at: now,
          preview: null,
          creator: null,
          worker_state: "idle",
          credential_id: null,
        },
      };
    }),
    messages: vi.fn(async () => ({ messages: [] })),
    artifacts: vi.fn(async () => ({ artifacts: [] })),
    prompt: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => ({
      artifact_id: "art-1",
      path: "/workspace/chat-session/attachments/abc.zip",
      originalName: "doc.zip",
    })),
    abort: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("../src/shared/api/client.js", () => ({
  api: { chat: { sessions: mocks } },
}));

// Hook/component import AFTER the mock registration.
const { useChat } = await import("../src/features/chat/hooks/useChat.js");
const { ChatInput } = await import("../src/features/chat/components/ChatInput.js");

/* -------------------------------------------------------------------------- */
/*  Browser stubs (jsdom lacks EventSource / WebSocket)                        */
/* -------------------------------------------------------------------------- */

class FakeEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

const wsInstances: FakeWebSocket[] = [];

class FakeWebSocket {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    wsInstances.push(this);
  }
  close() {}
}

(globalThis as Record<string, unknown>).EventSource = FakeEventSource;
(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/*  Setup                                                                     */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;

type ChatApi = ReturnType<typeof useChat>;
let latest: ChatApi;

function HookHarness() {
  latest = useChat();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.created = 0;
  wsInstances.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mountHook() {
  await act(async () => {
    root.render(<HookHarness />);
  });
}

/* -------------------------------------------------------------------------- */
/*  useChat: draft materialization                                            */
/* -------------------------------------------------------------------------- */

describe("useChat draft first-send (HALL-86 / #58)", () => {
  it("stale onSend closure + explicit session id creates NO second session", async () => {
    await mountHook();
    act(() => latest.startDraftSession());
    expect(latest.activeId).toBe("draft");

    // ChatInput.submit() holds THIS closure across the ensureSession() await —
    // it was captured from the pre-materialization render.
    const staleSend = latest.sendPrompt;

    // Step 1 (ChatInput): materialize draft → session A, upload to A.
    let uploadSessionId: string | null = null;
    await act(async () => {
      uploadSessionId = await latest.ensureSession();
    });
    expect(uploadSessionId).toBe("sess-1");
    expect(mocks.create).toHaveBeenCalledTimes(1);

    // Step 2 (ChatInput): stale onSend closure invoked with the upload id.
    await act(async () => {
      await staleSend("分析一下这个压缩包", undefined, uploadSessionId ?? undefined);
    });

    // The bug: stale closure still saw the draft → second createSession().
    expect(mocks.create).toHaveBeenCalledTimes(1);
    // Prompt must land on the SAME session the attachments were uploaded to.
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("分析一下这个压缩包"),
    );
  });

  it("text-only first send from a draft still creates exactly one session", async () => {
    await mountHook();
    act(() => latest.startDraftSession());

    await act(async () => {
      await latest.sendPrompt("hello");
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).toHaveBeenCalledWith("sess-1", "hello");
  });

  it("follow-up send in the materialized session creates no session", async () => {
    await mountHook();
    act(() => latest.startDraftSession());
    await act(async () => {
      await latest.sendPrompt("first");
    });
    expect(latest.activeId).toBe("sess-1");

    // First send leaves the session flagged streaming until the WS turn end;
    // simulate agent_end so the follow-up isn't (correctly) blocked.
    const ws = wsInstances.find((w) => w.url.includes("/ws/chat/sess-1"));
    act(() => {
      ws?.onmessage?.({ data: JSON.stringify({ type: "agent_end" }) } as MessageEvent);
    });

    await act(async () => {
      await latest.sendPrompt("second");
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).toHaveBeenNthCalledWith(2, "sess-1", "second");
  });
});

/* -------------------------------------------------------------------------- */
/*  ChatInput: submit passes the upload session id to onSend                  */
/* -------------------------------------------------------------------------- */

describe("ChatInput attachment submit (HALL-86 / #58)", () => {
  it("passes the ensured upload session id through to onSend", async () => {
    const onSend = vi.fn();
    const onEnsureSession = vi.fn(async () => "sess-1");
    act(() => {
      root.render(
        <ChatInput
          sessionId={null}
          streaming={false}
          onSend={onSend}
          onAbort={() => {}}
          onEnsureSession={onEnsureSession}
        />,
      );
    });

    // Attach a (non-image) file via the hidden picker input.
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["zip-bytes"], "doc.zip", { type: "application/zip" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    act(() => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="chat-attachments"]')).toBeTruthy();

    const sendBtn = container.querySelector('[data-testid="chat-send-btn"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn.click();
    });
    await act(async () => {
      /* flush submit()'s promise chain (ensureSession → upload → onSend) */
    });

    expect(onEnsureSession).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith("sess-1", file);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(
      expect.stringContaining("artifact_id: art-1"),
      undefined,
      "sess-1",
    );
  });
});
