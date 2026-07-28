import { useEffect, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FeedbackItem } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

const PAGE = 20;

export function FeedbackSection() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["admin-feedback", offset],
    queryFn: () => api.feedback.list({ limit: PAGE, offset }),
  });

  const items = data?.feedback ?? [];
  const total = data?.total ?? 0;

  return (
    <section style={CARD} data-testid="settings-card-feedback">
      <h3 style={TITLE}>
        <Icon name="chat" size={18} style={{ color: "var(--text-secondary)" }} />
        <span>{i18n.t("settings.feedback.title")}</span>
      </h3>
      <p style={DESC}>{i18n.t("settings.feedback.desc")}</p>

      {isLoading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{i18n.t("common.loading")}</div>
      ) : isError ? (
        <div>
          <div style={{ color: "var(--brand)", fontSize: 13 }}>{i18n.t("settings.feedback.loadFailed")}</div>
          <button type="button" onClick={() => void refetch()} style={LINK}>{i18n.t("common.retry")}</button>
        </div>
      ) : items.length === 0 ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{i18n.t("settings.feedback.empty")}</div>
      ) : (
        <>
          <div style={{ border: "1px solid var(--divider)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ ...ROW, background: "var(--bg-page)", fontWeight: 600, fontSize: 11, color: "var(--text-secondary)" }}>
              <div style={{ width: 150 }}>{i18n.t("settings.feedback.col.time")}</div>
              <div style={{ width: 160 }}>{i18n.t("settings.feedback.col.user")}</div>
              <div style={{ width: 70 }}>{i18n.t("settings.feedback.col.sat")}</div>
              <div style={{ flex: 1 }}>{i18n.t("settings.feedback.col.content")}</div>
              <div style={{ width: 180 }}>{i18n.t("settings.feedback.col.email")}</div>
            </div>
            {items.map((f) => (
              <FeedbackRow key={f.id} item={f} expanded={expanded === f.id} onToggle={() => setExpanded(expanded === f.id ? null : f.id)} />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {i18n.t("settings.feedback.total").replace("{n}", String(total))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} style={PAGE_BTN}>
                {i18n.t("common.prev")}
              </button>
              <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} style={PAGE_BTN}>
                {i18n.t("common.next")}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function FeedbackRow({ item, expanded, onToggle }: { item: FeedbackItem; expanded: boolean; onToggle: () => void }) {
  const userLabel = item.user?.display_name || item.user?.email || "—";
  return (
    <div
      data-testid="feedback-row"
      onClick={onToggle}
      style={{ ...ROW, cursor: "pointer", borderTop: "1px solid var(--divider)", alignItems: expanded ? "flex-start" : "center" }}
    >
      <div style={{ width: 150, fontSize: 12, color: "var(--text-secondary)" }}>
        {new Date(item.created_at).toLocaleString()}
      </div>
      <div style={{ width: 160, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={userLabel}>
        {userLabel}
      </div>
      <div style={{ width: 70, fontSize: 13, fontWeight: 700 }}>{item.satisfaction}</div>
      <div style={{ flex: 1, fontSize: 12.5, minWidth: 0 }}>
        {expanded ? (
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{item.content}</div>
        ) : (
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.content}</div>
        )}
      </div>
      <div style={{ width: 180, fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.contact_email || "—"}
      </div>
    </div>
  );
}

const CARD: CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--divider)", borderRadius: 10, padding: "20px 22px", marginBottom: 18,
};
const TITLE: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, margin: "0 0 4px" };
const DESC: CSSProperties = { fontSize: 12.5, color: "var(--text-secondary)", margin: "0 0 16px", lineHeight: 1.55 };
const ROW: CSSProperties = { display: "flex", gap: 10, padding: "10px 12px" };
const PAGE_BTN: CSSProperties = {
  height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card)",
  fontSize: 12, cursor: "pointer",
};
const LINK: CSSProperties = { border: "none", background: "none", color: "var(--link, var(--brand))", cursor: "pointer", fontSize: 12.5, marginTop: 6 };
