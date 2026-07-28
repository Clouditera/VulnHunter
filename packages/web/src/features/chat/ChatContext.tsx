import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useChat } from "./hooks/useChat.js";

export type ChatContextValue = ReturnType<typeof useChat>;

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const chatRef = useRef(chat);
  chatRef.current = chat;

  useEffect(() => {
    const onSelect = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id) chatRef.current.selectSession(id);
    };
    const onNew = () => {
      chatRef.current.startDraftSession();
    };
    const onDelete = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      void chatRef.current.deleteSession(id).then(() => {
        window.dispatchEvent(new CustomEvent("vh:sessions-changed"));
      });
    };

    window.addEventListener("vh:select-session", onSelect);
    window.addEventListener("vh:new-chat", onNew);
    window.addEventListener("vh:delete-session", onDelete);
    return () => {
      window.removeEventListener("vh:select-session", onSelect);
      window.removeEventListener("vh:new-chat", onNew);
      window.removeEventListener("vh:delete-session", onDelete);
    };
  }, []);

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatContext() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatContext must be used inside ChatProvider");
  return ctx;
}
