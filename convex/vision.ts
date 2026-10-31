import Anthropic from "@anthropic-ai/sdk";

// Shared by the live pipeline and the model bench, so both ask the exact same question.
export const EVENTS = [
  "goal",
  "shot",
  "save",
  "foul",
  "cross",
  "tackle",
  "dribble",
  "pass",
  "celebration",
  "replay",
  "none",
] as const;

export type Reading = { event: string; note: string; score: string | null };

export function textOf(content: Anthropic.ContentBlock[]) {
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

// frames: base64 JPEGs, oldest first, no data: prefix.
export async function classify(
  client: Anthropic,
  model: string,
  frames: string[],
  hint: string | undefined,
): Promise<Reading> {
  const res = await client.messages.create({
    model,
    max_tokens: 150,
    thinking: { type: "disabled" }, // thinking would eat the whole token budget
    messages: [
      {
        role: "user",
        content: [
          ...frames.flatMap((data, i) => [
            { type: "text" as const, text: `Frame ${i + 1} of ${frames.length}:` },
            {
              type: "image" as const,
              source: { type: "base64" as const, media_type: "image/jpeg" as const, data },
            },
          ]),
          {
            type: "text",
            text: `These are football match frames about 0.5s apart, oldest first. Detector hint: ${hint ?? "none"}. Say what has just happened in the LAST frame. If the ball is in the net or players celebrate right after a shot, answer "goal". Use "replay" only for a slow-motion or different-angle replay, not for YouTube overlays or ordinary camera cuts. The note describes only what you see (who, where, which colour), never what did not happen. Read the scoreboard overlay if one is visible, as "home-away" digits like "0-1", else null. Reply with JSON only: {"event":${EVENTS.map((e) => `"${e}"`).join("|")},"note":"max 12 words","score":"0-1"|null}`,
          },
        ],
      },
    ],
  });
  try {
    const p = JSON.parse(textOf(res.content).match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return {
      event: EVENTS.includes(p.event) ? p.event : "none",
      note: typeof p.note === "string" ? p.note : "",
      score: typeof p.score === "string" && /^\d+-\d+$/.test(p.score) ? p.score : null,
    };
  } catch {
    return { event: "none", note: "", score: null };
  }
}
