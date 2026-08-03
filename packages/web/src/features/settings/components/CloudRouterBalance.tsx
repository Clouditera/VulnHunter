/**
 * CloudRouter balance on credential rows (collapsed glance + expanded strip).
 * Only render when API returns a finite remaining number (fish 2026-08-03):
 * keys without quota / unlimited plans / errors → hide entirely.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { formatBalanceAmount, isCloudrouterBaseUrl } from "./CloudRouterPromo.js";

type BalancePayload = {
  available?: boolean;
  remaining?: number | null;
  unit?: string | null;
  mode?: string | null;
  updated_at?: string | null;
  planName?: string | null;
};

/** True only when we have a real finite balance figure to show. */
export function hasRealCloudRouterBalance(data: BalancePayload | null | undefined): boolean {
  if (!data || data.available !== true) return false;
  if (data.mode === "unlimited") return false;
  return typeof data.remaining === "number" && Number.isFinite(data.remaining);
}

export function useCloudrouterBalance(enabled: boolean) {
  return useQuery({
    queryKey: ["promo-cloudrouter-balance"],
    queryFn: () => api.promo.cloudrouter.balance(),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Compact glance for collapsed credential row. */
export function CloudRouterBalanceGlance({ baseUrl }: { baseUrl?: string | null }) {
  const enabled = isCloudrouterBaseUrl(baseUrl);
  const { data, isFetching } = useCloudrouterBalance(enabled);
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  if (!enabled) return null;
  if (!hasRealCloudRouterBalance(data)) return null;

  const amount = formatBalanceAmount(data!.remaining, data!.unit);

  return (
    <span
      data-testid="cloudrouter-balance-glance"
      title={`${i18n.t("settings.creds.cloudRouter.balanceLabel")} ${amount}`}
      style={{
        fontSize: 11,
        color: "var(--text-secondary)",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        opacity: isFetching ? 0.7 : 1,
      }}
    >
      <span style={{ fontWeight: 500 }}>{i18n.t("settings.creds.cloudRouter.balanceLabel")} </span>
      <span style={{ fontWeight: 650, color: "var(--text-primary)" }}>{amount}</span>
    </span>
  );
}

/** Expanded strip for open credential editor card. */
export function CloudRouterBalanceStrip({ baseUrl }: { baseUrl?: string | null }) {
  const enabled = isCloudrouterBaseUrl(baseUrl);
  const qc = useQueryClient();
  const { data, isFetching, refetch } = useCloudrouterBalance(enabled);
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  if (!enabled) return null;
  if (!hasRealCloudRouterBalance(data)) return null;

  const updated =
    data?.updated_at
      ? new Date(data.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;

  return (
    <div
      data-testid="cloudrouter-balance-strip"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "10px 12px",
        marginBottom: 14,
        borderRadius: 8,
        background: "var(--brand-soft)",
        border: "1px solid var(--brand-border)",
        fontSize: 12.5,
        color: "var(--text-secondary)",
      }}
    >
      <Icon name="wallet" size={16} style={{ color: "var(--brand)", flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }} data-testid="cloudrouter-balance-value">
        <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
          {i18n.t("settings.creds.cloudRouter.balanceTitle")}{" "}
        </span>
        <strong
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--text-primary)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatBalanceAmount(data!.remaining, data!.unit)}
        </strong>
        {updated ? (
          <span style={{ marginLeft: 8, fontSize: 11.5 }}>
            · {i18n.t("settings.creds.cloudRouter.balanceUpdated").replace("{t}", updated)}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        data-testid="cloudrouter-balance-refresh"
        disabled={isFetching}
        onClick={() => {
          void qc.invalidateQueries({ queryKey: ["promo-cloudrouter-balance"] });
          void refetch();
        }}
        style={{
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
          borderRadius: 6,
          padding: "4px 10px",
          fontSize: 11.5,
          fontWeight: 600,
          color: "var(--brand)",
          cursor: isFetching ? "wait" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <Icon
          name="activity"
          size={12}
          style={{
            animation: isFetching ? "va-spin 0.8s linear infinite" : undefined,
          }}
        />
        {i18n.t("settings.creds.cloudRouter.balanceRefresh")}
      </button>
    </div>
  );
}
