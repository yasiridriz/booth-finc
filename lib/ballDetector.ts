// Ball-only detector: yolov9-soccer-ball (AGPL-3.0, huggingface.co/acatorcini/yolov9-soccer-ball).
// Fixed 1280x1280 input, float32 output [1, 5, 33600] = cx, cy, w, h, conf per anchor.
// It is slow, so it runs on its own schedule beside the main loop and never blocks it.
import type { Box } from "./detector";
import { withOrt } from "./ortLock";

const SIZE = 1280;
const MIN_CONF = 0.25;
const MIN_GAP_MS = 400; // the 1280px model is heavy, so do not run it back to back

type Ort = typeof import("onnxruntime-web/all");
let ready: Promise<{
  ort: Ort;
  session: import("onnxruntime-web/all").InferenceSession;
}> | null = null;

function load() {
  ready ??= (async () => {
    const ort = await import("onnxruntime-web/all");
    ort.env.logLevel = "error";
    ort.env.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
    const session = await ort.InferenceSession.create(
      "/models/yolov9-ball.onnx",
      {
        executionProviders: ["webgpu", "wasm"],
      },
    );
    return { ort, session };
  })();
  return ready;
}

const work =
  typeof document !== "undefined" ? document.createElement("canvas") : null;

async function run(src: HTMLCanvasElement): Promise<Box | null> {
  const { ort, session } = await load();
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
  const o = out[session.outputNames[0]].data as Float32Array;
  const n = out[session.outputNames[0]].dims[2];

  let best = -1;
  let bestConf = MIN_CONF;
  for (let i = 0; i < n; i++) {
    const conf = o[4 * n + i];
    if (conf > bestConf) {
      bestConf = conf;
      best = i;
    }
  }
  if (best < 0) return null;
  const w = o[2 * n + best];
  const h = o[3 * n + best];
  return {
    x: (o[best] - w / 2 - ox) / scale,
    y: (o[n + best] - h / 2 - oy) / scale,
    w: w / scale,
    h: h / scale,
    score: bestConf,
  };
}

export class BallWorker {
  private busy = false;
  private lastStart = 0;
  private latest: { box: Box | null; t: number } | null = null;
  ms = 0; // duration of the last inference

  // Start a run if none is active. Returns at once.
  submit(src: HTMLCanvasElement) {
    const start = performance.now();
    if (this.busy || start - this.lastStart < MIN_GAP_MS) return;
    this.busy = true;
    this.lastStart = start;
    // Copy the frame: the caller redraws its canvas before the lock frees up.
    const copy = document.createElement("canvas");
    copy.width = src.width;
    copy.height = src.height;
    copy.getContext("2d")!.drawImage(src, 0, 0);
    withOrt(() => run(copy))
      .then((box) => {
        this.latest = { box, t: performance.now() };
        this.ms = performance.now() - start;
      })
      .catch((e) => console.error("ball detector", e))
      .finally(() => (this.busy = false));
  }

  // Newest ball position, or null if none was found or it is older than maxAgeMs.
  fresh(now: number, maxAgeMs = 600): Box | null {
    return this.latest && now - this.latest.t < maxAgeMs
      ? this.latest.box
      : null;
  }
}
