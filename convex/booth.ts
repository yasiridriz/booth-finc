import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";

const PERSONA =
  "You are a loud, passionate football commentator. One or two short sentences. No stage directions.";

export const latest = query({
  args: {},
  handler: async (ctx) => ctx.db.query("lines").order("desc").take(10),
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
  handler: async (ctx, { frames, hint }) => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const vision = await client.messages.create({
      model: MODEL,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            ...frames.flatMap((data, i) => [
              {
                type: "text" as const,
                text: `Frame ${i + 1} of ${frames.length}:`,
              },
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/jpeg" as const,
                  data,
                },
              },
            ]),
            {
              type: "text",
              text: `These are football match frames about 0.5s apart, oldest first. Detector hint: ${hint ?? "none"}. Say what has just happened in the LAST frame. If the ball is in the net or players celebrate right after a shot, answer "goal". Reply with JSON only: {"event":"goal"|"shot"|"save"|"foul"|"cross"|"tackle"|"dribble"|"pass"|"celebration"|"replay"|"none","note":"what is happening, max 12 words"}`,
            },
          ],
        },
      ],
    });
    const raw = vision.content[0].type === "text" ? vision.content[0].text : "";
    let event = "none";
    let note = "";
    try {
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      event = parsed.event ?? "none";
      note = parsed.note ?? "";
    } catch {}
    if (event === "none") return { event, note };

    const speech = await client.messages.create({
      model: MODEL,
      max_tokens: 120,
      system: PERSONA,
      messages: [
        {
          role: "user",
          content: `Event: ${event}. Detail: ${note}. Call it live.`,
        },
      ],
    });
    const text =
      speech.content[0].type === "text" ? speech.content[0].text : "";

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
    return { event, note };
  },
});
