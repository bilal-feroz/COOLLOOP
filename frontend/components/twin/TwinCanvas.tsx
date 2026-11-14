"use client";

import { CameraControls, Environment, Lightformer } from "@react-three/drei";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { useApp } from "@/lib/store";
import type { V3 } from "./kit";
import { NODE_BY_ID, PRESETS } from "./layout";
import { Scene } from "./Scene";

const FOV = 30;
const UP = new THREE.Vector3(0, 1, 0);

/** Camera position that fits a box into the view from a given direction. */
function frame(min: V3, max: V3, dir: THREE.Vector3, aspect: number, margin = 0.03): { position: THREE.Vector3; target: THREE.Vector3 } {
  const target = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const forward = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanV = Math.tan((FOV * Math.PI) / 360) * (1 - margin);
  const tanH = tanV * aspect;
  let distance = 0;
  const corner = new THREE.Vector3();
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        corner.set(x, y, z).sub(target);
        const depth = corner.dot(forward);
        distance = Math.max(distance, Math.abs(corner.dot(right)) / tanH - depth, Math.abs(corner.dot(up)) / tanV - depth);
      }
    }
  }
  return { position: target.clone().addScaledVector(dir, distance), target };
}

/** Shadows are static (only fans move, inside their stacks), so the shadow map
 *  is rendered a few times after a change and then left alone. */
function StaticShadows({ version }: { version: string }) {
  const gl = useThree((s) => s.gl);
  const frames = useRef(0);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    frames.current = 12;
  }, [gl, version]);
  useFrame(() => {
    if (frames.current > 0) {
      gl.shadowMap.needsUpdate = true;
      frames.current -= 1;
    }
  });
  return null;
}

function Rig({ interacting }: { interacting: React.RefObject<number> }) {
  const controls = useRef<CameraControls>(null);
  const preset = useApp((s) => s.preset);
  const selected = useApp((s) => s.selected);
  const view = useApp((s) => s.view);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const moved = useRef(false); // true once the operator has taken the camera
  const first = useRef(true);
  const aspect = width / Math.max(height, 1);

  const applyPreset = useCallback(
    (animate: boolean) => {
      const c = controls.current;
      if (!c || width < 8 || height < 8) return;
      const p = PRESETS[useApp.getState().preset.name];
      const { position, target } = frame(p.min, p.max, new THREE.Vector3(...p.dir).normalize(), aspect);
      c.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, animate);
      moved.current = false;
      interacting.current = performance.now() + 1600;
    },
    [aspect, width, height, interacting],
  );

  // A preset button animates to it; a change of viewport shape re-frames
  // silently, unless the operator has moved the camera themselves.
  useEffect(() => {
    applyPreset(!first.current);
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);
  useEffect(() => {
    if (!moved.current) applyPreset(false);
  }, [applyPreset]);
  useEffect(() => {
    applyPreset(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // In the Digital Twin view, selecting an item frames it from the current
  // viewing direction.
  useEffect(() => {
    const c = controls.current;
    const node = selected ? NODE_BY_ID[selected] : undefined;
    if (!c || !node || view !== "twin") return;
    const centre = node.center ?? node.anchor;
    const half = node.size ? node.size.map((v) => v / 2 + 2.5) : [node.radius / 2, 4, node.radius / 2];
    const direction = c.getPosition(new THREE.Vector3()).sub(c.getTarget(new THREE.Vector3())).normalize();
    if (direction.y < 0.36) direction.setY(0.36).normalize();
    const { position, target } = frame(
      [centre[0] - half[0], Math.max(0, centre[1] - half[1]), centre[2] - half[2]],
      [centre[0] + half[0], centre[1] + half[1], centre[2] + half[2]],
      direction,
      aspect,
      0.34,
    );
    c.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, true);
    moved.current = true;
    interacting.current = performance.now() + 1600;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, view]);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={14}
      maxDistance={520}
      minPolarAngle={0.12}
      maxPolarAngle={Math.PI / 2.06}
      smoothTime={0.32}
      draggingSmoothTime={0.12}
      dollySpeed={0.7}
      onStart={() => {
        moved.current = true;
        interacting.current = Number.POSITIVE_INFINITY;
      }}
      onEnd={() => {
        interacting.current = performance.now() + 1200;
      }}
    />
  );
}

/** Render at full rate while the camera is moving and at half rate otherwise:
 *  the animation stays smooth and an idle twin costs half the GPU time. */
function useFrameBudget(active: boolean, interacting: React.RefObject<number>) {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let n = 0;
    const loop = () => {
      n += 1;
      if (!document.hidden && (performance.now() < interacting.current || n % 2 === 0)) invalidate();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, interacting]);
}

export default function TwinCanvas({ active }: { active: boolean }) {
  const select = useApp((s) => s.select);
  const cutaway = useApp((s) => s.layers.cutaway);
  const interacting = useRef(0);
  useFrameBudget(active, interacting);

  return (
    <Canvas
      shadows="percentage"
      frameloop="demand"
      dpr={[1, 1.6]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: FOV, near: 2, far: 1800, position: [130, 90, 120] }}
      onPointerMissed={() => select(null)}
      onCreated={({ gl }) => {
        // Development aid: lets a console read draw calls and triangle counts.
        if (process.env.NODE_ENV !== "production") (window as unknown as { __gl?: THREE.WebGLRenderer }).__gl = gl;
      }}
    >
      <color attach="background" args={["#07090b"]} />
      <fog attach="fog" args={["#07090b", 330, 820]} />

      <hemisphereLight args={["#9db6c9", "#090b0d", 0.3]} />
      <directionalLight
        position={[96, 118, 62]}
        intensity={3.1}
        color="#fff1dc"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-125}
        shadow-camera-right={125}
        shadow-camera-top={95}
        shadow-camera-bottom={-95}
        shadow-camera-near={20}
        shadow-camera-far={400}
        shadow-bias={-0.0004}
        shadow-normalBias={0.45}
      />
      <directionalLight position={[-90, 46, -80]} intensity={0.5} color="#74b0d8" />

      {/* Studio-style reflections built in the scene, nothing is downloaded. */}
      <Environment resolution={256} frames={1} environmentIntensity={0.5}>
        <color attach="background" args={["#0a0d10"]} />
        <Lightformer form="rect" intensity={2.4} color="#dfeaf2" position={[0, 60, 0]} rotation-x={Math.PI / 2} scale={[160, 160, 1]} />
        <Lightformer form="rect" intensity={1.6} color="#ffe7c4" position={[90, 20, 60]} rotation-y={-Math.PI / 3} scale={[80, 30, 1]} />
        <Lightformer form="rect" intensity={0.9} color="#6fb3d9" position={[-90, 14, -50]} rotation-y={Math.PI / 2.4} scale={[90, 26, 1]} />
      </Environment>

      <StaticShadows version={cutaway ? "cutaway" : "exterior"} />
      <Rig interacting={interacting} />
      <Scene />
    </Canvas>
  );
}
