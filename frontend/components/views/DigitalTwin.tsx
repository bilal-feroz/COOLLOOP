"use client";

import { useMemo } from "react";
import { num } from "@/lib/format";
import { useApp } from "@/lib/store";
import type { EquipmentState, PointResult } from "@/lib/types";
import { CameraPresets, CircuitLegend, Inspector, LayerControls } from "../twin/Controls";
import { TwinSlot } from "../twin/TwinViewport";
import { CHECK_COLOUR, CHECK_LABEL, Dot, Note, Section, STATE_COLOUR, STATE_LABEL, Stat, Tag } from "../ui";

const GROUPS: { title: string; kinds: string[] }[] = [
  { title: "White space", kinds: ["hall"] },
  { title: "Cooling towers", kinds: ["tower"] },
  { title: "Water-cooled chillers", kinds: ["wc_chiller"] },
  { title: "Air-cooled chillers", kinds: ["ac_chiller"] },
  { title: "Condenser water pumps", kinds: ["cw_pump"] },
  { title: "Chilled water pumps", kinds: ["chw_pump"] },
  { title: "Water systems", kinds: ["tank", "makeup", "blowdown"] },
  { title: "Pipe circuits", kinds: ["pipe"] },
];

/** Constraints that concern a kind of equipment. */
const RELATED: Record<string, string[]> = {
  tower: ["cws_high", "cws_low", "cw_range", "cell_flow_low", "cell_flow_high"],
  wc_chiller: ["wc_chiller_capacity", "cws_high", "cws_low", "cw_range"],
  ac_chiller: ["dry_capacity", "dry_condensing"],
  cw_pump: ["cell_flow_low", "cell_flow_high", "cw_range"],
  hall: ["server_inlet"],
  makeup: ["water_rate"],
  tank: ["water_rate"],
  blowdown: ["coc"],
  pipe: ["cws_high", "cw_range"],
};

function EquipmentList({ equipment }: { equipment: EquipmentState[] }) {
  const selected = useApp((s) => s.selected);
  const select = useApp((s) => s.select);
  const hover = useApp((s) => s.hover);
  return (
    <div>
      {GROUPS.map((group) => {
        const items = equipment.filter((e) => group.kinds.includes(e.kind));
        if (!items.length) return null;
        return (
          <div key={group.title} className="border-b border-line">
            <div className="label px-3 pb-1.5 pt-2.5">{group.title}</div>
            {items.map((item) => {
              const on = item.id === selected;
              return (
                <button
                  key={item.id}
                  onClick={() => select(on ? null : item.id)}
                  onPointerEnter={() => hover(item.id)}
                  onPointerLeave={() => hover(null)}
                  aria-pressed={on}
                  className={`flex h-[26px] w-full items-center gap-2 border-l-2 px-3 text-left transition-colors ${
                    on ? "border-accent bg-raised" : "border-transparent hover:bg-raised/60"
                  }`}
                >
                  <Dot colour={STATE_COLOUR[item.state]} pulse={item.state === "fault"} size={6} />
                  <span className={`num w-[58px] shrink-0 text-[11.5px] ${on ? "text-ink" : "text-ink-2"}`}>{item.tag}</span>
                  <span className="truncate text-[11px] text-ink-3">{item.summary}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function PlantSummary({ point }: { point: PointResult }) {
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of point.equipment) if (e.kind !== "pipe" && e.kind !== "hall") out[e.state] = (out[e.state] ?? 0) + 1;
    return out;
  }, [point]);
  const t = point.thermal;
  return (
    <>
      <Section title="Plant state" right={<Tag>Simulated</Tag>}>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {(Object.keys(STATE_LABEL) as (keyof typeof STATE_LABEL)[]).map((state) =>
            counts[state] ? (
              <span key={state} className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
                <Dot colour={STATE_COLOUR[state]} size={6} />
                <span className="num text-ink">{counts[state]}</span> {STATE_LABEL[state].toLowerCase()}
              </span>
            ) : null,
          )}
        </div>
        <div className="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-3.5">
          <Stat label="Chilled water" value={t.chw_supply_c} unit="°C" sub={`return ${num(t.chw_return_c, 1)} °C`} />
          <Stat label="Condenser water" value={t.cws_c} unit="°C" sub={`return ${num(t.cwr_c, 1)} °C`} />
          <Stat label="Tower approach" value={t.approach_k} unit="K" sub={`wet-bulb ${num(point.conditions.t_wb_c, 1)} °C`} />
          <Stat label="Evaporative share" value={t.wet_fraction * 100} unit="%" digits={0} sub={`dry ${num(t.dry_load_kw, 0)} kW`} />
        </div>
      </Section>
      <Section title="How to read the twin">
        <ul className="space-y-1.5 text-[11.5px] leading-snug text-ink-2">
          <li>Moving dashes on a pipe show the direction of flow; faster dashes mean more flow.</li>
          <li>Tower fans turn at the simulated fan speed. Vapour above a stack scales with the heat that cell rejects.</li>
          <li>A pulsing ring on the ground marks equipment in a warning or fault state.</li>
          <li>Select an item in the model or in the list to read its simulated values.</li>
        </ul>
      </Section>
    </>
  );
}

export default function DigitalTwin() {
  const overview = useApp((s) => s.overview);
  const selected = useApp((s) => s.selected);
  const select = useApp((s) => s.select);
  const point = overview?.now ?? null;
  const item = point?.equipment.find((e) => e.id === selected);
  const related = item && point ? point.constraints.filter((c) => (RELATED[item.kind] ?? []).includes(c.id) && c.status !== "n/a") : [];

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[268px] shrink-0 overflow-y-auto border-r border-line bg-panel">
        {point ? (
          <EquipmentList equipment={point.equipment} />
        ) : (
          <div className="p-3">
            <Note tone="warn">Equipment states need weather data. The model is shown without live values.</Note>
          </div>
        )}
      </aside>

      <TwinSlot className="relative min-w-0 flex-1">
        <div className="pointer-events-none absolute left-3 top-3 z-[2]">
          <div className="label">Digital twin</div>
          <div className="mt-1.5 text-[11.5px] text-ink-2">
            {overview?.facility.id} · {overview?.facility.name}
          </div>
          <div className="mt-0.5 text-[10.5px] text-ink-3">Simulated state of the applied configuration</div>
        </div>
        <div className="absolute right-3 top-3 z-[2] flex flex-col items-end gap-2">
          <CameraPresets />
          <div className="border border-line-2 bg-[#0a0d10d9] px-2.5 py-1.5">
            <LayerControls />
          </div>
        </div>
        <div className="absolute bottom-3 left-3 z-[2] border border-line-2 bg-[#0a0d10d9] px-2.5 py-2">
          <div className="label mb-1.5">Circuits</div>
          <CircuitLegend />
        </div>
        <div className="pointer-events-none absolute bottom-3 right-3 z-[2] text-[10.5px] text-ink-3">
          Drag to orbit · right-drag to pan · scroll to zoom
        </div>
      </TwinSlot>

      <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-panel">
        {item ? (
          <>
            <Section title="Selected equipment">
              <Inspector item={item} onClose={() => select(null)} />
            </Section>
            {related.length > 0 && (
              <Section title="Limits that apply" pad={false}>
                {related.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 border-t border-line px-3 py-[7px]">
                    <div className="min-w-0">
                      <div className="truncate text-[11.5px] text-ink-2">{c.label}</div>
                      <div className="num text-[11px] text-ink-3">
                        {num(c.value, 1)} of {c.kind === "max" ? "max" : "min"} {num(c.limit, 1)} {c.unit}
                      </div>
                    </div>
                    <Tag colour={CHECK_COLOUR[c.status]}>{CHECK_LABEL[c.status]}</Tag>
                  </div>
                ))}
              </Section>
            )}
          </>
        ) : point ? (
          <PlantSummary point={point} />
        ) : (
          <div className="p-3">
            <Note tone="warn">No simulated state is available without weather data.</Note>
          </div>
        )}
      </aside>
    </div>
  );
}
