import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  lines: defineTable({
    persona: v.string(),
    event: v.string(),
    text: v.string(),
    audioUrl: v.optional(v.string()),
  }),
});
