import type { Box } from "./detector";

type Team = 0 | 1;
type Colour = [number, number, number];
type Feature = [number, number, number, number];
type Pair = [Feature, Feature];
type Rect = { x: number; y: number; w: number; h: number };

const ALPHA = 0.1;
const GRASS_TOLERANCE = 0.1;
const MIN_SEPARATION = 0.08;
const LIGHTNESS_WEIGHT = 0.25;
const UNKNOWN: Colour = [0.5, 0.5, 0.5];

function rgbDistance(a: Colour, b: Colour) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Keep brightness separate so shadows have less weight.
function normalize([r, g, b]: Colour): Feature {
  const sum = r + g + b;
  return sum > 0 ? [r / sum, g / sum, b / sum, Math.max(r, g, b)] : [1 / 3, 1 / 3, 1 / 3, 0];
}

function distance(a: Feature, b: Feature) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], LIGHTNESS_WEIGHT * (a[3] - b[3]));
}

function mix(a: Feature, b: Feature): Feature {
  return [
    a[0] + ALPHA * (b[0] - a[0]),
    a[1] + ALPHA * (b[1] - a[1]),
    a[2] + ALPHA * (b[2] - a[2]),
    a[3] + ALPHA * (b[3] - a[3]),
  ];
}

function looksLikeGrass([r, g, b]: Colour) {
  const value = Math.max(r, g, b);
  const delta = value - Math.min(r, g, b);
  if (value < 0.2 || value > 0.8 || delta <= value * 0.25) return false;
  let hue = value === r ? (g - b) / delta : value === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= 70 && hue <= 170;
}

function clip(x: number, y: number, w: number, h: number, width: number, height: number): Rect | null {
  if (![x, y, w, h, x + w, y + h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + w));
  const bottom = Math.min(height, Math.ceil(y + h));
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

// Sample a small grid from the single frame read.
function sample(data: Uint8ClampedArray, union: Rect, rect: Rect, limit: number, visit: (c: Colour) => void) {
  const step = Math.max(1, Math.ceil(Math.sqrt(rect.w * rect.h / limit)));
  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      const offset = ((y - union.y) * union.w + x - union.x) * 4;
      if (data[offset + 3] < 128) continue;
      visit([data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255]);
    }
  }
}

function grassColour(data: Uint8ClampedArray, union: Rect): Colour | null {
  const channels: [number[], number[], number[]] = [[], [], []];
  const h = Math.max(1, Math.ceil(union.h * 0.2));
  sample(data, union, { ...union, y: union.y + union.h - h, h }, 2048, (c) => {
    if (looksLikeGrass(c)) for (let i = 0; i < 3; i++) channels[i].push(c[i]);
  });
  if (channels[0].length < 8) return null;
  return channels.map((values) => {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return (values[mid] + values[Math.floor((values.length - 1) / 2)]) / 2;
  }) as Colour;
}

function cluster(colours: Feature[]): Pair | null {
  let seeds: Pair | null = null;
  let farthest = MIN_SEPARATION;
  for (let i = 0; i < colours.length; i++) {
    for (let j = i + 1; j < colours.length; j++) {
      const d = distance(colours[i], colours[j]);
      if (d > farthest) {
        farthest = d;
        seeds = [colours[i], colours[j]];
      }
    }
  }
  if (!seeds) return null;
  for (let iteration = 0; iteration < 8; iteration++) {
    const sums: Pair = [[0, 0, 0, 0], [0, 0, 0, 0]];
    const counts = [0, 0];
    for (const c of colours) {
      const team = distance(c, seeds[0]) <= distance(c, seeds[1]) ? 0 : 1;
      counts[team]++;
      for (let i = 0; i < 4; i++) sums[team][i] += c[i];
    }
    for (const team of [0, 1] as const) {
      if (counts[team]) seeds[team] = sums[team].map((v) => v / counts[team]) as Feature;
    }
  }
  return distance(seeds[0], seeds[1]) >= MIN_SEPARATION ? seeds : null;
}

let latest: TeamSplitter | null = null;

export class TeamSplitter {
  private centroids: Pair | null = null;

  assign(src: HTMLCanvasElement, players: Box[]): (Team | null)[] {
    latest = this;
    const result: (Team | null)[] = players.map(() => null);
    const boxes = players.map((b) => clip(b.x, b.y, b.w, b.h, src.width, src.height));
    const valid = boxes.filter((b): b is Rect => b !== null);
    if (!valid.length) return result;
    const x = Math.min(...valid.map((b) => b.x));
    const y = Math.min(...valid.map((b) => b.y));
    const union: Rect = {
      x, y,
      w: Math.max(...valid.map((b) => b.x + b.w)) - x,
      h: Math.max(...valid.map((b) => b.y + b.h)) - y,
    };
    const ctx = src.getContext("2d", { willReadFrequently: true });
    if (!ctx) return result;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(union.x, union.y, union.w, union.h).data;
    } catch {
      return result;
    }
    const grass = grassColour(data, union);
    const colours = players.map((b, index): Feature | null => {
      if (!boxes[index]) return null;
      const torso = clip(b.x + b.w * 0.3, b.y + b.h * 0.2, b.w * 0.4, b.h * 0.3, src.width, src.height);
      if (!torso) return null;
      const sum: Feature = [0, 0, 0, 0];
      let kept = 0;
      let total = 0;
      sample(data, union, torso, 256, (c) => {
        total++;
        if (grass && looksLikeGrass(c) && rgbDistance(c, grass) <= GRASS_TOLERANCE) return;
        kept++;
        const normalized = normalize(c);
        for (let i = 0; i < 4; i++) sum[i] += normalized[i];
      });
      if (kept < 3 || kept < total * 0.2) return null;
      return sum.map((v) => v / kept) as Feature;
    });
    const usable = colours.filter((c): c is Feature => c !== null);
    const next = cluster(usable);
    if (!this.centroids) {
      if (!next) return result;
      this.centroids = next;
    } else if (next) {
      const old = this.centroids;
      const direct = distance(next[0], old[0]) + distance(next[1], old[1]);
      const swapped = distance(next[0], old[1]) + distance(next[1], old[0]);
      const matched: Pair = swapped < direct ? [next[1], next[0]] : next;
      // A view of just one team must not pull the other centroid towards it.
      this.centroids = old.map((c, i) =>
        distance(matched[i], c) < distance(matched[i], old[1 - i]) ? mix(c, matched[i]) : c,
      ) as Pair;
    }
    const centres = this.centroids;
    const distances = usable.map((c) => Math.min(distance(c, centres[0]), distance(c, centres[1])));
    const mean = distances.reduce((sum, d) => sum + d, 0) / (distances.length || 1);
    // A small floor allows rounding noise in otherwise uniform shirts.
    const cutoff = Math.max(0.03, 2 * mean);
    colours.forEach((c, i) => {
      if (!c) return;
      const a = distance(c, centres[0]);
      const b = distance(c, centres[1]);
      if (Math.min(a, b) > cutoff || Math.abs(a - b) < 0.02) return;
      result[i] = a < b ? 0 : 1;
    });
    return result;
  }

  teamColour(i: Team): string {
    const feature = this.centroids?.[i];
    const scale = feature ? feature[3] / Math.max(feature[0], feature[1], feature[2]) : 1;
    const c: Colour = feature ? [feature[0] * scale, feature[1] * scale, feature[2] * scale] : UNKNOWN;
    return `rgb(${c.map((v) => Math.round(v * 255)).join(", ")})`;
  }

  colourName(i: Team): string {
    if (!this.centroids) return "unknown";
    const [r, g, b, lightness] = this.centroids[i];
    const value = Math.max(r, g, b);
    const delta = value - Math.min(r, g, b);
    if (delta <= value * 0.2) return lightness >= 0.45 ? "white" : "black";
    let hue = value === r ? (g - b) / delta : value === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    if (hue < 15 || hue >= 345) return "red";
    if (hue < 45) return "orange";
    if (hue < 70) return "yellow";
    if (hue < 170) return "green";
    if (hue < 210) return "light blue";
    if (hue < 255) return "blue";
    if (hue < 290) return "purple";
    return "pink";
  }
}

// Module helpers use the most recently assigned splitter.
export function teamColour(i: Team): string {
  return latest?.teamColour(i) ?? "rgb(128, 128, 128)";
}

export function colourName(i: Team): string {
  return latest?.colourName(i) ?? "unknown";
}
