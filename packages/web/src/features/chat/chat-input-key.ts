export interface ChatInputKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/** Returns true only for Enter presses that should send the current message. */
export function shouldSubmitChatInput(event: ChatInputKeyEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
