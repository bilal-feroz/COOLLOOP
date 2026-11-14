"use client";

// One WebGL canvas for the whole application.
//
// A view that wants to show the twin renders a <TwinSlot>. The single
// <TwinHost> then positions the canvas over that slot. Switching views moves
// the canvas instead of rebuilding it, so the scene, the camera and the GPU
// resources survive navigation.

import dynamic from "next/dynamic";
import { useLayoutEffect, useRef } from "react";
import { create } from "zustand";

const TwinCanvas = dynamic(() => import("./TwinCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <span className="label pulse">Building digital twin</span>
    </div>
  ),
});

const useSlot = create<{ el: HTMLElement | null }>(() => ({ el: null }));

export function TwinSlot({ className, children }: { className?: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    useSlot.setState({ el });
    return () => {
      if (useSlot.getState().el === el) useSlot.setState({ el: null });
    };
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

export function TwinHost() {
  const el = useSlot((s) => s.el);
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    if (!el) {
      node.style.visibility = "hidden";
      return;
    }
    const sync = () => {
      const r = el.getBoundingClientRect();
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.width = `${r.width}px`;
      node.style.height = `${r.height}px`;
      node.style.visibility = r.width > 0 && r.height > 0 ? "visible" : "hidden";
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    observer.observe(document.body);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [el]);

  return (
    <div ref={host} className="fixed z-[1] overflow-hidden bg-bg" style={{ visibility: "hidden", left: 0, top: 0, width: 1, height: 1 }}>
      <TwinCanvas active={el !== null} />
      {/* Soft falloff toward the edges so the model sits in the frame. */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 85% 80% at 50% 46%, transparent 58%, rgba(5,7,9,0.62) 100%)" }} />
    </div>
  );
}
