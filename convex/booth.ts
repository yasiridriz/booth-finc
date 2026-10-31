import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { classify, textOf } from "./vision";
import { synthesizeCommentary } from "../lib/commentaryVoice";

const MODEL = "claude-haiku-5-5"; // writes the spoken line, where speed matters most
const VISION_MODEL = "claude-sonnet-5-5"; // reads the frames; benched clearly better than Haiku for ~0.4s more
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";

const PERSONA =
  "You are an electric, hyped-up live football commentator. One or two punchy calls, max 20 words. Always bring energy: even a simple pass crackles with anticipation, attacks build to a roar, saves and goals explode with disbelief and joy. Use exclamations, rhythm and vivid verbs, and vary them so no two calls sound alike. React only to the supplied observation; never invent teams, scores or outcomes. Name a player only if the observation already names them; never guess a name. Refer to a team by its name from the match line, not by shirt colour (the kit colours in the match line tell you which colour is which team). Never mention what did not happen (no 'no shot', 'no goal'). Vary your wording. No stage directions or audio tags; delivery is added separately.";

// Big moments are always called. Minor ones only fill silence.
const BIG = new Set(["goal", "shot", "save", "foul", "celebration"]);
const QUIET_MS = 10000;
const REPEAT_MS = 20000;

const goals = (score: string) => score.split("-").reduce((a, b) => a + Number(b), 0);

// CLI-only smoke test: exercises synthesis and storage without faking match events.
export const previewVoice = internalAction({
  args: { event: v.union(v.literal("pass"), v.literal("save"), v.literal("goal")) },
  returns: v.object({ audioUrl: v.string(), model: v.string(), voice: v.string(), ms: v.number() }),
  handler: async (ctx, { event }) => {
    const samples = {
      pass: "A composed touch, and they work it patiently across the back.",
      save: "Oh! What a save! He's clawed that out of the top corner!",
      goal: "It's in! Oh, what a finish! That is absolutely unbelievable!",
    };
    const { audio, model, voice, ms } = await synthesizeCommentary(samples[event], event);
    const id = await ctx.storage.store(audio);
    const audioUrl = await ctx.storage.getUrl(id);
    if (!audioUrl) throw new Error("Could not retrieve the commentary audio");
    return { audioUrl, model, voice, ms };
  },
});

export const latest = query({
  args: {},
  handler: async (ctx) => ctx.db.query("lines").order("desc").take(10),
});

// Starts a fresh match: forgets the score and clears the commentary feed. Samples are kept for the bench.
export const resetMatch = mutation({
  args: {},
  handler: async (ctx) => {
    // Keep the pasted roster; forget the score and teams.
    for await (const row of ctx.db.query("state")) await ctx.db.patch("state", row._id, { score: null, teams: undefined });
    for await (const row of ctx.db.query("lines")) await ctx.db.delete("lines", row._id);
    for await (const row of ctx.db.query("memory")) await ctx.db.delete("memory", row._id);
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
  handler: async (ctx): Promise<{ score: string | null; teams: string | null; roster: string | null }> => {
    const row = await ctx.db.query("state").first();
    return { score: row?.score ?? null, teams: row?.teams ?? null, roster: row?.roster ?? null };
  },
});

export const roster = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("state").first())?.roster ?? "",
});

export const setRoster = mutation({
  args: { roster: v.string() },
  handler: async (ctx, { roster }) => {
    const row = await ctx.db.query("state").first();
    if (row) await ctx.db.patch("state", row._id, { roster });
    else await ctx.db.insert("state", { score: null, roster });
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
    priority: v.optional(v.number()),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("lines", args);
  },
});

// One frame in, at most one spoken line out.
export const processFrame = action({
  args: { frames: v.array(v.string()), hint: v.optional(v.string()) }, // base64 JPEGs, oldest first, no data: prefix
  returns: v.object({ event: v.string(), note: v.string(), score: v.union(v.string(), v.null()) }),
  handler: async (ctx, { frames, hint }): Promise<{ event: string; note: string; score: string | null }> => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_KEY });

    const t0 = Date.now();
    const match = await ctx.runQuery(internal.booth.getState, {});
    const reading = await classify(client, VISION_MODEL, frames, hint, match.teams, match.roster);
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

    const earlier: string[] = await ctx.runQuery(internal.memory.recent, {});
    const speech = await client.messages.create({
      model: MODEL,
      max_tokens: 120,
      thinking: { type: "disabled" },
      system: PERSONA,
      messages: [
        {
          role: "user",
          content: `Match: ${teams ?? "unknown teams"}, score ${score ?? prev ?? "unknown"}. ${earlier.length ? `Earlier in this match (use for a storyline only when it truly connects): ${earlier.join("; ")}. ` : ""}Event: ${event}. Detail: ${note}. ${match.roster ? `Lineup: ${match.roster.replace(/\n+/g, "; ")}. ` : ""}Game state from tracking (may be wrong; its shirt colours are not team names): ${hint ?? "unknown"}. Call it live; let the danger level set your intensity.`,
        },
      ],
    });
    const text = textOf(speech.content);

    const speechAudio = await synthesizeCommentary(text, event);
    const audioId = await ctx.storage.store(speechAudio.audio);
    const audioUrl = (await ctx.storage.getUrl(audioId)) ?? undefined;

    await ctx.runMutation(internal.booth.insertLine, {
      persona: "commentator",
      event,
      text,
      audioUrl,
      priority: 3,
      ttlMs: 9000,
    });
    if (event === "goal" || event === "shot" || event === "save" || event === "foul") {
      await ctx.runMutation(internal.memory.record, { kind: event, text: score ? `${note} (score ${score})` : note });
    }
    return { event, note, score };
  },
});
