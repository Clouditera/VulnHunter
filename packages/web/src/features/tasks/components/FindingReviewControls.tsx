/**
 * Shared UI primitives for Finding Review Workflow.
 * Used by FindingsTab and ReportGenerateModal.
 */
import { useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { useConfirmClose } from "../../../shared/hooks/useConfirmClose.js";
import type { FindingReviewStatus, FindingReviewEvent } from "../../../shared/api/client.js";

// ─── Status metadata ───

export const REVIEW_STATUS_META: Record<
  FindingReviewStatus,
  { labelKey: string; color: string; bg: string }
> = {
  pending: {
    labelKey: "review.status.pending",
    color: "var(--review-pending)",
    bg: "var(--review-pending-bg)",
  },
  confirmed: {
    labelKey: "review.status.confirmed",
    color: "var(--review-confirmed)",
    bg: "var(--review-confirmed-bg)",
  },
  false_positive: {
    labelKey: "review.status.false_positive",
    color: "var(--review-false-positive)",
    bg: "var(--review-false-positive-bg)",
  },
  ignored: {
    labelKey: "review.status.ignored",
    color: "var(--review-ignored)",
    bg: "var(--review-ignored-bg)",
  },
};

// ─── ReviewStatusBadge ───

export function ReviewStatusBadge({
  status,
  muted,
}: {
  status: FindingReviewStatus;
  muted?: boolean;
}) {
  const meta = REVIEW_STATUS_META[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px 2px 6px",
        borderRadius: 999,
        background: meta.bg,
        border: status === "pending" ? "none" : `1px solid color-mix(in srgb, ${meta.color} 20%, transparent)`,
        fontSize: 11,
        fontWeight: 500,
        color: meta.color,
        opacity: muted ? 0.6 : 1,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: meta.color,
          flexShrink: 0,
        }}
      />
      {i18n.t(meta.labelKey)}
    </span>
  );
}

// ─── ReviewStatusSelect ───

export function ReviewStatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: FindingReviewStatus;
  onChange: (status: FindingReviewStatus, note?: string) => void;
  disabled?: boolean;
}) {
  const [noteModalTarget, setNoteModalTarget] = useState<FindingReviewStatus | null>(null);

  const statuses: FindingReviewStatus[] = ["pending", "confirmed", "false_positive", "ignored"];

  function handleClick(status: FindingReviewStatus) {
    if (status === value || disabled) return;
    // false_positive and ignored prompt for note
    if (status === "false_positive" || status === "ignored") {
      setNoteModalTarget(status);
    } else {
      onChange(status);
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {statuses.map((s) => {
          const meta = REVIEW_STATUS_META[s];
          const active = s === value;
          return (
            <button
              key={s}
              type="button"
              onClick={() => handleClick(s)}
              disabled={disabled}
              aria-pressed={active}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 12px",
                borderRadius: 6,
                border: active ? `1px solid ${meta.color}` : "1px solid var(--border)",
                background: active ? meta.bg : "transparent",
                color: active ? meta.color : "var(--text-secondary)",
                fontSize: 12,
                fontFamily: "inherit",
                fontWeight: active ? 600 : 400,
                cursor: disabled ? "wait" : "pointer",
                opacity: disabled ? 0.5 : 1,
                transition: "background 0.12s, border-color 0.12s, color 0.12s",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: active ? meta.color : "var(--text-secondary)",
                }}
              />
              {i18n.t(meta.labelKey)}
            </button>
          );
        })}
      </div>
      {noteModalTarget && (
        <ReviewNoteModal
          targetStatus={noteModalTarget}
          onConfirm={(note) => {
            onChange(noteModalTarget, note);
            setNoteModalTarget(null);
          }}
          onCancel={() => setNoteModalTarget(null)}
        />
      )}
    </>
  );
}

// ─── ReviewNoteModal ───

export function ReviewNoteModal({
  targetStatus,
  onConfirm,
  onCancel,
}: {
  targetStatus: FindingReviewStatus;
  onConfirm: (note?: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const meta = REVIEW_STATUS_META[targetStatus];
  // Unified modal base (fish 2026-08-07): ESC closes, dirty note asks first;
  // backdrop never closes. Mount-only modal → esc=true.
  const requestCancel = useConfirmClose(onCancel, note.trim() !== "", true);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 20,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: 400,
          maxWidth: "100%",
          maxHeight: "calc(100vh - 40px)",
          overflowY: "auto",
          padding: 20,
          borderRadius: 10,
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          {i18n.t("review.note.markAs")}<span style={{ color: meta.color }}>{i18n.t(meta.labelKey)}</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
          {i18n.t("review.note.placeholder")}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={i18n.t("review.note.placeholder")}
          style={{
            width: "100%",
            minHeight: 72,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-page)",
            color: "var(--text-primary)",
            fontSize: 12,
            resize: "vertical",
            outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={requestCancel}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 12,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {i18n.t("review.action.cancel")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note || undefined)}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              background: "var(--brand)",
              color: "#fff",
              fontSize: 12,
              fontFamily: "inherit",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {i18n.t("review.action.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ReviewHistoryTimeline ───

export function ReviewHistoryTimeline({ events }: { events: FindingReviewEvent[] }) {
  if (events.length === 0) {
    return (
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 8 }}>
          {i18n.t("review.history.title")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "center", padding: "12px 0" }}>
          {i18n.t("review.history.empty")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 10 }}>
        {i18n.t("review.history.title")}
      </div>
      <div style={{ position: "relative", paddingLeft: 18 }}>
        {/* Timeline line */}
        <div style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 2, background: "var(--divider)" }} />
        {events.map((ev) => {
          const newMeta = REVIEW_STATUS_META[ev.new_status];
          return (
            <div key={ev.id} style={{ position: "relative", marginBottom: 14 }}>
              {/* Dot */}
              <div
                style={{
                  position: "absolute",
                  left: -18,
                  top: 2,
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: newMeta.color,
                  border: "2px solid var(--bg-card)",
                }}
              />
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 500 }}>{ev.user_display_name}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {formatRelativeTime(ev.created_at)}
                </span>
              </div>
              {/* Status change */}
              <div style={{ fontSize: 12, marginTop: 2 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                  {i18n.t(REVIEW_STATUS_META[ev.old_status].labelKey)}
                </span>
                {" → "}
                <span style={{ color: newMeta.color, fontWeight: 500 }}>
                  {i18n.t(newMeta.labelKey)}
                </span>
              </div>
              {/* Note */}
              {ev.note && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", fontStyle: "italic", marginTop: 2 }}>
                  {ev.note}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ───

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}
