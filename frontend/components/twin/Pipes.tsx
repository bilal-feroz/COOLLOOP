"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useApp } from "@/lib/store";
import { G, Kit, type Part } from "./kit";
import { ROUTES, type Route } from "./layout";
import { materials } from "./materials";

/** A pipe run: straight legs joined by smooth bends. */
function pipeGeometry(route: Route, dash: number): THREE.BufferGeometry {
  const pts = route.points.map((p) => new THREE.Vector3(...p));
  const path = new THREE.CurvePath<THREE.Vector3>();
  const bend = Math.max(route.radius * 1.7, 0.22);
  let from = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const corner = pts[i];
    const into = corner.clone().sub(pts[i - 1]);
    const out = pts[i + 1].clone().sub(corner);
    const r = Math.min(bend, into.length() / 2, out.length() / 2);
    const a = corner.clone().addScaledVector(into.normalize(), -r);
    const b = corner.clone().addScaledVector(out.normalize(), r);
    path.add(new THREE.LineCurve3(from, a));
    path.add(new THREE.QuadraticBezierCurve3(a, corner, b));
    from = b;
  }
  path.add(new THREE.LineCurve3(from, pts[pts.length - 1]));
  const length = path.getLength();
  const segments = Math.max(6, Math.ceil(length / 0.32));
  const geometry = new THREE.TubeGeometry(path, segments, route.radius, 14, false);
  // Texture coordinate along the pipe, in flow-dash units.
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * length) / dash);
  return geometry;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Flanges at both ends of every run, so no pipe ends in an open tube. */
function flanges(): Part[] {
  const m = materials();
  const parts: Part[] = [];
  for (const route of ROUTES) {
    const pts = route.points;
    const ends: [number[], number[]][] = [
      [pts[0], pts[1]],
      [pts[pts.length - 1], pts[pts.length - 2]],
    ];
    for (const [end, next] of ends) {
      const dir = new THREE.Vector3(next[0] - end[0], next[1] - end[1], next[2] - end[2]).normalize();
      parts.push({
        geo: G.cyl,
        mat: m.steelDark,
        matrix: new THREE.Matrix4().compose(
          new THREE.Vector3(end[0], end[1], end[2]).addScaledVector(dir, 0.04),
          new THREE.Quaternion().setFromUnitVectors(UP, dir),
          new THREE.Vector3(route.radius * 1.38, 0.08, route.radius * 1.38),
        ),
      });
    }
  }
  return parts;
}

export interface FlowRates {
  /** Visual flow speed of each circuit in m/s. Zero stops the animation. */
  [circuit: string]: number;
}

export function Pipes({ flows }: { flows: FlowRates }) {
  const m = materials();
  const select = useApp((s) => s.select);
  const hover = useApp((s) => s.hover);
  const showFlow = useApp((s) => s.layers.water);
  const selected = useApp((s) => s.selected);
  const hovered = useApp((s) => s.hovered);

  const meshes = useMemo(() => {
    const groups = new Map<string, THREE.BufferGeometry[]>();
    for (const route of ROUTES) {
      const circuit = m.circuits[route.circuit];
      const list = groups.get(route.circuit) ?? [];
      list.push(pipeGeometry(route, circuit.dash));
      groups.set(route.circuit, list);
    }
    return [...groups.entries()].map(([key, list]) => {
      const merged = mergeGeometries(list);
      list.forEach((g) => g.dispose());
      return { key, geometry: merged, circuit: m.circuits[key] };
    });
  }, [m]);
  const flangeParts = useMemo(flanges, []);

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05);
    for (const { key, circuit } of meshes) {
      const speed = flows[key] ?? 0;
      const active = showFlow && speed > 0;
      const emphasised = circuit.id === selected || circuit.id === hovered;
      const target = (active ? 0.7 : 0) + (emphasised ? 0.8 : 0);
      const material = circuit.material;
      material.emissiveIntensity += (target - material.emissiveIntensity) * Math.min(1, step * 6);
      if (active) circuit.flow.offset.x -= (speed * step) / circuit.dash;
    }
  });

  return (
    <group>
      {meshes.map(({ key, geometry, circuit }) => (
        <mesh
          key={key}
          geometry={geometry}
          material={circuit.material}
          castShadow
          receiveShadow
          onClick={(e) => {
            e.stopPropagation();
            select(circuit.id);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            hover(circuit.id);
          }}
          onPointerOut={() => hover(null)}
        />
      ))}
      <Kit parts={flangeParts} />
    </group>
  );
}
