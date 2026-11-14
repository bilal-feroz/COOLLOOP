"use client";

// The parts of the twin that move or change with the simulation: fans, vapour
// plumes, tank level, status beacons. Each one reads plain numbers ("drivers")
// derived from the simulated operating point.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { rotorGeometry } from "./equipment";
import { ACC_POS, CHILLER_X, CHILLER_Z, CHW_PUMP_Z, CW_PUMP_Z, MAKEUP_SKID, BLOWDOWN, ROOF_DECK_Y, TANK, TOWER_X, TOWER_Z } from "./layout";
import { materials, seeded, STATE_COLOURS } from "./materials";
import { tankGauge, tankShellGeometry } from "./site";

export interface Drivers {
  /** Fan speed 0..1 of each tower cell (0 when the cell is not running). */
  towerFan: number[];
  /** Heat rejected by each tower cell as a fraction of its design duty. */
  towerHeat: number[];
  /** Load 0..1 of each air-cooled chiller (0 when stopped). */
  accLoad: number[];
  tankLevel: number; // 0..1
  itLoad: number; // 0..1 of design
  states: Record<string, string>;
}

// --- cooling tower fans ---------------------------------------------------------
export function TowerFans({ drivers }: { drivers: Drivers }) {
  const m = materials();
  const geometry = useMemo(() => rotorGeometry(2.55, 8, 0.5, 0.62), []);
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const speed = useRef<number[]>(TOWER_X.map(() => 0));
  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05);
    TOWER_X.forEach((_, i) => {
      const target = drivers.towerFan[i] ?? 0;
      speed.current[i] += (target - speed.current[i]) * Math.min(1, step * 1.5);
      const mesh = refs.current[i];
      if (mesh) mesh.rotation.y -= speed.current[i] * step * 7.5;
    });
  });
  return (
    <>
      {TOWER_X.map((x, i) => (
        <mesh
          key={x}
          ref={(el) => {
            refs.current[i] = el;
          }}
          geometry={geometry}
          material={m.fan}
          position={[x, 9.42, TOWER_Z]}
          raycast={() => null}
        />
      ))}
    </>
  );
}

// --- air-cooled chiller fans (instanced) ----------------------------------------------
const FANS_PER_UNIT = 12;

export function AccFans({ drivers }: { drivers: Drivers }) {
  const m = materials();
  const geometry = useMemo(() => rotorGeometry(0.46, 5, 0.1, 0.2), []);
  const ref = useRef<THREE.InstancedMesh>(null);
  const angle = useRef(ACC_POS.map(() => 0));
  const speed = useRef(ACC_POS.map(() => 0));
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const write = () => {
    const mesh = ref.current;
    if (!mesh) return;
    ACC_POS.forEach(([x, z], u) => {
      for (let i = 0; i < 6; i++) {
        for (let s = 0; s < 2; s++) {
          dummy.position.set(x - 4.9 + i * 1.72, ROOF_DECK_Y + 2.42, z + (s ? 0.58 : -0.58));
          dummy.rotation.set(0, angle.current[u] * (s ? 1 : -1) + i, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(u * FANS_PER_UNIT + i * 2 + s, dummy.matrix);
        }
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  useLayoutEffect(() => {
    write();
    ref.current?.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05);
    let moving = false;
    ACC_POS.forEach((_, u) => {
      const target = drivers.accLoad[u] > 0 ? 0.55 + 0.45 * drivers.accLoad[u] : 0;
      speed.current[u] += (target - speed.current[u]) * Math.min(1, step * 1.5);
      if (speed.current[u] > 0.002) {
        angle.current[u] += speed.current[u] * step * 14;
        moving = true;
      }
    });
    if (moving) write();
  });
  return <instancedMesh ref={ref} args={[geometry, m.fan, ACC_POS.length * FANS_PER_UNIT]} raycast={() => null} />;
}

// --- vapour plumes and warm exhaust ---------------------------------------------------------
const PLUME_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / -mv.z;
    vAlpha = aAlpha;
    vColor = aColor;
  }
`;
const PLUME_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

interface Emitter {
  origin: [number, number, number];
  spread: number;
  rise: number;
  size: number;
  colour: THREE.Color;
  strength: () => number;
  count: number;
}

export function Plumes({ drivers, visible }: { drivers: Drivers; visible: boolean }) {
  const m = materials();
  const driversRef = useRef(drivers);
  driversRef.current = drivers;
  const { size, camera, viewport } = useThree();

  const { geometry, material, particles } = useMemo(() => {
    const vapour = new THREE.Color("#cfe4ec");
    const warm = new THREE.Color("#f0b48c");
    const emitters: Emitter[] = [
      ...TOWER_X.map((x, i) => ({
        origin: [x, 10.9, TOWER_Z] as [number, number, number],
        spread: 2.1,
        rise: 15,
        size: 5.2,
        colour: vapour,
        strength: () => Math.min(1.2, driversRef.current.towerHeat[i] ?? 0),
        count: 22,
      })),
      ...ACC_POS.map(([x, z], i) => ({
        origin: [x - 0.6, ROOF_DECK_Y + 2.7, z] as [number, number, number],
        spread: 4.2,
        rise: 7,
        size: 3.4,
        colour: warm,
        strength: () => (driversRef.current.accLoad[i] > 0 ? 0.35 + 0.4 * driversRef.current.accLoad[i] : 0),
        count: 12,
      })),
    ];
    const rand = seeded(7);
    const list = emitters.flatMap((e) =>
      Array.from({ length: e.count }, () => ({
        e,
        phase: rand(),
        ox: (rand() - 0.5) * 2 * e.spread * (e.spread > 3 ? 1 : 0.7),
        oz: (rand() - 0.5) * 2 * (e.spread > 3 ? 0.8 : e.spread * 0.7),
        drift: 0.6 + rand() * 0.8,
        rate: 0.07 + rand() * 0.035,
      })),
    );
    const n = list.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(n), 1));
    const colours = new Float32Array(n * 3);
    list.forEach((p, i) => p.e.colour.toArray(colours, i * 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colours, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(10, 15, -10), 140);
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLUME_VERTEX,
      fragmentShader: PLUME_FRAGMENT,
      uniforms: { uMap: { value: m.puff }, uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
    });
    return { geometry: g, material: mat, particles: list };
  }, [m]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, dt) => {
    if (!visible) return;
    const step = Math.min(dt, 0.05);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 30;
    material.uniforms.uScale.value = (size.height * viewport.dpr) / (2 * Math.tan((fov * Math.PI) / 360));
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const sizes = geometry.attributes.aSize as THREE.BufferAttribute;
    const alpha = geometry.attributes.aAlpha as THREE.BufferAttribute;
    particles.forEach((p, i) => {
      const strength = p.e.strength();
      p.phase = (p.phase + step * p.rate * (0.6 + 0.6 * Math.min(1, strength))) % 1;
      const t = p.phase;
      const widen = 1 + t * 1.6;
      pos.setXYZ(
        i,
        p.e.origin[0] + p.ox * widen + t * t * 5.5 * p.drift,
        p.e.origin[1] + t * p.e.rise,
        p.e.origin[2] + p.oz * widen - t * t * 2.2 * p.drift,
      );
      sizes.setX(i, p.e.size * (0.7 + 1.9 * t));
      const fade = Math.min(1, t * 7) * (1 - t) * (1 - t);
      alpha.setX(i, strength * fade * 0.2);
    });
    pos.needsUpdate = true;
    sizes.needsUpdate = true;
    alpha.needsUpdate = true;
  });

  return <points geometry={geometry} material={material} visible={visible} raycast={() => null} renderOrder={5} />;
}

// --- water tank shell, stored volume and level gauge -------------------------------------------------
export function Tank({ level, cutaway }: { level: number; cutaway: boolean }) {
  const m = materials();
  const { shell, roof } = useMemo(tankShellGeometry, []);
  const gauge = useMemo(tankGauge, []);
  const fill = Math.min(Math.max(level, 0.01), 1);
  const waterHeight = (TANK.h - 0.5) * fill;
  const material = cutaway ? m.tankGhost : m.tankShell;
  return (
    <group>
      <mesh geometry={shell} material={material} position={[TANK.x, 0.4 + TANK.h / 2, TANK.z]} castShadow={!cutaway} receiveShadow raycast={() => null} />
      <mesh geometry={roof} material={material} position={[TANK.x, 0.4 + TANK.h + 0.75, TANK.z]} castShadow={!cutaway} raycast={() => null} />
      {cutaway && (
        <mesh position={[TANK.x, 0.45 + waterHeight / 2, TANK.z]} material={m.stored} raycast={() => null}>
          <cylinderGeometry args={[TANK.r - 0.12, TANK.r - 0.12, waterHeight, 56]} />
        </mesh>
      )}
      <mesh
        position={[gauge.position[0], gauge.position[1] + (gauge.height * fill) / 2, gauge.position[2]]}
        rotation={[0, gauge.yaw, 0]}
        material={m.gaugeFill}
        raycast={() => null}
      >
        <boxGeometry args={[0.06, gauge.height * fill, 0.34]} />
      </mesh>
    </group>
  );
}

// --- status beacons ------------------------------------------------------------------------------
function beaconPositions(): { id: string; position: [number, number, number]; size: number }[] {
  const out: { id: string; position: [number, number, number]; size: number }[] = [];
  TOWER_X.forEach((x, i) => out.push({ id: `CT-0${i + 1}`, position: [x - 4.3, 9.82, TOWER_Z + 4.3], size: 0.26 }));
  CHILLER_X.forEach((x, i) => {
    out.push({ id: `CH-0${i + 1}`, position: [x + 1.3, 2.66, CHILLER_Z - 1.55], size: 0.15 });
    out.push({ id: `CWP-0${i + 1}`, position: [x, 1.46, CW_PUMP_Z - 0.7], size: 0.1 });
    out.push({ id: `CHP-0${i + 1}`, position: [x, 1.46, CHW_PUMP_Z + 0.7], size: 0.1 });
  });
  ACC_POS.forEach(([x, z], i) => out.push({ id: `ACC-0${i + 1}`, position: [x + 5.1, ROOF_DECK_Y + 2.42, z - 0.8], size: 0.18 }));
  out.push({ id: "TK-01", position: [TANK.x, TANK.h + 2.75, TANK.z], size: 0.26 });
  out.push({ id: "MU-01", position: [MAKEUP_SKID.x + 1.6, 1.82, MAKEUP_SKID.z - 0.9], size: 0.12 });
  out.push({ id: "BD-01", position: [BLOWDOWN.x - 2.6, 1.38, BLOWDOWN.z], size: 0.12 });
  return out;
}

export function Beacons({ states }: { states: Record<string, string> }) {
  const beacons = useMemo(beaconPositions, []);
  const ref = useRef<THREE.InstancedMesh>(null);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 14, 10), []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();
    beacons.forEach((b, i) => {
      dummy.position.set(...b.position);
      dummy.scale.setScalar(b.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, colour.set(STATE_COLOURS[states[b.id] ?? "off"] ?? STATE_COLOURS.off));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [beacons, states]);
  return <instancedMesh ref={ref} args={[geometry, material, beacons.length]} raycast={() => null} />;
}

/** Rack LEDs and hot-aisle glow follow the IT load. */
export function useLoadGlow(itLoad: number, heatLayer: boolean) {
  const m = materials();
  useEffect(() => {
    m.rackFront.emissiveIntensity = 0.5 + 1.5 * itLoad;
    m.containment.emissiveIntensity = heatLayer ? 0.15 + 0.75 * itLoad : 0.05;
    m.containment.opacity = heatLayer ? 0.1 + 0.14 * itLoad : 0.07;
  }, [m, itLoad, heatLayer]);
}

// --- airflow arrows ---------------------------------------------------------------------------------
interface Arrow {
  from: THREE.Vector3;
  to: THREE.Vector3;
  quaternion: THREE.Quaternion;
  phase: number;
  rate: number;
  size: number;
  colour: THREE.Color;
  /** Strength 0..1 of the stream this arrow belongs to. */
  strength: (d: Drivers) => number;
}

function buildArrows(): Arrow[] {
  const cool = new THREE.Color("#9cc4dc");
  const warm = new THREE.Color("#f2b98a");
  const up = new THREE.Vector3(0, 1, 0);
  const rand = seeded(19);
  const out: Arrow[] = [];
  const add = (from: [number, number, number], to: [number, number, number], colour: THREE.Color, size: number, strength: Arrow["strength"]) => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    out.push({
      from: a,
      to: b,
      quaternion: new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize()),
      phase: rand(),
      rate: 0.32 + rand() * 0.14,
      size,
      colour,
      strength,
    });
  };

  // Cooling towers: ambient air in through the louvres, warm moist air out of the stack.
  TOWER_X.forEach((x, i) => {
    const s = (d: Drivers) => d.towerFan[i] ?? 0;
    for (const dx of [-2.8, 0, 2.8]) {
      add([x + dx, 2.5, TOWER_Z + 8.6], [x + dx, 2.5, TOWER_Z + 4.9], cool, 0.5, s);
      add([x + dx, 2.5, TOWER_Z - 8.6], [x + dx, 2.5, TOWER_Z - 4.9], cool, 0.5, s);
    }
    for (const [dx, dz] of [[-1.3, 0.8], [1.2, -0.9], [0.1, 1.4]]) add([x + dx, 10.9, TOWER_Z + dz], [x + dx * 1.3, 15.6, TOWER_Z + dz * 1.3], warm, 0.55, s);
  });

  // Air-cooled chillers: air in through the coils, hot air straight up.
  ACC_POS.forEach(([x, z], i) => {
    const s = (d: Drivers) => (d.accLoad[i] > 0 ? 0.5 + 0.5 * d.accLoad[i] : 0);
    for (const dx of [-4, -1.3, 1.4, 4]) {
      add([x + dx - 0.6, ROOF_DECK_Y + 1.2, z + 2.9], [x + dx - 0.6, ROOF_DECK_Y + 1.2, z + 1.35], cool, 0.3, s);
      add([x + dx - 0.6, ROOF_DECK_Y + 1.2, z - 2.9], [x + dx - 0.6, ROOF_DECK_Y + 1.2, z - 1.35], cool, 0.3, s);
      add([x + dx - 0.6, ROOF_DECK_Y + 2.8, z], [x + dx - 0.6, ROOF_DECK_Y + 5.4, z], warm, 0.34, s);
    }
  });

  // White space: cold air down the cold aisles, hot air rising out of the contained hot aisles.
  const load = (d: Drivers) => 0.35 + 0.65 * d.itLoad;
  for (let k = 0; k <= 10; k++) {
    const x = -52.5 + (k - 0.5) * 5.0;
    for (const z of [0.6, 6.2, 11.8]) add([x, 1.5, z], [x, 1.5, z + 4.6], cool, 0.3, load);
  }
  for (let k = 0; k < 10; k++) {
    const x = -52.5 + k * 5.0;
    for (const z of [3.2, 8.4, 13.6]) add([x, 2.9, z], [x, 5.3, z], warm, 0.3, load);
  }
  return out;
}

export function AirFlow({ drivers, visible }: { drivers: Drivers; visible: boolean }) {
  const arrows = useMemo(buildArrows, []);
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.ConeGeometry(0.42, 1.5, 10), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7, toneMapped: false, depthWrite: false }), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const driversRef = useRef(drivers);
  driversRef.current = drivers;

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    arrows.forEach((a, i) => mesh.setColorAt(i, a.colour));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 120);
  }, [arrows]);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh || !visible) return;
    const step = Math.min(dt, 0.05);
    const d = driversRef.current;
    arrows.forEach((a, i) => {
      const strength = a.strength(d);
      a.phase = (a.phase + step * a.rate * (0.4 + 0.6 * strength)) % 1;
      const fade = Math.sin(Math.PI * a.phase);
      const scale = strength > 0.001 ? a.size * fade * (0.6 + 0.4 * strength) : 0;
      dummy.position.lerpVectors(a.from, a.to, a.phase);
      dummy.quaternion.copy(a.quaternion);
      dummy.scale.setScalar(Math.max(scale, 1e-4));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[geometry, material, arrows.length]} visible={visible} raycast={() => null} renderOrder={6} />;
}
