import { describe, expect, it } from "vitest";
import { buildBufferPreview, CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES } from "../../src/features/chat/artifact-preview.js";

describe("chat artifact preview", () => {
  it("returns ready preview for markdown", () => {
    const result = buildBufferPreview(Buffer.from("# Report"), "text/markdown");
    expect(result).toEqual({ preview: "# Report", preview_status: "ready", preview_truncated: false });
  });

  it("marks large text previews as truncated", () => {
    const result = buildBufferPreview(Buffer.alloc(CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES + 1, "a"), "text/plain");
    expect(result.preview_status).toBe("ready");
    expect(result.preview_truncated).toBe(true);
    expect(result.preview?.length).toBe(CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES);
  });

  it("marks zip artifacts unsupported", () => {
    const result = buildBufferPreview(Buffer.from("zip"), "application/zip");
    expect(result).toEqual({ preview_status: "unsupported", preview_truncated: false });
  });
});
