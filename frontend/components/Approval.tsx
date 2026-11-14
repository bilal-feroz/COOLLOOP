"use client";

// Human approval. No configuration reaches the simulated facility without an
// operator confirming it here; the backend refuses the request otherwise.

import { useEffect, useState } from "react";
import { num } from "@/lib/format";
import { useApp } from "@/lib/store";
import type { ControlSpec, Deltas, OperatingConfig, ParameterChange } from "@/lib/types";
import { Btn, Delta, Icon, Note } from "./ui";

export function diffConfig(controls: ControlSpec[], from: OperatingConfig, to: OperatingConfig): ParameterChange[] {
  const out: ParameterChange[] = [];
  for (const c of controls) {
    const before = Number(from[c.key]) * c.scale;
    const after = Number(to[c.key]) * c.scale;
    if (Math.abs(before - after) > 1e-6) out.push({ key: c.key, label: c.label, unit: c.unit, before, after });
  }
  return out;
}

export function ChangeList({ changes }: { changes: ParameterChange[] }) {
  if (!changes.length) return <div className="text-[11.5px] text-ink-3">No set points change.</div>;
  return (
    <div className="border-t border-line">
      {changes.map((c) => (
        <div key={c.key} className="flex items-baseline justify-between gap-3 border-b border-line py-[5px] text-[11.5px]">
          <span className="text-ink-2">{c.label}</span>
          <span className="num whitespace-nowrap">
            <span className="text-ink-3">{num(c.before, Number.isInteger(c.before) && Number.isInteger(c.after) ? 0 : 1)}</span>
            <span className="mx-1.5 text-ink-3">→</span>
            <span className="text-ink">{num(c.after, Number.isInteger(c.before) && Number.isInteger(c.after) ? 0 : 1)}</span>
            {c.unit && <span className="ml-1 text-ink-3">{c.unit}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface ApprovalRequest {
  title: string;
  source: string;
  config: OperatingConfig;
  changes: ParameterChange[];
  deltas?: Deltas | null;
  windowHours?: number;
  feasible: boolean;
  problems?: string[];
}

export function ApprovalDialog({ request, onClose }: { request: ApprovalRequest; onClose: () => void }) {
  const operator = useApp((s) => s.operator);
  const setOperator = useApp((s) => s.setOperator);
  const apply = useApp((s) => s.apply);
  const busy = useApp((s) => s.busy);
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(request.feasible);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const confirm = async () => {
    if (await apply(request.config, request.source, note)) onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label={request.title} className="rise w-[460px] border border-line-2 bg-panel shadow-[0_24px_70px_rgba(0,0,0,0.75)]">
        <div className="flex h-10 items-center justify-between border-b border-line px-4">
          <span className="flex items-center gap-2 text-[12.5px] text-ink">
            <Icon name="lock" size={13} className="text-accent" />
            Operator approval
          </span>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">
            <Icon name="close" size={13} />
          </button>
        </div>

        <div className="space-y-3.5 p-4">
          <div>
            <div className="text-[14px] text-ink">{request.title}</div>
            <div className="mt-1 text-[11.5px] text-ink-3">Source: {request.source}</div>
          </div>

          <ChangeList changes={request.changes} />

          {request.deltas && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1.5">Projected makeup water</div>
                <Delta value={request.deltas.makeup_pct} digits={0} />
                <span className="num ml-2 text-[11px] text-ink-3">{num(request.deltas.makeup_m3, 0)} m³</span>
              </div>
              <div>
                <div className="label mb-1.5">Projected cooling energy</div>
                <Delta value={request.deltas.energy_pct} digits={1} />
                <span className="num ml-2 text-[11px] text-ink-3">{num(request.deltas.energy_kwh, 0)} kWh</span>
              </div>
              {request.windowHours && (
                <div className="col-span-2 -mt-1 text-[11px] text-ink-3">
                  Simulated totals for the next {request.windowHours} hours against the current configuration.
                </div>
              )}
            </div>
          )}

          {!request.feasible && (
            <Note tone="crit">
              This configuration breaks a limit.
              {request.problems?.length ? <ul className="mt-1 list-disc pl-4">{request.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-ink">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="accent-[var(--color-crit)]" />
                Apply it to the simulation anyway
              </label>
            </Note>
          )}

          <div className="grid grid-cols-[150px_1fr] gap-2">
            <label className="block">
              <span className="mb-1 block text-[10.5px] text-ink-3">Approved by</span>
              <input
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                className="h-7 w-full border border-line-2 bg-inset px-2 text-[12px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10.5px] text-ink-3">Note for the log (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                className="h-7 w-full border border-line-2 bg-inset px-2 text-[12px] text-ink outline-none focus:border-accent"
              />
            </label>
          </div>

          <Note>This changes the simulated facility only. COOLLOOP does not control real equipment.</Note>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={confirm} disabled={busy || !acknowledged || operator.trim().length < 2}>
            <Icon name="check" size={12} />
            Approve and apply
          </Btn>
        </div>
      </div>
    </div>
  );
}
