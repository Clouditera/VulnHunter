import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, type ChatSessionApi } from "../shared/api/client.js";
import { i18n } from "../shared/i18n/index.js";
import { theme } from "../shared/theme/index.js";
import { Icon, type IconName } from "../shared/components/Icon.js";
import { ChangelogModal } from "../shared/components/ChangelogModal.js";
import { ChangelogDrawer } from "../shared/components/ChangelogDrawer.js";
import { shouldShowChangelog, markChangelogSeen } from "../shared/changelog.js";
import { useNotifications } from "../shared/hooks/useNotifications.js";
import { useSystemStatus } from "../features/auth/hooks/useSystemStatus.js";
import { SessionSearchModal } from "../features/chat/components/SessionSearchModal.js";
import { FeedbackModal } from "../features/feedback/components/FeedbackModal.js";
import { OnboardingHost } from "../features/onboarding/OnboardingTour.js";
import { useEdition } from "../shared/hooks/useEdition.js";

const NAV_ITEMS: Array<{ to: string; icon: IconName; labelKey: string; testid: string; tour?: string }> = [
  { to: "/chat", icon: "chat", labelKey: "nav.chat", testid: "nav-chat" },
  { to: "/tasks", icon: "tasks", labelKey: "nav.tasks", testid: "nav-tasks", tour: "nav-tasks" },
  { to: "/dashboard", icon: "dashboard", labelKey: "nav.dashboard", testid: "nav-dashboard" },
  { to: "/settings", icon: "settings", labelKey: "nav.settings", testid: "nav-settings", tour: "nav-settings" },
];

const SIDEBAR_STYLE_ID = "va-chat-first-sidebar-style";

interface RecentSession {
  id: string;
  title: string;
  updated_at: string;
  creator?: { id: string; display_name: string; email: string };
}

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [, forceUpdate] = useState(0);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    const saved = window.localStorage.getItem("va.sidebar.collapsed");
    if (saved) return saved === "true";
    return window.innerWidth < 1280;
  });
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [activeRecentId, setActiveRecentId] = useState<string | null>(null);
  const [sessionRefreshToken, setSessionRefreshToken] = useState(0);
  const [showChangelog, setShowChangelog] = useState(() => shouldShowChangelog());
  const [showChangelogDrawer, setShowChangelogDrawer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { isSaas } = useEdition();
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  useNotifications();
  const { data: systemStatus } = useSystemStatus();
  const isAdmin = systemStatus?.user?.role === "admin";

  function dismissChangelog() {
    markChangelogSeen();
    setShowChangelog(false);
  }

  useEffect(() => {
    const unsub1 = i18n.onChange(() => forceUpdate((n) => n + 1));
    const unsub2 = theme.onChange(() => forceUpdate((n) => n + 1));
    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(SIDEBAR_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SIDEBAR_STYLE_ID;
    style.textContent = `
      .va-sidebar-button:hover { background: rgba(255,255,255,0.08) !important; color: rgba(255,255,255,0.85) !important; }
      .va-sidebar-primary:hover { filter: brightness(1.1); }
      .va-sidebar-search:hover { background: rgba(255,255,255,0.08) !important; }
      .va-sidebar-session:hover { background: rgba(255,255,255,0.06) !important; }
      .va-sidebar-session:hover .va-sidebar-session-title { color: rgba(255,255,255,0.85) !important; }
      .va-sidebar-session:hover .va-sidebar-session-delete, .va-sidebar-session:focus-within .va-sidebar-session-delete { opacity: 1 !important; }
      .va-sidebar-session-delete:hover { color: var(--danger) !important; }
      .va-sidebar-scroll::-webkit-scrollbar { width: 6px; }
      .va-sidebar-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 999px; }
    `;
    document.head.appendChild(style);
  }, []);

  useEffect(() => {
    let mounted = true;
    setListError(false);
    setReachedEnd(false);
    api.chat.sessions
      .list({ limit: 20, offset: 0 })
      .then((res) => {
        if (!mounted) return;
        const sessions = res.sessions ?? [];
        setRecentSessions(sessions.filter(hasPersistedContent).map(toRecentSession));
        const next = res.next_offset ?? null;
        setNextOffset(next);
        setReachedEnd(next == null);
      })
      .catch(() => {
        if (mounted) {
          setRecentSessions([]);
          setListError(true);
          setNextOffset(null);
        }
      });
    return () => {
      mounted = false;
    };
  }, [location.pathname, location.key, sessionRefreshToken]);

  async function loadMoreSessions() {
    if (loadingMore || nextOffset == null) return;
    setLoadingMore(true);
    setListError(false);
    try {
      const res = await api.chat.sessions.list({ limit: 20, offset: nextOffset });
      const sessions = (res.sessions ?? []).filter(hasPersistedContent).map(toRecentSession);
      setRecentSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...sessions.filter((s) => !seen.has(s.id))];
      });
      const next = res.next_offset ?? null;
      setNextOffset(next);
      setReachedEnd(next == null);
    } catch {
      setListError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  function onRecentsScroll(e: React.UIEvent<HTMLUListElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      void loadMoreSessions();
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onChanged = () => setSessionRefreshToken((n) => n + 1);
    window.addEventListener("vh:sessions-changed", onChanged);
    return () => window.removeEventListener("vh:sessions-changed", onChanged);
  }, []);

  useEffect(() => {
    const onActive = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string | null }>).detail?.id;
      setActiveRecentId(id ?? null);
    };
    window.addEventListener("vh:active-session", onActive);
    return () => window.removeEventListener("vh:active-session", onActive);
  }, []);

  const currentTheme = theme.current();
  const currentLang = i18n.locale();

  const sidebarWidth = collapsed ? 64 : 288;

  async function handleLogout() {
    await api.auth.logout();
    qc.clear();
    navigate("/login");
  }

  function toggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem("va.sidebar.collapsed", String(next));
      return next;
    });
  }

  function handleNewChat() {
    setActiveRecentId(null);
    if (location.pathname === "/chat") {
      window.dispatchEvent(new CustomEvent("vh:new-chat"));
    } else {
      navigate("/chat", { state: { newChat: true } });
    }
  }

  function handleSelectSession(id: string) {
    setActiveRecentId(id);
    if (location.pathname === "/chat") {
      window.dispatchEvent(new CustomEvent("vh:select-session", { detail: { id } }));
    } else {
      navigate("/chat", { state: { selectSessionId: id } });
    }
  }

  async function handleDeleteSession(session: RecentSession) {
    const ok = window.confirm(`Delete chat “${session.title}”?`);
    if (!ok) return;
    // Always notify chat host first so the open pane clears even if delete races.
    window.dispatchEvent(new CustomEvent("vh:delete-session", { detail: { id: session.id } }));
    if (location.pathname !== "/chat") {
      // ChatProvider unmounted off /chat — host won't run API delete.
      try {
        await api.chat.sessions.delete(session.id);
      } catch {
        /* optimistic */
      }
      window.dispatchEvent(new CustomEvent("vh:sessions-changed"));
    }
    setRecentSessions((prev) => prev.filter((s) => s.id !== session.id));
    if (activeRecentId === session.id) setActiveRecentId(null);
  }

  return (
    <div
      data-testid="app-layout"
      data-theme={currentTheme}
      style={{ display: "flex", height: "100vh", background: "var(--bg-page)", overflow: "hidden" }}
    >
      <nav
        aria-label="Main navigation"
        data-testid="nav-sidebar"
        style={{
          width: sidebarWidth,
          background: "var(--nav-bg)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          height: "100vh",
          position: "sticky",
          top: 0,
          zIndex: 10,
          transition: "width 200ms ease",
          overflow: "hidden",
        }}
      >
        <SidebarHeader collapsed={collapsed} onToggle={toggleCollapse} />

        <div style={collapsed ? ACTIONS_COLLAPSED : ACTIONS_EXPANDED}>
          <button
            type="button"
            data-testid="chat-new-btn"
            className="va-sidebar-primary"
            onClick={handleNewChat}
            title={i18n.t("nav.newChat")}
            style={collapsed ? NEW_CHAT_COLLAPSED : NEW_CHAT_EXPANDED}
          >
            <Icon name="plus" size={collapsed ? 16 : 14} strokeWidth={2.5} />
            {!collapsed ? <span>{i18n.t("nav.newChat")}</span> : null}
          </button>
          {!collapsed ? (
            <button
              type="button"
              data-testid="sidebar-search-chats"
              className="va-sidebar-search"
              style={SEARCH_BUTTON}
              onClick={() => setSearchOpen(true)}
            >
              <Icon name="search" size={13} strokeWidth={1.75} />
              <span>{i18n.t("nav.searchChats")}</span>
            </button>
          ) : null}
        </div>

        <div style={collapsed ? MAIN_NAV_COLLAPSED : MAIN_NAV_EXPANDED}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-testid={item.testid}
              data-tour={item.tour}
              title={collapsed ? i18n.t(item.labelKey) : undefined}
              style={({ isActive }) => navItemStyle(isActive, collapsed)}
            >
              <Icon name={item.icon} size={18} strokeWidth={1.75} />
              {!collapsed ? <span>{i18n.t(item.labelKey)}</span> : null}
            </NavLink>
          ))}
        </div>

        {!collapsed ? (
          <section style={RECENTS_WRAP}>
            <div style={RECENTS_LABEL}>{i18n.t("sidebar.recents")}</div>
            <ul
              data-testid="sidebar-recents"
              role="list"
              className="va-sidebar-scroll"
              style={RECENTS_LIST}
              onScroll={onRecentsScroll}
            >
              {recentSessions.length === 0 ? (
                <li style={RECENTS_EMPTY}>{i18n.t("chat.noSession")}</li>
              ) : (
                recentSessions.map((session) => {
                  const active = location.pathname === "/chat" && activeRecentId === session.id;
                  return (
                    <li key={session.id} style={{ listStyle: "none" }}>
                      <div
                        className="va-sidebar-session"
                        data-testid="sidebar-session-row"
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectSession(session.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleSelectSession(session.id);
                          }
                        }}
                        style={{
                          ...SESSION_ROW,
                          background: active ? "rgba(255,255,255,0.1)" : "transparent",
                        }}
                      >
                        <div
                          className="va-sidebar-session-title"
                          style={{
                            ...SESSION_TITLE,
                            color: active ? "#fff" : "rgba(255,255,255,0.7)",
                            fontWeight: active ? 600 : 500,
                          }}
                        >
                          {session.title}
                        </div>
                        {isAdmin && session.creator ? (
                          <div
                            data-testid="sidebar-session-creator"
                            title={session.creator.email}
                            style={SESSION_CREATOR}
                          >
                            {session.creator.display_name || session.creator.email || "Unknown"}
                          </div>
                        ) : null}
                        <div style={SESSION_TIME}>{formatRelative(session.updated_at)}</div>
                        <button
                          type="button"
                          data-testid="sidebar-session-delete"
                          className="va-sidebar-session-delete"
                          aria-label="Delete chat"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteSession(session);
                          }}
                          style={SESSION_DELETE}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                    </li>
                  );
                })
              )}
              {loadingMore ? (
                <li style={RECENTS_EMPTY} data-testid="sidebar-loading-more">{i18n.t("sidebar.loadingMore")}</li>
              ) : null}
              {listError ? (
                <li style={RECENTS_EMPTY}>
                  <button type="button" data-testid="sidebar-load-retry" onClick={() => void loadMoreSessions()} style={{ background: "none", border: "none", color: "var(--brand)", cursor: "pointer", fontSize: 11 }}>
                    {i18n.t("sidebar.loadFailed")}
                  </button>
                </li>
              ) : null}
              {reachedEnd && recentSessions.length > 20 ? (
                <li style={RECENTS_EMPTY} data-testid="sidebar-no-more">{i18n.t("sidebar.noMore")}</li>
              ) : null}
            </ul>
          </section>
        ) : (
          <div style={{ flex: 1, minHeight: 0 }} />
        )}

        <div data-testid="nav-bottom" style={collapsed ? FOOTER_COLLAPSED : FOOTER_EXPANDED}>
          {isSaas ? (!collapsed ? (
            <>
            <button
              type="button"
              data-testid="sidebar-feedback"
              className="va-sidebar-button"
              onClick={() => setFeedbackOpen(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 10px",
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: "rgba(255,255,255,0.7)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                marginBottom: 4,
              }}
            >
              <Icon name="send" size={14} />
              <span>{i18n.t("nav.feedback")}</span>
            </button>
            </>
          ) : (
            <>
            <button
              type="button"
              data-testid="sidebar-feedback"
              className="va-sidebar-button"
              title={i18n.t("nav.feedback")}
              onClick={() => setFeedbackOpen(true)}
              style={{
                width: 40, height: 40, border: "none", borderRadius: 10, background: "transparent",
                color: "rgba(255,255,255,0.7)", cursor: "pointer", display: "grid", placeItems: "center", margin: "0 auto 6px",
              }}
            >
              <Icon name="send" size={15} />
            </button>
            </>
          )) : null}
          <VersionEntry
            collapsed={collapsed}
            version={systemStatus?.version?.version}
            onClick={() => setShowChangelogDrawer(true)}
          />
          <div style={collapsed ? FOOTER_TOGGLES_COLLAPSED : FOOTER_TOGGLES_EXPANDED}>
            <IconToggle
              testid="nav-lang-toggle"
              dataAttr={{ "data-lang": currentLang }}
              onClick={() => i18n.toggle()}
              title={currentLang === "zh" ? "Switch to English" : "切换到中文"}
              badge={currentLang === "zh" ? "中" : "EN"}
            >
              <Icon name="globe" size={15} />
            </IconToggle>
            <IconToggle
              testid="nav-theme-toggle"
              dataAttr={{ "data-theme": currentTheme }}
              onClick={() => theme.toggle()}
              title={currentTheme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              <Icon name={currentTheme === "dark" ? "moon" : "sun"} size={15} />
            </IconToggle>
          </div>
          <UserAvatarPopover
            collapsed={collapsed}
            onLogout={handleLogout}
            onNavigateSettings={() => navigate("/settings")}
          />
        </div>
      </nav>

      <main style={{ flex: 1, minWidth: 0, overflow: "auto", height: "100vh" }}>
        <Outlet />
      </main>

      {showChangelog && <ChangelogModal onClose={dismissChangelog} />}
      <ChangelogDrawer
        open={showChangelogDrawer}
        runtimeVersion={systemStatus?.version?.version}
        productName="VulnHunter"
        onClose={() => setShowChangelogDrawer(false)}
      />
      <SessionSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        activeSessionId={activeRecentId}
        onSelect={handleSelectSession}
        onNewChat={handleNewChat}
      />
      {isSaas ? <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} /> : null}
      {!isAdmin ? <OnboardingHost /> : null}
    </div>
  );
}

function VersionEntry({ collapsed, version, onClick }: { collapsed: boolean; version?: string; onClick: () => void }) {
  const label = version ? `VulnHunter v${version}` : "VulnHunter";
  const compact = version ? `v${version}` : "V";
  return (
    <button
      type="button"
      data-testid="nav-version-entry"
      className="va-sidebar-button"
      onClick={onClick}
      title={`${label} · ${i18n.t("nav.versionChangelog")}`}
      style={collapsed ? VERSION_COLLAPSED : VERSION_EXPANDED}
    >
      {collapsed ? compact : label}
    </button>
  );
}

function SidebarHeader({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <div style={collapsed ? HEADER_COLLAPSED : HEADER_EXPANDED}>
      <div style={LOGO_MARK}>V</div>
      {!collapsed ? <div style={BRAND_TEXT}>VulnHunter</div> : null}
      <button
        type="button"
        data-testid="sidebar-collapse-toggle"
        className="va-sidebar-button"
        onClick={onToggle}
        aria-label={collapsed ? i18n.t("sidebar.expand") : i18n.t("sidebar.collapse")}
        title={collapsed ? i18n.t("sidebar.expand") : i18n.t("sidebar.collapse")}
        style={COLLAPSE_BUTTON}
      >
        ≡
      </button>
    </div>
  );
}

function IconToggle({
  children,
  onClick,
  title,
  testid,
  dataAttr,
  badge,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  testid: string;
  dataAttr?: Record<string, string>;
  badge?: string;
}) {
  return (
    <button
      data-testid={testid}
      {...dataAttr}
      onClick={onClick}
      title={title}
      className="va-sidebar-button"
      style={ICON_TOGGLE}
    >
      {children}
      {badge && <span style={BADGE}>{badge}</span>}
    </button>
  );
}

function UserAvatarPopover({
  collapsed,
  onLogout,
  onNavigateSettings,
}: { collapsed: boolean; onLogout: () => void; onNavigateSettings: () => void }) {
  const { data: status } = useSystemStatus();
  const user = status?.user;
  const [open, setOpen] = useState(false);

  const displayName = user?.displayName || user?.email?.split("@")[0] || "User";
  const initial = (user?.displayName?.[0] || user?.email?.[0] || "U").toUpperCase();

  return (
    <div style={{ position: "relative", width: collapsed ? "40px" : "100%" }}>
      <button
        data-testid="nav-avatar"
        onClick={() => setOpen(!open)}
        className="va-sidebar-session"
        style={collapsed ? USER_BUTTON_COLLAPSED : USER_BUTTON_EXPANDED}
      >
        <span style={AVATAR}>{initial}</span>
        {!collapsed ? (
          <>
            <span style={USER_NAME}>{displayName}</span>
            <Icon name="chevron-right" size={12} style={{ color: "rgba(255,255,255,0.3)" }} />
          </>
        ) : null}
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 998 }}
          />
          <div style={popoverStyle(collapsed)}>
            <div style={{ padding: "10px 12px" }}>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                {displayName}
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {user?.email}
              </div>
              {user?.role === "admin" && (
                <span
                  style={{
                    display: "inline-block",
                    marginTop: "4px",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontSize: "10px",
                    fontWeight: 600,
                    border: "1px solid var(--brand)",
                    color: "var(--brand)",
                  }}
                >
                  Admin
                </span>
              )}
            </div>
            <div style={{ borderTop: "1px solid var(--divider)", margin: "4px 0" }} />
            <button
              onClick={() => {
                setOpen(false);
                onNavigateSettings();
              }}
              style={popoverItem}
            >
              <Icon name="settings" size={14} />
              <span>{i18n.t("nav.user.settings")}</span>
            </button>
            <button
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              style={{ ...popoverItem, color: "var(--brand)" }}
            >
              <Icon name="logout" size={14} />
              <span>{i18n.t("nav.user.logout")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function navItemStyle(isActive: boolean, collapsed: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: collapsed ? "center" : "flex-start",
    gap: collapsed ? 0 : "10px",
    width: collapsed ? "40px" : "100%",
    height: collapsed ? "40px" : undefined,
    padding: collapsed ? 0 : "9px 14px",
    borderRadius: "8px",
    textDecoration: "none",
    color: isActive ? "#fff" : "rgba(255,255,255,0.55)",
    background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
    fontSize: "13px",
    fontWeight: isActive ? 600 : 500,
    transition: "all 0.15s",
    boxSizing: "border-box",
  };
}

function hasPersistedContent(session: ChatSessionApi): boolean {
  // Empty chats (no messages) must not appear in history — fish 2026-07-23.
  // Prefer message preview; fall back to non-default titles only when preview
  // field is absent from older API responses.
  if (session.preview != null) return Boolean(session.preview.trim());
  const title = session.title?.trim() ?? "";
  return title.length > 0 && title !== "Untitled" && title !== "未命名对话";
}

function toRecentSession(session: ChatSessionApi): RecentSession {
  return {
    id: session.id,
    title: session.title?.trim() || "Untitled",
    updated_at: session.updated_at,
    creator: session.creator,
  };
}

function formatRelative(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const diffMs = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "now";
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

const HEADER_EXPANDED: CSSProperties = {
  padding: "16px 16px 12px",
  display: "flex",
  alignItems: "center",
  gap: "12px",
  flexShrink: 0,
};
const HEADER_COLLAPSED: CSSProperties = {
  padding: "16px 0 8px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "8px",
  flexShrink: 0,
};
const LOGO_MARK: CSSProperties = {
  width: "32px",
  height: "32px",
  borderRadius: "8px",
  background: "var(--brand)",
  color: "#fff",
  fontSize: "16px",
  fontWeight: 800,
  letterSpacing: "-0.5px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
const BRAND_TEXT: CSSProperties = {
  fontSize: "15px",
  fontWeight: 700,
  color: "#fff",
  letterSpacing: "-0.3px",
  flex: 1,
};
const COLLAPSE_BUTTON: CSSProperties = {
  width: "28px",
  height: "28px",
  borderRadius: "6px",
  border: "none",
  background: "transparent",
  color: "rgba(255,255,255,0.5)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "16px",
  lineHeight: 1,
};
const ACTIONS_EXPANDED: CSSProperties = {
  padding: "8px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  flexShrink: 0,
};
const ACTIONS_COLLAPSED: CSSProperties = {
  padding: "8px 0",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  flexShrink: 0,
};
const NEW_CHAT_EXPANDED: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  padding: "10px 14px",
  borderRadius: "8px",
  background: "var(--brand)",
  color: "#fff",
  fontSize: "13px",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
  boxSizing: "border-box",
};
const NEW_CHAT_COLLAPSED: CSSProperties = {
  width: "40px",
  height: "40px",
  borderRadius: "8px",
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const SEARCH_BUTTON: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  padding: "9px 14px",
  borderRadius: "8px",
  background: "rgba(255,255,255,0.06)",
  color: "rgba(255,255,255,0.4)",
  fontSize: "12px",
  fontWeight: 400,
  border: "1px solid rgba(255,255,255,0.08)",
  cursor: "default",
  boxSizing: "border-box",
};
const MAIN_NAV_EXPANDED: CSSProperties = {
  padding: "4px 12px 8px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  flexShrink: 0,
};
const MAIN_NAV_COLLAPSED: CSSProperties = {
  padding: "4px 0 8px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "2px",
  flexShrink: 0,
};
const RECENTS_WRAP: CSSProperties = {
  flex: 1,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const RECENTS_LABEL: CSSProperties = {
  padding: "12px 16px 6px",
  fontSize: "11px",
  fontWeight: 600,
  color: "rgba(255,255,255,0.35)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const RECENTS_LIST: CSSProperties = { flex: 1, overflowY: "auto", padding: "0 8px 8px", margin: 0 };
const RECENTS_EMPTY: CSSProperties = {
  listStyle: "none",
  padding: "24px 16px",
  fontSize: "12px",
  color: "rgba(255,255,255,0.35)",
  textAlign: "center",
};
const SESSION_ROW: CSSProperties = {
  padding: "8px 12px",
  borderRadius: "6px",
  cursor: "pointer",
  marginBottom: "1px",
  position: "relative",
  transition: "background 0.12s",
  outlineOffset: "-2px",
};
const SESSION_TITLE: CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  paddingRight: "16px",
};
const SESSION_CREATOR: CSSProperties = {
  fontSize: "11px",
  color: "rgba(255,255,255,0.5)",
  marginTop: "3px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  paddingRight: "16px",
};
const SESSION_TIME: CSSProperties = {
  fontSize: "11px",
  color: "rgba(255,255,255,0.3)",
  marginTop: "2px",
};
const SESSION_DELETE: CSSProperties = {
  position: "absolute",
  right: "6px",
  top: "50%",
  transform: "translateY(-50%)",
  width: "20px",
  height: "20px",
  borderRadius: "4px",
  background: "transparent",
  border: "none",
  color: "rgba(255,255,255,0.4)",
  cursor: "pointer",
  opacity: 0,
  transition: "opacity 0.12s, color 0.12s",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};
const FOOTER_EXPANDED: CSSProperties = {
  padding: "8px 12px 16px",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  flexShrink: 0,
};
const FOOTER_COLLAPSED: CSSProperties = {
  padding: "8px 0 16px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "4px",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  flexShrink: 0,
};
const VERSION_EXPANDED: CSSProperties = {
  width: "100%",
  marginBottom: "6px",
  padding: "7px 10px",
  borderRadius: "8px",
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.04)",
  color: "rgba(255,255,255,0.62)",
  fontSize: "11px",
  fontWeight: 600,
  textAlign: "left",
  cursor: "pointer",
  boxSizing: "border-box",
};
const VERSION_COLLAPSED: CSSProperties = {
  width: "40px",
  minHeight: "28px",
  padding: "4px 2px",
  borderRadius: "8px",
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.04)",
  color: "rgba(255,255,255,0.62)",
  fontSize: "10px",
  fontWeight: 700,
  cursor: "pointer",
};
const FOOTER_TOGGLES_EXPANDED: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "2px",
  padding: "4px 6px",
  marginBottom: "6px",
};
const FOOTER_TOGGLES_COLLAPSED: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "4px",
};
const ICON_TOGGLE: CSSProperties = {
  position: "relative",
  width: "32px",
  height: "32px",
  borderRadius: "6px",
  background: "transparent",
  border: "none",
  color: "rgba(255,255,255,0.6)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "all 0.15s",
};
const BADGE: CSSProperties = {
  position: "absolute",
  right: 1,
  bottom: 1,
  minWidth: "14px",
  height: "14px",
  padding: "0 3px",
  borderRadius: "7px",
  background: "var(--brand)",
  color: "#fff",
  fontSize: "9px",
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
};
const USER_BUTTON_EXPANDED: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  width: "100%",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  transition: "background 0.12s",
  boxSizing: "border-box",
};
const USER_BUTTON_COLLAPSED: CSSProperties = {
  width: "40px",
  height: "36px",
  padding: 0,
  borderRadius: "8px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const AVATAR: CSSProperties = {
  width: "28px",
  height: "28px",
  borderRadius: "50%",
  background: "var(--brand)",
  color: "#fff",
  fontSize: "12px",
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
const USER_NAME: CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  color: "rgba(255,255,255,0.8)",
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "left",
};
function popoverStyle(collapsed: boolean): CSSProperties {
  return {
    position: "fixed",
    left: collapsed ? "72px" : "296px",
    bottom: "16px",
    width: "220px",
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
    padding: "6px",
    zIndex: 999,
  };
}
const popoverItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  padding: "8px 12px",
  border: "none",
  borderRadius: "6px",
  background: "transparent",
  fontSize: "13px",
  color: "var(--text-primary)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
  transition: "background 0.12s",
};
