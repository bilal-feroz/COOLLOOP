// Site plan of the reference facility, in metres. X runs east, Z runs south,
// Y is up. Every component of the twin reads its position from here, so the
// geometry, the pipe routes, the labels and the camera all agree.

import type { CameraPreset } from "@/lib/store";
import type { V3 } from "./kit";

export const HALL = { x0: -62, x1: 2, z0: -20, z1: 20, h: 11.5, splitZ: -4, wall: 0.4 };
export const PLANT = { x0: 14, x1: 52, z0: 2, z1: 24, h: 8, wall: 0.3 };
export const CUT_HEIGHT = 1.3; // wall height left standing in cutaway view

export const TOWER_X = [18.8, 28.4, 38.0, 47.6, 57.2];
export const TOWER_Z = -17;
export const CHILLER_X = [20.5, 27, 33.5, 40, 46.5];
export const CHILLER_Z = 10.5;
export const CW_PUMP_Z = 18.5;
export const CHW_PUMP_Z = 4.9;
export const ROOF_DECK_Y = 12.2;
export const ACC_POS: [number, number][] = [
  [-46, -15.5],
  [-20, -15.5],
  [-46, -9.5],
  [-20, -9.5],
];
export const TANK = { x: 66, z: 13, r: 7, h: 9.5 };
export const MAKEUP_SKID = { x: 57, z: 6 };
export const BLOWDOWN = { x: 70, z: -23.6 };

// White space: 20 rows of 20 racks in hot-aisle pairs.
export const RACK = { w: 0.8, h: 2.3, d: 1.2 };
export const RACK_ROWS = 20;
export const RACKS_PER_ROW = 20;
export const ROW_Z0 = 0.4; // first rack centre along the row
export const PAIR_X0 = -52.5; // centre of the first hot aisle
export const PAIR_PITCH = 5.0;
export const HOT_AISLE = 1.4;

export interface Node {
  id: string;
  /** Centre and size of the pick/highlight volume. Pipes have none. */
  center?: V3;
  size?: V3;
  /** Where the label and the state marker sit. */
  anchor: V3;
  /** Camera framing radius when the item is selected. */
  radius: number;
}

const nodes: Node[] = [{ id: "DH-01", center: [-30, 1.7, 8.3], size: [57, 3.4, 20.4], anchor: [-30, 5.4, 8.3], radius: 46 }];

CHILLER_X.forEach((x, i) => {
  nodes.push({ id: `CH-0${i + 1}`, center: [x, 1.55, CHILLER_Z], size: [3.1, 3.1, 5.9], anchor: [x, 3.9, CHILLER_Z], radius: 13 });
  nodes.push({ id: `CWP-0${i + 1}`, center: [x, 0.95, CW_PUMP_Z], size: [1.4, 1.9, 2.9], anchor: [x, 2.5, CW_PUMP_Z], radius: 9 });
  nodes.push({ id: `CHP-0${i + 1}`, center: [x, 0.95, CHW_PUMP_Z], size: [1.4, 1.9, 2.9], anchor: [x, 2.5, CHW_PUMP_Z], radius: 9 });
});
ACC_POS.forEach(([x, z], i) => {
  nodes.push({
    id: `ACC-0${i + 1}`,
    center: [x, ROOF_DECK_Y + 1.4, z],
    size: [11.9, 2.9, 2.7],
    anchor: [x, ROOF_DECK_Y + 3.6, z],
    radius: 20,
  });
});
TOWER_X.forEach((x, i) => {
  nodes.push({ id: `CT-0${i + 1}`, center: [x, 5.4, TOWER_Z], size: [9.5, 10.8, 9.5], anchor: [x, 11.9, TOWER_Z], radius: 22 });
});
nodes.push(
  { id: "TK-01", center: [TANK.x, 5.5, TANK.z], size: [14.6, 11.4, 14.6], anchor: [TANK.x, 12.4, TANK.z], radius: 26 },
  { id: "MU-01", center: [MAKEUP_SKID.x, 0.9, MAKEUP_SKID.z], size: [4.4, 1.9, 2.8], anchor: [MAKEUP_SKID.x, 2.8, MAKEUP_SKID.z], radius: 16 },
  { id: "BD-01", center: [BLOWDOWN.x, 0.7, BLOWDOWN.z], size: [3.8, 1.7, 3.8], anchor: [BLOWDOWN.x, 2.6, BLOWDOWN.z], radius: 16 },
  { id: "PIPE-CWS", anchor: [16, 2.4, -3], radius: 34 },
  { id: "PIPE-CWR", anchor: [54, 6.2, -3], radius: 34 },
  { id: "PIPE-CHWS", anchor: [8, 7.7, 6.4], radius: 30 },
  { id: "PIPE-CHWR", anchor: [8, 4.0, 3.0], radius: 30 },
);

export const NODES = nodes;
export const NODE_BY_ID: Record<string, Node> = Object.fromEntries(nodes.map((n) => [n.id, n]));

// --- pipe routes ---------------------------------------------------------------
// Points are listed in the direction of flow.
export interface Route {
  circuit: string; // key into materials().circuits
  select: string; // equipment id a click selects
  radius: number;
  points: V3[];
}

const routes: Route[] = [];
const add = (circuit: string, select: string, radius: number, points: V3[]) =>
  routes.push({ circuit, select, radius, points });

const TS = TOWER_Z + 4.6; // tower south face
const TN = TOWER_Z - 4.8; // tower north (basin) face
const CN = CHILLER_Z - 2.8; // chiller north nozzles
const CS = CHILLER_Z + 2.8; // chiller south nozzles

// Condenser water supply: tower basins -> pumps -> chiller condensers.
TOWER_X.forEach((x) => add("CWS", "PIPE-CWS", 0.3, [[x, 0.85, TS - 0.2], [x, 0.85, -10.6]]));
add("CWS", "PIPE-CWS", 0.42, [[TOWER_X[4], 0.85, -10.6], [16, 0.85, -10.6], [16, 0.85, 20.8], [CHILLER_X[4], 0.85, 20.8]]);
CHILLER_X.forEach((x) => {
  add("CWS", "PIPE-CWS", 0.22, [[x, 0.85, 20.8], [x, 0.85, CW_PUMP_Z + 1.28]]);
  add("CWS", "PIPE-CWS", 0.2, [[x, 1.52, CW_PUMP_Z + 0.75], [x, 3.4, CW_PUMP_Z + 0.75], [x, 3.4, 16.4]]);
  add("CWS", "PIPE-CWS", 0.2, [[x + 0.95, 3.4, 16.4], [x + 0.95, 3.4, 14.1], [x + 0.95, 0.62, 14.1], [x + 0.95, 0.62, CS + 0.2]]);
});
add("CWS", "PIPE-CWS", 0.34, [[CHILLER_X[0] - 0.4, 3.4, 16.4], [CHILLER_X[4] + 1.35, 3.4, 16.4]]);

// Condenser water return: chiller condensers -> tower distribution.
CHILLER_X.forEach((x) => add("CWR", "PIPE-CWR", 0.2, [[x + 0.4, 1.12, CS + 0.2], [x + 0.4, 1.12, 14.7], [x + 0.4, 4.6, 14.7]]));
add("CWR", "PIPE-CWR", 0.42, [[CHILLER_X[0] + 0.4, 4.6, 14.7], [54, 4.6, 14.7], [54, 4.6, -9.6], [TOWER_X[0], 4.6, -9.6]]);
TOWER_X.forEach((x) => add("CWR", "PIPE-CWR", 0.3, [[x, 4.6, -9.6], [x, 4.6, TS + 0.45], [x, 7.0, TS + 0.45], [x, 7.0, TS + 0.05]]));

// Chilled water supply: evaporators -> hall. Roof branch: air-cooled chillers -> hall.
CHILLER_X.forEach((x) => add("CHWS", "PIPE-CHWS", 0.2, [[x - 0.3, 0.8, CN - 0.2], [x - 0.3, 0.8, 6.95], [x - 0.3, 6.2, 6.95], [x - 0.3, 6.2, 6.4]]));
add("CHWS", "PIPE-CHWS", 0.36, [[CHILLER_X[4] - 0.3, 6.2, 6.4], [-1.6, 6.2, 6.4], [-1.6, 3.6, 6.4], [-1.6, 3.6, 18.6]]);
add("CHWS", "PIPE-CHWS", 0.3, [[-1.6, 3.6, 6.4], [-1.6, 3.6, -2.8], [-58.4, 3.6, -2.8], [-58.4, 3.6, 18.6]]);
add("CHWS_ROOF", "PIPE-CHWS", 0.28, [[-39.5, 13.35, -12.5], [2.9, 13.35, -12.5], [2.9, 6.2, -12.5], [2.9, 6.2, 6.4]]);
ACC_POS.forEach(([x, z]) => add("CHWS_ROOF", "PIPE-CHWS", 0.17, [[x + 5.7, 13.35, z - 0.3], [x + 6.5, 13.35, z - 0.3], [x + 6.5, 13.35, -12.5]]));

// Chilled water return: hall -> pumps -> evaporators. Roof branch to the air-cooled chillers.
add("CHWR", "PIPE-CHWR", 0.36, [[-0.7, 4.4, 18.6], [-0.7, 4.4, 3.0], [-0.7, 5.4, 3.0], [CHILLER_X[4], 5.4, 3.0]]);
add("CHWR", "PIPE-CHWR", 0.3, [[-59.3, 4.4, 18.6], [-59.3, 4.4, -2.0], [-0.7, 4.4, -2.0], [-0.7, 4.4, 3.0]]);
CHILLER_X.forEach((x) => {
  add("CHWR", "PIPE-CHWR", 0.2, [[x, 5.4, 3.0], [x, 0.85, 3.0], [x, 0.85, CHW_PUMP_Z - 1.28]]);
  add("CHWR", "PIPE-CHWR", 0.19, [
    [x, 1.52, CHW_PUMP_Z - 0.75],
    [x, 2.3, CHW_PUMP_Z - 0.75],
    [x - 0.95, 2.3, CHW_PUMP_Z - 0.75],
    [x - 0.95, 2.3, 7.1],
    [x - 0.95, 1.1, 7.1],
    [x - 0.95, 1.1, CN - 0.2],
  ]);
});
add("CHWR_ROOF", "PIPE-CHWR", 0.28, [[3.6, 5.4, 3.0], [3.6, 5.4, -13.4], [3.6, 12.75, -13.4], [-38.9, 12.75, -13.4]]);
ACC_POS.forEach(([x, z]) => add("CHWR_ROOF", "PIPE-CHWR", 0.17, [[x + 7.1, 12.75, -13.4], [x + 7.1, 12.75, z + 0.3], [x + 5.7, 12.75, z + 0.3]]));

// Makeup water: utility connection -> tank -> makeup pumps -> tower basins.
add("MU", "MU-01", 0.14, [[84, 0.7, TANK.z], [74.3, 0.7, TANK.z], [74.3, 8.9, TANK.z], [72.7, 8.9, TANK.z]]);
add("MU", "MU-01", 0.14, [[TANK.x - TANK.r + 0.1, 0.7, TANK.z], [MAKEUP_SKID.x, 0.7, TANK.z], [MAKEUP_SKID.x, 0.7, MAKEUP_SKID.z + 1.1]]);
add("MU", "MU-01", 0.14, [[MAKEUP_SKID.x, 0.7, MAKEUP_SKID.z - 1.1], [MAKEUP_SKID.x, 0.7, 3.4], [64, 0.7, 3.4], [64, 0.7, TN - 0.8], [TOWER_X[0], 0.7, TN - 0.8]]);
TOWER_X.forEach((x) => add("MU", "MU-01", 0.09, [[x, 0.7, TN - 0.8], [x, 0.7, TN + 0.1]]));

// Blowdown: tower basins -> discharge chamber.
TOWER_X.forEach((x) => add("BD", "BD-01", 0.09, [[x + 1.5, 0.3, TN + 0.1], [x + 1.5, 0.3, BLOWDOWN.z]]));
add("BD", "BD-01", 0.13, [[TOWER_X[0] + 1.5, 0.3, BLOWDOWN.z], [BLOWDOWN.x - 1.0, 0.3, BLOWDOWN.z]]);

export const ROUTES = routes;

// --- camera ----------------------------------------------------------------------
// A preset is a volume to frame and the direction to look from. The distance is
// worked out from the viewport shape, so the same preset fills a wide control
// room view and the small simulation preview equally well.
export interface Framing {
  label: string;
  min: V3;
  max: V3;
  /** Direction from the target toward the camera. */
  dir: V3;
}

export const PRESETS: Record<CameraPreset, Framing> = {
  overview: { label: "Site", min: [-62, 0, -23], max: [75, 8, 26], dir: [0.6, 0.48, 0.64] },
  towers: { label: "Towers", min: [13, 0, -24], max: [63, 11, -8], dir: [0.4, 0.45, 0.8] },
  plant: { label: "Plant", min: [13, 0, 1], max: [57, 7, 25], dir: [0.48, 0.6, 0.64] },
  hall: { label: "Data hall", min: [-63, 0, -20], max: [3, 15, 27], dir: [0.36, 0.62, 0.7] },
  water: { label: "Water", min: [50, 0, -26], max: [86, 11, 22], dir: [0.78, 0.42, 0.46] },
};
