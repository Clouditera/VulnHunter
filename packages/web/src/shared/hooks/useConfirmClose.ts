import { useCallback, useEffect } from "react";
import { i18n } from "../i18n/index.js";
import { confirm, hasPendingDialog, wasEscHandledByHost } from "../confirm/confirm.js";

/**
 * Unified modal close guard (fish 2026-08-07 定稿, task-d3f85fe5):
 * - Backdrop NEVER closes (all modals, no per-type customization)
 * - ESC closes; when the form holds content (isDirty), ask first with the
 *   fish-approved copy: title 关闭前确认 / body 表单已有填写内容… /
 *   【继续填写】primary (cancel) + 【放弃内容并关闭】danger (confirm)
 * - Clean modals close immediately (lightweight)
 *
 * Returns a `requestClose` fn to wire into the ✕ button and any other close
 * affordance (backdrop clicks must not call it at all).
 *
 * `esc` gates the ESC-key listener: pass the modal's `open` flag for
 * always-mounted modals (FeedbackModal); leave false for modals that
 * only mount while open and did not previously close on ESC.
 */
export function useConfirmClose(onClose: () => void, isDirty: boolean, esc: boolean | string = false) {
  const requestClose = useCallback(() => {
    if (!isDirty) {
      onClose();
      return;
    }
    void confirm({
      title: i18n.t("modal.unsaved.title"),
      message: i18n.t("modal.unsaved.message"),
      confirmText: i18n.t("modal.unsaved.discard"),
      cancelText: i18n.t("modal.unsaved.keep"),
      danger: true,
    }).then((confirmed) => {
      if (confirmed) onClose();
    });
  }, [onClose, isDirty]);

  useEffect(() => {
    if (!esc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The shared confirm host handles its own ESC (= 继续填写/cancel);
      // don't let the same keypress also fire the underlying modal's guard.
      // Identity check FIRST: the host's window-capture settle() clears the
      // pending flag synchronously, so a state check alone can't see that
      // this very keypress was already consumed (fish 2026-08-09 layer 3).
      if (wasEscHandledByHost(e)) return;
      if (hasPendingDialog()) return;
      requestClose();
    };
    // CAPTURE phase (fish 2026-08-09 ESC saga): a bubble listener never
    // receives real keyboard ESC in the admin console — something on the
    // target→document bubble path eats it (QA probe matrix: capture probe
    // fires, bubble hook doesn't, document-target dispatch works). Document
    // capture is the page-wide earliest point and cannot be cut off by any
    // subtree stopPropagation.
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [esc, requestClose]);

  return requestClose;
}
