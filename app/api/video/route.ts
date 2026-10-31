import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import path from "node:path";

// Paste-a-link source: yt-dlp downloads the match to a local cache in the background (about 14x faster
// than real time), and this route serves byte ranges of whatever has arrived. The host page plays it in
// its own <video> and reads frames directly, so there is no screen sharing and seeking works.
// YouTube refuses plain fetches of its stream URLs, so yt-dlp has to do the downloading.
// Needs a current yt-dlp on PATH (brew install yt-dlp).

const run = promisify(execFile);
const FORMAT = "bv*[height<=720][ext=mp4][vcodec^=avc1]/b[height<=720][ext=mp4]";
const DIR = path.join(process.cwd(), ".cache", "videos");
const CHUNK = 4 * 1024 * 1024;
const WAIT_MS = 60_000; // how long a request waits for bytes that have not downloaded yet

type Job = { file: string; size: number; proc: ChildProcess | null; error: string | null };
const jobs = new Map<string, Promise<Job>>();

function start(link: string): Promise<Job> {
  let job = jobs.get(link);
  if (job) return job;
  job = (async () => {
    const { stdout } = await run("yt-dlp", ["-j", "--no-playlist", "-f", FORMAT, link], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const info = JSON.parse(stdout);
    const size = Number(info.filesize ?? info.filesize_approx);
    if (!size) throw new Error("yt-dlp gave no file size for this video");
    mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `${info.id}.${info.ext ?? "mp4"}`);
    const j: Job = { file, size, proc: null, error: null };
    if (existsSync(file) && statSync(file).size >= size) return j;
    // yt-dlp grows <file>.part and renames it when done; it resumes a .part left by an earlier run.
    j.proc = spawn("yt-dlp", ["-q", "--no-playlist", "-f", FORMAT, "-o", file, link]);
    j.proc.stderr?.on("data", (d) => (j.error = String(d).slice(0, 500)));
    j.proc.on("exit", () => (j.proc = null));
    return j;
  })();
  job.catch(() => jobs.delete(link));
  jobs.set(link, job);
  return job;
}

// Jump-ahead: a separate download that starts at `from` seconds, for seeking past the main download.
// ffmpeg writes fragmented mp4 so the browser can play it while it grows. It takes about 20s to start.
type Section = { file: string; proc: ChildProcess | null };
const sections = new Map<string, Section>();

function startSection(link: string, id: string, from: number): Section {
  const key = `${link}@${from}`;
  let sec = sections.get(key);
  if (sec && (sec.proc || existsSync(sec.file))) return sec;
  const file = path.join(DIR, `${id}@${from}.mp4`);
  sec = { file, proc: null };
  const proc = spawn("yt-dlp", [
    "-q", "--no-playlist", "-f", FORMAT,
    "--download-sections", `*${from}-inf`,
    "--downloader-args", "ffmpeg_o:-movflags frag_keyframe+empty_moov+default_base_moof",
    "--force-overwrites", "-o", file, link,
  ]);
  sec.proc = proc;
  proc.on("exit", () => (sec!.proc = null));
  sections.set(key, sec);
  return sec;
}

// Streams a growing section file from the start, waiting for new bytes until the download ends.
function tail(sec: Section, signal: AbortSignal) {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (signal.aborted) return controller.close();
        const f = current(sec.file);
        const size = existsSync(f) ? statSync(f).size : 0;
        if (size > pos) {
          const buf = Buffer.alloc(Math.min(size - pos, CHUNK));
          const fd = openSync(f, "r");
          try {
            readSync(fd, buf, 0, buf.length, pos);
          } finally {
            closeSync(fd);
          }
          pos += buf.length;
          return controller.enqueue(new Uint8Array(buf));
        }
        if (!sec.proc) return controller.close();
        await new Promise((r) => setTimeout(r, 300));
      }
    },
  });
}

// The finished file, or the growing .part while yt-dlp is still downloading.
const current = (file: string) => (existsSync(file) ? file : `${file}.part`);
const have = (file: string) => (existsSync(current(file)) ? statSync(current(file)).size : 0);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const link = params.get("url");
  if (!link || !/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(link)) {
    return new Response("url must be a YouTube link", { status: 400 });
  }
  let job: Job;
  try {
    job = await start(link);
    // A download that stopped before the end (killed, server restart) resumes from its .part.
    if (!job.proc && have(job.file) < job.size) {
      jobs.delete(link);
      job = await start(link);
    }
  } catch (e) {
    return new Response(`yt-dlp failed: ${e instanceof Error ? e.message : e}`, { status: 502 });
  }

  const from = Number(params.get("from"));
  if (from > 0) {
    const id = path.basename(job.file).replace(/\.[^.]+$/, "");
    const sec = startSection(link, id, Math.floor(from));
    return new Response(tail(sec, request.signal), { headers: { "content-type": "video/mp4" } });
  }

  // The page polls this to show download progress.
  if (params.has("status")) {
    return Response.json({ have: have(job.file), size: job.size, downloading: !!job.proc, error: job.error });
  }

  const m = /bytes=(\d+)-(\d*)/.exec(request.headers.get("range") ?? "");
  const at = m ? Number(m[1]) : 0;
  if (at >= job.size) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${job.size}` } });
  }
  const deadline = Date.now() + WAIT_MS;
  while (have(job.file) <= at) {
    if (!job.proc && have(job.file) <= at) return new Response(job.error ?? "download stopped", { status: 503 });
    if (Date.now() > deadline || request.signal.aborted) return new Response("still downloading", { status: 503 });
    await new Promise((r) => setTimeout(r, 300));
  }
  const want = m?.[2] ? Number(m[2]) : job.size - 1;
  const to = Math.min(want, have(job.file) - 1, at + CHUNK - 1);

  const buf = Buffer.alloc(to - at + 1);
  const fd = openSync(current(job.file), "r");
  try {
    readSync(fd, buf, 0, buf.length, at);
  } finally {
    closeSync(fd);
  }
  return new Response(buf, {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(buf.length),
      "content-range": `bytes ${at}-${to}/${job.size}`,
      "accept-ranges": "bytes",
    },
  });
}
