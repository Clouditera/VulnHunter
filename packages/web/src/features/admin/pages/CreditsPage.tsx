import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreditCodeItem } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { AdminPageHeader, adminCardStyle } from "../layout.js";

export function CreditsPage() {
  const qc = useQueryClient();
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  const [text, setText] = useState("");
  const [page, setPage] = useState(1);
  const [importResult, setImportResult] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<CreditCodeItem | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["credit-codes", page],
    queryFn: () => api.creditCodes.list({ page, page_size: 20 }),
  });

  const importMut = useMutation({
    mutationFn: () => api.creditCodes.import(text),
    onSuccess: (r) => {
      setImportResult(
        i18n
          .t("admin.credits.importResult")
          .replace("{n}", String(r.inserted))
          .replace("{m}", String(r.skipped_duplicates)),
      );
      setText("");
      qc.invalidateQueries({ queryKey: ["credit-codes"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.creditCodes.delete(id),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["credit-codes"] });
    },
  });

  const items = data?.items ?? [];
  const counts = data?.counts ?? { available: 0, assigned: 0 };
  const total = data?.total ?? 0;
  const pageSize = data?.page_size ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* ignore */
    }
  }

  return (
    <div data-testid="admin-credits-page">
      <AdminPageHeader
        page={i18n.t("admin.nav.credits")}
        title={i18n.t("admin.credits.title")}
        desc={i18n.t("admin.credits.desc")}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <StatCard
          testid="credits-stat-available"
          icon="gift"
          label={i18n.t("admin.credits.available")}
          value={counts.available}
          tone="blue"
        />
        <StatCard
          testid="credits-stat-assigned"
          icon="check-circle"
          label={i18n.t("admin.credits.assigned")}
          value={counts.assigned}
          tone="green"
        />
      </div>

      {counts.available === 0 ? (
        <div
          data-testid="credits-empty-stock-warn"
          style={{
            display: "flex",
            gap: 10,
            padding: "12px 14px",
            marginBottom: 16,
            borderRadius: 8,
            background: "rgba(217,119,6,0.1)",
            border: "1px solid rgba(217,119,6,0.35)",
            fontSize: 13,
            color: "var(--text-primary)",
          }}
        >
          <Icon name="alert-triangle" size={16} style={{ color: "#d97706", flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{i18n.t("admin.credits.stockOutTitle")}</div>
            <div style={{ color: "var(--text-secondary)" }}>{i18n.t("admin.credits.stockOutBody")}</div>
          </div>
        </div>
      ) : null}

      <section style={adminCardStyle} data-testid="credits-import-card">
        <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 600 }}>{i18n.t("admin.credits.importTitle")}</h3>
        <textarea
          data-testid="credits-import-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder={"VH-XXXX-AAAA\nVH-XXXX-BBBB\nVH-XXXX-CCCC"}
          style={{
            width: "100%",
            fontFamily: "SF Mono, JetBrains Mono, monospace",
            fontSize: 12.5,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            background: "var(--bg-page)",
            color: "var(--text-primary)",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
          <button
            type="button"
            data-testid="credits-import-btn"
            disabled={!text.trim() || importMut.isPending}
            onClick={() => importMut.mutate()}
            style={{
              padding: "8px 14px",
              border: "none",
              borderRadius: 6,
              background: !text.trim() || importMut.isPending ? "var(--bg-disabled)" : "var(--brand)",
              color: "var(--btn-primary-text)",
              fontSize: 12,
              fontWeight: 600,
              cursor: !text.trim() || importMut.isPending ? "not-allowed" : "pointer",
            }}
          >
            {importMut.isPending ? i18n.t("admin.credits.importing") : i18n.t("admin.credits.import")}
          </button>
          {importResult ? (
            <span data-testid="credits-import-result" style={{ color: "var(--status-completed)", fontSize: 13 }}>
              {importResult}
            </span>
          ) : null}
          {importMut.isError ? (
            <span style={{ color: "var(--brand)", fontSize: 13 }}>
              {importMut.error instanceof Error ? importMut.error.message : String(importMut.error)}
            </span>
          ) : null}
        </div>
      </section>

      <section style={adminCardStyle} data-testid="credits-list-card">
        <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>{i18n.t("admin.credits.listTitle")}</h3>
        {isLoading ? (
          <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>…</div>
        ) : isError ? (
          <div style={{ color: "var(--brand)", fontSize: 13 }}>{i18n.t("admin.credits.loadFailed")}</div>
        ) : items.length === 0 ? (
          <div
            data-testid="credits-empty"
            style={{
              border: "1px dashed var(--border)",
              borderRadius: 10,
              padding: "36px 20px",
              textAlign: "center",
              color: "var(--text-secondary)",
            }}
          >
            <Icon name="gift" size={28} style={{ marginBottom: 10, opacity: 0.5 }} />
            <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
              {i18n.t("admin.credits.emptyTitle")}
            </div>
            <div style={{ fontSize: 13 }}>{i18n.t("admin.credits.emptyBody")}</div>
          </div>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase" }}>
                  <th style={th}>{i18n.t("admin.credits.col.code")}</th>
                  <th style={th}>{i18n.t("admin.credits.col.status")}</th>
                  <th style={th}>{i18n.t("admin.credits.col.user")}</th>
                  <th style={th}>{i18n.t("admin.credits.col.assignedAt")}</th>
                  <th style={th}>{i18n.t("admin.credits.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} data-testid="credit-row" style={{ height: 45, borderTop: "1px solid var(--border)" }}>
                    <td style={td}>
                      <span style={{ fontFamily: "monospace", fontSize: 12.5 }}>{row.code}</span>
                      <button
                        type="button"
                        aria-label="copy"
                        onClick={() => void copyCode(row.code)}
                        style={{
                          marginLeft: 6,
                          border: "none",
                          background: "transparent",
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                          opacity: 0.55,
                        }}
                      >
                        <Icon name="copy" size={12} />
                      </button>
                    </td>
                    <td style={td}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                          background: row.status === "available" ? "rgba(37,99,235,0.1)" : "rgba(22,163,74,0.12)",
                          color: row.status === "available" ? "var(--brand)" : "var(--status-completed)",
                        }}
                      >
                        {row.status === "available"
                          ? i18n.t("admin.credits.statusAvailable")
                          : i18n.t("admin.credits.statusAssigned")}
                      </span>
                    </td>
                    <td style={td}>{row.assigned_user_email ?? "—"}</td>
                    <td style={td}>
                      {row.assigned_at ? new Date(row.assigned_at).toLocaleString() : "—"}
                    </td>
                    <td style={td}>
                      {row.status === "available" ? (
                        <button
                          type="button"
                          data-testid="credit-delete-btn"
                          onClick={() => setDeleteTarget(row)}
                          style={{
                            padding: "4px 10px",
                            border: "1px solid rgba(194,40,40,0.35)",
                            borderRadius: 5,
                            background: "transparent",
                            color: "var(--brand)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          {i18n.t("admin.credits.delete")}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={pageBtn}>
                ‹
              </button>
              <span style={{ fontSize: 12, color: "var(--text-secondary)", alignSelf: "center" }}>
                {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                style={pageBtn}
              >
                ›
              </button>
            </div>
          </>
        )}
      </section>

      {deleteTarget ? (
        <div
          data-testid="credit-delete-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "grid",
            placeItems: "center",
            zIndex: 1000,
          }}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            style={{
              width: 400,
              background: "var(--bg-card)",
              borderRadius: 12,
              padding: 24,
              border: "1px solid var(--border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>{i18n.t("admin.credits.deleteTitle")}</h3>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-secondary)" }}>
              {i18n.t("admin.credits.deleteBody")}
            </p>
            <code
              style={{
                display: "inline-block",
                padding: "4px 10px",
                borderRadius: 6,
                background: "var(--bg-page)",
                border: "1px solid var(--border)",
                fontSize: 12.5,
                marginBottom: 16,
              }}
            >
              {deleteTarget.code}
            </code>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setDeleteTarget(null)} style={pageBtn}>
                {i18n.t("admin.credits.cancel")}
              </button>
              <button
                type="button"
                data-testid="credit-delete-confirm"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate(deleteTarget.id)}
                style={{
                  padding: "7px 14px",
                  border: "none",
                  borderRadius: 6,
                  background: "var(--brand)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {i18n.t("admin.credits.delete")}
              </button>
            </div>
            {deleteMut.isError ? (
              <div style={{ color: "var(--brand)", fontSize: 12, marginTop: 10 }}>
                {deleteMut.error instanceof Error ? deleteMut.error.message : String(deleteMut.error)}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  testid,
  icon,
  label,
  value,
  tone,
}: {
  testid: string;
  icon: "gift" | "check-circle";
  label: string;
  value: number;
  tone: "blue" | "green";
}) {
  const color = tone === "blue" ? "var(--brand)" : "var(--status-completed)";
  return (
    <div
      data-testid={testid}
      style={{
        ...adminCardStyle,
        marginBottom: 0,
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: tone === "blue" ? "rgba(37,99,235,0.1)" : "rgba(22,163,74,0.12)",
          color,
          display: "grid",
          placeItems: "center",
        }}
      >
        <Icon name={icon} size={18} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      </div>
    </div>
  );
}

const th: CSSProperties = { padding: "8px 6px", fontWeight: 600 };
const td: CSSProperties = { padding: "8px 6px", color: "var(--text-primary)" };
const pageBtn: CSSProperties = {
  padding: "6px 12px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: 12,
};
