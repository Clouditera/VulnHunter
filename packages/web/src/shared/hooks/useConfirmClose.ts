import { useCallback, useEffect } from "react";
import { i18n } from "../i18n/index.js";
import { confirm } from "../confirm/confirm.js";

/**
 * Close-with-confirm guard for input-bearing modals (fish 2026-08-04:
 * feedback modal lost typed content on accidental overlay click).
 *
 * Returns a `requestClose` fn — when `isDirty`, asks "内容还未提交，确定关闭吗？"
 * before invoking onClose; clean modals close immediately (lightweight).
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
    void confirm({ message: i18n.t("modal.closeConfirm") }).then((confirmed) => {
      if (confirmed) onClose();
    });
  }, [onClose, isDirty]);

  useEffect(() => {
    if (!esc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [esc, requestClose]);

  return requestClose;
}
