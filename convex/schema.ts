import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  lines: defineTable({
    persona: v.string(),
    event: v.string(),
    text: v.string(),
    audioUrl: v.optional(v.string()),
    priority: v.optional(v.number()), // 3 event, 2 color or memory, 1 fact; the page plays the highest first
    ttlMs: v.optional(v.number()), // the page drops the line if it waited longer than this
    vt: v.optional(v.number()), // video time (s) of the moment this line describes; link mode plays it then
    madeMs: v.optional(v.number()), // how long the line took to make, frames in to audio stored
  }),
  // Notable moments of this match, so later lines can refer back to them.
  memory: defineTable({
    kind: v.string(), // goal, save, shot, foul
    text: v.string(),
    usedCount: v.number(),
    lastUsedAt: v.optional(v.number()),
  }),
  // Frame sets the live page sent, kept for the model bench.
  samples: defineTable({
    frames: v.array(v.id("_storage")),
    hint: v.optional(v.string()),
    live: v.object({ model: v.string(), event: v.string(), note: v.string(), score: v.union(v.string(), v.null()), ms: v.number() }),
    label: v.optional(v.string()),
  }),
  // Talking points found online for the commentators to use in quiet moments.
  topics: defineTable({
    subject: v.string(), // club or player name
    scope: v.union(v.literal("club"), v.literal("player"), v.literal("match")),
    kind: v.string(), // transfer, injury, form, stat, quote, milestone, rivalry, social, controversy, history
    headline: v.string(),
    detail: v.string(), // one fact, ready to say aloud
    sourceUrl: v.string(),
    sourceName: v.string(),
    publishedAt: v.optional(v.number()), // only set when the source text showed a date
    window: v.union(v.literal("day"), v.literal("week"), v.literal("month"), v.literal("evergreen")),
    interest: v.number(),
    usedCount: v.number(),
    lastUsedAt: v.optional(v.number()),
  }).index("by_source", ["sourceUrl"]),
  // Single row: what the match looks like right now.
  state: defineTable({
    score: v.union(v.string(), v.null()),
    teams: v.optional(v.string()), // "Home (kit) vs Away (kit)", identified by the vision model
    gapAt: v.optional(v.number()), // when the last gap line was claimed, so two requests never both speak
    roster: v.optional(v.string()), // pasted lineup: team heading, then "number name" lines
    style: v.optional(v.string()), // commentating style id from convex/personas.ts
    lang: v.optional(v.string()), // commentary language id from convex/personas.ts
  }),
});
