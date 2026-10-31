import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

const MIN_AGE_MS = 90_000; // a callback needs some distance from the moment
const REUSE_MS = 5 * 60_000; // never bring back the same moment twice within this time
const WEIGHT: Record<string, number> = { goal: 4, save: 3, shot: 2, foul: 1 };

const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} seconds ago` : `about ${Math.round(s / 60)} minutes ago`;
};

export const record = internalMutation({
  args: { kind: v.string(), text: v.string() },
  handler: async (ctx, { kind, text }) => {
    await ctx.db.insert("memory", { kind, text, usedCount: 0 });
  },
});

// The last few moments, newest first, for the live call to build a storyline.
export const recent = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const now = Date.now();
    const rows = await ctx.db.query("memory").order("desc").take(5);
    return rows.map((r) => `${ago(now - r._creationTime)}: ${r.kind}, ${r.text}`);
  },
});

// Picks one older moment to bring back and marks it used.
export const claimCallback = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ kind: string; text: string; ago: string } | null> => {
    const now = Date.now();
    const rows = await ctx.db.query("memory").order("desc").take(40);
    let best: (typeof rows)[number] | null = null;
    let bestScore = 0;
    for (const r of rows) {
      if (now - r._creationTime < MIN_AGE_MS) continue;
      if (r.lastUsedAt && now - r.lastUsedAt < REUSE_MS) continue;
      const score = (WEIGHT[r.kind] ?? 1) / (1 + 2 * r.usedCount);
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (!best) return null;
    await ctx.db.patch("memory", best._id, { usedCount: best.usedCount + 1, lastUsedAt: now });
    return { kind: best.kind, text: best.text, ago: ago(now - best._creationTime) };
  },
});
