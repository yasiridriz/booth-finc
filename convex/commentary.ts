import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { textOf } from "./vision";
import { synthesizeCommentary } from "../lib/commentaryVoice";
import { SUBSTANCE, coPrompt, coVoice } from "./personas";

const MODEL = "claude-haiku-5-5";
const MIN_AFTER_LINE_MS = 1_500; // the page also waits for the audio to be nearly done
const MIN_FILLER_GAP_MS = 15_000; // real broadcasts leave silence; at most one filler per 15 s

type Kind = "color" | "fact" | "memory" | "banter";
// Banter needs no data, so it is never used: when there is nothing real to say, the booth stays quiet.
const ROTATION: Kind[] = ["color", "fact", "memory"];
// priority: the page plays the highest first. ttl: how long a line may wait in the page's queue.
const SETTINGS: Record<Kind, { priority: number; ttlMs: number }> = {
  color: { priority: 2, ttlMs: 15_000 },
  memory: { priority: 2, ttlMs: 20_000 },
  fact: { priority: 1, ttlMs: 40_000 },
  banter: { priority: 1, ttlMs: 20_000 },
};

const COLOR_SYSTEM =
  "You are a live football commentator in a lull. Give ONE short observation about how the game is going, max 12 words, using only the game read you are given: who has the ball, where, and who is on top. Name the teams from the match line; never say shirt colours alone. Do not announce a shot, goal, foul or save unless it is in the recent events. Do not repeat or rephrase your earlier lines. No stage directions.";
const MEMORY_SYSTEM =
  "You are a live football commentator. Bring back ONE earlier moment of this match, max 16 words, using only the note and its age ('about N minutes ago'). Tie it to the present only if the game read supports it. Add no detail that is not in the note. No stage directions.";
const BANTER_SYSTEM =
  "You are an electric, hyped-up live football commentator filling a quiet second. Max 22 words. Build anticipation with ONE of: a prediction about what comes next, a question to the fans, or a remark about the atmosphere or the tempo. Use only the match line and recent events; claim no shot, goal, foul or save, and no facts about players or clubs. Vary your style and never repeat or rephrase your earlier lines. No stage directions.";
const FACT_SYSTEM =
  "You are a live football commentator in a quiet moment of play. Say ONE talking point from the note you are given, max 20 words. Use only the facts in the note; add nothing. Attribute it naturally ('according to ...', 'reportedly') when the note names a source. Never say it is breaking news unless the note says it is from the last day. No stage directions.";

export const gate = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    lastKind: Kind | null;
    recentColor: string[];
    recentGap: string[];
  }> => {
    const now = Date.now();
    const rows = await ctx.db.query("lines").order("desc").take(30);
    const isKind = (e: string): e is Kind =>
      e === "color" || e === "fact" || e === "memory" || e === "banter";
    const lastFiller = rows.find((r) => isKind(r.event));
    const ok = !rows[0] || now - rows[0]._creationTime >= MIN_AFTER_LINE_MS;
    return {
      ok,
      lastKind:
        lastFiller && isKind(lastFiller.event) ? lastFiller.event : null,
      recentColor: rows
        .filter((r) => r.event === "color")
        .slice(0, 3)
        .map((r) => r.text),
      recentGap: rows
        .filter((r) => isKind(r.event))
        .slice(0, 4)
        .map((r) => r.text),
    };
  },
});

// Reserves the next gap-line slot in one transaction. Without it, two requests that arrive together both pass the gate.
export const claimGap = internalMutation({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const now = Date.now();
    const row = await ctx.db.query("state").first();
    if (row?.gapAt && now - row.gapAt < MIN_FILLER_GAP_MS) return false;
    if (row) await ctx.db.patch("state", row._id, { gapAt: now });
    else await ctx.db.insert("state", { score: null, gapAt: now });
    return true;
  },
});

// One call produces the next gap-filling line: color, a talking point, or a memory callback, in rotation.
export const next = action({
  args: { focus: v.array(v.string()), read: v.optional(v.string()) },
  returns: v.union(v.null(), v.object({ kind: v.string(), text: v.string() })),
  handler: async (
    ctx,
    { focus, read },
  ): Promise<{ kind: string; text: string } | null> => {
    const g = await ctx.runQuery(internal.commentary.gate, {});
    if (!g.ok || !(await ctx.runMutation(internal.commentary.claimGap, {})))
      return null;

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_KEY,
    });
    const match = await ctx.runQuery(internal.booth.getState, {});
    const earlier: string[] = await ctx.runQuery(internal.memory.recent, {});
    const spoken: string[] = await ctx.runQuery(internal.booth.recentSpoken, {});
    const matchLine = `Match: ${match.teams ?? "unknown teams"}, score ${match.score ?? "unknown"}.`;

    // Start after the kind used last, so the three take turns.
    const last = g.lastKind ? ROTATION.indexOf(g.lastKind) : -1;
    const start = last < 0 ? 0 : (last + 1) % ROTATION.length;
    const order: Kind[] = [
      ...ROTATION.map((_, i) => ROTATION[(start + i) % ROTATION.length]),
    ];
    for (const kind of order) {
      let system: string;
      let user: string;

      if (kind === "color") {
        if (!read) continue;
        system = COLOR_SYSTEM;
        user = `${matchLine}\nGame read (shirt colours are not team names): ${read}\nRecent events: ${earlier.join("; ") || "none"}\nYour earlier colour lines (do not repeat): ${g.recentColor.join(" | ") || "none"}`;
      } else if (kind === "fact") {
        const t = await ctx.runMutation(internal.topics.claimTopic, { focus });
        if (!t) continue;
        system = FACT_SYSTEM;
        user = `Subject: ${t.subject} (${t.kind}). Note: ${t.detail}. Source: ${t.sourceName}. Age: ${t.age}.`;
      } else if (kind === "banter") {
        system = BANTER_SYSTEM;
        user = `${matchLine}\nRecent events: ${earlier.join("; ") || "none"}\nYour earlier lines (do not repeat): ${g.recentGap.join(" | ") || "none"}`;
      } else {
        const m = await ctx.runMutation(internal.memory.claimCallback, {});
        if (!m) continue;
        system = MEMORY_SYSTEM;
        user = `${matchLine}\nEarlier moment (${m.ago}): ${m.kind}, ${m.text}\nGame read now: ${read ?? "unknown"}`;
      }

      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 120,
        thinking: { type: "disabled" },
        // Gap lines belong to the co-commentator, who talks with the caller. The task sets what to say.
        system: `${coPrompt(match.lang)}\n\nTask (your role overrides any energy level it mentions): ${system}\n\nRules: ${SUBSTANCE}`,
        messages: [
          {
            role: "user",
            content: `${user}\n${spoken.length ? `The broadcast so far, oldest first (reply to or build on the last line when it fits; never repeat or rephrase any of it): ${spoken.join(" / ")}` : ""}`,
          },
        ],
      });
      const text = textOf(res.content);
      const voice = await synthesizeCommentary(
        text,
        kind === "banter" ? "banter" : "color",
        coVoice(match.style),
      );
      const audioId = await ctx.storage.store(voice.audio);
      const audioUrl = (await ctx.storage.getUrl(audioId)) ?? undefined;
      await ctx.runMutation(internal.booth.insertLine, {
        persona: `co:${match.lang}`,
        event: kind,
        text,
        audioUrl,
        ...SETTINGS[kind],
      });
      return { kind, text };
    }
    return null;
  },
});
