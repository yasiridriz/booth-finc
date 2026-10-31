import type { Detections } from "./detector";

// Decides when a frame is worth sending to Haiku. Three signals:
// fast ball motion, a scene cut (replay, goal close-up), and a slow heartbeat.
export type Trigger = { reason: "ball-fast" | "scene-cut" | "heartbeat"; hint: string } | null;

const COOLDOWN_MS = 2000;
const HEARTBEAT_MS = 6000;
const BALL_SPEED = 0.6; // frame widths per second
const CUT_DIFF = 40; // mean abs diff of a 32x18 grayscale thumb, 0-255

export class TriggerState {
  private lastFire = 0;
  private lastBall: { x: number; y: number; t: number } | null = null;
  private lastThumb: Uint8ClampedArray | null = null;
  ballSpeed = 0;
  cutDiff = 0;

  update(src: HTMLCanvasElement, det: Detections, now: number): Trigger {
    const speed = this.trackBall(src, det, now);
    this.ballSpeed = speed;
    this.cutDiff = this.sceneDiff(src);

    if (now - this.lastFire < COOLDOWN_MS) return null;
    let reason: NonNullable<Trigger>["reason"] | null = null;
    if (this.cutDiff > CUT_DIFF) reason = "scene-cut";
    else if (speed > BALL_SPEED) reason = "ball-fast";
    else if (now - this.lastFire > HEARTBEAT_MS) reason = "heartbeat";
    if (!reason) return null;

    this.lastFire = now;
    const hint = `${det.players.length} players visible; ball ${
      det.ball ? `seen, speed ${speed.toFixed(2)} widths/s` : "not seen"
    }; trigger: ${reason}`;
    return { reason, hint };
  }

  private trackBall(src: HTMLCanvasElement, det: Detections, now: number) {
    if (!det.ball) {
      this.lastBall = null;
      return 0;
    }
    const x = det.ball.x + det.ball.w / 2;
    const y = det.ball.y + det.ball.h / 2;
    let speed = 0;
    if (this.lastBall) {
      const dt = (now - this.lastBall.t) / 1000;
      if (dt > 0) speed = Math.hypot(x - this.lastBall.x, y - this.lastBall.y) / src.width / dt;
    }
    this.lastBall = { x, y, t: now };
    return speed;
  }

  private sceneDiff(src: HTMLCanvasElement) {
    const c = (this.thumbCanvas ??= document.createElement("canvas"));
    c.width = 32;
    c.height = 18;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0, 32, 18);
    const px = ctx.getImageData(0, 0, 32, 18).data;
    const gray = new Uint8ClampedArray(32 * 18);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    let diff = 0;
    if (this.lastThumb) {
      for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - this.lastThumb[i]);
      diff /= gray.length;
    }
    this.lastThumb = gray;
    return diff;
  }
  private thumbCanvas: HTMLCanvasElement | null = null;
}
