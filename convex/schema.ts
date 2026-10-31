import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  lines: defineTable({
    persona: v.string(),
    event: v.string(),
    text: v.string(),
    audioUrl: v.optional(v.string()),
  }),
  // Frame sets the live page sent, kept for the model bench.
  samples: defineTable({
    frames: v.array(v.id("_storage")),
    hint: v.optional(v.string()),
    live: v.object({ model: v.string(), event: v.string(), note: v.string(), score: v.union(v.string(), v.null()), ms: v.number() }),
    label: v.optional(v.string()),
  }),
  // Single row: what the match looks like right now.
  state: defineTable({
    score: v.union(v.string(), v.null()),
    teams: v.optional(v.string()), // "Home (kit) vs Away (kit)", identified by the vision model
  }),
});
