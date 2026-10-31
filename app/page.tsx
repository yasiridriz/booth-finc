"use client";
import { useAction, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { detect, loadDetector, type Detections } from "@/lib/detector";
import { TriggerState } from "@/lib/trigger";

const DEFAULT_URL = "https://www.youtube.com/watch?v=91WI0e0Mf3c";
const DETECT_FPS = 5;

function videoId(url: string) {
  return url.match(/(?:v=|youtu\.be\/|embed\/|live\/)([\w-]{11})/)?.[1] ?? null;
}

export default function Host() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [capturing, setCapturing] = useState(false);
  const [stats, setStats] = useState({
    players: 0,
    ball: "-",
    speed: 0,
    cut: 0,
    last: "idle",
  });
  const [model, setModel] = useState("loading model...");

  const frameRef = useRef<HTMLIFrameElement>(null);
  const streamVideo = useRef<HTMLVideoElement>(null);
  const crop = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const busy = useRef(false);
  const ring = useRef<{ t: number; c: HTMLCanvasElement }[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const lastPlayed = useRef<string | null>(null);
  const trigger = useRef(new TriggerState());

  const processFrame = useAction(api.booth.processFrame);
  const lines = useQuery(api.booth.latest);
  const id = videoId(url);

  useEffect(() => {
    loadDetector().then(
      () => setModel("model ready"),
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

  const drawPreview = useCallback((det: Detections) => {
    const c = crop.current!;
    const p = preview.current!;
    p.width = c.width;
    p.height = c.height;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#22d3ee";
    det.players.forEach((b) => ctx.strokeRect(b.x, b.y, b.w, b.h));
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
  }, []);

  useEffect(() => {
    if (!capturing) return;
    let stop = false;
    const tick = async () => {
      try {
        const v = streamVideo.current!;
        const box = frameRef.current!.getBoundingClientRect();
        if (v.videoWidth) {
          // The captured tab is scaled against the CSS viewport, so map the iframe rect into it.
          const k = v.videoWidth / window.innerWidth;
          const c = crop.current!;
          c.width = Math.round(box.width * k);
          c.height = Math.round(box.height * k);
          c.getContext("2d")!.drawImage(
            v,
            box.left * k,
            box.top * k,
            c.width,
            c.height,
            0,
            0,
            c.width,
            c.height,
          );

          // Show the raw crop first so the preview fills even if detection fails.
          const p = preview.current!;
          p.width = c.width;
          p.height = c.height;
          p.getContext("2d")!.drawImage(c, 0, 0);

          const det = await detect(c);
          const now = performance.now();
          const t = trigger.current.update(c, det, now);
          drawPreview(det);
          setStats((s) => ({
            ...s,
            players: det.players.length,
            ball: det.ball ? det.ball.score.toFixed(2) : "-",
            speed: trigger.current.ballSpeed,
            cut: trigger.current.cutDiff,
          }));

          if (t && !busy.current && ring.current.length) {
            busy.current = true;
            const frames = ring.current.map(
              (f) => f.c.toDataURL("image/jpeg", 0.6).split(",")[1],
            );
            processFrame({ frames, hint: t.hint })
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
  }, [capturing, processFrame, drawPreview]);

  // Play the newest line once.
  useEffect(() => {
    const top = lines?.[0];
    if (top?.audioUrl && top.audioUrl !== lastPlayed.current) {
      lastPlayed.current = top.audioUrl;
      new Audio(top.audioUrl).play().catch(() => {});
    }
  }, [lines]);

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-4">
      <h1 className="text-2xl font-bold">Booth: host</h1>
      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-2 py-1 text-black"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="border rounded px-3"
          onClick={start}
          disabled={capturing || !id}
        >
          {capturing ? "Capturing" : "Start capture"}
        </button>
      </div>
      <p className="text-sm opacity-70">
        Press Start capture, choose &quot;This tab&quot;, then press play on the
        video. {model}
      </p>
      {id && (
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
            {stats.speed.toFixed(2)} | cut {stats.cut.toFixed(0)} | last:{" "}
            {stats.last}
          </p>
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
    </main>
  );
}
