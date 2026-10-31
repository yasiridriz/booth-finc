import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // STATIC_EXPORT=1 builds plain files in out/ for hosts without a Node server (Cloudflare, GitHub Pages).
  ...(process.env.STATIC_EXPORT ? { output: "export" as const } : {}),
  /* config options here */
  // These two cannot be used with a static export.
  ...(process.env.STATIC_EXPORT ? {} : { cacheComponents: true, partialPrefetching: true }),
  // Vercel cannot run yt-dlp, so paste-a-link matches (/api/video) would fail there. VERCEL is set during Vercel builds.
  env: { NEXT_PUBLIC_STATIC: process.env.NEXT_PUBLIC_STATIC ?? (process.env.VERCEL ? "1" : "") },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
