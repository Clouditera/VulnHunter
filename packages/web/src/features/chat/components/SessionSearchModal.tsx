/**
 * Session search modal — Grok-style two-column layout (fish screenshot SSOT).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ChatSessionApi } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

type GroupKey = "today" | "yesterday" | "last_7_days" | "this_year" | "earlier";

const GROUP_ORDER: GroupKey[] = ["today", "yesterday", "last_7_days", "this_year", "earlier"];

type FlatItem = {
  session: ChatSessionApi;
  match?: string;
  snippet?: string | null;
  group: GroupKey;
};

type Props = {
  open: boolean;
  onClose: () => void;
  activeSessionId?: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
};

export function SessionSearchModal({ open, onClose, activeSessionId, onSelect, onNewChat }: Props) {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<FlatItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [previewMsgs, setPreviewMsgs] = useState<Array<{ role: string; content: string }>>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();

  const selected = items[selectedIdx] ?? null;

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.chat.sessions.list({ limit: 50, offset: 0 });
      const sessions = res.sessions ?? [];
      setItems(sessions.map((s) => ({ session: s, group: bucketDate(s.updated_at) })));
      setSelectedIdx(0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const runSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      await loadAll();
      return;
    }
    setLoading(true);
    try {
      const res = await api.chat.sessions.search(trimmed);
      const flat: FlatItem[] = [];
      const byId = new Map(res.results.map((r) => [r.session.id, r]));
      for (const key of GROUP_ORDER) {
        for (const s of res.groups[key] ?? []) {
          const hit = byId.get(s.id);
          flat.push({
            session: s,
            match: hit?.match,
            snippet: hit?.snippet ?? null,
            group: key,
          });
        }
      }
      setItems(flat);
      setSelectedIdx(0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [loadAll]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    void loadAll();
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open, loadAll]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(q);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, open, runSearch]);

  useEffect(() => {
    if (!open || !selected) {
      setPreviewMsgs([]);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    api.chat.sessions
      .messages(selected.session.id)
      .then((res) => {
        if (cancelled) return;
        const msgs = (res.messages ?? []).slice(-12).map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        }));
        setPreviewMsgs(msgs);
      })
      .catch(() => {
        if (!cancelled) setPreviewMsgs([]);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selected?.session.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const grouped = useMemo(() => {
    const map = new Map<GroupKey, FlatItem[]>();
    for (const key of GROUP_ORDER) map.set(key, []);
    for (const it of items) map.get(it.group)!.push(it);
    return map;
  }, [items]);

  function openSelected() {
    if (!selected) return;
    onSelect(selected.session.id);
    onClose();
    if (location.pathname !== "/chat") navigate("/chat");
  }

  async function renameSelected() {
    if (!selected) return;
    const next = window.prompt(i18n.t("search.renamePrompt"), selected.session.title ?? "");
    if (next == null) return;
    const title = next.trim();
    if (!title) return;
    try {
      await api.chat.sessions.rename(selected.session.id, title);
      setItems((prev) =>
        prev.map((it) =>
          it.session.id === selected.session.id
            ? { ...it, session: { ...it.session, title } }
            : it,
        ),
      );
      window.dispatchEvent(new CustomEvent("vh:sessions-changed"));
    } catch {
      /* ignore */
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    const ok = window.confirm(i18n.t("search.deleteConfirm").replace("{title}", selected.session.title || ""));
    if (!ok) return;
    const id = selected.session.id;
    setItems((prev) => prev.filter((it) => it.session.id !== id));
    // Route through chat host so active pane clears (VULNHUN-152).
    window.dispatchEvent(new CustomEvent("vh:delete-session", { detail: { id } }));
    window.dispatchEvent(new CustomEvent("vh:sessions-changed"));
  }

  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openSelected();
    }
  }

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div
      data-testid="session-search-modal"
      role="dialog"
      aria-modal="true"
      style={OVERLAY}
      onClick={onClose}
    >
      <div style={MODAL} onClick={(e) => e.stopPropagation()}>
        {/* 横线1 之上：搜索框区 */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          <input
            ref={inputRef}
            data-testid="session-search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={i18n.t("search.placeholder")}
            style={SEARCH_INPUT}
          />
        </div>

        {/* 中部：左栏 | 通高竖线 | 右栏 */}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ width: "46%", display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 8px" }}>
              <button type="button" data-testid="search-new-chat" onClick={() => { onNewChat(); onClose(); }} style={ACTION_BTN}>
                {i18n.t("search.newChat")}
              </button>
              <button type="button" data-testid="search-show-all" onClick={() => { setQ(""); void loadAll(); }} style={LINK_BTN}>
                {i18n.t("search.showAll")}
              </button>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "0 10px 12px" }}>
              {loading && items.length === 0 ? (
                <div style={EMPTY}>{i18n.t("search.loading")}</div>
              ) : items.length === 0 ? (
                <div style={EMPTY} data-testid="search-empty">
                  <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.35 }}>⌕</div>
                  <div>{i18n.t("search.empty")}</div>
                  {q.trim() ? (
                    <button type="button" onClick={() => setQ("")} style={{ ...LINK_BTN, display: "block", margin: "10px auto 0" }}>
                      {i18n.t("search.clear")}
                    </button>
                  ) : null}
                </div>
              ) : (
                GROUP_ORDER.map((key) => {
                  const list = grouped.get(key) ?? [];
                  if (list.length === 0) return null;
                  return (
                    <div key={key} style={{ marginBottom: 6 }}>
                      <div style={GROUP_LABEL}>{i18n.t(`search.group.${key}`)}</div>
                      {list.map((it) => {
                        flatIndex += 1;
                        const idx = flatIndex;
                        const active = idx === selectedIdx;
                        const isCurrent = it.session.id === activeSessionId;
                        return (
                          <div
                            key={it.session.id}
                            data-testid="search-result-row"
                            className="vh-search-row"
                            onMouseEnter={() => setSelectedIdx(idx)}
                            onClick={() => setSelectedIdx(idx)}
                            onDoubleClick={openSelected}
                            style={{
                              ...ROW,
                              background: active ? "var(--bg-page)" : "transparent",
                            }}
                          >
                            {/* Left: title + badge + snippet — takes remaining space */}
                            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", paddingRight: 8 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                <span
                                  style={{
                                    flex: "0 1 auto",
                                    minWidth: 0,
                                    fontSize: 13,
                                    fontWeight: 600,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    color: "var(--text-primary)",
                                  }}
                                  dangerouslySetInnerHTML={{
                                    __html: highlight(it.session.title || i18n.t("search.untitled"), q),
                                  }}
                                />
                                {isCurrent ? <span style={CURRENT_BADGE}>{i18n.t("search.current")}</span> : null}
                              </div>
                              {it.snippet ? (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                    marginTop: 2,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  dangerouslySetInnerHTML={{ __html: highlight(it.snippet, q) }}
                                />
                              ) : null}
                            </div>
                            {/* Right edge: time always flush-right; hover ops sit just left of time */}
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginLeft: "auto" }}>
                              <div className="vh-search-ops" style={OPS}>
                                <button type="button" title={i18n.t("search.open")} onClick={(e) => { e.stopPropagation(); setSelectedIdx(idx); openSelected(); }} style={OP_BTN}>↗</button>
                                <button type="button" title={i18n.t("search.rename")} onClick={(e) => { e.stopPropagation(); setSelectedIdx(idx); void renameSelected(); }} style={OP_BTN}>✎</button>
                                <button type="button" title={i18n.t("search.delete")} onClick={(e) => { e.stopPropagation(); setSelectedIdx(idx); void deleteSelected(); }} style={OP_BTN}>🗑</button>
                              </div>
                              <span
                                data-testid="search-result-time"
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-tertiary, var(--text-secondary))",
                                  flexShrink: 0,
                                  whiteSpace: "nowrap",
                                  textAlign: "right",
                                  minWidth: 64,
                                }}
                              >
                                {relTime(it.session.updated_at)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right preview — 距竖线 20px */}
          <div style={{ width: "54%", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{
              padding: "14px 20px",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
              fontWeight: 700,
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {selected?.session.title || i18n.t("search.previewTitle")}
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
              {!selected ? (
                <div style={EMPTY}>{i18n.t("search.previewEmpty")}</div>
              ) : previewLoading ? (
                <div style={EMPTY}>{i18n.t("search.loading")}</div>
              ) : previewMsgs.length === 0 ? (
                <div style={EMPTY}>{i18n.t("search.previewNoMessages")}</div>
              ) : (
                previewMsgs.map((m, i) => {
                  const isUser = m.role === "user";
                  return (
                    <div
                      key={i}
                      style={{
                        marginBottom: 10,
                        display: "flex",
                        justifyContent: isUser ? "flex-end" : "flex-start",
                      }}
                    >
                      <div
                        style={{
                          maxWidth: "88%",
                          padding: "8px 12px",
                          borderRadius: 10,
                          background: isUser ? "var(--bg-page)" : "#fff",
                          border: isUser ? "1px solid transparent" : "1px solid var(--border)",
                          fontSize: 12.5,
                          lineHeight: 1.55,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          color: "var(--text-primary)",
                        }}
                      >
                        {m.content.slice(0, 800)}
                        {m.content.length > 800 ? "…" : ""}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* 横线2 + 快捷键条左对齐 20px */}
        <div style={FOOTER}>
          <span>↵ {i18n.t("search.open")}</span>
          <span>↑↓ {i18n.t("search.navigate")}</span>
          <span>Esc {i18n.t("search.close")}</span>
        </div>
      </div>
      <style>{`
        .vh-search-row .vh-search-ops { opacity: 0; transition: opacity .12s; }
        .vh-search-row:hover .vh-search-ops { opacity: 1; }
        .vh-search-hl { background: rgba(41,140,255,0.12); color: var(--brand); padding: 0 1px; border-radius: 2px; }
      `}</style>
    </div>
  );
}

function bucketDate(iso: string): GroupKey {
  const t = new Date(iso).getTime();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOf7 = startOfToday - 6 * 86400000;
  const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
  if (t >= startOfToday) return "today";
  if (t >= startOfYesterday) return "yesterday";
  if (t >= startOf7) return "last_7_days";
  if (t >= startOfYear) return "this_year";
  return "earlier";
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "刚刚";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)} 小时前`;
  if (ms < 7 * 86400_000) return `${Math.floor(ms / 86400_000)} 天前`;
  const now = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()} 年 ${m} 月 ${day} 日`;
  }
  return `${m} 月 ${day} 日`;
}

function highlight(text: string, q: string): string {
  const safe = escapeHtml(text);
  const qq = q.trim();
  if (!qq) return safe;
  try {
    const re = new RegExp(`(${escapeRegExp(qq)})`, "ig");
    return safe.replace(re, '<mark class="vh-search-hl">$1</mark>');
  } catch {
    return safe;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OVERLAY: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 90, background: "rgba(15,23,42,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
};
const MODAL: CSSProperties = {
  width: "min(1080px, 92vw)", height: "min(640px, 84vh)", background: "var(--bg-card, #fff)",
  borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", overflow: "hidden",
};
const SEARCH_INPUT: CSSProperties = {
  width: "100%", height: 44, border: "1px solid var(--border)", borderRadius: 10,
  padding: "0 14px", fontSize: 14, outline: "none", background: "var(--bg-page, #f6f7f9)", color: "var(--text-primary)",
};
const ACTION_BTN: CSSProperties = {
  border: "1px solid var(--border)", background: "var(--bg-page)", borderRadius: 8,
  padding: "6px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", color: "var(--text-primary)",
};
const LINK_BTN: CSSProperties = {
  border: "none", background: "none", color: "var(--link, var(--brand))", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};
const GROUP_LABEL: CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", padding: "10px 10px 4px", letterSpacing: "0.02em",
};
const ROW: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
  height: 40, padding: "0 10px", borderRadius: 6, cursor: "pointer",
};
const OPS: CSSProperties = { display: "flex", gap: 6, flexShrink: 0, alignItems: "center" };
const OP_BTN: CSSProperties = {
  border: "none", background: "transparent", cursor: "pointer", fontSize: 13, padding: "2px 4px",
  color: "var(--text-secondary)", lineHeight: 1,
};
const CURRENT_BADGE: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, padding: "1px 6px", borderRadius: 999,
  background: "rgba(22,163,74,0.12)", color: "var(--status-completed)", border: "1px solid rgba(22,163,74,0.28)", flexShrink: 0,
};
const EMPTY: CSSProperties = {
  textAlign: "center", color: "var(--text-secondary)", fontSize: 13, padding: "48px 16px",
};
const FOOTER: CSSProperties = {
  display: "flex", gap: 18, alignItems: "center", justifyContent: "flex-start",
  padding: "10px 20px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-secondary)",
};
