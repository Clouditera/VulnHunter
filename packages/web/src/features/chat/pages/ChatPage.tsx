import { useEffect, useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { SessionList } from "../components/SessionList.js";
import { MessageFlow } from "../components/MessageFlow.js";
import { ArtifactPanel } from "../components/ArtifactPanel.js";
import { useChatMock } from "../hooks/useChatMock.js";

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

  const {
    sessions,
    activeId,
    activeSession,
    messages,
    streaming,
    selectSession,
    createSession,
    deleteSession,
    sendPrompt,
    abort,
  } = useChatMock();

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
      <ArtifactPanel messages={messages} />
    </div>
  );
}
