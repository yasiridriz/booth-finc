import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { classify, textOf } from "./vision";

const MODEL = "claude-haiku-5-5";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";

const PERSONA =
  "You are a loud, passionate live football commentator. One short sentence, max 20 words. React to what you see. Never mention what did not happen (no 'no shot', 'no goal'). Vary your wording. No stage directions.";

// Big moments are always called. Minor ones only fill silence.
const BIG = new Set(["goal", "shot", "save", "foul", "celebration"]);
const QUIET_MS = 10000;

export const latest = query({
  args: {},
  handler: async (ctx) => ctx.db.query("lines").order("desc").take(10),
});

export const lastLineTime = internalQuery({
  args: {},
  handler: async (ctx): Promise<number | null> => {
    const top = await ctx.db.query("lines").order("desc").first();
    return top?._creationTime ?? null;
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

// Stores the new score and returns the previous one.
export const setScore = internalMutation({
  args: { score: v.string() },
  handler: async (ctx, { score }): Promise<string | null> => {
    const row = await ctx.db.query("state").first();
    if (!row) {
      await ctx.db.insert("state", { score });
      return null;
    }
    await ctx.db.patch("state", row._id, { score });
    return row.score;
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
    const reading = await classify(client, MODEL, frames, hint);
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
      live: { model: MODEL, event, note, score, ms },
    });

    // The scoreboard is the ground truth for goals, even when the goal itself was missed.
    if (score) {
      const prev: string | null = await ctx.runMutation(internal.booth.setScore, { score });
      if (prev && prev !== score) event = "goal";
    }

    if (event === "none") return { event, note, score };
    if (!BIG.has(event)) {
      const last = await ctx.runQuery(internal.booth.lastLineTime, {});
      if (last !== null && Date.now() - last < QUIET_MS) return { event, note, score };
    }

    const speech = await client.messages.create({
      model: MODEL,
      max_tokens: 120,
      thinking: { type: "disabled" },
      system: PERSONA,
      messages: [
        {
          role: "user",
          content: `Event: ${event}. Detail: ${note}. Call it live.`,
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
