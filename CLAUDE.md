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

### Sources, roster, and model lock
- **Source switch (host page).** "Local clip" plays `public/clips/*.mp4` in a `<video>` tag and the page reads frames
  from it directly, so there is no screen-share prompt. Frames are only read while the clip plays.
  "YouTube" keeps the iframe and tab capture. `public/clips/` is in `.gitignore`. Download clips with
  `yt-dlp --download-sections "*600-1200"` (needs a current `yt-dlp`; the Homebrew one works).
- **Roster.** The host page has a "Lineup" box (team name, then "number name" lines). It is saved in
  `state.roster` through `booth.setRoster` and survives "Reset match". `classify` (`convex/vision.ts`) uses it to turn a
  readable shirt number or on-screen caption into a player name in the note. It must not guess. The speech prompt in
  `convex/booth.ts` names a player only if the note already does, and uses team names, not shirt colours.
- **Model lock.** All `onnxruntime-web` runs (`detect`, `locatePitch`, the ball model in `lib/ballDetector.ts`) go through
  `withOrt` in `lib/ortLock.ts`, because the models share one wasm heap and corrupt it if runs overlap.
- **Ball model.** `lib/ballDetector.ts` runs `yolov9-soccer-ball` (1280px, AGPL-3.0) at most every 400 ms. The page uses its
  result if it is under 0.6 s old, else the COCO ball.

### Talking points (`convex/topics.ts`, `lib/topicRank.ts`)
Commentators fill quiet moments with club and player facts found online.
- **Table `topics`.** One fact per row: subject, kind, `detail` (ready to say aloud), source URL and name, `window`
  (`day|week|month|evergreen`), optional `publishedAt`, `interest` (0-100), `usedCount`, `lastUsedAt`.
- **`topics.refresh` (action).** The page calls it when capture starts and every 5 minutes.
  1. Haiku writes 6 search queries. Its prompt is given today's date, and each query must carry a time anchor
     ("October 2026", "this week"). It sees recent headlines, so it does not repeat a theme.
  2. Each query goes to Firecrawl `POST /v2/search` with `tbs: "qdr:w"`. If fewer than 3 results come back, it retries with
     `qdr:m`. **This date filter is what keeps results recent.** The prompt only helps. Web results carry no date,
     so the window is stored on each topic.
  3. Haiku extracts facts from the result text only. It drops generic text, other clubs with a similar name, youth teams,
     crime, private life and health (except a reported injury). Controversy must be widely reported and start with "Reportedly".
     Standings facts are capped at interest 30, because sites disagree and go stale.
  4. Rows are added; a source URL is never stored twice.
- **Clubs input must include town and league** (for example "KF Bashkimi Aračinovo (Macedonian First League)"). A bare
  name matched a different club in testing.
- **Ranking.** `effectiveScore` = interest x (0.3 + 0.7 x recency) x 0.35^usedCount x relevance. Recency halves every 7 days.
  An undated topic is aged at the far end of its window. A topic is never repeated within 10 minutes. Relevance is 1 for the
  focus clubs and 0.6 for others. The page shows the top 12 with scores.
- **Use.** `commentary.next` (below) takes topics through `topics.claimTopic`, which picks the best one and marks it used in one transaction.
- **Env:** `FIRECRAWL_API_KEY` in Convex. One refresh costs about 6-12 Firecrawl credits.
- **Limits.** Small clubs have little recent news, so the list falls back to evergreen facts. Player topics need the lineup
  pasted in the Lineup box. X posts are not searched (X needs a login); news about posts is.

### Lineup search (`convex/lineups.ts`)
"Find lineups online" on the host page calls `lineups.findLineup`. For each club it tries up to 3 Firecrawl searches
(accented name, plain name + transfermarkt, plain name + sofascore), scrapes the top 3 pages as markdown, and Haiku keeps only
players whose name and shirt number both appear for the exact club. The result fills the Lineup box. **It is never saved
automatically.** The user checks the names, then presses "Save lineup", because a wrong name would be spoken aloud.
Squad pages may be incomplete or from another date, so treat a short list as partial. Cost: about 3-9 Firecrawl credits per club.

### Continuous commentary (`convex/commentary.ts`, `convex/memory.ts`, host page)
The aim is no dead air, without overlapping or repeating.
- **Line kinds and priority** (stored on each `lines` row as `event`, `priority`, `ttlMs`): event calls (`goal`, `shot`, ...) priority 3,
  TTL 9 s; `color` and `memory` priority 2, TTL 15-20 s; `fact` (talking point) priority 1, TTL 40 s.
- **Page queue.** New `lines` rows go into a queue in the host page, not straight to audio. When audio ends, the page plays the
  highest priority line, oldest first, and drops lines that waited longer than their TTL. A line is never cut mid-sentence.
  The TTL clock starts when the page first sees the line (the browser clock may differ from the server clock).
  Lines that exist when the page opens are history and are not replayed.
- **`commentary.next` (action).** The page calls it every 1.5 s when: the clip plays, the queue is empty, no event call is in
  flight, and the current audio has under 1.5 s left. The server allows a call only if the last line is over 1.5 s old and the last
  gap line over 4 s old. The 4 s slot is reserved in one transaction (`claimGap`, `state.gapAt`), so two simultaneous requests
  cannot both speak. It rotates color -> fact -> memory, and skips a kind that has nothing to say. If all three are empty it
  falls back to `banter` (a prediction, a question to the fans, or a remark on the tempo; it needs no data), so a gap is never left empty:
  - `color`: one observation from the game read (`describeRead` in `lib/game.ts`: possession, phase, zone, danger,
    momentum). The page passes the read only if it is under 4 s old. The prompt also gets the last 3 color lines so it does not repeat.
  - `fact`: a ranked talking point (see Talking points).
  - `memory`: a callback to an earlier moment.
- **Match memory (`memory` table).** `processFrame` records every goal, shot, save and foul. The event speech prompt sees the 5
  newest ("about 2 minutes ago: shot, ..."), so a storyline can build. `memory.claimCallback` brings back a moment older than
  90 s, at most once per 5 minutes, preferring goal > save > shot > foul and moments used less. "Reset match" clears memory.
- **Hype.** All prompts ask for high energy. `lib/commentaryVoice.ts` maps events to ElevenLabs delivery tags: goals, shots and
  celebrations `[excited] [shouts]`; passes, replays and the gap kinds `[animated]`. Gap kinds `color`, `fact` and `memory`
  use the `[animated]` default; `banter` uses `[excited]`.
- **Topic reuse.** A used topic is blocked for 3 minutes, then returns at 0.6 of its score per earlier use, so a thin topic list recycles.
- **Status line.** The host page shows what the last gap request returned (`gap line: color`, `server said wait`, or the error).
- **Limits.** The color prompt maps shirt colours to team names through `state.teams`; if the vision model has not identified the teams yet, it may guess.
  Color lines can add small embellishments (for example "chase shadows"). Tighten `COLOR_SYSTEM` if that is a problem.
