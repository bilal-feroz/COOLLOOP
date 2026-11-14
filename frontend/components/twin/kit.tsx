"use client";

// A small construction kit for procedural equipment.
//
// Equipment is described as a list of `Part`s: a shared unit geometry, a shared
// material and a local transform. `Kit` then draws any number of placements of
// that list. Parts are grouped by (geometry, material), so every steel box in
// every cooling tower is ONE instanced draw call. That is what keeps a detailed
// plant cheap enough for a laptop.

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

export type V3 = [number, number, number];

export interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material | THREE.Material[];
  matrix: THREE.Matrix4;
  cast?: boolean;
  receive?: boolean;
}

export const HALF_PI = Math.PI / 2;

/** Shared unit geometries. Sizes come from the instance transform. */
export const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 36),
  cylLow: new THREE.CylinderGeometry(1, 1, 1, 14),
  tube: new THREE.CylinderGeometry(1, 1, 1, 48, 1, true),
  sphere: new THREE.SphereGeometry(1, 28, 18),
  dome: new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, HALF_PI),
  cone: new THREE.ConeGeometry(1, 1, 56, 1, true),
  ring: new THREE.TorusGeometry(1, 0.012, 8, 56),
  ringThick: new THREE.TorusGeometry(1, 0.035, 10, 56),
  disc: new THREE.CircleGeometry(1, 48),
};

export function xf(pos: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...scale),
  );
}

type Opt = { cast?: boolean; receive?: boolean };
type Mat = THREE.Material | THREE.Material[];

export const box = (mat: Mat, size: V3, pos: V3, rot?: V3, opt?: Opt): Part => ({
  geo: G.box,
  mat,
  matrix: xf(pos, rot, size),
  ...opt,
});

/** Upright cylinder (axis along Y). */
export const cyl = (mat: Mat, radius: number, height: number, pos: V3, rot?: V3, opt?: Opt): Part => ({
  geo: G.cyl,
  mat,
  matrix: xf(pos, rot, [radius, height, radius]),
  ...opt,
});
export const cylX = (mat: Mat, radius: number, length: number, pos: V3, opt?: Opt) =>
  cyl(mat, radius, length, pos, [0, 0, HALF_PI], opt);
export const cylZ = (mat: Mat, radius: number, length: number, pos: V3, opt?: Opt) =>
  cyl(mat, radius, length, pos, [HALF_PI, 0, 0], opt);

/** Thin low-poly cylinder for posts, rails and rungs. */
export const rod = (mat: Mat, radius: number, length: number, pos: V3, rot?: V3, opt?: Opt): Part => ({
  geo: G.cylLow,
  mat,
  matrix: xf(pos, rot, [radius, length, radius]),
  ...opt,
});

export const ball = (mat: Mat, radius: number | V3, pos: V3, opt?: Opt): Part => ({
  geo: G.sphere,
  mat,
  matrix: xf(pos, [0, 0, 0], typeof radius === "number" ? [radius, radius, radius] : radius),
  ...opt,
});

/** A flat ring lying in the XZ plane (handwheels, stiffeners, guards). */
export const ring = (mat: Mat, radius: number, pos: V3, rot: V3 = [HALF_PI, 0, 0], thick = false, opt?: Opt): Part => ({
  geo: thick ? G.ringThick : G.ring,
  mat,
  matrix: xf(pos, rot, [radius, radius, radius]),
  ...opt,
});

export const shape = (geo: THREE.BufferGeometry, mat: Mat, pos: V3, rot?: V3, scale?: V3, opt?: Opt): Part => ({
  geo,
  mat,
  matrix: xf(pos, rot, scale),
  ...opt,
});

/** Placement of a whole kit: position and a rotation about the vertical axis. */
export const place = (pos: V3, yaw = 0): THREE.Matrix4 => xf(pos, [0, yaw, 0]);

/** Move a list of parts by a transform (to nest one kit inside another). */
export function moved(parts: Part[], matrix: THREE.Matrix4): Part[] {
  return parts.map((p) => ({ ...p, matrix: new THREE.Matrix4().multiplyMatrices(matrix, p.matrix) }));
}

interface Batch {
  geo: THREE.BufferGeometry;
  mat: Mat;
  cast: boolean;
  receive: boolean;
  matrices: THREE.Matrix4[];
}

function batch(parts: Part[], placements: THREE.Matrix4[]): Batch[] {
  const map = new Map<string, Batch>();
  for (const part of parts) {
    const cast = part.cast !== false;
    const receive = part.receive !== false;
    const matId = Array.isArray(part.mat) ? part.mat.map((m) => m.uuid).join("+") : part.mat.uuid;
    const key = `${part.geo.uuid}|${matId}|${cast}|${receive}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { geo: part.geo, mat: part.mat, cast, receive, matrices: [] };
      map.set(key, entry);
    }
    for (const placement of placements) {
      entry.matrices.push(new THREE.Matrix4().multiplyMatrices(placement, part.matrix));
    }
  }
  return [...map.values()];
}

function Instances({ geo, mat, cast, receive, matrices }: Batch) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }, [matrices]);
  return (
    <instancedMesh
      ref={ref}
      args={[geo, mat, matrices.length]}
      castShadow={cast}
      receiveShadow={receive}
      raycast={() => null}
    />
  );
}

const ORIGIN = [new THREE.Matrix4()];

/** Draw `parts` once per placement, batched into instanced meshes. */
export function Kit({ parts, placements = ORIGIN }: { parts: Part[]; placements?: THREE.Matrix4[] }) {
  const batches = useMemo(() => batch(parts, placements), [parts, placements]);
  return (
    <>
      {batches.map((b, i) => (
        <Instances key={`${i}-${b.matrices.length}`} {...b} />
      ))}
    </>
  );
}
