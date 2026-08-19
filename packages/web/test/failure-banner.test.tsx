// @vitest-environment jsdom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FailureBanner } from "../src/features/tasks/components/FailureBanner.js";

/**
 * HALL-4: FailureBanner must render engine-reported structured failure JSON
 * as readable text (Chinese message + code badge + collapsed raw details),
 * and keep rendering legacy plain-text reasons unchanged.
 */

const FRAME = "\u0002\u0000\u0000\u0000\u0000\u0000\u000000";
const STRUCTURED = JSON.stringify({
  code: "ERR_PREPARE_FAILED",
  message: `Prepare 失败 (退出码 4): ${FRAME}02:57:41 [youngflow.runner] ERROR [prepare] ✕ API error (1): 403: {"code":"no_default_group","message":"no default group available for this model"}`,
  details: { engineError: "exit code 4" },
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone requires matching them
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u200B-\u200D]/;

let container: HTMLDivElement;
let root: Root;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(reason: string | null) {
  act(() => {
    root.render(
      <MemoryRouter>
        <FailureBanner failureReason={reason} />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FailureBanner (HALL-4)", () => {
  it("renders structured payload: readable message, code badge, no control chars", () => {
    render(STRUCTURED);
    const reason = container.querySelector('[data-testid="task-failure-reason"]');
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toContain("Prepare 失败 (退出码 4)");
    expect(reason?.textContent).toContain("no default group available for this model");
    expect(reason?.textContent).not.toMatch(CONTROL_CHAR_RE);
    // code badge
    const badge = container.querySelector('[data-testid="task-failure-code"]');
    expect(badge?.textContent).toBe("ERR_PREPARE_FAILED");
    // raw JSON tucked into a collapsed details block by default
    expect(container.querySelector('[data-testid="task-failure-details"]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-failure-details-toggle"]',
    );
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());
    const details = container.querySelector('[data-testid="task-failure-details"]');
    expect(details?.textContent).toContain('"code":"ERR_PREPARE_FAILED"');
    expect(details?.textContent).not.toMatch(CONTROL_CHAR_RE);
  });

  it("renders registry guiding action for known codes", () => {
    render(
      JSON.stringify({
        code: "ERR_MODEL_UPSTREAM",
        message: "模型服务返回错误：上游 403",
      }),
    );
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-failure-action"]',
    );
    expect(action).not.toBeNull();
  });

  it("legacy plain text renders cleaned, without structured extras", () => {
    render("Prepare 失败 (退出码 4): 直接纯文本原因");
    const reason = container.querySelector('[data-testid="task-failure-reason"]');
    expect(reason?.textContent).toContain("直接纯文本原因");
    expect(reason?.textContent).not.toMatch(CONTROL_CHAR_RE);
    expect(container.querySelector('[data-testid="task-failure-code"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-failure-details-toggle"]')).toBeNull();
  });

  it("empty reason falls back to the no-reason copy", () => {
    render(null);
    const reason = container.querySelector('[data-testid="task-failure-reason"]');
    expect(reason?.textContent).toBe("未提供失败原因。查看日志获取详细信息。");
  });

  it("malformed JSON falls back to plain-text rendering", () => {
    render('{"code":"ERR_PREPARE_FAILED","message":"truncated');
    const reason = container.querySelector('[data-testid="task-failure-reason"]');
    expect(reason?.textContent).toContain("truncated");
    expect(container.querySelector('[data-testid="task-failure-code"]')).toBeNull();
  });
});
