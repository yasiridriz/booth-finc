import { zoneOf, type Pitch } from "./pitch";
import type { Box } from "./detector";

// Turns per-frame detections into a read of the game: who attacks which way,
// who has the ball, what phase it is, and how dangerous it looks.
// Pitch coordinates are metres on a 105x68 pitch, x left to right.

export type Team = 0 | 1;
type Pt = [number, number];

export type Frame = {
  t: number; // ms
  pitch: Pitch | null;
  players: Box[];
  teams: (Team | null)[]; // one per player box
  keepers: Box[];
  ball: Box | null;
};

export type Read = {
  attacking: Record<Team, 1 | -1 | null>; // +1 means attacking towards x = 105
  possession: Team | null;
  phase: string;
  zone: string | null;
  danger: number; // 0-100
  momentum: [number, number]; // share of possession over the last 30s
  box: { attackers: number; defenders: number } | null;
};

const BALL_MEMORY_MS = 2000;
const POSSESSION_M = 4; // nearest player within this distance has the ball
const MOMENTUM_MS = 30000;
const ground = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h];
const centre = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];
const onPitch = ([x, y]: Pt) => x > -5 && x < 110 && y > -5 && y < 73;
const inBox = ([x, y]: Pt, right: boolean) =>
  y > 13.84 && y < 54.16 && (right ? x > 88.5 : x < 16.5);

export class GameState {
  // Running mean of (team 1 mean x - team 0 mean x). Each team sits nearer its own goal on average.
  private spread = 0;
  private spreadN = 0;
  private flip = false;
  private ball: { p: Pt; t: number } | null = null;
  private lastBallP: { p: Pt; t: number } | null = null;
  private possession: Team | null = null;
  private history: { t: number; team: Team }[] = [];
  private danger = 0;

  // Manual override for when the auto direction is wrong.
  toggleDirection() {
    this.flip = !this.flip;
  }

  update(f: Frame): Read | null {
    if (!f.pitch) return null;
    const pitch = f.pitch;
    const pts = f.players.map((b) => pitch.toPitch(...ground(b)));
    const own: Record<Team, Pt[]> = { 0: [], 1: [] };
    pts.forEach((p, i) => {
      const team = f.teams[i];
      if (team !== null && team !== undefined && onPitch(p)) own[team].push(p);
    });

    // Direction of play.
    if (own[0].length >= 3 && own[1].length >= 3) {
      const mean = (a: Pt[]) => a.reduce((s, p) => s + p[0], 0) / a.length;
      this.spreadN = Math.min(this.spreadN + 1, 200);
      this.spread += (mean(own[1]) - mean(own[0]) - this.spread) / this.spreadN;
    }
    // Team 1 deeper on the right means team 1 defends the right goal and attacks left.
    let dir0: 1 | -1 | null = this.spreadN >= 10 ? (this.spread > 0 ? 1 : -1) : null;
    if (dir0 && this.flip) dir0 = dir0 === 1 ? -1 : 1;
    const attacking: Record<Team, 1 | -1 | null> = {
      0: dir0,
      1: dir0 ? (dir0 === 1 ? -1 : 1) : null,
    };

    // Ball, remembered briefly when the detector loses it.
    if (f.ball) {
      const p = pitch.toPitch(...centre(f.ball));
      if (onPitch(p)) {
        this.lastBallP = this.ball;
        this.ball = { p, t: f.t };
      }
    }
    const ball = this.ball && f.t - this.ball.t < BALL_MEMORY_MS ? this.ball.p : null;

    // Possession: the nearest player's team, sticky until the other team is closer.
    if (ball) {
      let best: { d: number; team: Team } | null = null;
      for (const team of [0, 1] as Team[])
        for (const p of own[team]) {
          const d = Math.hypot(p[0] - ball[0], p[1] - ball[1]);
          if (!best || d < best.d) best = { d, team };
        }
      if (best && best.d < POSSESSION_M) this.possession = best.team;
    }
    if (this.possession !== null) this.history.push({ t: f.t, team: this.possession });
    this.history = this.history.filter((h) => f.t - h.t < MOMENTUM_MS);
    const share0 = this.history.length
      ? this.history.filter((h) => h.team === 0).length / this.history.length
      : 0.5;

    // Phase and danger, seen from the team with the ball.
    let phase = "unclear";
    let box: Read["box"] = null;
    let target = 0;
    const att = this.possession;
    const dir = att !== null ? attacking[att] : null;
    if (ball && att !== null && dir) {
      const ax = dir === 1 ? ball[0] : 105 - ball[0]; // metres towards the goal they attack
      const right = dir === 1;
      const def = (att === 0 ? 1 : 0) as Team;
      box = {
        attackers: own[att].filter((p) => inBox(p, right)).length,
        defenders: own[def].filter((p) => inBox(p, right)).length + f.keepers.length,
      };
      if (inBox(ball, right)) phase = "in the box";
      else if (ax > 70) phase = "attacking third";
      else if (ax > 35) phase = "middle third";
      else phase = "building from the back";

      // Ball moving towards goal adds danger.
      const prev = this.lastBallP;
      const toward =
        prev && f.t - prev.t < 1500 ? ((ball[0] - prev.p[0]) * dir) / ((f.t - prev.t) / 1000) : 0;
      target =
        Math.max(0, (ax - 45) / 60) * 55 +
        (phase === "in the box" ? 25 : 0) +
        Math.min(15, box.attackers * 5) -
        Math.max(0, box.defenders - box.attackers) * 3 +
        Math.max(0, Math.min(15, toward * 1.5));
    }
    // Danger rises fast and decays slowly, like a crowd.
    const k = target > this.danger ? 0.6 : 0.15;
    this.danger += (Math.max(0, Math.min(100, target)) - this.danger) * k;

    return {
      attacking,
      possession: this.possession,
      phase,
      zone: ball ? zoneOf(ball) : null,
      danger: Math.round(this.danger),
      momentum: [share0, 1 - share0],
      box,
    };
  }
}

// One line for Haiku. names[i] is how to call team i, e.g. "green shirts".
export function describeRead(r: Read, names: [string, string]): string {
  const parts: string[] = [];
  const dir = (d: 1 | -1 | null) => (d === 1 ? "left to right" : d === -1 ? "right to left" : "unknown");
  parts.push(`${names[0]} attack ${dir(r.attacking[0])}, ${names[1]} attack ${dir(r.attacking[1])}`);
  if (r.possession !== null) {
    parts.push(`${names[r.possession]} have the ball, ${r.phase}${r.zone ? ` (${r.zone})` : ""}`);
    if (r.box && (r.box.attackers || r.box.defenders))
      parts.push(`${r.box.attackers} attackers vs ${r.box.defenders} defenders in the box`);
  } else if (r.zone) parts.push(`ball in ${r.zone}`);
  parts.push(`danger ${r.danger}/100`);
  const [a, b] = r.momentum;
  if (Math.abs(a - b) > 0.3) parts.push(`${names[a > b ? 0 : 1]} dominating possession lately`);
  return parts.join("; ");
}
