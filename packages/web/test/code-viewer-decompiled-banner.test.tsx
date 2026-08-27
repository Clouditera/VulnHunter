// @vitest-environment jsdom

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeViewer } from "../src/features/tasks/components/CodeViewer.js";

/**
 * HALL-25 P0 (frontend): when the workspace file response carries
 * `decompiled_from` (the platform resolved a .class request through the
 * decompile manifest), the viewer must show a banner explaining that this
 * is decompiled code and which .class it came from. Without the field the
 * viewer renders exactly as before.
 */

let container: HTMLDivElement;
let root: Root;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(props: Record<string, unknown>) {
  act(() => {
    root.render(<CodeViewer path={String(props.path ?? "a.java")} file={props.file as any} loading={false} vulnLines={new Set<number>()} />);
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

const PLAIN_FILE = {
  content: "class Bar {}\n",
  language: "java",
  total_lines: 1,
  size_bytes: 13,
  is_truncated: false,
  type: "text" as const,
};

describe("CodeViewer decompiled banner (HALL-25)", () => {
  it("renders the decompiled-origin banner when decompiled_from is present", () => {
    render({
      path: "WEB-INF/classes/com/foo/Bar.class",
      file: { ...PLAIN_FILE, decompiled_from: "WEB-INF/classes/com/foo/Bar.class", resolved_path: ".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java" },
    });
    const banner = container.querySelector('[data-testid="workspace-code-decompiled-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("WEB-INF/classes/com/foo/Bar.class");
  });

  it("no banner without decompiled_from (legacy behavior)", () => {
    render({ path: "src/Main.java", file: PLAIN_FILE });
    expect(container.querySelector('[data-testid="workspace-code-decompiled-banner"]')).toBeNull();
  });

  it("banner is absent for binary files even with the field", () => {
    render({
      path: "x/Dep.class",
      file: { content: "", language: "binary", total_lines: 0, size_bytes: 5, is_truncated: false, type: "binary" as const },
    });
    expect(container.querySelector('[data-testid="workspace-code-decompiled-banner"]')).toBeNull();
  });
});
