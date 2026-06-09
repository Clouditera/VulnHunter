import { describe, expect, it } from "vitest";
import { extractMeta, toNumberOrNull } from "../../src/features/findings/indexer.js";

describe("extractMeta — CVSS/EV scoring", () => {
  it("extracts CVSS + EV fields from canonical VulnForge metadata", () => {
    const meta = extractMeta({
      metadata: {
        vuln_type: "bof",
        vuln_type_full_name: "Off-by-One",
        severity: "high",
        file_path: "src/openvpn/dhcp.c",
        line_number: 277,
        cwe: "CWE-193 / CWE-787",
        cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:H",
        cvss_score: 7.1,
        ev_vector: "EV:1.0/R:M/E:D/C:D/I:D",
        ev_score: 7,
        ev_priority: "P1",
        ev_rationale: "EV rationale text",
      },
    });
    expect(meta.cvss_vector).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:H");
    expect(meta.cvss_score).toBe(7.1);
    expect(meta.ev_vector).toBe("EV:1.0/R:M/E:D/C:D/I:D");
    expect(meta.ev_score).toBe(7);
    expect(meta.ev_priority).toBe("P1");
    expect(meta.ev_rationale).toBe("EV rationale text");
    expect(meta.severity).toBe("high");
  });

  it("extracts engine title from canonical metadata", () => {
    const meta = extractMeta({
      metadata: {
        title: "get_instance_fn 路径遍历导致任意 Python 文件加载执行 (RCE)",
        vuln_type: "path",
        severity: "high",
      },
    });
    expect(meta.title).toBe("get_instance_fn 路径遍历导致任意 Python 文件加载执行 (RCE)");
  });

  it("leaves title undefined for raw_findings schema without title", () => {
    const meta = extractMeta({
      vulnerability: { vuln_type: "cmdi", severity: "high", file_path: "app.py", line: "1" },
    });
    expect(meta.title).toBeUndefined();
  });

  it("coerces string CVSS/EV scores to numbers", () => {
    const meta = extractMeta({
      metadata: { severity: "medium", cvss_score: "5.5" as unknown as number, ev_score: "3" as unknown as number },
    });
    expect(meta.cvss_score).toBe(5.5);
    expect(meta.ev_score).toBe(3);
  });

  it("returns null scoring for legacy findings without CVSS/EV", () => {
    const meta = extractMeta({
      metadata: { vuln_type: "xss", severity: "low", file_path: "app.py", line_number: 7 },
    });
    expect(meta.cvss_vector).toBeNull();
    expect(meta.cvss_score).toBeNull();
    expect(meta.ev_vector).toBeNull();
    expect(meta.ev_score).toBeNull();
    expect(meta.ev_priority).toBeNull();
    expect(meta.ev_rationale).toBeNull();
  });

  it("handles raw_findings vulnerability-block schema with scoring fallback", () => {
    const meta = extractMeta({
      vulnerability: {
        vuln_type: "cmdi",
        severity: "high",
        file_path: "/workspace/src/app.py",
        line: "12",
      },
      metadata: { cvss_score: 9.1, ev_priority: "P0" },
    });
    expect(meta.vuln_type).toBe("cmdi");
    expect(meta.file_path).toBe("app.py");
    expect(meta.line_number).toBe(12);
    expect(meta.cvss_score).toBe(9.1);
    expect(meta.ev_priority).toBe("P0");
  });
});

describe("toNumberOrNull", () => {
  it("parses numbers and numeric strings", () => {
    expect(toNumberOrNull(7.1)).toBe(7.1);
    expect(toNumberOrNull("5.5")).toBe(5.5);
    expect(toNumberOrNull(0)).toBe(0);
  });
  it("returns null for empty / invalid", () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
    expect(toNumberOrNull("")).toBeNull();
    expect(toNumberOrNull("abc")).toBeNull();
  });
});
