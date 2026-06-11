import { describe, expect, it } from "vitest";
import { classifyCodeFileBuffer } from "../../src/features/workspace/code-viewer.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("workspace code file preview classification", () => {
  it("classifies common images as base64 previews", async () => {
    const result = await classifyCodeFileBuffer(PNG_1X1, "logo.png");

    expect(result.type).toBe("image");
    expect(result.mime).toBe("image/png");
    expect(result.data_base64).toBe(PNG_1X1.toString("base64"));
    expect(result.content).toBe("");
  });

  it("keeps svg as source text for XSS safety", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const result = await classifyCodeFileBuffer(svg, "icon.svg");

    expect(result.type).toBe("text");
    expect(result.language).toBe("plaintext");
    expect(result.content).toContain("<script>");
  });

  it("downgrades images larger than 5MB to binary", async () => {
    const hugePng = Buffer.concat([PNG_1X1, Buffer.alloc(5 * 1024 * 1024)]);

    const result = await classifyCodeFileBuffer(hugePng, "huge.png");

    expect(result.type).toBe("binary");
    expect(result.mime).toBe("image/png");
    expect(result.data_base64).toBeUndefined();
  });

  it("keeps source text viewable", async () => {
    const result = await classifyCodeFileBuffer(Buffer.from("const x = 1;\n"), "main.ts");

    expect(result.type).toBe("text");
    expect(result.language).toBe("typescript");
    expect(result.content).toBe("const x = 1;\n");
  });

  it("classifies known binary formats as non-previewable binary", async () => {
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

    const result = await classifyCodeFileBuffer(pdf, "sample.pdf");

    expect(result.type).toBe("binary");
    expect(result.mime).toBe("application/pdf");
    expect(result.data_base64).toBeUndefined();
  });
});
