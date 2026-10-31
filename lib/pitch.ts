// In-browser YOLOv8-pose pitch keypoint model.
// Input is a 640x640 letterboxed frame; output is [1, 101, 8400]:
// rows 0-3 box, row 4 pitch score, rows 5-100 = 32 keypoints x (x, y, conf).
// The keypoints give a homography from frame pixels to pitch metres.
import type { Box } from "./detector";
import { PITCH_VERTICES } from "./pitchConfig";
import { asset } from "./assets";

export type Pitch = { toPitch(x: number, y: number): [number, number] };

const SIZE = 640;
const PITCH_MIN = 0.3;
const KP_MIN = 0.5;
const MAX_ERR = 3; // metres
const L = 105;
const W = 68;

type Ort = typeof import("onnxruntime-web/all");
let ortPromise: Promise<{
  ort: Ort;
  session: import("onnxruntime-web/all").InferenceSession;
}> | null = null;

export function loadPitch() {
  ortPromise ??= (async () => {
    const ort = await import("onnxruntime-web/all");
    ort.env.logLevel = "error";
    ort.env.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
    const session = await ort.InferenceSession.create(
      asset("/models/pitch.onnx"),
      {
        executionProviders: ["webgpu", "wasm"],
      },
    );
    return { ort, session };
  })();
  return ortPromise;
}

const work =
  typeof document !== "undefined" ? document.createElement("canvas") : null;

// src is the already cropped match canvas. Returns null when the pitch can't be located.
export async function locatePitch(
  src: HTMLCanvasElement,
): Promise<Pitch | null> {
  const { ort, session } = await loadPitch();
  work!.width = SIZE;
  work!.height = SIZE;
  const ctx = work!.getContext("2d", { willReadFrequently: true })!;
  const scale = Math.min(SIZE / src.width, SIZE / src.height);
  const dw = src.width * scale;
  const dh = src.height * scale;
  const ox = (SIZE - dw) / 2;
  const oy = (SIZE - dh) / 2;
  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(src, ox, oy, dw, dh);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = data[i * 4] / 255;
    input[plane + i] = data[i * 4 + 1] / 255;
    input[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", input, [
      1,
      3,
      SIZE,
      SIZE,
    ]),
  });
  const raw = out[session.outputNames[0]].data as Float32Array;
  const n = out[session.outputNames[0]].dims[2];

  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < n; i++) {
    if (raw[4 * n + i] > bestScore) {
      bestScore = raw[4 * n + i];
      best = i;
    }
  }
  if (best < 0 || bestScore < PITCH_MIN) return null;

  const from: [number, number][] = [];
  const to: [number, number][] = [];
  for (let k = 0; k < PITCH_VERTICES.length; k++) {
    const row = 5 + k * 3;
    if (raw[(row + 2) * n + best] <= KP_MIN) continue;
    // Undo the letterbox so the fit works in src pixels.
    from.push([
      (raw[row * n + best] - ox) / scale,
      (raw[(row + 1) * n + best] - oy) / scale,
    ]);
    to.push(PITCH_VERTICES[k]);
  }
  if (from.length < 4) return null;

  const H = fitHomography(from, to);
  if (!H) return null;
  let err = 0;
  for (let i = 0; i < from.length; i++) {
    const [px, py] = apply(H, from[i][0], from[i][1]);
    err += Math.hypot(px - to[i][0], py - to[i][1]);
  }
  if (!(err / from.length <= MAX_ERR)) return null;
  return { toPitch: (x, y) => apply(H, x, y) };
}

// 3x3 row-major.
type Mat = number[];

function apply(H: Mat, x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function mul(a: Mat, b: Mat): Mat {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

// Move centroid to 0 and mean distance to sqrt(2). Returns the transform and its inverse.
function normalizer(pts: [number, number][]): { T: Mat; inv: Mat } {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - cx, y - cy);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return {
    T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    inv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1],
  };
}

// Normalized DLT with h33 = 1, least squares via normal equations.
function fitHomography(
  from: [number, number][],
  to: [number, number][],
): Mat | null {
  const a = normalizer(from);
  const b = normalizer(to);
  const AtA = Array.from({ length: 8 }, () => new Array(9).fill(0)); // last column is At*b
  const addRow = (r: number[], v: number) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) AtA[i][j] += r[i] * r[j];
      AtA[i][8] += r[i] * v;
    }
  };
  for (let i = 0; i < from.length; i++) {
    const [x, y] = apply(a.T, from[i][0], from[i][1]);
    const [u, v] = apply(b.T, to[i][0], to[i][1]);
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA);
  if (!h) return null;
  const H = mul(b.inv, mul([...h, 1], a.T));
  if (!H.every(Number.isFinite) || Math.abs(H[8]) < 1e-12) return null;
  return H.map((x) => x / H[8]);
}

// Gaussian elimination with partial pivoting on an n x (n+1) augmented matrix.
function solve(M: number[][]): number[] | null {
  const n = M.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export function zoneOf([x, y]: [number, number]): string {
  let zone: string;
  if (y > 13.84 && y < 54.16 && x < 16.5) zone = "left penalty box";
  else if (y > 13.84 && y < 54.16 && x > 88.5) zone = "right penalty box";
  else if (x < 35) zone = "left third";
  else if (x > 70) zone = "right third";
  else zone = "midfield";
  if (y < 8 || y > 60) zone += " near the touchline";
  return zone;
}

// Points more than 5 m off the pitch are likely bad mappings.
function onPitch([x, y]: [number, number]) {
  return x > -5 && x < L + 5 && y > -5 && y < W + 5;
}

// Short plain-words hint, e.g. "ball in right penalty box; 4 players in right penalty box; 2 in left third".
export function describe(
  pitch: Pitch,
  det: { players: Box[]; ball: Box | null },
): string {
  const parts: string[] = [];
  if (det.ball) {
    const p = pitch.toPitch(
      det.ball.x + det.ball.w / 2,
      det.ball.y + det.ball.h / 2,
    );
    if (onPitch(p)) parts.push(`ball in ${zoneOf(p)}`);
  }
  const counts = new Map<string, number>();
  for (const b of det.players) {
    const p = pitch.toPitch(b.x + b.w / 2, b.y + b.h);
    if (!onPitch(p)) continue;
    const z = zoneOf(p);
    counts.set(z, (counts.get(z) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  sorted.forEach(([z, c], i) => {
    parts.push(
      i === 0 ? `${c} player${c === 1 ? "" : "s"} in ${z}` : `${c} in ${z}`,
    );
  });
  return parts.join("; ");
}
