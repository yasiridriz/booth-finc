export const DEFAULT_VOICE_MODEL = "eleven_v4_turbo";
// Daniel: male British broadcaster.
const DEFAULT_VOICE_ID = "onwK4e9ZLuTAKqWW03F9";

// Hyped throughout; goals stay the loudest. Unknown events (color, fact, memory, banter) are animated.
const DELIVERY: Record<string, string> = {
  goal: "[excited] [shouts]",
  shot: "[excited] [shouts]",
  save: "[surprised] [excited]",
  foul: "[frustrated] [animated]",
  celebration: "[excited] [shouts]",
  penalty: "[excited] [shouts]",
  handball: "[excited] [shouts]",
  card: "[excited]",
  cross: "[excited]",
  tackle: "[excited]",
  dribble: "[excited]",
  pass: "[animated]",
  replay: "[animated]",
  banter: "[excited]",
};

export function speechText(text: string, event: string) {
  // Keep directions out of the transcript; the event controls the performance.
  const clean = text.replace(/\[[^\]]*\]/g, "").trim();
  if (!clean) throw new Error("Commentary text is empty");
  return `${DELIVERY[event] ?? "[animated]"} ${clean}`;
}

export async function synthesizeCommentary(text: string, event: string, voiceId?: string) {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_KEY;
  if (!apiKey) throw new Error("Set ELEVENLABS_API_KEY on the Convex deployment");
  const model = process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_VOICE_MODEL;
  const voice = voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  // Only these expressive model families understand inline audio directions.
  const expressive = /^eleven_v[34](?:_|$)/.test(model);
  const directed = speechText(text, event);
  const spoken = expressive ? directed : directed.replace(/\[[^\]]*\]\s*/g, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const start = Date.now();
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({ text: spoken, model_id: model }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      // Do not log provider responses which could contain request or account data.
      throw new Error(`ElevenLabs speech failed (HTTP ${response.status}, model ${model}). Check the API key, quota, and voice access.`);
    }
    const audio = await response.blob();
    if (!audio.size || !audio.type.startsWith("audio/")) {
      throw new Error("ElevenLabs returned empty or invalid audio");
    }
    return { audio, model, voice, ms: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}
