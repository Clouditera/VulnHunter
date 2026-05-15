import type { ChatArtifact, ChatMessage } from "./types.js";

export function extractChatArtifacts(messages: ChatMessage[]): ChatArtifact[] {
  const out: ChatArtifact[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const text of [m.content, ...(m.tool_calls ?? []).map((c) => c.result ?? "")]) {
      const artifact = parseChatArtifact(text);
      if (!artifact || seen.has(artifact.artifact_id)) continue;
      seen.add(artifact.artifact_id);
      out.push(artifact);
    }
  }
  return out;
}

export function stripChatArtifactJson(content: string): string {
  const artifact = parseChatArtifact(content);
  if (!artifact) return content;
  return content.replace(content.trim(), "").trim();
}

export function parseChatArtifact(text?: string | null): ChatArtifact | null {
  if (!text) return null;
  const candidates = [text.trim(), ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((m) => m[1].trim())];
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Partial<ChatArtifact>;
      if (parsed.type !== "chat_artifact" || !parsed.artifact_id || !parsed.download_url) continue;
      return {
        type: "chat_artifact",
        artifact_id: String(parsed.artifact_id),
        title: String(parsed.title ?? parsed.filename ?? "Artifact"),
        filename: String(parsed.filename ?? "artifact"),
        mime_type: String(parsed.mime_type ?? "application/octet-stream"),
        size_bytes: Number(parsed.size_bytes ?? 0),
        preview: typeof parsed.preview === "string" ? parsed.preview : undefined,
        download_url: String(parsed.download_url),
        created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}
