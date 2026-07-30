/**
 * Admin session on business site (or other invalid session): toast + hard redirect
 * to login — no intermediate full page (fish 2026-07-30).
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { toast } from "../../../shared/toast/toast.js";

export function SessionInvalidPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    toast.error(i18n.t("session.invalidBody") || "登录态已失效，请重新登录");
    (async () => {
      try {
        await api.auth.logout();
      } catch {
        /* cookie may already be dead */
      }
      if (cancelled) return;
      qc.clear();
      navigate("/login", { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, qc]);

  // Minimal blank while redirecting — never a "会话无效" card page.
  return (
    <div
      data-testid="session-invalid-redirect"
      style={{
        minHeight: "100vh",
        background: "var(--bg-page)",
      }}
    />
  );
}
