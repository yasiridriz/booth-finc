import { asset } from "./assets";
// In-browser YOLOv8n detector fine-tuned on football broadcasts.
// Input is a 640x640 letterboxed frame; output is [1, 8, 8400].
// Classes: 0 ball, 1 goalkeeper, 2 player, 3 referee.
export type Box = { x: number; y: number; w: number; h: number; score: number };
export type Detections = {
  players: Box[];
  goalkeepers: Box[];
  referees: Box[];
  ball: Box | null;
};

const SIZE = 640;
const BALL = 0;
const GOALKEEPER = 1;
const PLAYER = 2;
const REFEREE = 3;
const PERSON_MIN = 0.35;
// The ball is tiny in broadcast view, so use a lower threshold.
const BALL_MIN = 0.15;

type Ort = typeof import("onnxruntime-web/all");
let ortPromise: Promise<{
  ort: Ort;
  session: import("onnxruntime-web/all").InferenceSession;
}> | null = null;

export function loadDetector() {
  ortPromise ??= (async () => {
    const ort = await import("onnxruntime-web/all");
    ort.env.logLevel = "error";
    ort.env.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
    const session = await ort.InferenceSession.create(
      asset("/models/football.onnx"),
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

// src is the already cropped match canvas. Returned boxes are in src pixel coordinates.
export async function detect(src: HTMLCanvasElement): Promise<Detections> {
  const { ort, session } = await loadDetector();
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

  const keepers: Box[] = [];
  const outfield: Box[] = [];
  const refs: Box[] = [];
  let ball: Box | null = null;
  for (let i = 0; i < n; i++) {
    const cx = raw[i];
    const cy = raw[n + i];
    const w = raw[2 * n + i];
    const h = raw[3 * n + i];
    const toSrc = (score: number): Box => ({
      x: (cx - w / 2 - ox) / scale,
      y: (cy - h / 2 - oy) / scale,
      w: w / scale,
      h: h / scale,
      score,
    });
    const b = raw[(4 + BALL) * n + i];
    const g = raw[(4 + GOALKEEPER) * n + i];
    const p = raw[(4 + PLAYER) * n + i];
    const r = raw[(4 + REFEREE) * n + i];
    if (g > PERSON_MIN) keepers.push(toSrc(g));
    if (p > PERSON_MIN) outfield.push(toSrc(p));
    if (r > PERSON_MIN) refs.push(toSrc(r));
    if (b > BALL_MIN && (!ball || b > ball.score)) ball = toSrc(b);
  }
  const goalkeepers = nms(keepers);
  // players includes goalkeepers so callers that only read players still see them.
  return {
    players: [...nms(outfield), ...goalkeepers],
    goalkeepers,
    referees: nms(refs),
    ball,
  };
}

function iou(a: Box, b: Box) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

function nms(boxes: Box[]) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: Box[] = [];
  for (const b of sorted) if (keep.every((k) => iou(k, b) < 0.5)) keep.push(b);
  return keep;
}
