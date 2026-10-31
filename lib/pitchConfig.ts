// Keypoint order from SoccerPitchConfiguration.vertices in github.com/roboflow/sports/blob/main/sports/configs/soccer.py (rescaled from its 120x70 m to a 105x68 m pitch with IFAB box/circle dimensions).
const L = 105, W = 68, PBW = 40.32, PBL = 16.5, GBW = 18.32, GBL = 5.5, R = 9.15, S = 11;

export const PITCH_VERTICES: [number, number][] = [
  [0, 0], [0, (W - PBW) / 2], [0, (W - GBW) / 2], [0, (W + GBW) / 2], [0, (W + PBW) / 2], [0, W], // 0-5 left goal line
  [GBL, (W - GBW) / 2], [GBL, (W + GBW) / 2], // 6-7 left goal box
  [S, W / 2], // 8 left penalty spot
  [PBL, (W - PBW) / 2], [PBL, (W - GBW) / 2], [PBL, (W + GBW) / 2], [PBL, (W + PBW) / 2], // 9-12 left penalty box edge
  [L / 2, 0], [L / 2, W / 2 - R], [L / 2, W / 2 + R], [L / 2, W], // 13-16 halfway line
  [L - PBL, (W - PBW) / 2], [L - PBL, (W - GBW) / 2], [L - PBL, (W + GBW) / 2], [L - PBL, (W + PBW) / 2], // 17-20 right penalty box edge
  [L - S, W / 2], // 21 right penalty spot
  [L - GBL, (W - GBW) / 2], [L - GBL, (W + GBW) / 2], // 22-23 right goal box
  [L, 0], [L, (W - PBW) / 2], [L, (W - GBW) / 2], [L, (W + GBW) / 2], [L, (W + PBW) / 2], [L, W], // 24-29 right goal line
  [L / 2 - R, W / 2], [L / 2 + R, W / 2], // 30-31 centre circle left/right
];
