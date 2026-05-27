import { useEffect, useRef, useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { SessionList } from "../components/SessionList.js";
import { MessageFlow } from "../components/MessageFlow.js";
import { ArtifactWorkspace } from "../components/ArtifactWorkspace.js";
import { Splitter, useResizableWidth } from "../../../shared/components/Splitter.js";
import { useChat } from "../hooks/useChat.js";
import type { ChatArtifact } from "../types.js";

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
 * Data source is the real backend-backed chat hook.
 */

export function ChatPage() {
  // React to i18n/locale changes so labels stay in sync.
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [artifactWidth, setArtifactWidth] = useResizableWidth("chat-artifact-width", 440, { min: 360, max: 640 });
  const [drawerOpen, setDrawerOpen] = useState(false);
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
    selectSession,
    createSession,
    deleteSession,
    sendPrompt,
    abort,
  } = useChat();

  const handleArtifactSelect = (artifact: ChatArtifact) => {
    setSelectedArtifactId(artifact.artifact_id);
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
        onArtifactSelect={handleArtifactSelect}
        activity={activity}
      />
      {isNarrow ? (
        <>
          <button
            type="button"
            data-testid="chat-artifact-drawer-open"
            onClick={() => setDrawerOpen(true)}
            style={{
              position: "fixed",
              right: "16px",
              bottom: "88px",
              zIndex: 50,
              border: "1px solid var(--brand)",
              background: "var(--brand)",
              color: "#fff",
              borderRadius: "999px",
              padding: "9px 14px",
              fontSize: "13px",
              fontWeight: 600,
              boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              cursor: "pointer",
            }}
          >
            交付物{artifacts.length ? ` ${artifacts.length}` : ""}
          </button>
          {drawerOpen ? (
            <div
              data-testid="chat-artifact-drawer"
              role="dialog"
              aria-modal="true"
              style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", justifyContent: "flex-end" }}
            >
              <div onClick={() => setDrawerOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.36)" }} />
              <div style={{ position: "relative", height: "100%", width: "min(440px, 90vw)", maxWidth: "100vw", boxShadow: "-16px 0 40px rgba(0,0,0,0.22)" }}>
                <button
                  type="button"
                  aria-label="关闭文件预览区"
                  onClick={() => setDrawerOpen(false)}
                  style={{ position: "absolute", top: 10, right: 12, zIndex: 2, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-primary)", borderRadius: 6, height: 28, padding: "0 10px", cursor: "pointer" }}
                >
                  关闭
                </button>
                <ArtifactWorkspace
                  messages={messages}
                  persistedArtifacts={artifacts}
                  streaming={streaming}
                  width="100%"
                  selectedArtifactId={selectedArtifactId}
                  onSelectedArtifactChange={setSelectedArtifactId}
                />
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <Splitter value={artifactWidth} onResize={setArtifactWidth} min={360} max={640} containerRef={layoutRef} invert />
          <ArtifactWorkspace
            messages={messages}
            persistedArtifacts={artifacts}
            streaming={streaming}
            width={artifactWidth}
            selectedArtifactId={selectedArtifactId}
            onSelectedArtifactChange={setSelectedArtifactId}
          />
        </>
      )}
    </div>
  );
}

function useNarrowViewport(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" ? window.innerWidth <= maxWidth : false);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= maxWidth);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [maxWidth]);
  return narrow;
}
