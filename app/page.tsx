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
import { BoothIcon } from "@/components/BoothIcon";
import { CommentatorPicker } from "@/components/CommentatorPicker";
import { asset } from "@/lib/assets";

const CLIP = asset("/clips/bashkimi-shkendija-10-20.mp4"); // local sample, no screen share needed
const DEFAULT_CLUBS =
  "Arsenal (London, Premier League), Tottenham Hotspur (London, Premier League)";
const TOPIC_REFRESH_MS = 5 * 60 * 1000;
const FILLER_CHECK_MS = 1500; // how often to ask whether a gap line is needed
const QUIET_BEFORE_FILLER_MS = 4000; // silence needed before a filler is asked for
const DEFAULT_URL = "https://www.youtube.com/watch?v=D29dNXViqJw";
const DETECT_FPS = 5;
const RING_SIZE = 4;
// Reads overlap so a moment never waits long for the next one to leave. Each takes about 2.5 s.
const MAX_IN_FLIGHT = 2;
const SEND_GAP_MS = 1100;
const RING_GAP_MS = 500;
const PITCH_EVERY_MS = 1000;
const DELAY_S = 4; // broadcast delay: analysis runs this far ahead; calls measured at 2.4-2.9s to make
const EARLY_S = 0.2; // a timed line may start this much before its moment
const LATE_S = 2.5; // a timed line this late is stale and dropped

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// Finds a match date in a video title: "12/2/2018" (US order, as US broadcasters post) or "2 December 2018".
function dateFromTitle(title: string): string | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  const us = title.match(/\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/);
  if (us) return `${us[3]}-${pad(+us[1])}-${pad(+us[2])}`;
  const long = title.toLowerCase().match(/\b(\d{1,2})(?:st|nd|rd|th)? (january|february|march|april|may|june|july|august|september|october|november|december),? ((?:19|20)\d{2})\b/);
  if (long) return `${long[3]}-${pad(MONTHS.indexOf(long[2]) + 1)}-${pad(+long[1])}`;
  return null;
}

function videoId(url: string) {
  return url.match(/(?:v=|youtu\.be\/|embed\/|live\/)([\w-]{11})/)?.[1] ?? null;
}

export default function Host() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [capturing, setCapturing] = useState(false);
  const [source, setSource] = useState<"link" | "clip" | "youtube">("link");
  // Link and clip modes read frames straight from a <video>; only YouTube mode needs tab capture.
  const fromVideo = source !== "youtube";
  const clipVideo = useRef<HTMLVideoElement>(null); // analysis copy; in link mode it runs DELAY_S ahead
  const viewerVideo = useRef<HTMLVideoElement>(null); // what the viewer watches in link mode
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
  const visionCalls = useRef(0); // vision calls running now
  const lastSend = useRef(0);
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
  // YYYY-MM-DD of a past match being replayed, so talking points come from that time. Empty means live: today's news.
  const [matchDate, setMatchDate] = useState("");
  const dateTouched = useRef(false);
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
  const lastAudioEnd = useRef(0); // when the booth last went quiet
  const current = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<
    { url: string; priority: number; ttl: number; seenAt: number; vt?: number }[]
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
    if (fromVideo) {
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
        const v = fromVideo ? clipEl! : streamVideo.current!;
        const box = frameRef.current?.getBoundingClientRect();
        const ready =
          fromVideo
            ? !!v.videoWidth && !v.paused
            : !!v.videoWidth && !!box;
        if (ready) {
          const c = crop.current!;
          if (fromVideo) {
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

          if (t && visionCalls.current < MAX_IN_FLIGHT && now - lastSend.current >= SEND_GAP_MS && ring.current.length) {
            visionCalls.current += 1;
            lastSend.current = now;
            // Two older frames show motion at 640px; the newest is sharper, since players are tiny in wide shots.
            // Fewer, smaller images make the model answer faster.
            const sharp = document.createElement("canvas");
            const k = Math.min(1, 960 / c.width);
            sharp.width = Math.round(c.width * k);
            sharp.height = Math.round(c.height * k);
            sharp
              .getContext("2d")!
              .drawImage(c, 0, 0, sharp.width, sharp.height);
            const frames = [
              ...ring.current
                .slice(-3, -1)
                .map((f) => f.c.toDataURL("image/jpeg", 0.6).split(",")[1]),
              sharp.toDataURL("image/jpeg", 0.8).split(",")[1],
            ];
            // The video moment these frames show, so link mode can play the call exactly then.
            const vt = source === "link" ? clipVideo.current?.currentTime : undefined;
            processFrame({ frames, hint: `${gameHint}; ${t.hint}`, vt })
              .then((r) => {
                setStats((s) => ({ ...s, last: `${r.event} (${t.reason})` }));
                setLog((l) => [`${r.event}: ${r.note}`, ...l].slice(0, 6));
              })
              .catch((e) => {
                console.error(e);
                setStats((s) => ({ ...s, last: "error" }));
              })
              .finally(() => (visionCalls.current -= 1));
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
  }, [capturing, source, fromVideo, processFrame, drawPreview]);

  // Keep the talking points fresh while the match runs, and fill quiet moments with them.
  const playersRef = useRef(players);
  playersRef.current = players;
  useEffect(() => {
    if (!capturing || clubList.length === 0) return;
    const run = () =>
      refreshTopics({ clubs: clubList, players: playersRef.current, matchDate: matchDate || undefined })
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
      // Real broadcasts breathe: ask for a gap line only after a few seconds of silence.
      const idleSoon = !audioPlaying.current && Date.now() - lastAudioEnd.current > QUIET_BEFORE_FILLER_MS;
      if (
        // Event calls are not waited for here: the queue already holds a filler when a timed call is due.
        inFlight ||
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
  }, [capturing, clubs, matchDate, refreshTopics, nextLine]);

  // Lines wait in a queue. The highest priority plays first, and a line that waited too long is dropped.
  const pump = useCallback(function run() {
    if (audioPlaying.current) return;
    const now = Date.now();
    // In link mode a line that carries its video moment waits for the viewer to reach it, and is dropped once stale.
    const view = source === "link" ? viewerVideo.current : null;
    const at = view ? view.currentTime : null;
    queue.current = queue.current
      .filter((q) => (q.vt !== undefined && at !== null ? at - q.vt < LATE_S : now - q.seenAt < q.ttl))
      .sort((x, y) => y.priority - x.priority || x.seenAt - y.seenAt);
    const i = queue.current.findIndex((q) => q.vt === undefined || at === null || at >= q.vt - EARLY_S);
    if (i < 0) return;
    // A filler must not start while a timed call is due within its length.
    const due = at !== null && queue.current.some((q) => q.vt !== undefined && q.vt - at < 3);
    if (due && queue.current[i].vt === undefined) return;
    const [next] = queue.current.splice(i, 1);
    const a = new Audio(next.url);
    current.current = a;
    audioPlaying.current = true;
    const done = () => {
      audioPlaying.current = false;
      lastAudioEnd.current = Date.now();
      current.current = null;
      run();
    };
    a.addEventListener("ended", done);
    a.addEventListener("error", done);
    a.play().catch(done);
  }, [source]);

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
          vt: l.vt,
        });
    }
    pump();
  }, [lines, pump]);

  // Timed lines wait for their moment, so check the queue often, and report how early lines arrive.
  useEffect(() => {
    if (!capturing) return;
    const t = setInterval(pump, 100);
    return () => clearInterval(t);
  }, [capturing, pump]);
  useEffect(() => {
    const view = viewerVideo.current;
    const timed = lines?.filter((l) => l.vt !== undefined).slice(0, 5);
    if (!view || source !== "link" || !timed?.length) return;
    const leads = timed.map((l) => (l.madeMs ?? 0) / 1000);
    setGapNote((g) => `${g.split(" | lead")[0]} | lead: calls take ${Math.min(...leads).toFixed(1)}-${Math.max(...leads).toFixed(1)}s to make, delay is ${DELAY_S}s`);
  }, [lines, source]);

  // Link mode: keep the analysis copy DELAY_S ahead of the viewer, following play, pause and seeks.
  const [download, setDownload] = useState(""); // only set when something is wrong
  // Seconds into the match where the current stream starts: 0 for the full match, else a jump-ahead section.
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const availS = useRef(0); // how far the full download has reached, in seconds
  const matchUrl = id ? `/api/video?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}` : "";
  const videoSrc = offset ? `${matchUrl}&from=${offset}` : matchUrl;
  // Seeking past the downloaded part starts a separate stream from that point instead of waiting.
  const onSeeking = () => {
    const view = viewerVideo.current;
    if (!view || offset || !Number.isFinite(view.duration)) return;
    if (view.currentTime > availS.current - 5) {
      queue.current = [];
      setOffset(Math.floor(view.currentTime));
    }
  };
  useEffect(() => {
    if (source !== "link" || !id) return;
    const sync = setInterval(() => {
      const view = viewerVideo.current;
      const ana = clipVideo.current;
      if (!view || !ana) return;
      const target = view.currentTime + DELAY_S;
      if (Math.abs(ana.currentTime - target) > 0.6) ana.currentTime = target;
      if (view.paused && !ana.paused) ana.pause();
      if (!view.paused && ana.paused) ana.play().catch(() => {});
    }, 250);
    const status = setInterval(async () => {
      try {
        const r = await fetch(`/api/video?status=1&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
        const j = await r.json();
        const view = viewerVideo.current;
        if (view && !offset && Number.isFinite(view.duration)) availS.current = (j.have / j.size) * view.duration;
        setDownload(j.error && !j.downloading ? `Video error: ${j.error}` : "");
        // Classic-match uploads put the date in the title, e.g. "FULL MATCH | 12/2/2018" or "2 December 2018".
        if (!dateTouched.current && j.title) {
          const d = dateFromTitle(j.title);
          if (d) {
            dateTouched.current = true;
            setMatchDate(d);
          }
        }
      } catch {}
    }, 2000);
    return () => {
      clearInterval(sync);
      clearInterval(status);
    };
  }, [source, id, offset]);

  const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  return (
    <main className="booth-shell">
      <header className="masthead">
        <div className="flex items-center gap-3">
          <span className="brand-mark"><BoothIcon name="mic" /></span>
          <h1 className="brand-word">booth<span>.</span></h1>
          <span className="studio-label">Broadcast studio</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="masthead-note">Football, with a voice.</span>
          <span className={`on-air ${capturing ? "is-live" : ""}`} role="status">
            <span className="status-dot" />{capturing ? "ON AIR" : "STANDBY"}
          </span>
        </div>
      </header>

      <section className="source-bar" aria-label="Broadcast controls">
        <label className="source-field">
          <span className="eyebrow">Video source</span>
          <select value={source} disabled={capturing}
            onChange={(e) => setSource(e.target.value as "link" | "clip" | "youtube")}>
            <option value="link">YouTube link (no screen share)</option>
            <option value="clip">Local clip</option>
            <option value="youtube">YouTube (tab capture)</option>
          </select>
        </label>
        <label className="url-field">
          <span className="sr-only">YouTube match link</span>
          <BoothIcon name="link" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube match link" spellCheck={false} />
        </label>
        <button className="start-button" onClick={start}
          disabled={capturing || (source === "youtube" && !id)}>
          <BoothIcon name={capturing ? "activity" : "play"} />
          {capturing ? "On air" : "Start"}
        </button>
        <div className="utility-actions">
          <button className="utility-button" onClick={() => resetMatch()}><BoothIcon name="reset" />Reset match</button>
          <button className="utility-button" onClick={() => game.current.toggleDirection()}><BoothIcon name="flip" />Flip direction</button>
        </div>
      </section>

      <div className="broadcast-grid">
        <div className="min-w-0">
          <section className="player-panel" aria-labelledby="match-heading">
            <div className="panel-heading">
              <div className="flex items-center gap-3">
                <span className={`live-badge ${capturing ? "is-live" : ""}`}><span className="status-dot" />{capturing ? "LIVE" : "PREVIEW"}</span>
                <h2 id="match-heading" className="text-sm font-medium">Match broadcast</h2>
              </div>
              <span className="eyebrow text-muted">{source === "clip" ? "Local clip" : "YouTube"}</span>
            </div>
            <div className="player-screen">
              {source === "link" && id && (
                <>
                  {/* The analysis video stays mounted and follows the viewer. */}
                  <video
                    ref={viewerVideo}
                    src={videoSrc}
                    onSeeking={onSeeking}
                    onWaiting={() => setLoading(true)}
                    onPlaying={() => setLoading(false)}
                    onCanPlay={() => setLoading(false)}
                    // A jump-ahead swaps the source, which pauses the player; carry on playing.
                    onLoadedMetadata={(e) => offset > 0 && e.currentTarget.play().catch(() => {})}
                    muted
                    controls
                    playsInline
                    preload="auto"
                    className="match-video"
                    aria-label="Match broadcast"
                  />
                  <video
                    ref={clipVideo}
                    src={videoSrc}
                    muted
                    playsInline
                    preload="auto"
                    className="hidden"
                    title={`analysis copy, ${DELAY_S}s ahead`}
                  />
                </>
              )}
              {source === "clip" && (
                <video ref={clipVideo} src={CLIP} muted controls playsInline className="match-video" aria-label="Local match clip" />
              )}
              {source === "youtube" && id && (
                <iframe ref={frameRef} onLoad={() => setTimeout(muteYoutube, 1500)}
                  className="match-video" title="YouTube match broadcast"
                  src={`https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0`}
                  allow="autoplay; encrypted-media" />
              )}
              {source !== "clip" && !id && (
                <div className="player-placeholder">
                  <BoothIcon name="play" />
                  <h3>Your next match starts here.</h3>
                  <p>Paste a valid YouTube match link above to load the broadcast.</p>
                </div>
              )}
            </div>
            <div className="player-footer">
              <div className="flex items-center gap-2 text-sm">
                <BoothIcon name="mic" className="text-accent" />
                <span>AI commentary</span><span className="text-muted">/</span>
                <span className="text-muted">{capturing ? "On air" : "Ready when you are"}</span>
              </div>
              <p className="player-instruction">
                {source === "youtube" ? 'Press Start, choose “This tab”, then play the video.' : "Press Start, then play the video."}
              </p>
              {source === "link" && id && (download || loading || offset > 0) && (
                <p className="download-status" role="status">
                  <span className="status-dot" />
                  {download ||
                    (loading
                      ? offset
                        ? `Jumping to ${clock(offset)}… about 20 seconds`
                        : "Loading…"
                      : `Watching from ${clock(offset)}`)}
                  {offset > 0 && (
                    <button type="button" className="ml-3 underline" onClick={() => { queue.current = []; setOffset(0); }}>
                      Back to full match
                    </button>
                  )}
                </p>
              )}
            </div>
          </section>
        </div>

        <aside className="commentary-rail" aria-label="Live match insights">
          <CommentatorPicker />
          <section className="game-panel" aria-labelledby="game-heading">
            <div className="flex items-center justify-between gap-3">
              <h2 id="game-heading" className="rail-title"><BoothIcon name="activity" />Game read</h2>
              <span className="eyebrow text-muted">{read ? "Tracking" : "Awaiting play"}</span>
            </div>
            <div className="mt-6 flex items-end justify-between">
              <span className="eyebrow text-muted">Danger level</span>
              <span className="danger-number">{read ? Math.round(read.r.danger) : "—"}<span>/100</span></span>
            </div>
            <div className="danger-track" role="meter" aria-label="Danger level" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={read?.r.danger ?? 0} aria-valuetext={read ? `${Math.round(read.r.danger)} out of 100` : "Awaiting play"}>
              <div className="danger-fill" style={{ width: `${read?.r.danger ?? 0}%` }} />
            </div>
            <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-wider text-muted"><span>Settled</span><span>Threatening</span></div>
            <p className="game-description">{read ? describeRead(read.r, read.names) : "The shape of the game, as it happens. Start commentary to track possession, pressure and danger."}</p>
          </section>

          <section className="feed-panel" aria-labelledby="feed-heading">
            <div className="panel-heading">
              <h2 id="feed-heading" className="rail-title"><BoothIcon name="mic" />Commentary</h2>
              <span className="eyebrow text-muted">Newest first</span>
            </div>
            <div className="feed-scroll" role="region" aria-label="Commentary feed" tabIndex={0}>
              {lines?.length ? (
                <ol className="commentary-list" aria-live="polite" aria-relevant="additions">
                  {lines.map((l, index) => (
                    <li key={l._id} className={`commentary-line ${l.event === "goal" ? "goal-line" : ""}`}>
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <span className="event-badge" data-event={l.event}>{l.event === "goal" && <span aria-hidden="true">⚽ </span>}{l.event}</span>
                          {/* Two people in the booth: the chosen style calls the action, the co-commentator analyses. */}
                          <span className="eyebrow text-muted">{l.persona.startsWith("co:") ? "Co-commentator" : "Caller"}</span>
                        </span>
                        {index === 0 && <span className="latest-label">Latest call</span>}
                      </div>
                      <p>{l.text}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="feed-empty">
                  <div className="empty-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
                  <h3>Every moment. A voice.</h3>
                  <p>{lines === undefined ? "Connecting to the commentary feed…" : "Start the broadcast and press play. The live calls will land right here."}</p>
                  <span className="eyebrow">The booth is yours</span>
                </div>
              )}
            </div>
            <div className="feed-footer"><span className={`status-dot ${capturing ? "text-accent" : ""}`} />{capturing ? "Live commentary enabled" : "Waiting for kick-off"}</div>
          </section>
        </aside>
      </div>

      <video ref={streamVideo} muted playsInline className="hidden" />
      <canvas ref={crop} className="hidden" />
      <details className="engine-room">
        <summary>
          <span className="flex items-center gap-3"><BoothIcon name="sliders" /><span>Engine room</span><span className="engine-subtitle">Detection, match context & diagnostics</span></span>
          <span className="flex items-center gap-3"><span className="model-status">{model}</span><BoothIcon name="chevron" className="engine-chevron" /></span>
        </summary>
        <div className="engine-content">
          <div className="engine-grid">
            <section className="min-w-0">
              <h3 className="eyebrow mb-3">Vision preview</h3>
              {/* Keep this canvas mounted when the engine room is closed. */}
              <canvas ref={preview} className="detection-preview" aria-label="Live player and ball detections" />
              <p className="diagnostic-text mt-3">
                players {stats.players} | ball {stats.ball} | speed{" "}
                {stats.speed.toFixed(2)} | cut {stats.cut.toFixed(0)} | pitch{" "}
                {stats.pitchMs}ms | ball model {stats.ballMs.toFixed(0)}ms | last:{" "}
                {stats.last}
              </p>
              <h3 className="eyebrow mb-3 mt-6">Haiku log</h3>
              <ul className="space-y-2">
                {log.map((l, i) => <li key={i} className="diagnostic-text">haiku → {l}</li>)}
              </ul>
            </section>
            <section className="min-w-0">
              <h3 className="eyebrow mb-3">Match context</h3>
              <label className="block text-sm text-muted">
                Clubs for talking points (name, town, league; comma separated)
                <input className="engine-input mt-2" value={clubs} onChange={(e) => setClubs(e.target.value)} />
              </label>
              <label className="mt-4 block text-sm text-muted">
                Match date for a replayed match (YYYY-MM-DD; empty = live, today&apos;s news)
                <input className="engine-input mt-2" value={matchDate} placeholder="2018-12-02"
                  onChange={(e) => {
                    dateTouched.current = true;
                    setMatchDate(e.target.value.trim());
                  }} />
              </label>
              <details className="lineup-box mt-4">
                <summary>Lineup <span className="text-xs text-muted">Team name, then “number name” per line</span></summary>
                <textarea className="engine-input mt-3 h-40 font-mono text-xs"
                  aria-label="Team lineup"
                  placeholder={"Bashkimi\n1 Name Surname\n9 Name Surname\n\nShkendija\n1 Name Surname"}
                  value={rosterText ?? savedRoster ?? ""} onChange={(e) => setRosterText(e.target.value)} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className="secondary-button" onClick={() => saveRoster({ roster: rosterText ?? savedRoster ?? "" })}>Save lineup</button>
                  <button className="secondary-button" onClick={() => {
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
                  }}>Find lineups online</button>
                </div>
                <p className="diagnostic-text mt-2" role="status">{lineupNote}</p>
              </details>
              <h3 className="eyebrow mb-3 mt-6">Talking points</h3>
              <p className="diagnostic-text mb-3">talking points {topicNote} | {gapNote}</p>
              <div className="space-y-2">
                {topics?.map((t) => (
                  <p key={t._id} title={t.detail} className="diagnostic-text">
                    {t.score} · {t.kind} · {t.subject} · {t.window}
                    {t.usedCount ? ` · used ${t.usedCount}x` : ""} ·{" "}
                    <a className="underline decoration-white/30 underline-offset-4 hover:text-accent" href={t.sourceUrl} target="_blank" rel="noreferrer">{t.sourceName}</a>
                  </p>
                ))}
              </div>
            </section>
          </div>
        </div>
      </details>
      <footer className="studio-footer"><span>BOOTH <span className="text-accent">/</span> THE BEAUTIFUL GAME, CALLED YOUR WAY.</span><span>LIVE AI COMMENTARY</span></footer>
    </main>
  );
}
