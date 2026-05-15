import { useEffect, useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { SessionList } from "../components/SessionList.js";
import { MessageFlow } from "../components/MessageFlow.js";
import { ArtifactWorkspace } from "../components/ArtifactWorkspace.js";
import { useChatMock } from "../hooks/useChatMock.js";
import { useChat } from "../hooks/useChat.js";

/**
 * Toggle between the real backend-backed hook and the in-memory mock.
 * Controlled by `localStorage.setItem('vh.chat.mock', '1')` so we can
 * fall back to seeded demo sessions when the backend is unavailable
 * (useful during Phase 6 rollout, demos, and e2e tests).
 *
 * Default is real backend — assumes Developer's 6B API is up.
 */
function useMockFromStorage(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("vh.chat.mock") === "1";
}

/**
 * Three-column chat layout:
 *   - 240px  Sessions (left)
 *   - flex   Message stream + input (center)
 *   - 360px  Artifact / references panel (right)
 *
 * The whole page fills the available viewport height (main already has
 * `height: 100vh + overflow: auto`, so we just use `height: 100%` and
 * let each column manage its own internal scroll).
 *
 * Data source is currently `useChatMock` because the backend (6A/6B)
 * isn't ready yet. When it ships we'll swap to `useChat` (real WS +
 * REST) without changing any component below.
 */

export function ChatPage() {
  // React to i18n/locale changes so labels stay in sync.
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  const useMock = useMockFromStorage();
  // Both hooks expose the same surface area; React rules require we always
  // call the same hook, so we branch at module scope via a small wrapper.
  const real = useChat();
  const mock = useChatMock();
  const {
    sessions,
    activeId,
    activeSession,
    messages,
    artifacts,
    streaming,
    selectSession,
    createSession,
    deleteSession,
    sendPrompt,
    abort,
  } = useMock ? mock : real;

  return (
    <div
      data-testid="chat-page"
      style={{
        display: "flex",
        height: "100%",
        background: "var(--bg-page)",
        minHeight: 0,
      }}
    >
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={selectSession}
        onNew={createSession}
        onDelete={deleteSession}
      />
      <MessageFlow
        session={activeSession}
        messages={messages}
        streaming={streaming}
        onSend={sendPrompt}
        onAbort={abort}
      />
      <ArtifactWorkspace messages={messages} persistedArtifacts={artifacts} streaming={streaming} />
    </div>
  );
}
