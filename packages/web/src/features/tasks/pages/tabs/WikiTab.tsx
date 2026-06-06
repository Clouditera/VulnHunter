import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type WikiAnalysisSummary,
  type WikiFeature,
  type WikiFeatureGroup,
  type WikiPageEntry,
  type WikiProfiler,
  type WikiReport,
  type WikiRiskLevel,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";
import { Markdown } from "../../../chat/components/Markdown.js";
import { Splitter, useResizableWidth } from "../../../../shared/components/Splitter.js";

/**
 * Wiki Tab — two-column layout:
 *   Left sidebar (220px): section navigation list
 *   Right content (flex): section content, one at a time
 *
 * Sections render only when their backing data exists, so an old/partial
 * scan doesn't show empty cards.
 */

type SectionKey = "profile" | "reports" | "features" | "summaries";

const SECTION_META: Record<SectionKey, { icon: "cpu" | "file-text" | "database" | "activity"; i18nKey: string }> = {
  profile:   { icon: "cpu",       i18nKey: "wiki.section.profile" },
  reports:   { icon: "file-text", i18nKey: "wiki.section.reports" },
  features:  { icon: "database",  i18nKey: "wiki.section.features" },
  summaries: { icon: "activity",  i18nKey: "wiki.section.summaries" },
};

export function WikiTab() {
  const { taskId } = useParams<{ taskId: string }>();
  const id = taskId!;
  const [leftWidth, setLeftWidth] = useResizableWidth("wiki-left-width", 260, { min: 200, max: 600 });
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["task-wiki", id],
    queryFn: () => api.tasks.wiki(id),
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Unwrap envelopes once — renderer code is cleaner downstream.
  const features = useMemo<WikiFeature[]>(
    () => (data?.features ?? []).map((e) => e.feature).filter(Boolean),
    [data?.features],
  );
  const groups = useMemo<WikiFeatureGroup[]>(
    () => (data?.featureGroups ?? []).map((e) => e.group).filter(Boolean),
    [data?.featureGroups],
  );
  const summaries = data?.analysisSummaries ?? [];
  const reports = data?.reports ?? [];

  // Build available sections list (only sections with data).
  const sections = useMemo<SectionKey[]>(() => {
    const out: SectionKey[] = [];
    if (data?.profiler) out.push("profile");
    if (reports.length > 0) out.push("reports");
    if (features.length > 0) out.push("features");
    if (summaries.length > 0) out.push("summaries");
    return out;
  }, [data?.profiler, reports.length, features.length, summaries.length]);

  const [activeSection, setActiveSection] = useState<SectionKey | null>(null);
  // Resolve effective active section: default to first available.
  const effective = activeSection && sections.includes(activeSection) ? activeSection : sections[0] ?? null;

  if (isLoading) {
    return <FullState>{i18n.t("wiki.loading")}</FullState>;
  }
  if (error) {
    return (
      <FullState tone="error">
        {i18n.t("wiki.error").replace("{msg}", (error as Error).message)}
      </FullState>
    );
  }

  // VulnForge wiki mode: knowledge/wiki/*.md present → Markdown browser.
  if (data?.pages && data.pages.length > 0) {
    return (
      <WikiMarkdownBrowser
        taskId={id}
        pages={data.pages}
        indexName={data.indexName ?? data.pages[0].name}
        indexContent={data.indexContent ?? ""}
        leftWidth={leftWidth}
        setLeftWidth={setLeftWidth}
        splitContainerRef={splitContainerRef}
      />
    );
  }

  if (sections.length === 0) {
    return (
      <FullState>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
          <Icon name="file-text" size={32} style={{ opacity: 0.35 }} />
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
            {i18n.t("wiki.empty.title")}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", maxWidth: "440px", textAlign: "center", lineHeight: 1.6 }}>
            {i18n.t("wiki.empty.hint")}
          </div>
        </div>
      </FullState>
    );
  }

  /** Count badge text for sections that have countable items */
  const badge = (key: SectionKey): string | null => {
    if (key === "features" && features.length > 0) return `${features.length}`;
    if (key === "summaries" && summaries.length > 0) return `${summaries.length}`;
    if (key === "reports" && reports.length > 0) return `${reports.length}`;
    return null;
  };

  return (
    <div
      ref={splitContainerRef}
      data-testid="wiki-tab"
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "100%",
        overflow: "hidden",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      {/* ---- Left sidebar: section navigation ---- */}
      <nav
        data-testid="wiki-sidebar"
        style={{
          width: `${leftWidth}px`,
          flexShrink: 0,
          overflow: "auto",
          background: "var(--bg-page)",
          padding: "12px 0",
        }}
      >
        {sections.map((key) => {
          const meta = SECTION_META[key];
          const active = key === effective;
          const b = badge(key);
          return (
            <button
              key={key}
              type="button"
              data-testid={`wiki-nav-${key}`}
              onClick={() => setActiveSection(key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                width: "100%",
                padding: "9px 16px",
                border: "none",
                borderLeft: active ? "2px solid var(--brand)" : "2px solid transparent",
                background: active ? "var(--bg-card)" : "transparent",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                fontSize: "13px",
                fontWeight: active ? 600 : 400,
                cursor: "pointer",
                fontFamily: "inherit",
                textAlign: "left",
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
            >
              <Icon name={meta.icon} size={14} style={{ flexShrink: 0, opacity: active ? 1 : 0.6 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {i18n.t(meta.i18nKey)}
              </span>
              {b && (
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    background: "var(--bg-page)",
                    border: active ? "1px solid var(--border)" : "none",
                    borderRadius: "8px",
                    padding: "1px 6px",
                    flexShrink: 0,
                  }}
                >
                  {b}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Resizable splitter */}
      <Splitter
        value={leftWidth}
        onResize={setLeftWidth}
        min={200}
        max={600}
        containerRef={splitContainerRef}
      />

      {/* ---- Right content area ---- */}
      <div
        data-testid="wiki-content"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "auto",
        }}
      >
        <div style={CONTENT_INNER}>
          {effective === "profile" && data!.profiler && (
            <SectionCard
              title={i18n.t("wiki.section.profile")}
              icon="cpu"
              testid="wiki-section-profile"
            >
              <ProjectProfile profiler={data!.profiler} />
            </SectionCard>
          )}

          {effective === "reports" && reports.length > 0 && (
            <SectionCard
              title={i18n.t("wiki.section.reports")}
              icon="file-text"
              testid="wiki-section-reports"
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
                {reports.map((r, idx) => (
                  <ReportBlock key={`${r.name}-${idx}`} report={r} />
                ))}
              </div>
            </SectionCard>
          )}

          {effective === "features" && features.length > 0 && (
            <SectionCard
              title={`${i18n.t("wiki.section.features")} · ${features.length}`}
              icon="database"
              testid="wiki-section-features"
            >
              <FeatureList features={features} groups={groups} />
            </SectionCard>
          )}

          {effective === "summaries" && summaries.length > 0 && (
            <SectionCard
              title={`${i18n.t("wiki.section.summaries")} · ${summaries.length}`}
              icon="activity"
              testid="wiki-section-summaries"
            >
              <SummaryList summaries={summaries} groups={groups} />
            </SectionCard>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Layout primitives                                                         */
/* -------------------------------------------------------------------------- */

const CONTENT_INNER: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
};

function FullState({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <div
      data-testid="wiki-state"
      style={{
        padding: "60px 24px",
        textAlign: "center",
        fontSize: "13px",
        color: tone === "error" ? "var(--brand)" : "var(--text-secondary)",
      }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  VulnForge wiki: Markdown directory + detail browser                       */
/* -------------------------------------------------------------------------- */

function WikiMarkdownBrowser({
  taskId,
  pages,
  indexName,
  indexContent,
  leftWidth,
  setLeftWidth,
  splitContainerRef,
}: {
  taskId: string;
  pages: WikiPageEntry[];
  indexName: string;
  indexContent: string;
  leftWidth: number;
  setLeftWidth: (w: number) => void;
  splitContainerRef: RefObject<HTMLDivElement>;
}) {
  const [active, setActive] = useState<string>(indexName);

  // Per-page content query. The index/first page is seeded from the directory
  // response so it renders with zero extra round trips; React Query caches the
  // rest as the user navigates.
  const { data: pageData, isLoading } = useQuery({
    queryKey: ["task-wiki-page", taskId, active],
    queryFn: () => api.tasks.wikiPage(taskId, active),
    refetchOnWindowFocus: false,
    retry: 1,
    initialData:
      active === indexName ? { name: indexName, content: indexContent } : undefined,
  });

  const knownNames = useMemo(() => new Set(pages.map((p) => p.name)), [pages]);

  // Switch wiki page when a relative .md link is clicked inside the Markdown.
  const handleRelativeLink = (href: string) => {
    const name = href.split(/[#?]/)[0].split("/").pop() ?? href;
    if (knownNames.has(name)) setActive(name);
  };

  const prettyTitle = (name: string) => name.replace(/\.md$/, "");

  return (
    <div
      ref={splitContainerRef}
      data-testid="wiki-tab"
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "100%",
        overflow: "hidden",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      {/* Left: wiki page list */}
      <nav
        data-testid="wiki-sidebar"
        style={{
          width: `${leftWidth}px`,
          flexShrink: 0,
          overflow: "auto",
          background: "var(--bg-page)",
          padding: "12px 0",
        }}
      >
        {pages.map((p) => {
          const isActive = p.name === active;
          return (
            <button
              key={p.name}
              type="button"
              data-testid={`wiki-page-${p.name}`}
              onClick={() => setActive(p.name)}
              title={prettyTitle(p.name)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                width: "100%",
                padding: "8px 16px",
                border: "none",
                borderLeft: isActive ? "2px solid var(--brand)" : "2px solid transparent",
                background: isActive ? "var(--bg-card)" : "transparent",
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                fontSize: "13px",
                fontWeight: isActive ? 600 : 400,
                cursor: "pointer",
                fontFamily: "inherit",
                textAlign: "left",
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
            >
              <Icon name="file-text" size={14} style={{ flexShrink: 0, opacity: isActive ? 1 : 0.6 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {prettyTitle(p.name)}
              </span>
            </button>
          );
        })}
      </nav>

      <Splitter
        value={leftWidth}
        onResize={setLeftWidth}
        min={200}
        max={600}
        containerRef={splitContainerRef}
      />

      {/* Right: Markdown content */}
      <div
        data-testid="wiki-content"
        style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "24px 28px" }}
      >
        {isLoading && !pageData ? (
          <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("wiki.loading")}</div>
        ) : pageData ? (
          <div style={{ fontSize: "13px", lineHeight: 1.7, color: "var(--text-primary)" }}>
            <Markdown content={pageData.content} onRelativeLink={handleRelativeLink} />
          </div>
        ) : (
          <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("wiki.empty.hint")}</div>
        )}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  icon,
  testid,
  children,
}: {
  title: string;
  icon: "cpu" | "file-text" | "database" | "activity";
  testid?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testid}
      style={{
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "14px 24px",
          borderBottom: "1px solid var(--divider)",
        }}
      >
        <Icon name={icon} size={15} style={{ color: "var(--text-secondary)" }} />
        <h3
          style={{
            margin: 0,
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </h3>
      </header>
      <div style={{ padding: "20px 24px" }}>{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section 1 — Project Profile                                                */
/* -------------------------------------------------------------------------- */

function ProjectProfile({ profiler: p }: { profiler: WikiProfiler }) {
  // Surface "not a valid scan target" explicitly — clearer than empty card.
  if (p.is_valid_scan_target === false) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "10px",
          padding: "14px 16px",
          background: "var(--bg-warning)",
          color: "#9a3412",
          borderRadius: "8px",
          fontSize: "13px",
          lineHeight: 1.6,
        }}
      >
        <Icon name="alert-triangle" size={16} style={{ marginTop: "2px", flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 600, marginBottom: "4px" }}>
            {i18n.t("wiki.profile.notValid")}
          </div>
          {p.classification_basis ? (
            <div style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
              {p.classification_basis}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const tech = p.tech_stack ?? {};
  const stats = p.code_stats ?? {};
  const ents = p.entry_points ?? {};
  const surface = p.attack_surface ?? {};
  const types = Object.entries(p.project_type ?? {})
    .filter(([, v]) => v?.is_type)
    .map(([k, v]) => ({ type: k, reason: v?.reason ?? null }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Basic info */}
      <DefList>
        {p.basic_info?.project_name ? (
          <Row label={i18n.t("wiki.profile.projectName")}>
            <strong>{p.basic_info.project_name}</strong>
          </Row>
        ) : null}
        {tech.language ? (
          <Row label={i18n.t("wiki.profile.language")}>
            <code style={CODE}>{tech.language}</code>
          </Row>
        ) : null}
        {tech.framework ? (
          <Row label={i18n.t("wiki.profile.frameworks")}>
            <code style={CODE}>{tech.framework}</code>
          </Row>
        ) : null}
        {tech.package_manager ? (
          <Row label={i18n.t("wiki.profile.packageManager")}>
            <code style={CODE}>{tech.package_manager}</code>
          </Row>
        ) : null}
        {stats.file_count != null ? (
          <Row label={i18n.t("wiki.profile.fileCount")}>
            {stats.file_count.toLocaleString()}
          </Row>
        ) : null}
        {stats.loc != null ? (
          <Row label={i18n.t("wiki.profile.loc")}>
            {stats.loc.toLocaleString()}
          </Row>
        ) : null}
      </DefList>

      {/* Project types — only show ones flagged true */}
      {types.length > 0 ? (
        <SubBlock title={i18n.t("wiki.profile.types")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {types.map((t) => (
              <span
                key={t.type}
                title={t.reason ?? ""}
                style={{
                  padding: "3px 10px",
                  borderRadius: "999px",
                  background: "var(--bg-page)",
                  border: "1px solid var(--border)",
                  fontSize: "12px",
                  color: "var(--text-primary)",
                  fontFamily: MONO,
                  cursor: t.reason ? "help" : "default",
                }}
              >
                {t.type}
              </span>
            ))}
          </div>
        </SubBlock>
      ) : null}

      {/* Project structure (free-form bullet list from profiler) */}
      {stats.structure && stats.structure.length > 0 ? (
        <SubBlock title={i18n.t("wiki.profile.structure")}>
          <ul style={LIST}>
            {stats.structure.map((s, i) => (
              <li key={i} style={LIST_ITEM}>
                <span style={{ color: "var(--text-primary)" }}>{s}</span>
              </li>
            ))}
          </ul>
        </SubBlock>
      ) : null}

      {/* Entry points (main + route files) */}
      {(ents.main_files?.length ?? 0) > 0 || (ents.route_files?.length ?? 0) > 0 ? (
        <SubBlock title={i18n.t("wiki.profile.entryPoints")}>
          {ents.main_files && ents.main_files.length > 0 ? (
            <div style={{ marginBottom: "8px" }}>
              <span style={MUTED}>main: </span>
              <ChipList items={ents.main_files} />
            </div>
          ) : null}
          {ents.route_files && ents.route_files.length > 0 ? (
            <div>
              <span style={MUTED}>routes: </span>
              <ChipList items={ents.route_files} />
            </div>
          ) : null}
        </SubBlock>
      ) : null}

      {/* Attack surface (free-text) */}
      {surface.high_value_targets || surface.potential_entry_points ? (
        <SubBlock title={i18n.t("wiki.profile.attackSurface")}>
          {surface.high_value_targets ? (
            <Para label={i18n.t("wiki.profile.highValue")}>
              {surface.high_value_targets}
            </Para>
          ) : null}
          {surface.potential_entry_points ? (
            <Para label={i18n.t("wiki.profile.potentialEntries")}>
              {surface.potential_entry_points}
            </Para>
          ) : null}
        </SubBlock>
      ) : null}

      {/* Potential risks (free-text) */}
      {p.potential_risks ? (
        <SubBlock title={i18n.t("wiki.profile.risks")}>
          <p style={PRE_TEXT}>{p.potential_risks}</p>
        </SubBlock>
      ) : null}

      {/* Classification rationale (collapsed by default — verbose) */}
      {p.classification_basis ? (
        <Disclosure label={i18n.t("wiki.profile.classification")}>
          <p style={PRE_TEXT}>{p.classification_basis}</p>
        </Disclosure>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section 2 — Markdown reports                                              */
/* -------------------------------------------------------------------------- */

function ReportBlock({ report }: { report: WikiReport }) {
  return (
    <article
      data-testid="wiki-report"
      data-report={report.name}
      style={{ display: "flex", flexDirection: "column", gap: "10px" }}
    >
      <Markdown content={report.content} />
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section 3 — Feature cards (grouped)                                        */
/* -------------------------------------------------------------------------- */

function FeatureList({
  features,
  groups,
}: {
  features: WikiFeature[];
  groups: WikiFeatureGroup[];
}) {
  if (groups.length === 0) {
    return (
      <div style={{ display: "grid", gap: "8px" }}>
        {features.map((f) => (
          <FeatureCard key={f.id} feature={f} />
        ))}
      </div>
    );
  }

  const byId = new Map(features.map((f) => [f.id, f]));
  const claimed = new Set<string>();
  for (const g of groups) g.feature_ids.forEach((id) => claimed.add(id));
  const orphans = features.filter((f) => !claimed.has(f.id));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      {groups.map((g) => {
        const items = g.feature_ids
          .map((id) => byId.get(id))
          .filter((f): f is WikiFeature => !!f);
        if (items.length === 0) return null;
        return (
          <div key={g.id} data-testid="wiki-feature-group" data-group-id={g.id}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "8px",
                marginBottom: "8px",
                flexWrap: "wrap",
              }}
            >
              <h4
                style={{
                  margin: 0,
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "var(--text-primary)",
                }}
              >
                {g.name}
              </h4>
              <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                {items.length}
              </span>
              {g.attack_surface ? (
                <code style={{ ...CODE, fontSize: "11px" }}>{g.attack_surface}</code>
              ) : null}
            </div>
            <div style={{ display: "grid", gap: "8px" }}>
              {items.map((f) => (
                <FeatureCard key={f.id} feature={f} />
              ))}
            </div>
          </div>
        );
      })}

      {orphans.length > 0 ? (
        <div data-testid="wiki-feature-group" data-group-id="__orphans">
          <h4
            style={{
              margin: "0 0 8px",
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-secondary)",
            }}
          >
            {i18n.t("wiki.features.other")} ({orphans.length})
          </h4>
          <div style={{ display: "grid", gap: "8px" }}>
            {orphans.map((f) => (
              <FeatureCard key={f.id} feature={f} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FeatureCard({ feature }: { feature: WikiFeature }) {
  const [open, setOpen] = useState(false);
  const r = riskColors(feature.risk_level);
  const chain = feature.data_flow?.processing_chain ?? [];
  const hasDetails =
    chain.length > 0 ||
    (feature.code_locations?.length ?? 0) > 0 ||
    (feature.related_features?.length ?? 0) > 0 ||
    !!feature.risk_rationale;

  return (
    <article
      data-testid="wiki-feature-card"
      data-feature-id={feature.id}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "8px",
        background: "var(--bg-card)",
        overflow: "hidden",
      }}
    >
      <header
        role={hasDetails ? "button" : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        onClick={() => hasDetails && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!hasDetails) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "10px 14px",
          cursor: hasDetails ? "pointer" : "default",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "2px 8px",
            borderRadius: "4px",
            background: r.bg,
            color: r.fg,
            fontSize: "10px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            flexShrink: 0,
          }}
        >
          {feature.risk_level ?? "—"}
        </span>
        <code
          style={{
            fontFamily: MONO,
            fontSize: "11px",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          {feature.id}
        </code>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {feature.name}
        </div>
        {hasDetails ? (
          <Icon
            name="chevron-down"
            size={14}
            style={{
              color: "var(--text-secondary)",
              transform: open ? "rotate(180deg)" : undefined,
              transition: "transform 0.18s",
              flexShrink: 0,
            }}
          />
        ) : null}
      </header>

      {feature.description ? (
        <div
          style={{
            padding: "0 14px 12px",
            color: "var(--text-secondary)",
            fontSize: "12.5px",
            lineHeight: 1.6,
          }}
        >
          {feature.description}
        </div>
      ) : null}

      {open ? (
        <div
          style={{
            padding: "12px 14px 14px",
            borderTop: "1px solid var(--divider)",
            background: "var(--bg-page)",
            fontSize: "12.5px",
          }}
        >
          {feature.perspective ? (
            <DetailRow label={i18n.t("wiki.feature.perspective")}>
              <code style={CODE}>{feature.perspective}</code>
            </DetailRow>
          ) : null}
          {feature.risk_rationale ? (
            <DetailRow label={i18n.t("wiki.feature.riskRationale")}>
              <span style={{ lineHeight: 1.6 }}>{feature.risk_rationale}</span>
            </DetailRow>
          ) : null}
          {chain.length > 0 ? (
            <DetailRow label={i18n.t("wiki.feature.dataFlow")}>
              <ol style={{ ...LIST, marginTop: "2px", paddingLeft: "16px", listStyle: "decimal" }}>
                {chain.map((c, i) => (
                  <li key={i} style={{ ...LIST_ITEM, display: "list-item", marginBottom: "4px" }}>
                    <span style={{ color: "var(--text-primary)" }}>{c.action}</span>
                    {c.function ? (
                      <span style={MUTED}>
                        {" — "}
                        <code style={CODE}>{c.function}</code>
                      </span>
                    ) : null}
                    {c.file ? (
                      <span style={MUTED}>
                        {" "}
                        <code style={CODE}>
                          {c.file}
                          {c.line ? `:${c.line}` : ""}
                        </code>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </DetailRow>
          ) : null}
          {feature.code_locations && feature.code_locations.length > 0 ? (
            <DetailRow label={i18n.t("wiki.feature.codeLocations")}>
              <ul style={{ ...LIST, marginTop: "2px" }}>
                {feature.code_locations.map((loc, i) => (
                  <li key={i} style={LIST_ITEM}>
                    <code style={CODE}>
                      {loc.file}
                      {loc.start_line ? `:${loc.start_line}` : ""}
                      {loc.end_line && loc.end_line !== loc.start_line ? `-${loc.end_line}` : ""}
                    </code>
                    {loc.code_type ? <span style={MUTED}>· {loc.code_type}</span> : null}
                  </li>
                ))}
              </ul>
            </DetailRow>
          ) : null}
          {feature.related_features && feature.related_features.length > 0 ? (
            <DetailRow label={i18n.t("wiki.feature.related")}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {feature.related_features.map((id) => (
                  <code key={id} style={CODE}>
                    {id}
                  </code>
                ))}
              </div>
            </DetailRow>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section 4 — Analysis summaries                                            */
/* -------------------------------------------------------------------------- */

function SummaryList({
  summaries,
  groups,
}: {
  summaries: WikiAnalysisSummary[];
  groups: WikiFeatureGroup[];
}) {
  const groupName = (gid: string) => groups.find((g) => g.id === gid)?.name ?? gid;
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      {summaries.map((s, idx) => (
        <SummaryCard key={`${s.group_id}-${idx}`} summary={s} groupName={groupName(s.group_id)} />
      ))}
    </div>
  );
}

function SummaryCard({
  summary,
  groupName,
}: {
  summary: WikiAnalysisSummary;
  groupName: string;
}) {
  const [open, setOpen] = useState(false);
  const sinks = summary.covered_sinks ?? [];
  const filesRead = summary.files_read ?? [];

  return (
    <article
      data-testid="wiki-summary-card"
      data-group-id={summary.group_id}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "8px",
        background: "var(--bg-card)",
        overflow: "hidden",
      }}
    >
      <header
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "10px 14px",
          cursor: "pointer",
        }}
      >
        {/* No leading icon — prevents shield-icon overload (3x in summaries view).
            The section's activity icon already denotes 'analysis' category. */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {groupName}
          {summary.attack_surface ? (
            <span style={{ marginLeft: "8px", fontWeight: 400 }}>
              <code style={{ ...CODE, fontSize: "11px" }}>{summary.attack_surface}</code>
            </span>
          ) : null}
        </div>
        <span style={{ fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
          {sinks.length} {i18n.t("wiki.summary.sinks")} · {filesRead.length}{" "}
          {i18n.t("wiki.summary.filesRead")}
        </span>
        <Icon
          name="chevron-down"
          size={14}
          style={{
            color: "var(--text-secondary)",
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 0.18s",
            flexShrink: 0,
          }}
        />
      </header>

      {open ? (
        <div
          style={{
            padding: "12px 14px 14px",
            borderTop: "1px solid var(--divider)",
            background: "var(--bg-page)",
            fontSize: "12.5px",
          }}
        >
          {sinks.length > 0 ? (
            <DetailRow label={i18n.t("wiki.summary.coveredSinks")}>
              <ul style={{ ...LIST, marginTop: "2px" }}>
                {sinks.map((sk, i) => (
                  <li key={i} style={LIST_ITEM}>
                    <code style={CODE}>
                      {sk.file}:{sk.line}
                    </code>
                    {sk.function ? <span style={MUTED}>· {sk.function}()</span> : null}
                    {sk.vuln_type ? (
                      <span
                        style={{
                          ...MUTED,
                          color: "var(--brand)",
                          fontWeight: 600,
                        }}
                      >
                        · {sk.vuln_type}
                      </span>
                    ) : null}
                    {sk.sink ? <span style={MUTED}>· {sk.sink}</span> : null}
                  </li>
                ))}
              </ul>
            </DetailRow>
          ) : null}
          {filesRead.length > 0 ? (
            <DetailRow label={i18n.t("wiki.summary.filesRead")}>
              <ul style={{ ...LIST, marginTop: "2px" }}>
                {filesRead.map((fr, i) => (
                  <li key={i} style={LIST_ITEM}>
                    <code style={CODE}>{fr.file}</code>
                    {fr.lines_read ? (
                      <span style={MUTED}>
                        L{fr.lines_read}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </DetailRow>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Tiny primitives                                                           */
/* -------------------------------------------------------------------------- */

const MONO = "'SF Mono', Menlo, Consolas, monospace";

const CODE: CSSProperties = {
  fontFamily: MONO,
  fontSize: "12px",
  background: "var(--bg-page)",
  padding: "1px 6px",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
};

const LIST: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const LIST_ITEM: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: "6px",
  fontSize: "12.5px",
  lineHeight: 1.55,
};

const MUTED: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "12px",
};

const PRE_TEXT: CSSProperties = {
  margin: 0,
  fontSize: "13px",
  lineHeight: 1.65,
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
};

function DefList({ children }: { children: ReactNode }) {
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "minmax(120px, max-content) 1fr",
        rowGap: "10px",
        columnGap: "16px",
        fontSize: "13px",
      }}
    >
      {children}
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt style={{ color: "var(--text-secondary)", fontSize: "12px", paddingTop: "2px" }}>
        {label}
      </dt>
      <dd style={{ margin: 0, color: "var(--text-primary)", lineHeight: 1.55 }}>
        {children}
      </dd>
    </>
  );
}

function SubBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4
        style={{
          margin: "0 0 8px",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {title}
      </h4>
      {children}
    </div>
  );
}

function Para({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "10px" }}>
      <div
        style={{
          fontSize: "11px",
          color: "var(--text-secondary)",
          marginBottom: "4px",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <p style={PRE_TEXT}>{children}</p>
    </div>
  );
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "4px 0",
          background: "transparent",
          border: "none",
          color: "var(--text-secondary)",
          fontSize: "12px",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <Icon
          name="chevron-down"
          size={12}
          style={{
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 0.18s",
          }}
        />
        {label}
      </button>
      {open ? <div style={{ marginTop: "6px" }}>{children}</div> : null}
    </div>
  );
}

function ChipList({ items }: { items: string[] }) {
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px" }}>
      {items.map((it) => (
        <code key={it} style={{ ...CODE, fontSize: "11.5px" }}>
          {it}
        </code>
      ))}
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "12px", marginBottom: "8px" }}>
      <div
        style={{
          width: "92px",
          flexShrink: 0,
          color: "var(--text-secondary)",
          fontSize: "11px",
          paddingTop: "2px",
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, minWidth: 0, color: "var(--text-primary)" }}>
        {children}
      </div>
    </div>
  );
}

function riskColors(level: WikiRiskLevel | null | undefined): {
  bg: string;
  fg: string;
} {
  switch ((level ?? "").toLowerCase()) {
    case "critical":
      return { bg: "#fecaca", fg: "#991b1b" };
    case "high":
      return { bg: "var(--bg-error)", fg: "var(--brand)" };
    case "medium":
      return { bg: "var(--bg-warning)", fg: "#9a3412" };
    case "low":
      return { bg: "#dbeafe", fg: "#1d4ed8" };
    default:
      return { bg: "var(--bg-page)", fg: "var(--text-secondary)" };
  }
}
