"use client";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { detect, loadDetector, type Detections } from "@/lib/detector";
import { TriggerState } from "@/lib/trigger";
import { loadPitch, locatePitch, type Pitch } from "@/lib/pitch";
import { TeamSplitter, colourName, teamColour } from "@/lib/teams";
import { GameState, describeRead, type Read, type Team } from "@/lib/game";
import { BallWorker } from "@/lib/ballDetector";
import { withOrt } from "@/lib/ortLock";

const CLIP = "/clips/bashkimi-shkendija-10-20.mp4"; // local sample, no screen share needed
const DEFAULT_CLUBS =
  "KF Bashkimi Aračinovo (Macedonian First League), KF Shkëndija Tetovo (Macedonian First League)";
const TOPIC_REFRESH_MS = 5 * 60 * 1000;
const FILLER_CHECK_MS = 1500; // how often to ask whether a gap line is needed
const DEFAULT_URL = "https://www.youtube.com/watch?v=91WI0e0Mf3c";
const DETECT_FPS = 5;
const RING_SIZE = 4;
const RING_GAP_MS = 500;
const PITCH_EVERY_MS = 1000;

function videoId(url: string) {
  return url.match(/(?:v=|youtu\.be\/|embed\/|live\/)([\w-]{11})/)?.[1] ?? null;
}

export default function Host() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [capturing, setCapturing] = useState(false);
  const [source, setSource] = useState<"clip" | "youtube">("clip");
  const clipVideo = useRef<HTMLVideoElement>(null);
  const [stats, setStats] = useState({
    players: 0,
    ball: "-",
    speed: 0,
    cut: 0,
    ballMs: 0,
    last: "idle",
    pitchMs: 0,
  });
  const [model, setModel] = useState("loading model...");

  const frameRef = useRef<HTMLIFrameElement>(null);
  const streamVideo = useRef<HTMLVideoElement>(null);
  const crop = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const busy = useRef(false);
  const ring = useRef<{ t: number; c: HTMLCanvasElement }[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const trigger = useRef(new TriggerState());
  const splitter = useRef(new TeamSplitter());
  const game = useRef(new GameState());
  const pitch = useRef<{ p: Pitch | null; t: number }>({ p: null, t: 0 });
  const [read, setRead] = useState<{ r: Read; names: [string, string] } | null>(
    null,
  );
  const ballWorker = useRef(new BallWorker());

  const processFrame = useAction(api.booth.processFrame);
  const resetMatch = useMutation(api.booth.resetMatch);
  const findLineup = useAction(api.lineups.findLineup);
  const [lineupNote, setLineupNote] = useState("");
  const refreshTopics = useAction(api.topics.refresh);
  const nextLine = useAction(api.commentary.next);
  const [clubs, setClubs] = useState(DEFAULT_CLUBS);
  const [topicNote, setTopicNote] = useState("");
  const [gapNote, setGapNote] = useState("gap lines: waiting");
  const saveRoster = useMutation(api.booth.setRoster);
  const savedRoster = useQuery(api.booth.roster);
  const [rosterText, setRosterText] = useState<string | null>(null);
  const lines = useQuery(api.booth.latest);
  const id = videoId(url);
  const clubList = clubs
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  // Short names for ranking: drop the bracketed league and the "KF"/"FK" prefix.
  const focus = clubList.map((c) =>
    c
      .replace(/\(.*\)/, "")
      .replace(/^(KF|FK|FC)\s+/i, "")
      .trim()
      .toLowerCase(),
  );
  const players = (rosterText ?? savedRoster ?? "")
    .split("\n")
    .flatMap((l) => l.match(/^\s*\d+\s+(.+)$/)?.[1] ?? []);
  const topics = useQuery(api.topics.ranked, { focus });
  const audioPlaying = useRef(false);
  const current = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<
    { url: string; priority: number; ttl: number; seenAt: number }[]
  >([]);
  const seenLines = useRef<Set<string> | null>(null);
  const lastRead = useRef<{ text: string; t: number } | null>(null);

  useEffect(() => {
    Promise.all([loadDetector(), loadPitch()]).then(
      () => setModel("models ready"),
      (e) => setModel(`model failed: ${e instanceof Error ? e.message : e}`),
    );
  }, []);

  // Mute the YouTube player so only the AI voices are heard.
  const muteYoutube = () =>
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: "mute", args: [] }),
      "*",
    );

  const start = async () => {
    if (source === "clip") {
      setCapturing(true);
      return;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 },
      audio: false,
      // @ts-expect-error Chrome-only hint
      preferCurrentTab: true,
    });
    const v = streamVideo.current!;
    v.srcObject = stream;
    await v.play();
    stream
      .getVideoTracks()[0]
      .addEventListener("ended", () => setCapturing(false));
    setCapturing(true);
  };

  const drawPreview = useCallback(
    (
      det: Detections,
      teams: (Team | null)[],
      outfield: Detections["players"],
    ) => {
      const c = crop.current!;
      const p = preview.current!;
      p.width = c.width;
      p.height = c.height;
      const ctx = p.getContext("2d")!;
      ctx.drawImage(c, 0, 0);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#22d3ee";
      outfield.forEach((b, i) => {
        const team = teams[i];
        ctx.strokeStyle =
          team === null || team === undefined ? "#94a3b8" : teamColour(team);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      });
      ctx.strokeStyle = "#facc15";
      det.goalkeepers.forEach((b) => ctx.strokeRect(b.x, b.y, b.w, b.h));
      if (det.ball) {
        ctx.strokeStyle = "#f43f5e";
        ctx.lineWidth = 3;
        ctx.strokeRect(
          det.ball.x - 6,
          det.ball.y - 6,
          det.ball.w + 12,
          det.ball.h + 12,
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (!capturing) return;
    let stop = false;
    const tick = async () => {
      try {
        const clipEl = clipVideo.current;
        const v = source === "clip" ? clipEl! : streamVideo.current!;
        const box = frameRef.current?.getBoundingClientRect();
        const ready =
          source === "clip"
            ? !!v.videoWidth && !v.paused
            : !!v.videoWidth && !!box;
        if (ready) {
          const c = crop.current!;
          if (source === "clip") {
            // Read the clip directly, capped at 1280px wide.
            const k = Math.min(1, 1280 / v.videoWidth);
            c.width = Math.round(v.videoWidth * k);
            c.height = Math.round(v.videoHeight * k);
            c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
          } else {
            // The captured tab is scaled against the CSS viewport, so map the iframe rect into it.
            const k = v.videoWidth / window.innerWidth;
            c.width = Math.round(box!.width * k);
            c.height = Math.round(box!.height * k);
            c.getContext("2d")!.drawImage(
              v,
              box!.left * k,
              box!.top * k,
              c.width,
              c.height,
              0,
              0,
              c.width,
              c.height,
            );
          }

          // Show the raw crop first so the preview fills even if detection fails.
          const p = preview.current!;
          p.width = c.width;
          p.height = c.height;
          p.getContext("2d")!.drawImage(c, 0, 0);

          ballWorker.current.submit(c);
          const det = await withOrt(() => detect(c));
          // Prefer the ball-only model; keep the COCO ball as a fallback.
          det.ball = ballWorker.current.fresh(performance.now()) ?? det.ball;
          const now = performance.now();

          // Both models share one wasm heap and corrupt it if run at once, so the heavy pitch model
          // runs right after detection, about once a second.
          if (now - pitch.current.t > PITCH_EVERY_MS) {
            const t0 = performance.now();
            pitch.current = { p: await withOrt(() => locatePitch(c)), t: now };
            setStats((s) => ({
              ...s,
              pitchMs: Math.round(performance.now() - t0),
            }));
          }
          // A pitch fit older than 1.5s is stale once the camera pans.
          const fit = now - pitch.current.t < 1500 ? pitch.current.p : null;
          const keeperSet = new Set(det.goalkeepers);
          const outfield = det.players.filter((b) => !keeperSet.has(b));
          const teams = splitter.current.assign(c, outfield);
          const names: [string, string] = [
            `${colourName(0)} shirts`,
            `${colourName(1)} shirts`,
          ];
          const r = game.current.update({
            t: now,
            pitch: fit,
            players: outfield,
            teams,
            keepers: det.goalkeepers,
            ball: det.ball,
          });
          if (r) {
            setRead({ r, names });
            lastRead.current = { text: describeRead(r, names), t: now };
          }
          const gameHint = r
            ? describeRead(r, names)
            : "pitch not visible (close-up, replay or crowd shot)";

          // Keep the last few frames about 0.5s apart so Haiku sees motion, not one still.
          const last = ring.current.at(-1);
          if (!last || now - last.t >= RING_GAP_MS) {
            const scale = Math.min(1, 640 / c.width);
            const snap = document.createElement("canvas");
            snap.width = Math.round(c.width * scale);
            snap.height = Math.round(c.height * scale);
            snap.getContext("2d")!.drawImage(c, 0, 0, snap.width, snap.height);
            ring.current = [...ring.current, { t: now, c: snap }].slice(
              -RING_SIZE,
            );
          }
          const t = trigger.current.update(c, det, now);
          drawPreview(det, teams, outfield);
          setStats((s) => ({
            ...s,
            players: det.players.length,
            ball: det.ball ? det.ball.score.toFixed(2) : "-",
            speed: trigger.current.ballSpeed,
            cut: trigger.current.cutDiff,
            ballMs: ballWorker.current.ms,
          }));

          if (t && !busy.current && ring.current.length) {
            busy.current = true;
            // Older frames show motion at 640px. The newest is sent sharp, since players are tiny in wide shots.
            const sharp = document.createElement("canvas");
            const k = Math.min(1, 1280 / c.width);
            sharp.width = Math.round(c.width * k);
            sharp.height = Math.round(c.height * k);
            sharp
              .getContext("2d")!
              .drawImage(c, 0, 0, sharp.width, sharp.height);
            const frames = [
              ...ring.current
                .slice(1)
                .map((f) => f.c.toDataURL("image/jpeg", 0.6).split(",")[1]),
              sharp.toDataURL("image/jpeg", 0.85).split(",")[1],
            ];
            processFrame({ frames, hint: `${gameHint}; ${t.hint}` })
              .then((r) => {
                setStats((s) => ({ ...s, last: `${r.event} (${t.reason})` }));
                setLog((l) => [`${r.event}: ${r.note}`, ...l].slice(0, 6));
              })
              .catch((e) => {
                console.error(e);
                setStats((s) => ({ ...s, last: "error" }));
              })
              .finally(() => (busy.current = false));
          }
        }
      } catch (e) {
        console.error(e);
        setStats((s) => ({
          ...s,
          last: `detect error: ${e instanceof Error ? e.message : e}`,
        }));
      }
      if (!stop) setTimeout(tick, 1000 / DETECT_FPS);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [capturing, source, processFrame, drawPreview]);

  // Keep the talking points fresh while the match runs, and fill quiet moments with them.
  const playersRef = useRef(players);
  playersRef.current = players;
  useEffect(() => {
    if (!capturing || clubList.length === 0) return;
    const run = () =>
      refreshTopics({ clubs: clubList, players: playersRef.current })
        .then((r) => setTopicNote(`${r.added} new from ${r.results} results`))
        .catch((e) =>
          setTopicNote(
            `topic search failed: ${e instanceof Error ? e.message : e}`,
          ),
        );
    run();
    const refresh = setInterval(run, TOPIC_REFRESH_MS);
    let inFlight = false;
    const filler = setInterval(() => {
      const playing = clipVideo.current ? !clipVideo.current.paused : true;
      const a = current.current;
      const remaining =
        a && Number.isFinite(a.duration) ? a.duration - a.currentTime : 0;
      // Ask for the next gap line when the queue is empty and the audio is almost done, so there is no dead air.
      const idleSoon = !audioPlaying.current || remaining < 1.5;
      if (
        inFlight ||
        busy.current ||
        !playing ||
        queue.current.length ||
        !idleSoon
      )
        return;
      const fresh =
        lastRead.current && performance.now() - lastRead.current.t < 4000;
      inFlight = true;
      nextLine({ focus, read: fresh ? lastRead.current!.text : undefined })
        .then((r) =>
          setGapNote(r ? `gap line: ${r.kind}` : "gap line: server said wait"),
        )
        .catch((e) => {
          console.error(e);
          setGapNote(
            `gap line failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`,
          );
        })
        .finally(() => (inFlight = false));
    }, FILLER_CHECK_MS);
    return () => {
      clearInterval(refresh);
      clearInterval(filler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, clubs, refreshTopics, nextLine]);

  // Lines wait in a queue. The highest priority plays first, and a line that waited too long is dropped.
  const pump = useCallback(function run() {
    if (audioPlaying.current) return;
    const now = Date.now();
    queue.current = queue.current
      .filter((q) => now - q.seenAt < q.ttl)
      .sort((x, y) => y.priority - x.priority || x.seenAt - y.seenAt);
    const next = queue.current.shift();
    if (!next) return;
    const a = new Audio(next.url);
    current.current = a;
    audioPlaying.current = true;
    const done = () => {
      audioPlaying.current = false;
      current.current = null;
      run();
    };
    a.addEventListener("ended", done);
    a.addEventListener("error", done);
    a.play().catch(done);
  }, []);

  useEffect(() => {
    if (!lines) return;
    // Lines that exist when the page opens are history; do not replay them.
    if (seenLines.current === null) {
      seenLines.current = new Set(lines.map((l) => l._id));
      return;
    }
    const now = Date.now();
    for (const l of [...lines].reverse()) {
      if (seenLines.current.has(l._id)) continue;
      seenLines.current.add(l._id);
      if (l.audioUrl)
        queue.current.push({
          url: l.audioUrl,
          priority: l.priority ?? 3,
          ttl: l.ttlMs ?? 15000,
          seenAt: now,
        });
    }
    pump();
  }, [lines, pump]);

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-4">
      <h1 className="text-2xl font-bold">Booth: host</h1>
      <div className="flex gap-2">
        <select
          className="border rounded px-2 text-black"
          value={source}
          disabled={capturing}
          onChange={(e) => setSource(e.target.value as "clip" | "youtube")}
        >
          <option value="clip">Local clip</option>
          <option value="youtube">YouTube (tab capture)</option>
        </select>
        <input
          className="flex-1 border rounded px-2 py-1 text-black"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="border rounded px-3"
          onClick={start}
          disabled={capturing || (source === "youtube" && !id)}
        >
          {capturing ? "Capturing" : "Start capture"}
        </button>
        <button className="border rounded px-3" onClick={() => resetMatch()}>
          Reset match
        </button>
        <button
          className="border rounded px-3"
          onClick={() => game.current.toggleDirection()}
        >
          Flip direction
        </button>
      </div>
      <p className="text-sm opacity-70">
        Press Start capture, choose &quot;This tab&quot;, then press play on the
        video. {model}
      </p>
      <label className="block text-sm">
        Clubs for talking points (name, town, league; comma separated)
        <input
          className="w-full border rounded px-2 py-1 text-black"
          value={clubs}
          onChange={(e) => setClubs(e.target.value)}
        />
      </label>
      <details className="text-sm">
        <summary className="cursor-pointer">
          Lineup (paste team name, then &quot;number name&quot; per line)
        </summary>
        <textarea
          className="w-full h-40 border rounded p-2 font-mono text-black"
          placeholder={
            "Bashkimi\n1 Name Surname\n9 Name Surname\n\nShkendija\n1 Name Surname"
          }
          value={rosterText ?? savedRoster ?? ""}
          onChange={(e) => setRosterText(e.target.value)}
        />
        <button
          className="border rounded px-3 mt-1"
          onClick={() =>
            saveRoster({ roster: rosterText ?? savedRoster ?? "" })
          }
        >
          Save lineup
        </button>
        <button
          className="border rounded px-3 mt-1 ml-2"
          onClick={() => {
            setLineupNote("searching...");
            findLineup({ clubs: clubList })
              .then((r) => {
                setRosterText(r.roster);
                setLineupNote(
                  `found; check the names, then press Save lineup. Source: ${r.sources.join(", ") || "none"}`,
                );
              })
              .catch((e) =>
                setLineupNote(`failed: ${e instanceof Error ? e.message : e}`),
              );
          }}
        >
          Find lineups online
        </button>
        <span className="ml-2 text-xs opacity-70">{lineupNote}</span>
      </details>
      {source === "clip" && (
        <video
          ref={clipVideo}
          src={CLIP}
          muted
          controls
          playsInline
          className="w-full aspect-video bg-black"
        />
      )}
      {source === "youtube" && id && (
        <iframe
          ref={frameRef}
          onLoad={() => setTimeout(muteYoutube, 1500)}
          className="w-full aspect-video"
          src={`https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0`}
          allow="autoplay; encrypted-media"
        />
      )}
      <video ref={streamVideo} muted playsInline className="hidden" />
      <canvas ref={crop} className="hidden" />
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <canvas ref={preview} className="w-full bg-black" />
          <p className="text-sm font-mono">
            players {stats.players} | ball {stats.ball} | speed{" "}
            {stats.speed.toFixed(2)} | cut {stats.cut.toFixed(0)} | pitch{" "}
            {stats.pitchMs}ms | ball model {stats.ballMs.toFixed(0)}ms | last:{" "}
            {stats.last}
          </p>
          {read && (
            <div className="text-sm font-mono space-y-1">
              <div className="h-2 bg-neutral-800 rounded">
                <div
                  className="h-2 rounded bg-rose-500 transition-all"
                  style={{ width: `${read.r.danger}%` }}
                />
              </div>
              <p>{describeRead(read.r, read.names)}</p>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-xs font-mono space-y-1">
            <p className="opacity-70">
              talking points {topicNote} | {gapNote}
            </p>
            {topics?.map((t) => (
              <p key={t._id} title={t.detail}>
                {t.score} · {t.kind} · {t.subject} · {t.window}
                {t.usedCount ? ` · used ${t.usedCount}x` : ""} ·{" "}
                <a
                  className="underline"
                  href={t.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.sourceName}
                </a>
              </p>
            ))}
          </div>
          <ul className="space-y-1">
            {log.map((l, i) => (
              <li key={i} className="text-xs opacity-60 font-mono">
                haiku → {l}
              </li>
            ))}
            {lines?.map((l) => (
              <li key={l._id}>
                <b>{l.event}</b>: {l.text}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
