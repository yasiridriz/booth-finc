// Builds the site as plain files in out/ for hosts without a Node server (Cloudflare Pages, GitHub Pages).
// A static export cannot contain route handlers, so app/api (paste-a-link playback, which needs yt-dlp) is moved
// aside for the build and always put back. The big files stay out of out/; see lib/assets.ts.
import { existsSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const api = "app/api";
const hidden = ".api-hidden";
if (existsSync(hidden)) throw new Error(`${hidden} exists: a build was interrupted. Move it back to ${api} first.`);

const had = existsSync(api);
if (had) renameSync(api, hidden);
const restore = () => {
  if (had && existsSync(hidden)) renameSync(hidden, api);
};
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

let status = 1;
try {
  const env = { ...process.env, STATIC_EXPORT: "1", NEXT_PUBLIC_STATIC: "1" };
  status = spawnSync("npx", ["next", "build"], { stdio: "inherit", env }).status ?? 1;
  if (status === 0) {
    // Models and clips are too big for a static host's per-file cap. They are served from the asset base instead.
    for (const pattern of ["*.wasm", "*.onnx", "*.mp4"]) spawnSync("find", ["out", "-name", pattern, "-delete"]);
  }
} finally {
  restore();
}
process.exit(status);
