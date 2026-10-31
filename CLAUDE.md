<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Booth architecture (hackathon build)

Booth turns a football video into live AI commentary. Step 1 is the hybrid frame pipeline.

### Frame pipeline (host page, `app/page.tsx`)
1. The page shows a YouTube iframe. A YouTube iframe is cross-origin, so we cannot read its pixels directly.
   The user presses "Start capture" and chooses "This tab" (`getDisplayMedia`, Chrome only).
2. The page crops the iframe area from the captured tab into a canvas.
3. `lib/detector.ts` runs YOLOv8n (COCO, `public/models/yolov8n.onnx`) in the browser with
   `onnxruntime-web` at 5 fps. It finds players ("person") and the ball ("sports ball").
   The COCO model misses the small broadcast ball often. Replace it with a football-specific model if needed.
4. `lib/trigger.ts` decides when to call Haiku: fast ball motion, a scene cut, or a 6s heartbeat.
   A 2s cooldown applies. All thresholds are constants at the top of the file.
5. On a trigger, the page sends one 640px JPEG plus a text hint to the Convex action `booth.processFrame`.
   Only one call runs at a time. The page skips triggers while a call is busy.

### Convex (`convex/booth.ts`)
- `processFrame` (action): Haiku (`claude-haiku-5-5`) returns event JSON. For any event except `none`,
  Haiku writes a commentary line, ElevenLabs makes the audio, the audio goes to Convex storage,
  and a row goes to `lines`.
- `latest` (query): the 10 newest `lines`. The page plays each new `audioUrl` once.
- Env vars live in Convex, not in `.env.local`: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
  optional `ELEVENLABS_VOICE_ID`. Set them with `npx convex env set NAME value`.

### Known limits
- Tab capture works in Chrome only. The video is not muted by capture; the page mutes the YouTube player through the iframe API.
- Audio plays only after a user click. "Start capture" counts as that click.
- Only one persona exists. The rivalry duo and match memory come in Step 2.
