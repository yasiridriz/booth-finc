import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { classify, textOf } from "./vision";
import { synthesizeCommentary } from "../lib/commentaryVoice";
import { DEFAULT_LANG, DEFAULT_STYLE, STYLES, isLang, isStyle, personaPrompt, type Lang, type StyleId } from "./personas";

const MODEL = "claude-haiku-5-5"; // writes the spoken line, where speed matters most
const LIVE_VOICE_MODEL = "eleven_flash_v2_5";
const VISION_MODEL = "claude-sonnet-5-5"; // reads the frames; benched clearly better than Haiku for ~0.4s more
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";

// Shared rules for event calls. The style and language come first from convex/personas.ts and set the voice.
const PERSONA =
  "One or two punchy calls, max 20 words (a haiku style may use its own form). Use rhythm and vivid verbs, and vary them so no two calls sound alike. React only to the supplied observation; never invent teams, scores or outcomes. Name a player only if the observation already names them; never guess a name. Refer to a team by its name from the match line, not by shirt colour (the kit colours in the match line tell you which colour is which team). Never mention what did not happen (no 'no shot', 'no goal'). Vary your wording. No stage directions or audio tags; delivery is added separately.";

// Big moments are always called. Minor ones only fill silence.
const BIG = new Set(["goal", "shot", "save", "foul", "celebration", "penalty", "handball", "card"]);
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
    // Keep the pasted roster and the chosen commentator; forget the score and teams.
    for await (const row of ctx.db.query("state")) await ctx.db.patch("state", row._id, { score: null, teams: undefined });
    for await (const row of ctx.db.query("lines")) await ctx.db.delete("lines", row._id);
    for await (const row of ctx.db.query("memory")) await ctx.db.delete("memory", row._id);
    // Talking points belong to the clubs of the last match.
    for await (const row of ctx.db.query("topics")) await ctx.db.delete("topics", row._id);
  },
});

export const lastLine = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ at: number; event: string } | null> => {
    const top = await ctx.db.query("lines").order("desc").first();
    return top ? { at: top._creationTime, event: top.event } : null;
  },
});

export type MatchState = {
  score: string | null;
  teams: string | null;
  roster: string | null;
  style: StyleId;
  lang: Lang;
};

export const getState = internalQuery({
  args: {},
  handler: async (ctx): Promise<MatchState> => {
    const row = await ctx.db.query("state").first();
    return {
      score: row?.score ?? null,
      teams: row?.teams ?? null,
      roster: row?.roster ?? null,
      style: row?.style && isStyle(row.style) ? row.style : DEFAULT_STYLE,
      lang: row?.lang && isLang(row.lang) ? row.lang : DEFAULT_LANG,
    };
  },
});

// The commentating style and language the host picked. Both survive "Reset match".
export const persona = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("state").first();
    return {
      style: row?.style && isStyle(row.style) ? row.style : DEFAULT_STYLE,
      lang: row?.lang && isLang(row.lang) ? row.lang : DEFAULT_LANG,
    };
  },
});

export const setPersona = mutation({
  args: { style: v.string(), lang: v.string() },
  handler: async (ctx, { style, lang }) => {
    if (!isStyle(style) || !isLang(lang)) throw new Error("unknown style or language");
    const row = await ctx.db.query("state").first();
    if (row) await ctx.db.patch("state", row._id, { style, lang });
    else await ctx.db.insert("state", { score: null, style, lang });
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
    vt: v.optional(v.number()),
    madeMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("lines", args);
  },
});

// One frame in, at most one spoken line out.
export const processFrame = action({
  // frames: base64 JPEGs, oldest first, no data: prefix. vt: video time of the newest frame, when known.
  args: { frames: v.array(v.string()), hint: v.optional(v.string()), vt: v.optional(v.number()) },
  returns: v.object({ event: v.string(), note: v.string(), score: v.union(v.string(), v.null()) }),
  handler: async (ctx, { frames, hint, vt }): Promise<{ event: string; note: string; score: string | null }> => {
    const started = Date.now();
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_KEY });

    const t0 = Date.now();
    const match = await ctx.runQuery(internal.booth.getState, {});
    const earlier: string[] = await ctx.runQuery(internal.memory.recent, {});
    // The vision call also writes the spoken line, so a call needs one model round trip, not two.
    const speak = {
      system: `${personaPrompt(match.style, match.lang)}\n\nRules: ${PERSONA}`,
      context: `Match: ${match.teams ?? "teams as identified above"}, score ${match.score ?? "as on the scoreboard"}. ${earlier.length ? `Earlier in this match (use for a storyline only when it truly connects): ${earlier.join("; ")}. ` : ""}Let the danger level in the game state set your intensity.`,
    };
    const reading = await classify(client, VISION_MODEL, frames, hint, match.teams, match.roster, speak);
    const ms = Date.now() - t0;
    let { event } = reading;
    const { note, score } = reading;

    // Keep every frame set for the bench. Called on every exit after the line is made, so it never delays a call.
    const saveSample = async () => {
      const ids = await Promise.all(
        frames.map((f) => ctx.storage.store(new Blob([Uint8Array.from(atob(f), (c) => c.charCodeAt(0))], { type: "image/jpeg" }))),
      );
      await ctx.runMutation(internal.booth.saveSample, {
        frames: ids,
        hint,
        live: { model: VISION_MODEL, event: reading.event, note, score, ms },
      });
    };


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

    if (event === "none") {
      await saveSample();
      return { event, note, score };
    }
    const last = await ctx.runQuery(internal.booth.lastLine, {});
    if (last) {
      const age = Date.now() - last.at;
      if (!BIG.has(event) && age < QUIET_MS) {
        await saveSample();
        return { event, note, score };
      }
      // Sampling is continuous, so one celebration spans many reads. Call it once.
      if (event !== "goal" && event === last.event && age < REPEAT_MS) {
        await saveSample();
        return { event, note, score };
      }
    }

    // Use the line written with the frames, unless the event changed after the read (a score change made it a goal).
    let text = event === reading.event ? reading.line : "";
    if (!text) {
      const speech = await client.messages.create({
        model: MODEL,
        max_tokens: 120,
        thinking: { type: "disabled" },
        system: speak.system,
        messages: [
          {
            role: "user",
            content: `${speak.context} Event: ${event}. Detail: ${note}. ${match.roster ? `Lineup: ${match.roster.replace(/\n+/g, "; ")}. ` : ""}Game state from tracking (may be wrong; its shirt colours are not team names): ${hint ?? "unknown"}. Call it live.`,
          },
        ],
      });
      text = textOf(speech.content);
    }

    // Live calls use the low-latency voice model (about 0.4s against 1.1s); the energy comes from the words.
    const speechAudio = await synthesizeCommentary(text, event, STYLES.find((s) => s.id === match.style)?.voiceId, LIVE_VOICE_MODEL);
    const audioId = await ctx.storage.store(speechAudio.audio);
    const audioUrl = (await ctx.storage.getUrl(audioId)) ?? undefined;

    await ctx.runMutation(internal.booth.insertLine, {
      persona: `${match.style}:${match.lang}`,
      event,
      text,
      audioUrl,
      priority: 3,
      ttlMs: 9000,
      vt,
      madeMs: Date.now() - started,
    });
    if (event === "goal" || event === "shot" || event === "save" || event === "foul") {
      await ctx.runMutation(internal.memory.record, { kind: event, text: score ? `${note} (score ${score})` : note });
    }
    await saveSample();
    return { event, note, score };
  },
});
