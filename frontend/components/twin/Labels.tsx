"use client";

// Equipment labels. The chips are ordinary DOM in one overlay next to the
// canvas; a tiny component inside the canvas projects each anchor to screen
// space every rendered frame and moves its chip. No extra React roots.

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { useApp, useTwinPoint } from "@/lib/store";
import type { EquipmentState } from "@/lib/types";
import { NODE_BY_ID, NODES } from "./layout";
import { STATE_COLOURS } from "./materials";

const chips = new Map<string, HTMLElement>();
const point = new THREE.Vector3();

/** Lives inside the canvas. */
export function LabelProjector() {
  useFrame(({ camera, size }) => {
    chips.forEach((el, id) => {
      const node = NODE_BY_ID[id];
      if (!node) return;
      point.set(node.anchor[0], node.anchor[1], node.anchor[2]).project(camera);
      const visible = point.z < 1 && Math.abs(point.x) < 1.15 && Math.abs(point.y) < 1.15;
      el.style.opacity = visible ? "1" : "0";
      if (!visible) return;
      const x = (point.x * 0.5 + 0.5) * size.width;
      const y = (-point.y * 0.5 + 0.5) * size.height;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    });
  });
  return null;
}

const ABNORMAL = new Set(["warning", "fault"]);

/** Lives in the DOM, over the canvas. */
export function LabelLayer() {
  const { point: result } = useTwinPoint();
  const selected = useApp((s) => s.selected);
  const hovered = useApp((s) => s.hovered);
  const showAll = useApp((s) => s.layers.labels);
  const equipment = useMemo<Record<string, EquipmentState>>(
    () => Object.fromEntries((result?.equipment ?? []).map((e) => [e.id, e])),
    [result],
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {NODES.map((node) => {
        const item = equipment[node.id];
        const focus = node.id === selected || node.id === hovered;
        const abnormal = item ? ABNORMAL.has(item.state) : false;
        // Pipe circuits have no volume of their own, so they are only labelled on focus.
        if (!(focus || abnormal || (showAll && node.center))) return null;
        return (
          <div
            key={node.id}
            ref={(el) => {
              if (el) chips.set(node.id, el);
              else chips.delete(node.id);
            }}
            className="absolute left-0 top-0 flex flex-col items-center whitespace-nowrap transition-opacity duration-150"
            style={{ opacity: 0, zIndex: focus ? 3 : abnormal ? 2 : 1 }}
          >
            <div className={`flex items-center gap-1.5 border bg-[#0a0d10eb] px-1.5 py-[3px] ${focus ? "border-accent" : "border-line-2"}`}>
              <span className="h-[6px] w-[6px] rounded-full" style={{ background: STATE_COLOURS[item?.state ?? "off"] }} />
              <span className="num text-[10.5px] leading-none text-ink">{item?.tag ?? node.id}</span>
              {focus && item && <span className="text-[10.5px] leading-none text-ink-2">{item.summary}</span>}
            </div>
            <div className="h-3 w-px bg-line-2" />
          </div>
        );
      })}
    </div>
  );
}
