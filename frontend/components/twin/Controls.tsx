"use client";

import { type CameraPreset, type LayerKey, useApp } from "@/lib/store";
import { num } from "@/lib/format";
import type { EquipmentState } from "@/lib/types";
import { Check, Choice, Dot, STATE_COLOUR, STATE_LABEL, Tag } from "../ui";
import { PRESETS } from "./layout";

const LAYERS: { key: LayerKey; label: string }[] = [
  { key: "water", label: "Water flow" },
  { key: "heat", label: "Heat rejection" },
  { key: "air", label: "Airflow" },
  { key: "labels", label: "Labels" },
  { key: "cutaway", label: "Cutaway" },
];

export function LayerControls() {
  const layers = useApp((s) => s.layers);
  const toggle = useApp((s) => s.toggleLayer);
  return (
    <div className="flex flex-col">
      {LAYERS.map((l) => (
        <Check key={l.key} on={layers[l.key]} onChange={() => toggle(l.key)} label={l.label} />
      ))}
    </div>
  );
}

export function CameraPresets() {
  const preset = useApp((s) => s.preset.name);
  const setPreset = useApp((s) => s.setPreset);
  return (
    <Choice<CameraPreset>
      size="sm"
      value={preset}
      onChange={setPreset}
      options={(Object.keys(PRESETS) as CameraPreset[]).map((key) => ({ value: key, label: PRESETS[key].label }))}
    />
  );
}

export const CIRCUIT_LEGEND: { id: string; label: string; colour: string }[] = [
  { id: "PIPE-CWS", label: "Condenser water supply", colour: "#2a9db0" },
  { id: "PIPE-CWR", label: "Condenser water return", colour: "#cf6a38" },
  { id: "PIPE-CHWS", label: "Chilled water supply", colour: "#3a72c8" },
  { id: "PIPE-CHWR", label: "Chilled water return", colour: "#7d9fc8" },
  { id: "MU-01", label: "Makeup water", colour: "#7fbfcc" },
  { id: "BD-01", label: "Blowdown", colour: "#9a8a62" },
];

export function CircuitLegend() {
  const select = useApp((s) => s.select);
  const selected = useApp((s) => s.selected);
  return (
    <div className="flex flex-col gap-[3px]">
      {CIRCUIT_LEGEND.map((c) => (
        <button
          key={c.id}
          onClick={() => select(selected === c.id ? null : c.id)}
          className={`flex items-center gap-2 text-left text-[11px] ${selected === c.id ? "text-ink" : "text-ink-2 hover:text-ink"}`}
        >
          <span className="h-[4px] w-4" style={{ background: c.colour }} />
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** Detail of one piece of equipment: state and simulated values. */
export function Inspector({ item, onClose }: { item: EquipmentState; onClose?: () => void }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="num text-[15px] font-medium text-ink">{item.tag}</span>
            <Tag colour={STATE_COLOUR[item.state]}>
              <Dot colour={STATE_COLOUR[item.state]} size={5} />
              {STATE_LABEL[item.state]}
            </Tag>
          </div>
          <div className="mt-1 text-[12px] text-ink-2">{item.name}</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="mt-0.5 text-[11px] text-ink-3 hover:text-ink">
            Clear
          </button>
        )}
      </div>
      <div className="mt-2 text-[11.5px] text-ink-3">{item.summary}</div>
      <dl className="mt-3 border-t border-line">
        {item.metrics.map((m) => (
          <div key={m.label} className="flex items-baseline justify-between gap-3 border-b border-line py-[5px]">
            <dt className="text-[11.5px] text-ink-2">{m.label}</dt>
            <dd className="num whitespace-nowrap text-[12px] text-ink">
              {num(m.value, m.digits)}
              {m.unit && m.value !== null && <span className="ml-1 text-[11px] text-ink-3">{m.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 text-[10.5px] text-ink-3">Simulated values, not measurements.</div>
    </div>
  );
}
