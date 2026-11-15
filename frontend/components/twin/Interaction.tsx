"use client";

// Picking and highlighting of equipment (labels live in Labels.tsx).
//
// Every selectable item has an invisible pick volume. Hover and selection draw
// CAD-style corner brackets around it; abnormal states draw a pulsing ring on
// the ground so they are visible from any camera angle.

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useApp } from "@/lib/store";
import type { EquipmentState } from "@/lib/types";
import type { V3 } from "./kit";
import { type Node, NODE_BY_ID, NODES } from "./layout";
import { STATE_COLOURS } from "./materials";

const pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const unitBox = new THREE.BoxGeometry(1, 1, 1);

function bracketGeometry(size: V3): THREE.BufferGeometry {
  const [sx, sy, sz] = size.map((s) => s / 2);
  const len = Math.min(1.6, Math.min(...size) * 0.28);
  const pts: number[] = [];
  for (const x of [-sx, sx]) {
    for (const y of [-sy, sy]) {
      for (const z of [-sz, sz]) {
        pts.push(x, y, z, x - Math.sign(x) * len, y, z);
        pts.push(x, y, z, x, y - Math.sign(y) * len, z);
        pts.push(x, y, z, x, y, z - Math.sign(z) * len);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function Brackets({ node, colour, strong }: { node: Node; colour: string; strong: boolean }) {
  const geometry = useMemo(() => bracketGeometry(node.size!), [node]);
  return (
    <group position={node.center}>
      <lineSegments geometry={geometry} renderOrder={20} raycast={() => null}>
        <lineBasicMaterial color={colour} transparent opacity={strong ? 1 : 0.6} depthTest={false} toneMapped={false} />
      </lineSegments>
      <mesh geometry={unitBox} scale={node.size} renderOrder={19} raycast={() => null}>
        <meshBasicMaterial color={colour} transparent opacity={strong ? 0.07 : 0.035} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function StateRing({ node, colour }: { node: Node; colour: string }) {
  const ref = useRef<THREE.Mesh>(null);
  const radius = Math.max(node.size![0], node.size![2]) * 0.62;
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 3.2);
    (ref.current.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.55 * pulse;
  });
  const y = node.center![1] - node.size![1] / 2 + 0.14;
  return (
    <mesh ref={ref} position={[node.center![0], y, node.center![2]]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={18} raycast={() => null}>
      <ringGeometry args={[radius, radius + 0.32, 64]} />
      <meshBasicMaterial color={colour} transparent depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

const ABNORMAL = new Set(["warning", "fault"]);

export function Interaction({ equipment }: { equipment: Record<string, EquipmentState> }) {
  const selected = useApp((s) => s.selected);
  const hovered = useApp((s) => s.hovered);
  const select = useApp((s) => s.select);
  const hover = useApp((s) => s.hover);

  const pickable = useMemo(() => NODES.filter((n) => n.center && n.size), []);
  const selectedNode = selected ? NODE_BY_ID[selected] : undefined;
  const hoveredNode = hovered && hovered !== selected ? NODE_BY_ID[hovered] : undefined;

  return (
    <group>
      {pickable.map((node) => (
        <mesh
          key={node.id}
          geometry={unitBox}
          material={pickMaterial}
          position={node.center}
          scale={node.size}
          onClick={(e) => {
            e.stopPropagation();
            select(node.id === selected ? null : node.id);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            hover(node.id);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            hover(null);
            document.body.style.cursor = "";
          }}
        />
      ))}

      {pickable.map((node) => {
        const state = equipment[node.id]?.state;
        return state && ABNORMAL.has(state) ? <StateRing key={node.id} node={node} colour={STATE_COLOURS[state]} /> : null;
      })}

      {selectedNode?.center && <Brackets node={selectedNode} colour="#f0e2c4" strong />}
      {hoveredNode?.center && <Brackets node={hoveredNode} colour="#9d9383" strong={false} />}
    </group>
  );
}
