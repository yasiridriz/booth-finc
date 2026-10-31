import { asset } from "./assets";

// The matches the demo offers. Visitors pick from this list; they never paste a link.
// kind "clip": a video file under /clips on the asset base (R2). kind "link": a YouTube URL played through /api/video,
// which needs a Node host with yt-dlp, so it is local-only.
export type Match = {
  id: string;
  title: string;
  detail: string;
  clubs: string; // name, town, league: the town and league stop the topic search matching another club
  lineup?: string; // optional "Team name" then "number name" lines; lets the commentators use player names
} & ({ kind: "link"; link: string } | { kind: "clip"; file: string });

// Used when no matches.json can be loaded.
export const BUILT_IN: Match[] = [
  {
    id: "arsenal-spurs",
    title: "Arsenal v Tottenham",
    detail: "Premier League · North London derby · Dec 2018",
    clubs:
      "Arsenal (London, Premier League), Tottenham Hotspur (London, Premier League)",
    kind: "clip",
    file: "arsenal-spurs.mp4",
  },
];

// A static site has no server, so it can only offer matches that need none.
export const usable = (list: Match[]) =>
  list.filter((m) => !(process.env.NEXT_PUBLIC_STATIC && m.kind === "link"));
export const AVAILABLE = usable(BUILT_IN);

export const clipUrl = (file: string) => asset(`/clips/${file}`);

// The bucket holds matches.json next to clips/ and models/. To add a match: upload the video to clips/ and add an entry:
// { "id": "x", "title": "A v B", "detail": "League · date", "clubs": "A (Town, League), B (Town, League)", "file": "x.mp4", "lineup": "optional" }
export async function loadMatches(): Promise<Match[] | null> {
  try {
    // The bucket's copy wins; the copy deployed with the site (public/matches.json) is the fallback.
    let res = await fetch(asset("/matches.json"), { cache: "no-store" });
    if (!res.ok && asset("/matches.json") !== "/matches.json")
      res = await fetch("/matches.json", { cache: "no-store" });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return null;
    const str = (x: unknown) =>
      typeof x === "string" && x.trim() ? x.trim() : null;
    const list = raw.flatMap((x): Match[] => {
      const o = (x ?? {}) as Record<string, unknown>;
      const id = str(o.id),
        title = str(o.title),
        clubs = str(o.clubs),
        file = str(o.file);
      // A file name only: no folders, so an entry cannot point outside clips/.
      if (!id || !title || !clubs || !file || /[\\/]/.test(file)) return [];
      return [
        {
          id,
          title,
          clubs,
          kind: "clip",
          file,
          detail: str(o.detail) ?? "",
          lineup: str(o.lineup) ?? undefined,
        },
      ];
    });
    return list.length ? list : null;
  } catch {
    return null;
  }
}
