"use client";
import type { Match } from "@/lib/matches";
import { BoothIcon } from "./BoothIcon";

// Three steps that explain the app by being the controls: pick a match, pick a commentator, kick off.
export function DemoGuide({
  matches,
  matchId,
  onPick,
  capturing,
  onKickOff,
}: {
  matches: Match[];
  matchId: string;
  onPick: (m: Match) => void;
  capturing: boolean;
  onKickOff: () => void;
}) {
  if (capturing) {
    return (
      <section className="demo-live" role="status">
        <span className="status-dot" />
        <span>
          <b>Live now.</b> Turn your sound up. Every call lands in the feed on
          the right.
        </span>
        <button
          type="button"
          className="demo-restart"
          onClick={() => window.location.reload()}
        >
          <BoothIcon name="reset" />
          Pick another match
        </button>
      </section>
    );
  }
  return (
    <section className="demo-guide" aria-label="How Booth works">
      <div className="demo-step">
        <div className="demo-step-head">
          <span className="demo-step-num">1</span>
          <h2>Pick a match</h2>
        </div>
        <div className="match-options" role="group" aria-label="Matches">
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              className="match-option"
              aria-pressed={m.id === matchId}
              onClick={() => onPick(m)}
            >
              <span className="match-title">{m.title}</span>
              <span className="match-detail">{m.detail}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="demo-step">
        <div className="demo-step-head">
          <span className="demo-step-num">2</span>
          <h2>Choose your commentator</h2>
        </div>
        <p>
          Hyped, tactical, a conspiracy theorist, a poet, in English or French.
          Use the Commentator panel; you can change it during the match.
        </p>
      </div>
      <div className="demo-step">
        <div className="demo-step-head">
          <span className="demo-step-num">3</span>
          <h2>Kick off</h2>
        </div>
        <p>
          Booth watches every frame, then calls the action live, fills the quiet
          moments, and remembers the match. Sound on.
        </p>
        <button
          type="button"
          className="start-button kickoff"
          onClick={onKickOff}
        >
          <BoothIcon name="play" />
          Kick off
        </button>
      </div>
    </section>
  );
}
