import { useState, useEffect } from "react";
import { i18n } from "../../../shared/i18n/index.js";

export function ChatPage() {
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  return (
    <div data-testid="chat-page" style={{ padding: "40px", color: "var(--text-secondary)", textAlign: "center" }}>
      <div style={{ fontSize: "32px", marginBottom: "12px" }}>💬</div>
      <h2 style={{ fontWeight: 700 }}>{i18n.t("chat.title")}</h2>
      <p>{i18n.t("chat.placeholder")}</p>
    </div>
  );
}
