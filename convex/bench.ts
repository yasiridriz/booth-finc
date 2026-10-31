import { action, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { classify } from "./vision";
import type { Doc } from "./_generated/dataModel";

// Model bench: the live page records every frame set it sends, then we replay them through other models.

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("samples").order("desc").take(200);
    return Promise.all(
      rows.map(async (r) => ({
        _id: r._id,
        at: r._creationTime,
        live: r.live,
        label: r.label ?? null,
        urls: await Promise.all(r.frames.map((f) => ctx.storage.getUrl(f))),
      })),
    );
  },
});

export const label = mutation({
  args: { id: v.id("samples"), label: v.string() },
  handler: async (ctx, { id, label }) => {
    await ctx.db.patch("samples", id, { label });
  },
});

export const get = internalQuery({
  args: { ids: v.array(v.id("samples")) },
  handler: async (ctx, { ids }) => {
    const out = [];
    for (const id of ids) {
      const r = await ctx.db.get("samples", id);
      if (r) out.push(r);
    }
    return out;
  },
});

// Runs one model over the given samples, a few at a time.
export const run = action({
  args: { model: v.string(), ids: v.array(v.id("samples")) },
  handler: async (ctx, { model, ids }) => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const rows: Doc<"samples">[] = await ctx.runQuery(internal.bench.get, { ids });
    const results = [];
    for (let i = 0; i < rows.length; i += 5) {
      results.push(
        ...(await Promise.all(
          rows.slice(i, i + 5).map(async (r) => {
            const frames = await Promise.all(
              r.frames.map(async (f) => {
                const blob = await ctx.storage.get(f);
                return toBase64(new Uint8Array(await blob!.arrayBuffer()));
              }),
            );
            const t = Date.now();
            const reading = await classify(client, model, frames, r.hint);
            return { id: r._id, label: r.label ?? null, ms: Date.now() - t, ...reading };
          }),
        )),
      );
    }
    return results;
  },
});

function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
