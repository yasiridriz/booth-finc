import type { CSSProperties } from "react";

const paths = {
  mic: "M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Zm-7-4v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8",
  play: "m8 5 11 7-11 7V5Z",
  reset: "M3 10a9 9 0 1 1 2 8M3 4v6h6",
  flip: "M3 7h18l-4-4M21 17H3l4 4",
  link: "m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  chevron: "m6 9 6 6 6-6",
  sliders: "M4 3v7m0 4v7M12 3v12m0 4v2M20 3v2m0 4v12M1 10h6m2 5h6m2-10h6",
  activity: "M2 12h4l3-8 6 16 3-8h4",
  check: "m5 12 4 4L19 6",
} as const;

export function BoothIcon({ name, className = "", style }: {
  name: keyof typeof paths;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg className={`booth-icon ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
