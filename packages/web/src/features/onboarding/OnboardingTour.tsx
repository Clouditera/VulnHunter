/**
 * Spotlight tour onboarding — replaces modal form.
 * Spec: design-spec-onboarding-spotlight-tour-v1.0.md
 * Seen flag: users.onboarding_dismissed_at via status / PATCH /me
 * No manual reopen entry (fish/pm: delete sidebar help button).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client.js";
import { i18n } from "../../shared/i18n/index.js";
import { useSystemStatus } from "../auth/hooks/useSystemStatus.js";

type Step = {
  anchor: string;
  titleKey: string;
  bodyKey: string;
};

const STEPS: Step[] = [
  {
    anchor: '[data-tour="nav-settings"]',
    titleKey: "onboarding.step1Title",
    bodyKey: "onboarding.step1Body",
  },
  {
    anchor: '[data-tour="nav-tasks"]',
    titleKey: "onboarding.step2Title",
    bodyKey: "onboarding.step2Body",
  },
];

const PAD = 4;
const CARD_W = 320;
const CARD_GAP = 12;

export function OnboardingTour({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [fallback, setFallback] = useState(false);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);

  const dismiss = useCallback(async () => {
    try {
      await api.auth.updateMe({ onboarding_dismissed: true });
      await qc.invalidateQueries({ queryKey: ["system-status"] });
    } catch {
      /* still close */
    }
    document.body.style.overflow = "";
    onClose();
  }, [qc, onClose]);

  const measure = useCallback(() => {
    const sel = STEPS[step]?.anchor;
    if (!sel) {
      setFallback(true);
      setRect(null);
      return;
    }
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) {
      setFallback(true);
      setRect(null);
      return;
    }
    setFallback(false);
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    setRect(r);
  }, [step]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    nextRef.current?.focus();
  }, [open, step, measure]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void dismiss();
      }
    };
    const onResize = () => measure();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, dismiss, measure]);

  if (!open) return null;

  const isLast = step >= STEPS.length - 1;
  const title = i18n.t(STEPS[step]?.titleKey ?? "onboarding.step1Title");
  const body = i18n.t(STEPS[step]?.bodyKey ?? "onboarding.step1Body");
  const stepLabel = i18n.t("onboarding.stepOf").replace("{n}", String(step + 1));

  // Spotlight hole geometry
  const hole = rect
    ? {
        top: Math.max(0, rect.top - PAD),
        left: Math.max(0, rect.left - PAD),
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null;

  // Card position: right of anchor, flip below if overflow
  let cardStyle: CSSProperties = {
    position: "fixed",
    zIndex: 1200,
    width: CARD_W,
    maxWidth: "calc(100vw - 24px)",
  };
  let arrow: "left" | "top" | "none" = "none";
  if (hole && !fallback) {
    const rightSpace = window.innerWidth - (hole.left + hole.width + CARD_GAP);
    if (rightSpace >= CARD_W + 8) {
      cardStyle = {
        ...cardStyle,
        top: Math.min(
          Math.max(12, hole.top + hole.height / 2 - 80),
          window.innerHeight - 220,
        ),
        left: hole.left + hole.width + CARD_GAP,
      };
      arrow = "left";
    } else {
      cardStyle = {
        ...cardStyle,
        top: Math.min(hole.top + hole.height + CARD_GAP, window.innerHeight - 220),
        left: Math.min(
          Math.max(12, hole.left + hole.width / 2 - CARD_W / 2),
          window.innerWidth - CARD_W - 12,
        ),
      };
      arrow = "top";
    }
  } else {
    // centered fallback card
    cardStyle = {
      ...cardStyle,
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
    };
  }

  function next() {
    if (isLast) void dismiss();
    else setStep((s) => s + 1);
  }

  return (
    <div data-testid="onboarding-tour" role="dialog" aria-modal="true">
      {/* Spotlight hole — single-element cutout via huge box-shadow */}
      {hole && !fallback ? (
        <div
          data-testid="onboarding-spotlight"
          onClick={() => next()}
          style={{
            position: "fixed",
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            borderRadius: 10,
            border: "2px solid #fff",
            boxShadow:
              "0 0 0 6px rgba(41,140,255,0.4), 0 0 24px rgba(41,140,255,0.25), 0 0 0 9999px rgba(0,0,0,0.45)",
            zIndex: 1190,
            cursor: "pointer",
            transition: "top 200ms ease, left 200ms ease, width 200ms ease, height 200ms ease",
            animation: "vh-tour-pulse 2s ease-in-out infinite",
            pointerEvents: "auto",
          }}
        />
      ) : (
        <div
          data-testid="onboarding-mask"
          onClick={() => void dismiss()}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            zIndex: 1190,
          }}
        />
      )}

      {/* Click-catcher for dark area when spotlight is shown */}
      {hole && !fallback ? (
        <div
          data-testid="onboarding-mask-click"
          onClick={() => void dismiss()}
          style={{ position: "fixed", inset: 0, zIndex: 1189 }}
        />
      ) : null}

      {/* Tooltip card */}
      <div data-testid="onboarding-card" style={cardStyle}>
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 16,
            boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
            position: "relative",
          }}
        >
          {arrow === "left" ? (
            <div
              style={{
                position: "absolute",
                left: -7,
                top: 28,
                width: 12,
                height: 12,
                background: "var(--bg-card)",
                borderLeft: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                transform: "rotate(45deg)",
              }}
            />
          ) : null}
          {arrow === "top" ? (
            <div
              style={{
                position: "absolute",
                top: -7,
                left: "50%",
                marginLeft: -6,
                width: 12,
                height: 12,
                background: "var(--bg-card)",
                borderLeft: "1px solid var(--border)",
                borderTop: "1px solid var(--border)",
                transform: "rotate(45deg)",
              }}
            />
          ) : null}

          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            {stepLabel}
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 8,
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              marginBottom: 16,
            }}
          >
            {body}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <button
              type="button"
              data-testid="onboarding-skip"
              onClick={() => void dismiss()}
              style={{
                height: 34,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-primary)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {i18n.t("onboarding.skip")}
            </button>
            <button
              ref={nextRef}
              type="button"
              data-testid="onboarding-next"
              onClick={() => next()}
              style={{
                height: 34,
                padding: "0 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--brand)",
                color: "var(--btn-primary-text)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {isLast ? i18n.t("onboarding.tourDone") : i18n.t("onboarding.tourNext")}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes vh-tour-pulse {
          0%, 100% { box-shadow: 0 0 0 6px rgba(41,140,255,0.35), 0 0 24px rgba(41,140,255,0.25), 0 0 0 9999px rgba(0,0,0,0.45); }
          50% { box-shadow: 0 0 0 6px rgba(41,140,255,0.5), 0 0 28px rgba(41,140,255,0.35), 0 0 0 9999px rgba(0,0,0,0.45); }
        }
      `}</style>
    </div>
  );
}

/** Auto-open tour once after login when not dismissed. No manual reopen. */
export function OnboardingHost() {
  const { data: status, isLoading } = useSystemStatus();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isLoading || !status?.is_authenticated) return;
    if (status.user?.role === "admin") return;
    if (status.user?.onboarding_dismissed) return;
    setOpen(true);
  }, [isLoading, status?.is_authenticated, status?.user?.role, status?.user?.onboarding_dismissed]);

  if (!open) return null;
  return <OnboardingTour open={open} onClose={() => setOpen(false)} />;
}
