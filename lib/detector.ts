// In-browser YOLOv8n (COCO) detector: players ("person") and the ball ("sports ball").
// Input is a 640x640 letterboxed frame; output is [1, 84, 8400].
export type Box = { x: number; y: number; w: number; h: number; score: number };
export type Detections = { players: Box[]; ball: Box | null };

const SIZE = 640;
const PERSON = 0;
const BALL = 32;

type Ort = typeof import("onnxruntime-web/all");
let ortPromise: Promise<{ ort: Ort; session: import("onnxruntime-web/all").InferenceSession }> | null = null;

export function loadDetector() {
  ortPromise ??= (async () => {
    const ort = await import("onnxruntime-web/all");
    ort.env.logLevel = "error";
    ort.env.wasm.wasmPaths ="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
    const session = await ort.InferenceSession.create("/models/yolov8n.onnx", {
      executionProviders: ["webgpu", "wasm"],
    });
    return { ort, session };
  })();
  return ortPromise;
}

// The model file is float16, so convert the input to half floats and decode the output.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  if (e <= 0) return sign; // inputs are 0-1, so flush denormals to zero
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((x & 0x7fffff) >>> 13);
}
function fromHalf(h: number) {
  const sign = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * (1 + m / 1024) * 2 ** (e - 15);
}

const work = typeof document !== "undefined" ? document.createElement("canvas") : null;

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
  const input = new Uint16Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = toHalf(data[i * 4] / 255);
    input[plane + i] = toHalf(data[i * 4 + 1] / 255);
    input[2 * plane + i] = toHalf(data[i * 4 + 2] / 255);
  }
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float16", input, [1, 3, SIZE, SIZE]),
  });
  const raw = out[session.outputNames[0]].data as unknown as ArrayLike<number>;
  // ORT returns Uint16Array bit patterns, or Float16Array where the browser supports it.
  const at = raw instanceof Uint16Array ? (i: number) => fromHalf(raw[i]) : (i: number) => raw[i];
  const n = out[session.outputNames[0]].dims[2];

  const players: Box[] = [];
  let ball: Box | null = null;
  for (let i = 0; i < n; i++) {
    const person = at((4 + PERSON) * n + i);
    const sb = at((4 + BALL) * n + i);
    const cx = at(i);
    const cy = at(n + i);
    const w = at(2 * n + i);
    const h = at(3 * n + i);
    const toSrc = (score: number): Box => ({
      x: (cx - w / 2 - ox) / scale,
      y: (cy - h / 2 - oy) / scale,
      w: w / scale,
      h: h / scale,
      score,
    });
    if (person > 0.35) players.push(toSrc(person));
    // The ball is tiny in broadcast view, so use a lower threshold.
    if (sb > 0.15 && (!ball || sb > ball.score)) ball = toSrc(sb);
  }
  return { players: nms(players), ball };
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
