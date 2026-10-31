import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { speechText, synthesizeCommentary } from "../lib/commentaryVoice.ts";

assert.match(speechText("It's in!", "goal"), /\[shouts\]/);
assert.match(speechText("A composed pass.", "pass"), /^\[calm\]/);
assert.equal(speechText("[shouts] A pass.", "pass"), "[calm] A pass.");
assert.throws(() => speechText("[excited]", "goal"), /empty/);

const live = process.argv.includes("--live");
if (!live) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  const originalModel = process.env.ELEVENLABS_MODEL_ID;
  process.env.ELEVENLABS_API_KEY = "test-key";
  delete process.env.ELEVENLABS_MODEL_ID;
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model_id, "eleven_v4_turbo");
      assert.match(body.text, /\[excited\]/);
      return new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });
    };
    assert.equal((await synthesizeCommentary("What a goal!", "goal")).audio.size, 3);
    process.env.ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
    globalThis.fetch = async (_url, options) => {
      assert.equal(JSON.parse(options.body).text, "A pass.");
      return new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });
    };
    await synthesizeCommentary("A pass.", "pass");
    globalThis.fetch = async () => new Response("private provider details", { status: 401 });
    await assert.rejects(synthesizeCommentary("Goal!", "goal"), /HTTP 401/);
    globalThis.fetch = async () => new Response("{}", { headers: { "Content-Type": "application/json" } });
    await assert.rejects(synthesizeCommentary("Goal!", "goal"), /invalid audio/);
    console.log("Voice checks passed: delivery, model selection, legacy models, HTTP errors, invalid audio.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.ELEVENLABS_MODEL_ID;
    else process.env.ELEVENLABS_MODEL_ID = originalModel;
  }
} else {
  const samples = [
    ["pass", "A composed touch, and they work it patiently across the back."],
    ["save", "Oh! What a save! He's clawed that out of the top corner!"],
    ["goal", "It's in! Oh, what a finish! That is absolutely unbelievable!"],
  ];
  const directory = new URL("../artifacts/voice-demo/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const [event, text] of samples) {
    const result = await synthesizeCommentary(text, event);
    await writeFile(new URL(`${event}.mp3`, directory), Buffer.from(await result.audio.arrayBuffer()));
    results.push({ event, text, model: result.model, voice: result.voice, bytes: result.audio.size, ms: result.ms });
    console.log(`${event}: ${result.model}, ${result.audio.size} bytes, ${result.ms}ms (complete clip)`);
  }
  await writeFile(new URL("results.json", directory), JSON.stringify(results, null, 2));
  await writeFile(new URL("index.html", directory), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Booth voice samples</title><body style="font:18px system-ui;max-width:720px;margin:48px auto;padding:24px"><h1>Football commentary voice samples</h1><p>Same voice, three event-driven deliveries. Listen for calm buildup, surprise, and a goal reaction.</p>${samples.map(([event, text]) => `<h2>${event}</h2><p>${text}</p><audio controls src="${event}.mp3"></audio>`).join("")}</body></html>`);
  console.log("Listen: artifacts/voice-demo/index.html");
}
