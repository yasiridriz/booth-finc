// Big files (models, sample clip) can live outside the deployed site, for hosts with a per-file size limit.
// Set NEXT_PUBLIC_ASSET_BASE to the public URL that serves /models/* and /clips/*, for example
// https://pub-xxxx.r2.dev. Empty means the files come from this site's own /public folder.
export const asset = (path: string) => `${process.env.NEXT_PUBLIC_ASSET_BASE ?? ""}${path}`;
