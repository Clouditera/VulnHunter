import type {
  ChatArtifact,
  ChatArtifactUnion,
  ChatMessage,
  ChatReferenceArtifact,
} from "./types.js";

const REF_TYPES = new Set(["task_ref", "finding_ref", "wiki_ref", "report_ref"]);

export function extractChatArtifacts(messages: ChatMessage[]): ChatArtifact[] {
  return extractAllArtifacts(messages).filter((a): a is ChatArtifact => a.type === "chat_artifact");
}

export function extractAllArtifacts(messages: ChatMessage[]): ChatArtifactUnion[] {
  const out: ChatArtifactUnion[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const text of [m.content, ...(m.tool_calls ?? []).map((c) => c.result ?? "")]) {
      const fileArtifacts = parseAllChatArtifacts(text);
      for (const artifact of fileArtifacts) {
        if (seen.has(artifact.artifact_id)) continue;
        seen.add(artifact.artifact_id);
        out.push(artifact);
      }
      const refArtifacts = parseAllReferenceArtifacts(text);
      for (const artifact of refArtifacts) {
        if (seen.has(artifact.ref_id)) continue;
        seen.add(artifact.ref_id);
        out.push(artifact);
      }
    }
  }
  return out;
}

export function stripChatArtifactJson(content: string): string {
  let stripped = content;
  for (const block of jsonBlocks(content)) {
    const fileArtifact = parseChatArtifact(block.json);
    const refArtifact = parseReferenceArtifact(block.json);
    if (!fileArtifact && !refArtifact) continue;
    stripped = stripped.replace(block.raw, "").trim();
  }
  const whole = stripped.trim();
  if (parseChatArtifact(whole) || parseReferenceArtifact(whole)) return "";
  return stripped;
}

export function parseChatArtifact(text?: string | null): ChatArtifact | null {
  return parseAllChatArtifacts(text)[0] ?? null;
}

export function parseReferenceArtifact(text?: string | null): ChatReferenceArtifact | null {
  return parseAllReferenceArtifacts(text)[0] ?? null;
}

function parseAllChatArtifacts(text?: string | null): ChatArtifact[] {
  if (!text) return [];
  const out: ChatArtifact[] = [];
  for (const c of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(c) as Partial<ChatArtifact>;
      if (parsed.type !== "chat_artifact" || !parsed.artifact_id || !parsed.download_url) continue;
      out.push({
        type: "chat_artifact",
        artifact_id: String(parsed.artifact_id),
        title: String(parsed.title ?? parsed.filename ?? "Artifact"),
        filename: String(parsed.filename ?? "artifact"),
        mime_type: String(parsed.mime_type ?? "application/octet-stream"),
        size_bytes: Number(parsed.size_bytes ?? 0),
        preview: typeof parsed.preview === "string" ? parsed.preview : undefined,
        preview_status: parsed.preview_status,
        preview_truncated: parsed.preview_truncated,
        download_url: String(parsed.download_url),
        created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
      });
    } catch {
      // try next candidate
    }
  }
  return out;
}

function parseAllReferenceArtifacts(text?: string | null): ChatReferenceArtifact[] {
  if (!text) return [];
  const out: ChatReferenceArtifact[] = [];
  for (const c of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      if (!parsed?.type || !REF_TYPES.has(String(parsed.type)) || !parsed.task_id) continue;
      const type = String(parsed.type) as ChatReferenceArtifact["type"];
      const taskId = String(parsed.task_id);
      const findingKey = stringOrUndefined(parsed.finding_key);
      const reportId = stringOrUndefined(parsed.report_id);
      const section = stringOrUndefined(parsed.section);
      out.push({
        type,
        ref_id: `ref-${type}-${taskId}-${findingKey ?? reportId ?? section ?? "root"}`,
        task_id: taskId,
        finding_key: findingKey,
        report_id: reportId,
        section,
        title: stringOrUndefined(parsed.title),
        summary: stringOrUndefined(parsed.summary),
      });
    } catch {
      // try next candidate
    }
  }
  return out;
}

function jsonCandidates(text: string): string[] {
  const candidates = [text.trim(), ...jsonBlocks(text).map((b) => b.json)];
  return candidates.filter(Boolean);
}

function jsonBlocks(text: string): Array<{ raw: string; json: string }> {
  return Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((m) => ({
    raw: m[0],
    json: m[1].trim(),
  }));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
