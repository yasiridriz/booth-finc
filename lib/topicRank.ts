// Ranking for talking points. Pure, so Convex and the page score topics the same way.
export const WINDOW_DAYS = {
  day: 1,
  week: 7,
  month: 30,
  evergreen: 365,
} as const;
export type Window = keyof typeof WINDOW_DAYS;

const HALF_LIFE_DAYS = 7;
const COOLDOWN_MS = 3 * 60 * 1000; // a topic is never repeated within this time

export type Rankable = {
  subject: string;
  interest: number; // 0-100, how much a fan of this club cares
  window: Window;
  publishedAt?: number; // ms, only when the source showed a date
  usedCount: number;
  lastUsedAt?: number;
};

export function effectiveScore(
  t: Rankable,
  now: number,
  focus: string[],
): number {
  if (t.lastUsedAt && now - t.lastUsedAt < COOLDOWN_MS) return 0;
  // Undated topics are aged at the far end of the window they were found in.
  const ageDays = t.publishedAt
    ? Math.max(0, (now - t.publishedAt) / 86_400_000)
    : WINDOW_DAYS[t.window];
  const recency = 0.5 ** (ageDays / HALF_LIFE_DAYS);
  const fresh = 0.6 ** t.usedCount;
  const subject = t.subject.toLowerCase();
  const relevance =
    focus.length === 0 ||
    focus.some((f) => subject.includes(f) || f.includes(subject))
      ? 1
      : 0.6;
  return t.interest * (0.3 + 0.7 * recency) * fresh * relevance;
}
