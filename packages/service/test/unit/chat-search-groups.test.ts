import { describe, expect, it } from "vitest";

/** Mirror of route grouping helper for unit coverage */
function groupSearchByDate(sessions: { id: string; updated_at: Date }[]) {
  const groups = {
    today: [] as string[],
    yesterday: [] as string[],
    last_7_days: [] as string[],
    this_year: [] as string[],
    earlier: [] as string[],
  };
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOf7 = new Date(startOfToday.getTime() - 6 * 86400000);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  for (const s of sessions) {
    const t = new Date(s.updated_at).getTime();
    if (t >= startOfToday.getTime()) groups.today.push(s.id);
    else if (t >= startOfYesterday.getTime()) groups.yesterday.push(s.id);
    else if (t >= startOf7.getTime()) groups.last_7_days.push(s.id);
    else if (t >= startOfYear.getTime()) groups.this_year.push(s.id);
    else groups.earlier.push(s.id);
  }
  return groups;
}

describe("chat search date groups", () => {
  it("buckets sessions into today / yesterday / last_7 / year / earlier", () => {
    const now = new Date();
    const today = new Date(now);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    const week = new Date(now.getTime() - 3 * 86400000);
    const year = new Date(now.getFullYear(), 0, 15);
    const earlier = new Date(now.getFullYear() - 1, 5, 1);
    const g = groupSearchByDate([
      { id: "t", updated_at: today },
      { id: "y", updated_at: yesterday },
      { id: "w", updated_at: week },
      { id: "yr", updated_at: year },
      { id: "e", updated_at: earlier },
    ]);
    expect(g.today).toContain("t");
    expect(g.yesterday).toContain("y");
    expect(g.last_7_days).toContain("w");
    expect(g.this_year).toContain("yr");
    expect(g.earlier).toContain("e");
  });
});
