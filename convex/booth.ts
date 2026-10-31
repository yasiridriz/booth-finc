import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { classify, textOf } from "./vision";

const MODEL = "claude-haiku-5-5"; // writes the spoken line, where speed matters most
const VISION_MODEL = "claude-sonnet-5-5"; // reads the frames; benched clearly better than Haiku for ~0.4s more
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";

const PERSONA =
  "You are a loud, passionate live football commentator. One short sentence, max 20 words. React to what you see. Never mention what did not happen (no 'no shot', 'no goal'). Vary your wording. No stage directions.";

// Big moments are always called. Minor ones only fill silence.
const BIG = new Set(["goal", "shot", "save", "foul", "celebration"]);
const QUIET_MS = 10000;
const REPEAT_MS = 20000;

const goals = (score: string) => score.split("-").reduce((a, b) => a + Number(b), 0);

export const latest = query({
  args: {},
  handler: async (ctx) => ctx.db.query("lines").order("desc").take(10),
});

// Starts a fresh match: forgets the score and clears the commentary feed. Samples are kept for the bench.
export const resetMatch = mutation({
  args: {},
  handler: async (ctx) => {
    for await (const row of ctx.db.query("state")) await ctx.db.delete("state", row._id);
    for await (const row of ctx.db.query("lines")) await ctx.db.delete("lines", row._id);
  },
});

export const lastLine = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ at: number; event: string } | null> => {
    const top = await ctx.db.query("lines").order("desc").first();
    return top ? { at: top._creationTime, event: top.event } : null;
  },
});

export const getState = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ score: string | null; teams: string | null }> => {
    const row = await ctx.db.query("state").first();
    return { score: row?.score ?? null, teams: row?.teams ?? null };
  },
});

export const setTeams = internalMutation({
  args: { teams: v.string() },
  handler: async (ctx, { teams }) => {
    const row = await ctx.db.query("state").first();
    if (row) await ctx.db.patch("state", row._id, { teams });
    else await ctx.db.insert("state", { score: null, teams });
  },
});

export const saveSample = internalMutation({
  args: {
    frames: v.array(v.id("_storage")),
    hint: v.optional(v.string()),
    live: v.object({ model: v.string(), event: v.string(), note: v.string(), score: v.union(v.string(), v.null()), ms: v.number() }),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("samples", args);
  },
});

export const setScore = internalMutation({
  args: { score: v.string() },
  handler: async (ctx, { score }) => {
    const row = await ctx.db.query("state").first();
    if (row) await ctx.db.patch("state", row._id, { score });
    else await ctx.db.insert("state", { score });
  },
});

export const insertLine = internalMutation({
  args: {
    persona: v.string(),
    event: v.string(),
    text: v.string(),
    audioUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("lines", args);
  },
});

// One frame in, at most one spoken line out.
export const processFrame = action({
  args: { frames: v.array(v.string()), hint: v.optional(v.string()) }, // base64 JPEGs, oldest first, no data: prefix
  handler: async (ctx, { frames, hint }): Promise<{ event: string; note: string; score: string | null }> => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const t0 = Date.now();
    const match = await ctx.runQuery(internal.booth.getState, {});
    const reading = await classify(client, VISION_MODEL, frames, hint, match.teams);
    const ms = Date.now() - t0;
    let { event } = reading;
    const { note, score } = reading;

    // Keep every frame set for the bench. Runs after the reply is known so it adds no latency to the read.
    const ids = await Promise.all(
      frames.map((f) => ctx.storage.store(new Blob([Uint8Array.from(atob(f), (c) => c.charCodeAt(0))], { type: "image/jpeg" }))),
    );
    await ctx.runMutation(internal.booth.saveSample, {
      frames: ids,
      hint,
      live: { model: VISION_MODEL, event, note, score, ms },
    });

    // The scoreboard is the ground truth for goals, even when the goal itself was missed.
    // A score that goes up by exactly one is a goal; anything else is a misread and is ignored.
    if (!match.teams && reading.teams) await ctx.runMutation(internal.booth.setTeams, { teams: reading.teams });
    const teams = match.teams ?? reading.teams;
    const prev = match.score;
    if (score && score !== prev) {
      if (!prev || goals(score) === goals(prev) + 1) {
        await ctx.runMutation(internal.booth.setScore, { score });
        if (prev) event = "goal";
      }
    } else if (!score && prev && event === "goal") {
      // The broadcaster hides the scoreboard during replays, so a "goal" without it is the replay.
      event = "replay";
    }

    if (event === "none") return { event, note, score };
    const last = await ctx.runQuery(internal.booth.lastLine, {});
    if (last) {
      const age = Date.now() - last.at;
      if (!BIG.has(event) && age < QUIET_MS) return { event, note, score };
      // Sampling is continuous, so one celebration spans many reads. Call it once.
      if (event !== "goal" && event === last.event && age < REPEAT_MS) return { event, note, score };
    }

    const speech = await client.messages.create({
      model: MODEL,
      max_tokens: 120,
      thinking: { type: "disabled" },
      system: PERSONA,
      messages: [
        {
          role: "user",
          content: `Match: ${teams ?? "unknown teams"}, score ${score ?? prev ?? "unknown"}. Event: ${event}. Detail: ${note}. Game state from tracking (may be wrong): ${hint ?? "unknown"}. Call it live; let the danger level set your intensity.`,
        },
      ],
    });
    const text = textOf(speech.content);

    let audioUrl: string | undefined;
    const tts = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
      },
    );
    if (tts.ok) {
      const id = await ctx.storage.store(await tts.blob());
      audioUrl = (await ctx.storage.getUrl(id)) ?? undefined;
    }

    await ctx.runMutation(internal.booth.insertLine, {
      persona: "commentator",
      event,
      text,
      audioUrl,
    });
    return { event, note, score };
  },
});
