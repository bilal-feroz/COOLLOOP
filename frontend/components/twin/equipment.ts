"use client";

// Part lists for the repeated machines. Each list is drawn once per unit by
// `Kit`, so adding detail here costs draw calls only once, not per unit.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ball, box, cyl, cylX, cylZ, G, HALF_PI, type Part, ring, rod, shape } from "./kit";
import { materials } from "./materials";

/** Velocity-recovery fan stack: flared, with a narrower throat at the fan. */
function stackGeometry(): THREE.BufferGeometry {
  const profile = [
    [2.98, 0.0],
    [2.9, 0.25],
    [2.74, 0.85],
    [2.68, 1.25],
    [2.72, 1.6],
    [2.9, 2.25],
    [3.06, 2.8],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(profile, 64);
}

/** Axial fan rotor: hub plus pitched blades, as one mesh. Axis along Y. */
export function rotorGeometry(radius: number, blades: number, hubRadius: number, chord: number): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const hub = new THREE.CylinderGeometry(hubRadius, hubRadius, chord * 0.75, 24);
  pieces.push(hub);
  pieces.push(new THREE.SphereGeometry(hubRadius * 0.9, 16, 8, 0, Math.PI * 2, 0, HALF_PI).translate(0, chord * 0.37, 0));
  const span = radius - hubRadius;
  for (let i = 0; i < blades; i++) {
    const blade = new THREE.BoxGeometry(span, chord * 0.07, chord, 4, 1, 1);
    // Taper the tip and twist the blade along its span.
    const pos = blade.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const t = pos.getX(v) / span + 0.5; // 0 at the root, 1 at the tip
      const twist = 0.62 - 0.34 * t;
      const z = pos.getZ(v) * (1.0 - 0.3 * t);
      const y = pos.getY(v);
      pos.setZ(v, z * Math.cos(twist) - y * Math.sin(twist));
      pos.setY(v, z * Math.sin(twist) + y * Math.cos(twist));
    }
    blade.translate(hubRadius + span / 2, 0, 0);
    blade.rotateY((i / blades) * Math.PI * 2);
    blade.computeVertexNormals();
    pieces.push(blade);
  }
  const merged = mergeGeometries(pieces.map((g) => (g.index ? g.toNonIndexed() : g)));
  pieces.forEach((g) => g.dispose());
  return merged;
}

let stack: THREE.BufferGeometry | null = null;

/** One induced-draft counterflow cell. Origin at grade, centre of the cell. */
export function towerParts(): Part[] {
  const m = materials();
  stack ??= stackGeometry();
  const p: Part[] = [];

  // Cold water basin and its sump on the south side.
  p.push(box(m.concrete, [9.6, 1.1, 9.6], [0, 0.55, 0]));
  p.push(box(m.water, [8.9, 0.06, 8.9], [0, 1.13, 0], undefined, { cast: false }));
  p.push(box(m.concrete, [1.7, 0.95, 0.9], [0, 0.475, 5.05]));

  // Air inlet zone: structure, louvres on the north and south faces.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) p.push(box(m.steelDark, [0.3, 2.75, 0.3], [sx * 4.45, 2.47, sz * 4.45]));
    p.push(box(m.frpBand, [0.12, 2.75, 8.6], [sx * 4.54, 2.47, 0]));
  }
  for (const sz of [-1, 1]) {
    for (const x of [-1.5, 1.5]) p.push(box(m.steelDark, [0.16, 2.75, 0.16], [x, 2.47, sz * 4.5]));
    for (let i = 0; i < 7; i++) {
      p.push(box(m.louvre, [8.6, 0.05, 0.52], [0, 1.42 + i * 0.37, sz * 4.5], [sz * 0.62, 0, 0]));
    }
  }

  // Fill and drift-eliminator casing with stiffening bands and battens.
  p.push(box(m.frp, [9.2, 3.95, 9.2], [0, 5.82, 0]));
  for (const y of [3.93, 5.82, 7.71]) p.push(box(m.frpBand, [9.34, 0.16, 9.34], [0, y, 0]));
  for (const s of [-1, 1]) {
    for (const t of [-3.07, -1.53, 0, 1.53, 3.07]) {
      p.push(box(m.frpBand, [0.1, 3.7, 0.06], [t, 5.82, s * 4.63]));
      p.push(box(m.frpBand, [0.06, 3.7, 0.1], [s * 4.63, 5.82, t]));
    }
  }
  p.push(box(m.steelDark, [0.9, 1.7, 0.06], [3.25, 4.95, 4.64])); // access door
  p.push(cylZ(m.steelDark, 0.42, 0.14, [0, 7.0, 4.67])); // hot water inlet flange

  // Fan deck, stack, fan drive.
  p.push(box(m.frpBand, [9.5, 0.18, 9.5], [0, 7.88, 0]));
  p.push(shape(stack, m.stack, [0, 7.97, 0]));
  p.push(ring(m.frpBand, 3.07, [0, 10.77, 0], [HALF_PI, 0, 0], true));
  p.push(ring(m.frpBand, 2.99, [0, 8.0, 0], [HALF_PI, 0, 0], true));
  p.push(box(m.steelDark, [5.5, 0.2, 0.2], [0, 8.82, 0]));
  p.push(box(m.steelDark, [0.2, 0.2, 5.5], [0, 8.82, 0]));
  p.push(cyl(m.motor, 0.44, 0.62, [0, 8.98, 0]));
  p.push(cylX(m.steel, 0.07, 3.7, [1.95, 8.98, 0]));
  p.push(box(m.steelDark, [1.25, 0.72, 0.85], [3.95, 8.33, 0]));
  p.push(cylX(m.motor, 0.34, 1.0, [3.95, 8.98, 0]));
  p.push(cylX(m.steelDark, 0.37, 0.16, [4.52, 8.98, 0]));

  // Handrail along the north and south deck edges.
  for (const sz of [-1, 1]) {
    for (let i = 0; i <= 6; i++) p.push(rod(m.steel, 0.035, 1.1, [-4.62 + i * 1.54, 8.52, sz * 4.66]));
    p.push(box(m.steel, [9.4, 0.05, 0.05], [0, 9.06, sz * 4.66]));
    p.push(box(m.steel, [9.4, 0.04, 0.04], [0, 8.56, sz * 4.66]));
    p.push(box(m.steelDark, [9.4, 0.12, 0.03], [0, 8.03, sz * 4.66]));
  }
  p.push(rod(m.steelDark, 0.04, 0.8, [-4.3, 9.3, 4.3])); // beacon mast
  return p;
}

/** Hand rail returns, ladder and cage for the whole tower row. World-space X. */
export function towerRowParts(xWest: number, xEast: number, z: number): Part[] {
  const m = materials();
  const p: Part[] = [];
  for (const x of [xWest - 4.66, xEast + 4.66]) {
    for (let i = 0; i <= 6; i++) p.push(rod(m.steel, 0.035, 1.1, [x, 8.52, z - 4.62 + i * 1.54]));
    p.push(box(m.steel, [0.05, 0.05, 9.4], [x, 9.06, z]));
    p.push(box(m.steel, [0.04, 0.04, 9.4], [x, 8.56, z]));
  }
  // Caged ladder on the east end.
  const lx = xEast + 4.95;
  for (const dz of [-0.28, 0.28]) p.push(box(m.steel, [0.06, 9.2, 0.06], [lx, 4.6, z + 2.4 + dz]));
  for (let y = 0.5; y < 9.0; y += 0.3) p.push(rod(m.steel, 0.02, 0.56, [lx, y, z + 2.4], [HALF_PI, 0, 0]));
  for (let y = 2.6; y < 9.2; y += 0.9) p.push(ring(m.steel, 0.42, [lx + 0.38, y, z + 2.4], [HALF_PI, 0, 0]));
  for (const dz of [-0.36, 0, 0.36]) p.push(box(m.steel, [0.03, 6.6, 0.03], [lx + 0.74 - Math.abs(dz) * 0.6, 5.9, z + 2.4 + dz]));
  return p;
}

/** Water-cooled centrifugal chiller. Long axis along Z, origin at the floor. */
export function chillerParts(): Part[] {
  const m = materials();
  const p: Part[] = [];
  for (const sx of [-1, 1]) p.push(box(m.steelDark, [0.22, 0.2, 5.2], [sx * 0.98, 0.1, 0]));
  for (const z of [-1.9, 0, 1.9]) p.push(box(m.steelDark, [2.2, 0.16, 0.18], [0, 0.1, z]));
  for (const z of [-1.5, 1.5]) {
    p.push(box(m.steelDark, [0.9, 0.42, 0.14], [-0.62, 0.36, z]));
    p.push(box(m.steelDark, [0.8, 0.4, 0.14], [0.66, 0.34, z]));
  }

  // Evaporator (insulated) and condenser barrels with water boxes.
  p.push(cylZ(m.insulation, 0.62, 4.5, [-0.62, 0.95, 0]));
  p.push(cylZ(m.shell, 0.56, 4.5, [0.66, 0.88, 0]));
  for (const sz of [-1, 1]) {
    p.push(cylZ(m.insulation, 0.67, 0.42, [-0.62, 0.95, sz * 2.42]));
    p.push(ball(m.insulation, [0.66, 0.66, 0.2], [-0.62, 0.95, sz * 2.63]));
    p.push(cylZ(m.chiller, 0.61, 0.42, [0.66, 0.88, sz * 2.42]));
    p.push(ball(m.chiller, [0.6, 0.6, 0.18], [0.66, 0.88, sz * 2.63]));
    p.push(cylZ(m.steelDark, 0.64, 0.05, [0.66, 0.88, sz * 2.2]));
  }

  // Compressor, motor and refrigerant piping on top.
  p.push(cylZ(m.chiller, 0.46, 1.5, [0.02, 2.08, -0.85]));
  p.push(cylZ(m.steelDark, 0.48, 0.1, [0.02, 2.08, -1.55]));
  for (let i = 0; i < 5; i++) p.push(cylZ(m.chiller, 0.49, 0.035, [0.02, 2.08, -1.3 + i * 0.22]));
  p.push(cylZ(m.chiller, 0.66, 0.5, [0.02, 2.08, 0.28]));
  p.push(cylZ(m.shell, 0.34, 0.5, [0.02, 2.08, 0.78]));
  p.push(box(m.steelDark, [1.1, 0.5, 2.2], [0.02, 1.52, -0.4]));
  p.push(cyl(m.insulation, 0.24, 0.85, [-0.62, 1.95, 1.2]));
  p.push(ball(m.insulation, 0.25, [-0.62, 2.38, 1.2]));
  p.push(cylX(m.insulation, 0.24, 0.68, [-0.28, 2.38, 1.2]));
  p.push(ball(m.insulation, 0.25, [0.06, 2.38, 1.2]));
  p.push(cylZ(m.insulation, 0.24, 0.3, [0.06, 2.3, 1.05]));
  p.push(cyl(m.shell, 0.2, 0.95, [0.66, 1.85, 0.28]));
  p.push(cylZ(m.insulation, 0.26, 1.3, [-0.1, 0.42, -0.2])); // oil sump / economiser

  // Control panel with its display.
  p.push(box(m.cabinet, [0.38, 1.25, 0.95], [1.3, 1.9, -1.55]));
  p.push(box(m.steelDark, [0.1, 0.9, 0.1], [1.3, 0.85, -1.55]));
  p.push(box(m.screen, [0.02, 0.3, 0.46], [1.5, 2.15, -1.55], undefined, { cast: false }));

  // Water nozzles: chilled water on the north end, condenser water on the south.
  const nozzle = (mat: THREE.Material, x: number, y: number, s: number) => {
    p.push(cylZ(mat, 0.2, 0.34, [x, y, s * 2.74]));
    p.push(cylZ(m.steelDark, 0.28, 0.06, [x, y, s * 2.92]));
  };
  nozzle(m.insulation, -0.95, 1.1, -1);
  nozzle(m.insulation, -0.3, 0.8, -1);
  nozzle(m.shell, 0.95, 0.62, 1);
  nozzle(m.shell, 0.4, 1.12, 1);
  return p;
}

/** Air-cooled chiller. Long axis along X, cabinet at the +X end, origin on the deck. */
export function accParts(): Part[] {
  const m = materials();
  const p: Part[] = [];
  for (const sz of [-1, 1]) {
    p.push(box(m.steelDark, [11.4, 0.2, 0.18], [0, 0.1, sz * 1.02]));
    p.push(box(m.coil, [10.0, 1.78, 0.14], [-0.6, 1.2, sz * 1.03], [-sz * 0.1, 0, 0]));
    p.push(box(m.cabinet, [10.1, 0.12, 0.1], [-0.6, 0.3, sz * 1.12]));
  }
  for (const x of [-5.62, -3.1, -0.6, 1.9, 4.4]) p.push(box(m.cabinet, [0.1, 1.95, 2.1], [x, 1.2, 0]));
  p.push(box(m.cabinet, [10.2, 0.1, 2.32], [-0.6, 2.2, 0]));
  for (let i = 0; i < 6; i++) {
    for (const sz of [-1, 1]) {
      const x = -4.9 + i * 1.72;
      p.push(shape(G.tube, m.stack, [x, 2.37, sz * 0.58], [0, 0, 0], [0.5, 0.26, 0.5]));
      p.push(ring(m.steelDark, 0.5, [x, 2.51, sz * 0.58], [HALF_PI, 0, 0], true));
      p.push(box(m.steelDark, [1.0, 0.025, 0.025], [x, 2.51, sz * 0.58]));
      p.push(box(m.steelDark, [0.025, 0.025, 1.0], [x, 2.51, sz * 0.58]));
    }
  }
  // Compressor and control cabinet.
  p.push(box(m.cabinet, [1.3, 2.25, 2.32], [5.1, 1.125, 0]));
  p.push(box(m.cladDark, [0.04, 1.15, 1.2], [5.76, 1.5, 0.35]));
  p.push(box(m.screen, [0.02, 0.24, 0.36], [5.77, 1.95, -0.78], undefined, { cast: false }));
  p.push(cylX(m.insulation, 0.17, 0.3, [5.72, 1.15, -0.3]));
  p.push(cylX(m.insulation, 0.17, 0.3, [5.72, 0.55, 0.3]));
  return p;
}

/** End-suction pump set. Shaft along Z, suction at +Z, origin at the floor. */
export function pumpParts(): Part[] {
  const m = materials();
  const p: Part[] = [];
  p.push(box(m.concrete, [1.15, 0.26, 2.75], [0, 0.13, 0]));
  p.push(box(m.steelDark, [0.92, 0.1, 2.55], [0, 0.31, 0]));
  // Motor with cooling fins, fan cowl and terminal box.
  p.push(cylZ(m.motor, 0.33, 1.0, [0, 0.85, -0.72]));
  for (let i = 0; i < 6; i++) p.push(cylZ(m.motor, 0.365, 0.035, [0, 0.85, -1.12 + i * 0.16]));
  p.push(cylZ(m.steelDark, 0.37, 0.2, [0, 0.85, -1.32]));
  p.push(box(m.motor, [0.3, 0.2, 0.32], [0, 1.26, -0.7]));
  p.push(box(m.steelDark, [0.62, 0.5, 0.1], [0, 0.6, -0.4]));
  p.push(box(m.steelDark, [0.62, 0.5, 0.1], [0, 0.6, -1.05]));
  // Coupling guard, bearing frame, volute, nozzles.
  p.push(box(m.guard, [0.36, 0.36, 0.32], [0, 0.85, -0.06]));
  p.push(cylZ(m.pumpBody, 0.2, 0.42, [0, 0.85, 0.3]));
  p.push(box(m.steelDark, [0.5, 0.5, 0.1], [0, 0.6, 0.3]));
  p.push(cylZ(m.pumpBody, 0.47, 0.3, [0, 0.85, 0.75]));
  p.push(cyl(m.pumpBody, 0.2, 0.36, [0, 1.3, 0.75]));
  p.push(cyl(m.steelDark, 0.27, 0.06, [0, 1.5, 0.75]));
  p.push(cylZ(m.pumpBody, 0.22, 0.34, [0, 0.85, 1.07]));
  p.push(cylZ(m.steelDark, 0.29, 0.06, [0, 0.85, 1.26]));
  return p;
}
