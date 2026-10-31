This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Football commentary voice

Live commentary uses ElevenLabs **Eleven v4 Turbo** (`eleven_v4_turbo`) with **Daniel**, a male British broadcaster voice, and event-specific audio tags: calm buildup, excited attacks, surprised saves, and shouted goals. The commentary writer supplies clean text; the speech layer adds delivery instructions. This is an event-driven commentator fed by match vision, so microphone input and conversational turn-taking are unnecessary.

Set `ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY` on the Convex deployment. Existing `ELEVENLABS_KEY` and `ANTHROPIC_KEY` names are also supported. Optional `ELEVENLABS_VOICE_ID` selects the voice; audition a voice with an energetic sports delivery. Optional `ELEVENLABS_MODEL_ID` overrides the model, for example `eleven_v4` for higher-quality recorded clips. Legacy models receive plain text without audio tags.

Run `npm run voice:test` for offline checks. With the ElevenLabs key in `.env.local`, run `npm run voice:demo` to generate pass, save, and goal samples through the same speech helper used by the live backend. Open `artifacts/voice-demo/index.html` to listen; `results.json` records the actual model, voice, bytes, and full-clip generation time. These calls consume the provider's speech quota. Requires Node 22.6+ for TypeScript stripping.

After pushing to your development deployment, `npx convex run booth:previewVoice '{"event":"goal"}'` tests synthesis and Convex audio storage together, returning a playable URL. This internal action does not add fake events to the live commentary feed. Events supported: `pass`, `save`, `goal`.

The live pipeline currently generates each complete clip, stores it in Convex, then plays its URL. Model latency claims describe first-audio latency and do not represent the app's total reaction time. End-to-end audio streaming would require a separate playback transport change.

Model references: [ElevenLabs models](https://elevenlabs.io/docs/overview/models), [audio tags](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-and-v4). Alternatives considered: [Inworld TTS-2](https://docs.inworld.ai/tts/capabilities/steering) for natural-language delivery steering and [Cartesia Sonic](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion) for emotion controls.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
