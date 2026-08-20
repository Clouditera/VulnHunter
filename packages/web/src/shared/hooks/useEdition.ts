/**
 * Edition gating for open-core split (Track B).
 * Source of truth: GET /api/system → edition (community | enterprise | saas).
 */
import type { Edition } from "@vulnhunter/shared";
import { useSystemStatus } from "../../features/auth/hooks/useSystemStatus.js";

export type { Edition };

/** Pure flags — unit-testable without React Query. */
export function editionFlags(edition: Edition) {
  return {
    isSaas: edition === "saas",
    isEnterpriseOrAbove: edition === "enterprise" || edition === "saas",
    isCommunity: edition === "community",
    // HALL-6: 企业私有化部署不展示 SaaS 获客营销首页；社区版本期保持现状。
    hasMarketingHome: edition !== "enterprise",
  } as const;
}

export function useEdition() {
  const { data: status, isLoading, error } = useSystemStatus();
  const edition: Edition = status?.edition ?? "community";
  return {
    edition,
    isLoading,
    error,
    ...editionFlags(edition),
  };
}
