/**
 * Duration helpers (milliseconds).
 *
 * Postgres BIGINT columns often arrive as JSON **strings**. Using them in
 * `acc + (now - start)` string-concats and yields multi-million-hour displays
 * (e.g. 2417352h). Always coerce via toDurationMs before arithmetic/format.
 * fish 2026-08-10 / task-e95101cb.
 */

/** Coerce duration-like values to a finite non-negative millisecond number. */
export function toDurationMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Format a wall-clock duration given in **milliseconds**. */
export function formatDurationMs(ms: unknown): string {
  const n = toDurationMs(ms);
  if (n == null) return "—";
  const totalSec = Math.floor(n / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

/** Compact list-style: whole minutes ("12 min"). */
export function formatDurationMinutes(ms: unknown): string {
  const n = toDurationMs(ms);
  if (n == null || n === 0) return "—";
  return `${Math.round(n / 60_000)} min`;
}
