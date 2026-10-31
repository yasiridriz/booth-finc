"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { STYLES, LANGUAGES, type StyleId, type Lang } from "@/convex/personas";
import { BoothIcon } from "./BoothIcon";

const emoji: Record<StyleId, string> = {
  hype: "⚡", tactician: "♟", conspiracy: "👁", grandpa: "📻", poet: "🪶", ultra: "📣",
};

export function CommentatorPicker() {
  const persona = useQuery(api.booth.persona);
  const setPersona = useMutation(api.booth.setPersona);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function choose(style: StyleId, lang: Lang) {
    setSaving(true);
    setError("");
    try {
      await setPersona({ style, lang });
    } catch {
      setError("Couldn’t update your commentator. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const style = persona?.style ?? "hype";
  const lang = persona?.lang ?? "en";
  const current = STYLES.find((s) => s.id === style);

  // Compact: two dropdowns at the top of the right rail.
  return (
    <section className="game-panel" aria-label="Commentator" aria-busy={saving}>
      <h2 className="rail-title"><BoothIcon name="mic" />Commentator</h2>
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
        <select
          className="w-full min-w-0 rounded-md border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
          aria-label="Commentator style"
          value={style}
          disabled={!persona}
          onChange={(e) => choose(e.target.value as StyleId, lang)}
        >
          {STYLES.map((s) => (
            <option key={s.id} value={s.id} className="bg-neutral-900">
              {emoji[s.id]} {s.name}
            </option>
          ))}
        </select>
        <select
          className="w-full min-w-0 rounded-md border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
          aria-label="Commentary language"
          value={lang}
          disabled={!persona}
          onChange={(e) => choose(style, e.target.value as Lang)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id} className="bg-neutral-900">
              {l.label}
            </option>
          ))}
        </select>
      </div>
      {current && <p className="mt-2 text-xs text-muted">{current.tagline}</p>}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
