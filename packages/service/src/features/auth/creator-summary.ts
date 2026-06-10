export interface CreatorSummary {
  id: string;
  display_name: string;
  email: string;
}

export interface UserSummary {
  id: string;
  display_name: string;
  email: string;
}

export function uniqueCreatorIds<T, K extends keyof T>(rows: T[], field: K): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row[field])
        .filter((value): value is Extract<T[K], string> => typeof value === "string" && value.length > 0),
    ),
  ];
}

export function attachCreatorSummaries<T, K extends keyof T>(
  role: string,
  rows: T[],
  field: K,
  users: Iterable<UserSummary>,
): Array<T & { creator?: CreatorSummary }> {
  if (role !== "admin") return rows as Array<T & { creator?: CreatorSummary }>;
  const byId = new Map([...users].map((u) => [u.id, u]));
  return rows.map((row) => {
    const id = row[field];
    if (typeof id !== "string" || !id) return row as T & { creator?: CreatorSummary };
    const user = byId.get(id);
    return {
      ...row,
      creator: user
        ? { id, display_name: user.display_name, email: user.email }
        : { id, display_name: "Unknown", email: "" },
    };
  });
}
