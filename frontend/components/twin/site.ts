"use client";

// Part lists for everything that exists once: buildings, white space, tank,
// yard, pipe supports. Buildings come in two versions: the full exterior, and
// a cutaway where the roof is lifted and the walls are sectioned at 1.3 m so
// the equipment inside can be seen.

import * as THREE from "three";
import { box, cyl, cylX, cylZ, G, HALF_PI, type Part, ring, rod, shape, type V3 } from "./kit";
import {
  ACC_POS,
  BLOWDOWN,
  CHILLER_X,
  CUT_HEIGHT,
  HALL,
  HOT_AISLE,
  MAKEUP_SKID,
  PAIR_PITCH,
  PAIR_X0,
  PLANT,
  RACK,
  RACK_ROWS,
  RACKS_PER_ROW,
  ROOF_DECK_Y,
  ROW_Z0,
  TANK,
  TOWER_X,
} from "./layout";
import { materials } from "./materials";

const FLOOR = 0.3; // data hall finished floor level

export interface BuildingParts {
  always: Part[];
  exterior: Part[];
  cutaway: Part[];
}

export function hallParts(): BuildingParts {
  const m = materials();
  const { x0, x1, z0, z1, h, splitZ, wall } = HALL;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const lx = x1 - x0;
  const lz = z1 - z0;
  const wallH = h - FLOOR;
  const wallY = FLOOR + wallH / 2;
  const always: Part[] = [];
  const exterior: Part[] = [];
  const cutaway: Part[] = [];

  // Plinth and base band.
  always.push(box(m.concrete, [lx + 0.8, FLOOR, lz + 0.8], [cx, FLOOR / 2, cz]));

  // North wall and the north part of the roof stay in both versions.
  always.push(box(m.cladLong, [lx, wallH, wall], [cx, wallY, z0 + wall / 2]));
  always.push(box(m.cladDark, [lx + 0.1, 0.9, wall + 0.06], [cx, FLOOR + 0.45, z0 + wall / 2]));
  const northLen = splitZ - z0;
  for (const x of [x0 + wall / 2, x1 - wall / 2]) {
    always.push(box(m.cladShort, [wall, wallH, northLen], [x, wallY, z0 + northLen / 2]));
    always.push(box(m.cladDark, [wall + 0.06, 0.9, northLen], [x, FLOOR + 0.45, z0 + northLen / 2]));
  }
  always.push(box(m.roof, [lx - 0.6, 0.3, northLen + 0.2], [cx, h - 0.15, z0 + northLen / 2 + 0.1]));
  always.push(box(m.steelDark, [lx + 0.4, 0.28, 0.6], [cx, h + 0.1, z0 + 0.3]));
  for (const x of [x0 + 0.3, x1 - 0.3]) always.push(box(m.steelDark, [0.6, 0.28, northLen], [x, h + 0.1, z0 + northLen / 2]));
  // Louvre bands on the north plant rooms.
  for (const x of [-52, -38, -24, -10]) always.push(box(m.louvre, [8, 2.2, 0.08], [x, 7.6, z0 - 0.02]));

  // South part: full height outside, sectioned in the cutaway.
  const southLen = z1 - splitZ;
  const southZ = splitZ + southLen / 2;
  exterior.push(box(m.cladLong, [lx, wallH, wall], [cx, wallY, z1 - wall / 2]));
  exterior.push(box(m.cladDark, [lx + 0.1, 0.9, wall + 0.06], [cx, FLOOR + 0.45, z1 - wall / 2]));
  for (const x of [x0 + wall / 2, x1 - wall / 2]) {
    exterior.push(box(m.cladShort, [wall, wallH, southLen], [x, wallY, southZ]));
    exterior.push(box(m.cladDark, [wall + 0.06, 0.9, southLen], [x, FLOOR + 0.45, southZ]));
    exterior.push(box(m.steelDark, [0.6, 0.28, southLen], [x < cx ? x0 + 0.3 : x1 - 0.3, h + 0.1, southZ]));
  }
  exterior.push(box(m.roof, [lx - 0.6, 0.3, southLen], [cx, h - 0.15, southZ]));
  exterior.push(box(m.steelDark, [lx + 0.4, 0.28, 0.6], [cx, h + 0.1, z1 - 0.3]));
  for (let x = x0 + 8; x < x1; x += 12) exterior.push(box(m.lamp, [0.5, 0.12, 0.1], [x, 6.4, z1 + 0.06], undefined, { cast: false }));

  const cutY = FLOOR + CUT_HEIGHT / 2;
  cutaway.push(box(m.cladLong, [lx, CUT_HEIGHT, wall], [cx, cutY, z1 - wall / 2]));
  cutaway.push(box(m.cut, [lx, 0.04, wall + 0.02], [cx, FLOOR + CUT_HEIGHT + 0.02, z1 - wall / 2]));
  for (const x of [x0 + wall / 2, x1 - wall / 2]) {
    cutaway.push(box(m.cladShort, [wall, CUT_HEIGHT, southLen], [x, cutY, southZ]));
    cutaway.push(box(m.cut, [wall + 0.02, 0.04, southLen], [x, FLOOR + CUT_HEIGHT + 0.02, southZ]));
  }
  // The steel frame stays, so the removed volume is still readable.
  const bays = 6;
  for (let i = 0; i < bays; i++) {
    const x = x0 + 0.5 + (i * (lx - 1.0)) / (bays - 1);
    cutaway.push(box(m.steelDark, [0.3, wallH, 0.3], [x, wallY, z1 - 0.55]));
    cutaway.push(box(m.steelDark, [0.22, 0.42, southLen - 0.6], [x, h - 0.5, southZ]));
  }
  cutaway.push(box(m.steelDark, [lx - 0.6, 0.3, 0.22], [cx, h - 0.42, z1 - 0.55]));

  // Partition between the plant rooms (north) and the white space (south).
  always.push(box(m.cladLong, [lx - 0.8, wallH, 0.3], [cx, wallY, splitZ + 0.15]));

  // Entrance block on the south-west corner.
  always.push(box(m.cladDark, [16, 4.6, 6.4], [-50, FLOOR + 2.3, z1 + 3.2]));
  always.push(box(m.glazing, [13.6, 1.5, 0.08], [-50, FLOOR + 2.6, z1 + 6.43], undefined, { cast: false }));
  always.push(box(m.steelDark, [16.4, 0.2, 6.8], [-50, FLOOR + 4.7, z1 + 3.2]));
  always.push(box(m.steelDark, [5, 0.14, 2.2], [-50, FLOOR + 2.9, z1 + 7.5]));
  for (const x of [-52.2, -47.8]) always.push(rod(m.steel, 0.06, 2.9, [x, FLOOR + 1.45, z1 + 8.4]));
  return { always, exterior, cutaway };
}

/** Racks, containment, CRAH galleries and overhead trays. */
export function whiteSpaceParts(): Part[] {
  const m = materials();
  const p: Part[] = [];
  const { x0, x1, z1, splitZ } = HALL;
  const depth = z1 - splitZ - 0.7;
  const zc = splitZ + 0.3 + depth / 2;
  p.push(box(m.tile, [x1 - x0 - 0.8, 0.05, depth], [(x0 + x1) / 2, FLOOR + 0.025, zc], undefined, { cast: false }));

  const rowLength = RACKS_PER_ROW * RACK.w;
  const rowCentreZ = ROW_Z0 + rowLength / 2;
  const offset = HOT_AISLE / 2 + RACK.d / 2;
  for (let k = 0; k < RACK_ROWS / 2; k++) {
    const aisle = PAIR_X0 + k * PAIR_PITCH;
    for (const side of [-1, 1]) {
      const x = aisle + side * offset;
      for (let j = 0; j < RACKS_PER_ROW; j++) {
        p.push(box(m.rack, [RACK.d, RACK.h, RACK.w - 0.02], [x, FLOOR + RACK.h / 2 + 0.05, ROW_Z0 + (j + 0.5) * RACK.w]));
      }
      p.push(box(m.tray, [0.45, 0.07, rowLength + 1.2], [x, FLOOR + 2.95, rowCentreZ]));
      p.push(box(m.steelDark, [0.16, 0.12, rowLength], [x + side * 0.42, FLOOR + 2.6, rowCentreZ]));
    }
    // Hot-aisle containment: glazed roof and end doors.
    p.push(box(m.containment, [HOT_AISLE, 0.05, rowLength], [aisle, FLOOR + RACK.h + 0.36, rowCentreZ], undefined, { cast: false }));
    for (const z of [ROW_Z0 - 0.04, ROW_Z0 + rowLength + 0.04]) {
      p.push(box(m.containment, [HOT_AISLE, RACK.h + 0.3, 0.05], [aisle, FLOOR + (RACK.h + 0.3) / 2 + 0.05, z], undefined, { cast: false }));
      p.push(box(m.steelDark, [HOT_AISLE + 0.1, 0.08, 0.08], [aisle, FLOOR + RACK.h + 0.38, z]));
    }
  }
  // Cross trays tying the rows together.
  for (const z of [ROW_Z0 - 0.7, ROW_Z0 + rowLength + 0.7]) {
    p.push(box(m.tray, [PAIR_PITCH * 9 + 5, 0.07, 0.5], [PAIR_X0 + PAIR_PITCH * 4.5, FLOOR + 3.05, z]));
  }
  // CRAH galleries on the east and west ends.
  for (const x of [-3.4, -57.0]) {
    for (let i = 0; i < 9; i++) {
      const z = 1.6 + i * 1.95;
      p.push(box(m.crah, [1.15, 2.15, 1.6], [x, FLOOR + 1.075, z]));
      p.push(box(m.louvre, [0.95, 0.06, 1.4], [x, FLOOR + 2.19, z]));
      p.push(box(m.screen, [0.02, 0.16, 0.26], [x + (x > -30 ? -0.59 : 0.59), FLOOR + 1.6, z + 0.4], undefined, { cast: false }));
    }
  }
  return p;
}

export function plantParts(): BuildingParts {
  const m = materials();
  const { x0, x1, z0, z1, h, wall } = PLANT;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const lx = x1 - x0;
  const lz = z1 - z0;
  const always: Part[] = [];
  const exterior: Part[] = [];
  const cutaway: Part[] = [];

  always.push(box(m.epoxy, [lx, 0.08, lz], [cx, 0.1, cz], undefined, { cast: false }));
  // Painted walkway down the middle and across.
  always.push(box(m.walkway, [lx - 2, 0.01, 0.12], [cx, 0.146, 15.4], undefined, { cast: false }));
  always.push(box(m.walkway, [lx - 2, 0.01, 0.12], [cx, 0.146, 6.6], undefined, { cast: false }));
  // Drive cabinets along the south wall.
  for (let i = 0; i < 9; i++) {
    const x = x0 + 9 + i * 2.6;
    always.push(box(m.cabinet, [0.9, 2.1, 0.65], [x, 1.19, z1 - 0.9]));
    always.push(box(m.screen, [0.26, 0.16, 0.02], [x, 1.75, z1 - 1.24], undefined, { cast: false }));
  }

  const walls: [V3, V3][] = [
    [[lx, 0, wall], [cx, 0, z0 + wall / 2]],
    [[lx, 0, wall], [cx, 0, z1 - wall / 2]],
    [[wall, 0, lz], [x0 + wall / 2, 0, cz]],
    [[wall, 0, lz], [x1 - wall / 2, 0, cz]],
  ];
  for (const [size, pos] of walls) {
    exterior.push(box(m.cladPlant, [size[0], h, size[2]], [pos[0], h / 2 + 0.06, pos[2]]));
    cutaway.push(box(m.cladPlant, [size[0], CUT_HEIGHT, size[2]], [pos[0], CUT_HEIGHT / 2 + 0.06, pos[2]]));
    cutaway.push(box(m.cut, [size[0] + 0.02, 0.04, size[2] + 0.02], [pos[0], CUT_HEIGHT + 0.08, pos[2]]));
  }
  exterior.push(box(m.roof, [lx + 0.6, 0.3, lz + 0.6], [cx, h + 0.2, cz]));
  exterior.push(box(m.cladDark, [5.2, 4.6, 0.1], [x1 - 6, 2.4, z1 + 0.03])); // roller door
  for (const x of [x0 + 7, x0 + 19, x0 + 31]) exterior.push(box(m.louvre, [7, 1.8, 0.08], [x, 5.6, z1 + 0.03]));
  for (let x = x0 + 4; x < x1; x += 10) exterior.push(box(m.lamp, [0.5, 0.12, 0.1], [x, 4.6, z1 + 0.08], undefined, { cast: false }));

  // Portal frames.
  const bays = 5;
  for (let i = 0; i < bays; i++) {
    const x = x0 + 0.35 + (i * (lx - 0.7)) / (bays - 1);
    for (const z of [z0 + 0.45, z1 - 0.45]) cutaway.push(box(m.steelDark, [0.26, h - 0.2, 0.26], [x, h / 2, z]));
    cutaway.push(box(m.steelDark, [0.2, 0.4, lz - 0.6], [x, h - 0.3, cz]));
  }
  for (const z of [z0 + 0.45, z1 - 0.45]) cutaway.push(box(m.steelDark, [lx - 0.5, 0.26, 0.2], [cx, h - 0.25, z]));
  return { always, exterior, cutaway };
}

/** Fixed parts of the water tank. The shell itself is drawn separately so it
 *  can turn translucent in the cutaway. */
export function tankParts(): Part[] {
  const m = materials();
  const { x, z, r, h } = TANK;
  const p: Part[] = [];
  p.push(cyl(m.concrete, r + 0.45, 0.4, [x, 0.2, z]));
  for (const y of [0.52, 3.6, 6.7, 9.82]) p.push(shape(G.tube, m.band, [x, y, z], [0, 0, 0], [r + 0.035, 0.16, r + 0.035]));
  p.push(cyl(m.steelDark, 0.28, 0.5, [x, h + 1.95, z]));
  // Caged ladder and landing on the south-west side, toward the camera.
  const a = Math.PI * 0.32;
  const lx = x + Math.cos(a) * (r + 0.16);
  const lz = z + Math.sin(a) * (r + 0.16);
  const yaw: V3 = [0, -a, 0];
  for (const d of [-0.26, 0.26]) {
    p.push(box(m.steel, [0.06, h + 0.9, 0.06], [lx - Math.sin(a) * d, (h + 0.9) / 2 + 0.3, lz + Math.cos(a) * d], yaw));
  }
  for (let y = 0.7; y < h + 0.9; y += 0.3) p.push(rod(m.steel, 0.02, 0.52, [lx, y, lz], [HALF_PI, -a, 0]));
  for (let y = 2.6; y < h + 1.0; y += 0.95) {
    p.push(ring(m.steel, 0.4, [lx + Math.cos(a) * 0.36, y, lz + Math.sin(a) * 0.36], [HALF_PI, 0, 0]));
  }
  // Level gauge board and nozzles.
  const g = Math.PI * 0.72;
  const gx = x + Math.cos(g) * (r + 0.07);
  const gz = z + Math.sin(g) * (r + 0.07);
  p.push(box(m.gaugeBack, [0.08, h - 0.8, 0.62], [gx, h / 2 + 0.3, gz], [0, -g, 0]));
  p.push(cylX(m.steelDark, 0.22, 0.5, [x - r - 0.15, 0.7, z]));
  p.push(cylX(m.steelDark, 0.2, 0.4, [x + r + 0.1, 8.9, z]));
  p.push(cylZ(m.steelDark, 0.42, 0.25, [x, 1.1, z + r + 0.05]));
  p.push(cylZ(m.steel, 0.5, 0.05, [x, 1.1, z + r + 0.2]));
  return p;
}

export function tankGauge(): { position: V3; yaw: number; height: number } {
  const g = Math.PI * 0.72;
  return {
    position: [TANK.x + Math.cos(g) * (TANK.r + 0.12), 0.75, TANK.z + Math.sin(g) * (TANK.r + 0.12)],
    yaw: -g,
    height: TANK.h - 0.9,
  };
}

/** A gate valve on a pipe running along X. Origin at the pipe axis. */
export function valveParts(r: number): Part[] {
  const m = materials();
  return [
    cylX(m.steelDark, r * 1.35, r * 1.5, [0, 0, 0]),
    cylX(m.steel, r * 1.7, 0.06, [-r * 0.85, 0, 0]),
    cylX(m.steel, r * 1.7, 0.06, [r * 0.85, 0, 0]),
    cyl(m.steelDark, r * 0.5, r * 2.6, [0, r * 1.9, 0]),
    ring(m.guard, r * 1.3, [0, r * 3.3, 0], [HALF_PI, 0, 0], true),
    box(m.guard, [r * 2.6, 0.03, 0.03], [0, r * 3.3, 0]),
    box(m.guard, [0.03, 0.03, r * 2.6], [0, r * 3.3, 0]),
  ];
}

/** Yard, roads, supports, pipe bridge, skids and the roof platform. */
export function siteParts(): Part[] {
  const m = materials();
  const p: Part[] = [];

  // Ground surfaces.
  p.push(box(m.slab, [82, 0.06, 66], [43, 0.03, -1], undefined, { cast: false }));
  p.push(box(m.concreteDark, [72, 0.04, 54], [-30, 0.02, 2], undefined, { cast: false }));
  p.push(box(m.asphalt, [210, 0.04, 9], [6, 0.02, 39], undefined, { cast: false }));
  for (let x = -92; x < 106; x += 9) p.push(box(m.marking, [3.2, 0.012, 0.16], [x, 0.046, 39], undefined, { cast: false }));
  p.push(box(m.asphalt, [9, 0.04, 44], [1, 0.022, 14], undefined, { cast: false }));

  // Area lighting.
  const poles: V3[] = [
    [10, 0, -30], [44, 0, -30], [80, 0, -30], [80, 0, 30], [44, 0, 30], [10, 0, 30], [-66, 0, 30], [-66, 0, -26],
  ]; // fmt: skip
  for (const [x, , z] of poles) {
    p.push(rod(m.steelDark, 0.09, 9, [x, 4.5, z]));
    p.push(box(m.steelDark, [1.5, 0.08, 0.14], [x + (x > 40 ? -0.7 : 0.7), 8.96, z]));
    p.push(box(m.lamp, [0.5, 0.06, 0.2], [x + (x > 40 ? -1.3 : 1.3), 8.9, z], undefined, { cast: false }));
  }

  // Sleepers under the low condenser water supply main.
  for (let x = 19; x < 57; x += 4.8) p.push(box(m.concrete, [0.9, 0.42, 0.55], [x, 0.21, -10.6]));
  for (let z = -8.2; z < 1.6; z += 3.2) p.push(box(m.concrete, [0.55, 0.42, 0.9], [16, 0.21, z]));
  // T-supports under the high condenser water return main.
  const tee = (x: number, z: number, alongX: boolean) => {
    p.push(box(m.steelDark, [0.2, 4.05, 0.2], [x, 2.025, z]));
    p.push(box(m.steelDark, alongX ? [0.2, 0.16, 1.3] : [1.3, 0.16, 0.2], [x, 4.1, z]));
    p.push(box(m.concrete, [0.6, 0.3, 0.6], [x, 0.15, z]));
  };
  for (let x = 21; x < 53; x += 4.8) tee(x, -9.6, true);
  for (let z = -6.4; z < 1.4; z += 3.6) tee(54, z, false);
  // Small sleepers for the makeup and blowdown lines.
  for (let z = -18; z < 2; z += 5) p.push(box(m.concrete, [0.4, 0.5, 0.4], [64, 0.25, z]));
  for (let x = 22; x < 64; x += 6) {
    p.push(box(m.concrete, [0.4, 0.5, 0.4], [x, 0.25, -22.6]));
    p.push(box(m.concrete, [0.4, 0.14, 0.4], [x + 2.4, 0.07, BLOWDOWN.z]));
  }

  // Pipe bridge carrying chilled water between plant and data hall.
  for (const x of [5.2, 10.8]) {
    for (const z of [2.0, 7.6]) {
      p.push(box(m.steelDark, [0.26, 7.0, 0.26], [x, 3.5, z]));
      p.push(box(m.concrete, [0.7, 0.3, 0.7], [x, 0.15, z]));
    }
    p.push(box(m.steelDark, [0.2, 0.22, 5.9], [x, 4.92, 4.8]));
    p.push(box(m.steelDark, [0.2, 0.22, 5.9], [x, 6.9, 4.8]));
    p.push(box(m.steelDark, [0.16, 0.16, 3.0], [x, 5.72, 6.2]));
  }
  for (const z of [2.0, 7.6]) {
    for (const y of [4.92, 6.9]) p.push(box(m.steelDark, [12.2, 0.2, 0.2], [8, y, z]));
    // Diagonal bracing.
    p.push(box(m.steel, [5.9, 0.08, 0.08], [8, 5.9, z], [0, 0, 0.34]));
    p.push(box(m.steel, [5.9, 0.08, 0.08], [8, 5.9, z], [0, 0, -0.34]));
  }
  // Wall brackets for the chilled water risers on the hall east face.
  for (let z = -12; z < 6.5; z += 3.2) {
    p.push(box(m.steelDark, [1.9, 0.12, 0.12], [3.0, 4.92, z]));
    p.push(box(m.steelDark, [1.2, 0.12, 0.12], [2.7, 5.78, z]));
  }
  for (let y = 7.2; y < 12.6; y += 1.8) p.push(box(m.steelDark, [1.9, 0.1, 0.1], [3.0, y, -12.95]));

  // Roof platform for the air-cooled chillers.
  const deckY = ROOF_DECK_Y;
  p.push(box(m.grating, [58.4, 0.1, 14.4], [-30.6, deckY - 0.05, -12.5]));
  for (let x = -58; x <= -3; x += 6.1) {
    p.push(box(m.steelDark, [0.24, 0.3, 14.2], [x, deckY - 0.25, -12.5]));
    for (const z of [-18.8, -12.5, -6.2]) p.push(box(m.steelDark, [0.2, 0.42, 0.2], [x, HALL.h + 0.2, z]));
  }
  for (const z of [-19.6, -5.4]) {
    for (let x = -59.6; x <= -1.5; x += 2.9) p.push(rod(m.steel, 0.035, 1.1, [x, deckY + 0.55, z]));
    p.push(box(m.steel, [58.2, 0.05, 0.05], [-30.6, deckY + 1.1, z]));
    p.push(box(m.steel, [58.2, 0.04, 0.04], [-30.6, deckY + 0.58, z]));
  }
  for (const x of [-59.7, -1.5]) {
    p.push(box(m.steel, [0.05, 0.05, 14.2], [x, deckY + 1.1, -12.5]));
    p.push(box(m.steel, [0.04, 0.04, 14.2], [x, deckY + 0.58, -12.5]));
  }
  for (const [x, z] of ACC_POS) {
    for (const dx of [-4.4, 0, 4.4]) p.push(box(m.steelDark, [0.3, 0.14, 2.5], [x + dx, deckY + 0.02, z]));
  }
  // Low supports for the roof headers.
  for (let x = -38; x < 2; x += 5.2) p.push(box(m.steelDark, [0.14, 0.52, 1.3], [x, deckY + 0.26, -12.95]));

  // Makeup pump skid.
  const { x: sx, z: sz } = MAKEUP_SKID;
  p.push(box(m.concrete, [4.2, 0.24, 2.6], [sx, 0.18, sz]));
  p.push(box(m.steelDark, [3.9, 0.1, 2.3], [sx, 0.35, sz]));
  for (const dx of [-0.95, 0.95]) {
    p.push(cylZ(m.motor, 0.24, 0.72, [sx + dx, 0.82, sz - 0.5]));
    p.push(cylZ(m.pumpBody, 0.32, 0.22, [sx + dx, 0.82, sz + 0.3]));
    p.push(cylZ(m.pumpBody, 0.13, 0.7, [sx + dx, 0.82, sz + 0.75]));
    p.push(box(m.guard, [0.24, 0.24, 0.2], [sx + dx, 0.82, sz + 0.02]));
  }
  p.push(cylX(m.steelDark, 0.14, 2.3, [sx, 0.82, sz + 1.1]));
  p.push(cylX(m.steelDark, 0.14, 2.3, [sx, 0.82, sz - 1.1]));
  p.push(box(m.cabinet, [0.7, 1.3, 0.4], [sx + 1.6, 1.05, sz - 0.9]));
  p.push(box(m.screen, [0.26, 0.16, 0.02], [sx + 1.6, 1.4, sz - 0.69], undefined, { cast: false }));

  // Utility connection: valve chamber and meter at the site boundary.
  p.push(box(m.concrete, [2.8, 0.7, 2.8], [84.4, 0.35, TANK.z]));
  p.push(box(m.grating, [2.2, 0.06, 2.2], [84.4, 0.72, TANK.z]));
  p.push(box(m.cabinet, [0.7, 1.2, 0.45], [84.4, 1.35, TANK.z - 1.8]));

  // Blowdown discharge chamber with its control valve.
  const { x: bx, z: bz } = BLOWDOWN;
  p.push(box(m.concrete, [3.4, 0.85, 3.4], [bx, 0.425, bz]));
  p.push(box(m.concreteDark, [2.6, 0.05, 2.6], [bx, 0.86, bz]));
  p.push(box(m.grating, [2.5, 0.06, 2.5], [bx, 0.9, bz]));
  for (const d of [-1.25, 1.25]) {
    p.push(rod(m.steel, 0.03, 1.0, [bx + d, 1.4, bz - 1.25]));
    p.push(rod(m.steel, 0.03, 1.0, [bx + d, 1.4, bz + 1.25]));
    p.push(box(m.steel, [0.04, 0.04, 2.5], [bx + d, 1.9, bz]));
  }
  p.push(box(m.steel, [2.5, 0.04, 0.04], [bx, 1.9, bz - 1.25]));
  p.push(cylX(m.steelDark, 0.28, 1.6, [bx + 2.4, 0.4, bz]));
  p.push(box(m.cabinet, [0.36, 0.5, 0.36], [bx - 2.6, 1.0, bz]));
  p.push(cyl(m.steelDark, 0.07, 0.5, [bx - 2.6, 0.55, bz]));
  p.push(cylX(m.steelDark, 0.2, 0.4, [bx - 2.6, 0.3, bz]));
  return p;
}

/** Placement helpers reused by the scene. */
export function chillerRowCabinetX(): number[] {
  return CHILLER_X;
}
export function towerRowExtent(): [number, number] {
  return [TOWER_X[0], TOWER_X[TOWER_X.length - 1]];
}

/** Tank shell and roof geometries (drawn solid or translucent). */
export function tankShellGeometry(): { shell: THREE.BufferGeometry; roof: THREE.BufferGeometry } {
  const shell = new THREE.CylinderGeometry(TANK.r, TANK.r, TANK.h, 72, 1, true);
  const roof = new THREE.ConeGeometry(TANK.r + 0.12, 1.5, 72, 1, false);
  return { shell, roof };
}

export { G, shape };
