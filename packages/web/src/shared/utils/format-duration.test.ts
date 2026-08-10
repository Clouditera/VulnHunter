import { describe, expect, it } from "vitest";
import { formatDurationMinutes, formatDurationMs, toDurationMs } from "./duration.js";

describe("toDurationMs / formatDurationMs (task-e95101cb)", () => {
  it("coerces BIGINT string so arithmetic never concatenates", () => {
    const acc = toDurationMs("8702468")!;
    const live = acc + 5_000_000;
    expect(typeof live).toBe("number");
    expect(formatDurationMs(live)).toMatch(/^3h /);
    expect(formatDurationMs(live)).not.toMatch(/2417352/);
  });

  it("formats 8702468ms as ~2h 25m (not 2417352h)", () => {
    expect(formatDurationMs(8_702_468)).toBe("2h 25m");
    expect(formatDurationMs("8702468")).toBe("2h 25m");
  });

  it("handles null/invalid", () => {
    expect(toDurationMs(null)).toBeNull();
    expect(toDurationMs(undefined)).toBeNull();
    expect(toDurationMs("")).toBeNull();
    expect(toDurationMs("nope")).toBeNull();
    expect(toDurationMs(-1)).toBeNull();
    expect(formatDurationMs(null)).toBe("—");
  });

  it("list minutes style", () => {
    expect(formatDurationMinutes(8_702_468)).toBe("145 min");
    expect(formatDurationMinutes("8702468")).toBe("145 min");
  });

  it("sub-minute and sub-hour", () => {
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(125_000)).toBe("2m 5s");
    expect(formatDurationMs(3_600_000)).toBe("1h 0m");
  });
});
