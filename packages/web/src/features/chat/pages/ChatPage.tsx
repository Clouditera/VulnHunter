import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { i18n } from "../../../shared/i18n/index.js";
import { MessageFlow } from "../components/MessageFlow.js";
import { ArtifactWorkspace } from "../components/ArtifactWorkspace.js";
import { Splitter, useResizableWidth } from "../../../shared/components/Splitter.js";
import { ChatProvider, useChatContext } from "../ChatContext.js";
import type { ChatArtifactUnion } from "../types.js";

/**
 * Chat-first layout:
 *   - global AppLayout sidebar owns New Chat / Recents
 *   - flex Message stream + input (center)
 *   - Artifact / references panel opens only after a card click
 */

export function ChatPage() {
  return (
    <ChatProvider>
      <ChatPageInner />
    </ChatProvider>
  );
}

function ChatPageInner() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  const location = useLocation();
  const navigate = useNavigate();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const handledStateKey = useRef<string | null>(null);
  const [artifactWidth, setArtifactWidth] = useResizableWidth("chat-artifact-width", 440, {
    min: 360,
    max: 640,
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [referencePanelOpen, setReferencePanelOpen] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const isNarrow = useNarrowViewport(1180);
  const {
    sessions,
    activeId,
    activeSession,
    messages,
    artifacts,
    streaming,
    activity,
    loading,
    selectSession,
    startDraftSession,
    ensureSession,
    sendPrompt,
    abort,
  } = useChatContext();

  useEffect(() => {
    const state = location.state as { selectSessionId?: string; newChat?: boolean } | null;
    if (!state || handledStateKey.current === location.key) return;
    handledStateKey.current = location.key;
    if (state.selectSessionId) selectSession(state.selectSessionId);
    if (state.newChat) {
      startDraftSession();
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [location.key, location.pathname, location.state, navigate, selectSession, startDraftSession]);

  useEffect(() => {
    // Only auto-open a blank draft when there is truly no session to show.
    // Login/refresh should land on the latest session (set by useChat load).
    // Explicit "新对话" uses startDraftSession via nav state / event (VULNHUN-170).
    if (!loading && !activeId && sessions.length === 0) startDraftSession();
  }, [activeId, loading, startDraftSession, sessions.length]);

  const closeReferencePanel = () => {
    setDrawerOpen(false);
    setReferencePanelOpen(false);
  };

  const handleArtifactSelect = (artifact: ChatArtifactUnion) => {
    setSelectedArtifactId(
      artifact.type === "chat_artifact" ? artifact.artifact_id : artifact.ref_id,
    );
    setReferencePanelOpen(true);
    if (isNarrow) setDrawerOpen(true);
  };

  return (
    <div
      data-testid="chat-page"
      ref={layoutRef}
      style={{
        display: "flex",
        height: "100%",
        background: "var(--bg-page)",
        minHeight: 0,
      }}
    >
      <MessageFlow
        session={activeSession}
        messages={messages}
        streaming={streaming}
        onSend={sendPrompt}
        onEnsureSession={ensureSession}
        onAbort={abort}
        onArtifactSelect={handleArtifactSelect}
        persistedArtifacts={artifacts}
        activity={activity}
        onSuggest={(text, submit = false) => {
          if (!activeId) {
            startDraftSession();
            window.setTimeout(
              () => window.dispatchEvent(new CustomEvent("vh:chat-suggest", { detail: { text, submit } })),
              0,
            );
            return;
          }
          window.dispatchEvent(new CustomEvent("vh:chat-suggest", { detail: { text, submit } }));
        }}
      />
      {isNarrow ? (
        drawerOpen && referencePanelOpen ? (
          <div
            data-testid="chat-artifact-drawer"
            role="dialog"
            aria-modal="true"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 80,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              aria-label={i18n.t("common.close")}
              onClick={closeReferencePanel}
              style={{
                position: "absolute",
                inset: 0,
                border: "none",
                background: "rgba(0,0,0,0.36)",
                cursor: "pointer",
              }}
            />
            <div
              style={{
                position: "relative",
                height: "100%",
                width: "min(440px, 90vw)",
                maxWidth: "100vw",
                boxShadow: "-16px 0 40px rgba(0,0,0,0.22)",
              }}
            >
              <ArtifactWorkspace
                messages={messages}
                persistedArtifacts={artifacts}
                streaming={streaming}
                width="100%"
                selectedArtifactId={selectedArtifactId}
                onSelectedArtifactChange={setSelectedArtifactId}
                onClose={closeReferencePanel}
              />
            </div>
          </div>
        ) : null
      ) : referencePanelOpen ? (
        <>
          <Splitter
            value={artifactWidth}
            onResize={setArtifactWidth}
            min={360}
            max={640}
            containerRef={layoutRef}
            invert
          />
          <ArtifactWorkspace
            messages={messages}
            persistedArtifacts={artifacts}
            streaming={streaming}
            width={artifactWidth}
            selectedArtifactId={selectedArtifactId}
            onSelectedArtifactChange={setSelectedArtifactId}
            onClose={closeReferencePanel}
          />
        </>
      ) : null}
    </div>
  );
}

function useNarrowViewport(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= maxWidth : false,
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= maxWidth);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [maxWidth]);
  return narrow;
}
