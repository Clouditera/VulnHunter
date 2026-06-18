import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { describe, expect, it } from "vitest";
import { extractMeta, severityFromCvss, toNumberOrNull, type FindingYaml } from "../../src/features/findings/indexer.js";

function loadFixture(rel: string): FindingYaml {
  return yamlLoad(readFileSync(new URL(`../fixtures/vulnforge-ffmpeg-merged/${rel}`, import.meta.url), "utf-8")) as FindingYaml;
}

describe("extractMeta — CVSS/EV scoring", () => {
  it("extracts current ffmpeg-merged finding schema: title, anchors[0], CVSS-derived severity, EV=0", () => {
    const meta = extractMeta(loadFixture("findings/BUG-HYP-23-1-3.yaml"));
    expect(meta.title).toBe("OpenSSL DTLS 客户端未校验证书主机名");
    expect(meta.vuln_type).toBe("auth");
    expect(meta.cwe).toBe("CWE-297");
    expect(meta.cvss_vector).toBe("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N");
    expect(meta.cvss_score).toBe(7.4);
    expect(meta.severity).toBe("high");
    expect(meta.file_path).toBe("libavformat/tls_openssl.c");
    expect(meta.line_number).toBe(764);
    expect(meta.function).toBe("dtls_start");
    expect(meta.ev_vector).toBe("EV:1.0/R:U/E:U/C:U/I:U");
    expect(meta.ev_score).toBe(0);
    expect(meta.ev_priority).toBe("P3");
    expect(meta.ev_rationale).toContain("历史静态 finding");
  });

  it("extracts ffmpeg-merged risk transition schema with file_path/line fallback", () => {
    const meta = extractMeta(loadFixture("risks/RISK-HYP-38-5-2.yaml"));
    expect(meta.title).toBe("AV1/AAC codec string 生成信任 extradata_size 导致空指针拒绝服务风险");
    expect(meta.cvss_score).toBe(4.7);
    expect(meta.severity).toBe("medium");
    expect(meta.ev_score).toBeNull();
    expect(meta.file_path).toBe("libavformat/codecstring.c");
    expect(meta.line_number).toBe(181);
    expect(meta.function).toBe("ff_make_codec_str");
  });

  it("derives severity from CVSS when metadata.severity is absent", () => {
    const meta = extractMeta({
      metadata: {
        title: "current schema finding",
        vuln_type: "path",
        cvss_score: 4.0,
        anchors: [{ file_path: "app.py", line: "12", function: "load" }],
      },
    });
    expect(meta.severity).toBe("medium");
    expect(meta.file_path).toBe("app.py");
    expect(meta.line_number).toBe(12);
    expect(meta.function).toBe("load");
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
    expect(meta.file_path).toBe("app.py");
    expect(meta.line_number).toBe(7);
  });

  it("handles missing/invalid anchors without crashing", () => {
    const meta = extractMeta({
      metadata: {
        title: "bad anchor",
        vuln_type: "misc",
        cvss_score: 0,
        anchors: [{ file_path: "", line: "not-a-number" }],
      },
    });
    expect(meta.severity).toBe("info");
    expect(meta.file_path).toBeUndefined();
    expect(meta.line_number).toBeUndefined();
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

describe("severityFromCvss", () => {
  it("maps CVSS to platform severity without critical tier", () => {
    expect(severityFromCvss(9.8)).toBe("high");
    expect(severityFromCvss(7)).toBe("high");
    expect(severityFromCvss(4)).toBe("medium");
    expect(severityFromCvss(0.1)).toBe("low");
    expect(severityFromCvss(0)).toBe("info");
    expect(severityFromCvss(null)).toBeUndefined();
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
