import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // STATIC_EXPORT=1 builds plain files in out/ for hosts without a Node server (Cloudflare, GitHub Pages).
  ...(process.env.STATIC_EXPORT ? { output: "export" as const } : {}),
  /* config options here */
  // These two cannot be used with a static export.
  ...(process.env.STATIC_EXPORT ? {} : { cacheComponents: true, partialPrefetching: true }),
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
