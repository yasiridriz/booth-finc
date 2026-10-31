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
  "penalty",
  "handball",
  "card",
  "corner",
  "freekick",
  "offside",
  "replay",
  "none",
] as const;

export type Reading = { event: string; note: string; score: string | null; teams: string | null };

export function textOf(content: Anthropic.ContentBlock[]) {
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

// frames: base64 JPEGs, oldest first, no data: prefix.
export async function classify(
  client: Anthropic,
  model: string,
  frames: string[],
  hint: string | undefined,
  teams: string | null = null, // known once identified, so later calls skip the question
  roster: string | null = null, // pasted lineup, used to turn shirt numbers into names
): Promise<Reading> {
  const res = await client.messages.create({
    model,
    max_tokens: 150,
    // Thinking would eat the whole token budget. Newer models spell "off" differently.
    thinking: (model.includes("haiku") ? { type: "disabled" } : { type: "between_tools" }) as Anthropic.ThinkingConfigParam,
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
            text: `These are football match frames about 0.5s apart, oldest first. Game state from player tracking (approximate, trust your eyes over it): ${hint ?? "none"}. Say what has just happened in the LAST frame. If the ball is in the net or players celebrate right after a shot, answer "goal". Call "penalty" when a penalty is awarded or about to be taken (player alone at the spot facing the keeper), "handball" when players or the referee signal a handball, "card" when a yellow or red card is shown. Use "replay" only for a slow-motion or different-angle replay, not for YouTube overlays or ordinary camera cuts. The note describes only what you see (who, where, which colour), never what did not happen. ${roster ? `Lineup (number and name per team):\n${roster}\nIf you can read a shirt number or an on-screen caption for the player involved in the LAST frame, start the note with that player's name from the lineup (for example "Mitrev shoots from the edge"). Name a player only when you can read the number or caption; otherwise describe the role and team. Never guess a name. ` : ""}Read the scoreboard overlay if one is visible, as "home-away" digits like "0-1", else null. ${teams ? `The teams are ${teams}; use their names in the note.` : `Also identify the two teams if you can (scoreboard abbreviations, kits, badges) as "Home Name (kit colours) vs Away Name (kit colours)", else null.`} Reply with JSON only: {"event":${EVENTS.map((e) => `"${e}"`).join("|")},"note":"max 12 words","score":"0-1"|null${teams ? "" : `,"teams":string|null`}}`,
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
      teams: typeof p.teams === "string" && p.teams.includes(" vs ") ? p.teams : null,
    };
  } catch {
    return { event: "none", note: "", score: null, teams: null };
  }
}
