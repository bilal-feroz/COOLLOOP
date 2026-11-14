"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { dateClock, dayClock, num } from "@/lib/format";
import { useApp, useOffset } from "@/lib/store";
import type { AnalystSection, Answer, Briefing, Finding, Severity } from "@/lib/types";
import { ApprovalDialog, type ApprovalRequest, ChangeList, diffConfig } from "../Approval";
import { Btn, CHECK_COLOUR, Choice, Delta, Icon, Note, Section, Skeleton, Tag } from "../ui";

const SEVERITY: Record<Severity, { colour: string; label: string }> = {
  info: { colour: "var(--color-ink-3)", label: "Info" },
  watch: { colour: "var(--color-warn)", label: "Watch" },
  warning: { colour: "var(--color-serious)", label: "Warning" },
  critical: { colour: "var(--color-crit)", label: "Critical" },
};

const TOOL_LABEL: Record<string, string> = {
  get_weather_summary: "Weather summary",
  get_hourly_forecast: "Hourly forecast",
  get_operating_point: "Simulated operating point",
  get_projection: "Forecast projection",
  get_optimisation: "Optimisation result",
  get_facility_and_assumptions: "Facility and assumptions",
};

function FindingRow({ finding }: { finding: Finding }) {
  const s = SEVERITY[finding.severity];
  return (
    <li className="border-t border-line px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-[5px] h-[7px] w-[7px] shrink-0" style={{ background: s.colour }} title={s.label} />
        <div className="min-w-0">
          <div className="text-[12px] text-ink">{finding.title}</div>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-2">{finding.detail}</p>
          {finding.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {finding.evidence
                .filter((e) => e.value !== null)
                .map((e, i) => (
                  <span key={`${e.label}-${i}`} className="text-[10.5px] text-ink-3">
                    {e.label} <span className="num text-ink-2">{num(e.value, e.digits)}</span>
                    {e.unit ? ` ${e.unit}` : ""}
                  </span>
                ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Analyst({ section }: { section: AnalystSection }) {
  const worst = section.findings.reduce<Severity>((acc, f) => (Object.keys(SEVERITY).indexOf(f.severity) > Object.keys(SEVERITY).indexOf(acc) ? f.severity : acc), "info");
  return (
    <div className="flex min-h-0 min-w-0 flex-col border-r border-line last:border-r-0">
      <div className="border-b border-line px-3 pb-3 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="label">{section.name}</span>
          <Tag colour={SEVERITY[worst].colour}>{SEVERITY[worst].label}</Tag>
        </div>
        <p className="mt-2 text-[13px] leading-snug text-ink">{section.headline}</p>
        <p className="mt-1.5 text-[11px] leading-snug text-ink-3">{section.remit}</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto [&>li:first-child]:border-t-0">
        {section.findings.map((f) => (
          <FindingRow key={f.title} finding={f} />
        ))}
        {section.findings.length === 0 && <li className="px-3 py-3 text-[11.5px] text-ink-3">Nothing to report.</li>}
      </ul>
    </div>
  );
}

function RecommendationPanel({ briefing, onApprove }: { briefing: Briefing; onApprove: (r: ApprovalRequest) => void }) {
  const overview = useApp((s) => s.overview)!;
  const dismiss = useApp((s) => s.dismiss);
  const setView = useApp((s) => s.setView);
  const loadDraft = useApp((s) => s.loadDraft);
  const rec = briefing.recommendation;
  if (!rec) {
    return (
      <Section title="Recommendation">
        <Note tone="warn">No recommendation can be made without weather data.</Note>
      </Section>
    );
  }
  const checked = rec.constraints.filter((c) => c.status !== "n/a");
  const clear = checked.filter((c) => c.status === "ok").length;
  return (
    <Section title="Recommendation" right={<Tag colour={rec.actionable ? "var(--color-accent)" : "var(--color-ink-3)"}>{rec.actionable ? "Awaiting approval" : "No action"}</Tag>}>
      <div className="text-[14px] text-ink">{rec.actionable ? `Apply the ${rec.label.toLowerCase()} configuration` : "Keep the current configuration"}</div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink-2">{rec.reason}</p>

      {rec.actionable && rec.deltas && (
        <div className="mt-3 grid grid-cols-2 gap-3 border-y border-line py-2.5">
          <div>
            <div className="label mb-1.5">Makeup water, {rec.window_hours} h</div>
            <div className="text-[16px]">
              <Delta value={rec.deltas.makeup_pct} digits={0} />
            </div>
            <div className="num mt-1 text-[11px] text-ink-3">
              {num(rec.baseline_summary.makeup_m3, 0)} → {num(rec.summary.makeup_m3, 0)} m³
            </div>
          </div>
          <div>
            <div className="label mb-1.5">Cooling energy, {rec.window_hours} h</div>
            <div className="text-[16px]">
              <Delta value={rec.deltas.energy_pct} digits={1} />
            </div>
            <div className="num mt-1 text-[11px] text-ink-3">
              {num(rec.baseline_summary.cooling_energy_kwh / 1000, 1)} → {num(rec.summary.cooling_energy_kwh / 1000, 1)} MWh
            </div>
          </div>
        </div>
      )}

      {rec.actionable && (
        <>
          <div className="label mb-1.5 mt-3">Set-point changes</div>
          <ChangeList changes={rec.changes} />
          <div className="label mb-1.5 mt-3">Why each change</div>
          <ul className="space-y-1.5">
            {rec.rationale.map((line) => (
              <li key={line} className="border-l border-line-2 pl-2.5 text-[11.5px] leading-snug text-ink-2">
                {line}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-3 flex items-center gap-2 text-[11.5px] text-ink-2">
        <span className="h-[7px] w-[7px]" style={{ background: clear === checked.length ? CHECK_COLOUR.ok : CHECK_COLOUR.warning }} />
        {clear} of {checked.length} constraints clear in every hour of the window
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {rec.actionable && (
          <Btn
            kind="primary"
            onClick={() =>
              onApprove({
                title: `Apply the ${rec.label.toLowerCase()} configuration`,
                source: `recommendation: ${rec.label.toLowerCase()}`,
                config: rec.config,
                changes: diffConfig(overview.controls, overview.config, rec.config),
                deltas: rec.deltas,
                windowHours: rec.window_hours,
                feasible: rec.feasible,
              })
            }
          >
            <Icon name="lock" size={12} />
            Review and approve
          </Btn>
        )}
        <Btn
          onClick={() => {
            loadDraft(rec.config);
            setView("simulation");
          }}
        >
          Open in simulation
        </Btn>
        {rec.actionable && (
          <Btn kind="quiet" onClick={() => dismiss(`recommendation: ${rec.label.toLowerCase()}`)}>
            Dismiss
          </Btn>
        )}
      </div>
      <p className="mt-2.5 text-[10.5px] leading-snug text-ink-3">{rec.approval_note}</p>
    </Section>
  );
}

function Ask() {
  const llm = useApp((s) => s.overview?.llm);
  const [role, setRole] = useState<Answer["role"]>("thermal");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offset = useOffset();
  const examples: Record<Answer["role"], string> = {
    climate: "When is the hardest hour for the towers in the next three days?",
    thermal: "Why does water use peak in the afternoon?",
    planner: "What do I give up if I pick the water-saving configuration?",
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.ask(role, question.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The analyst could not answer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Ask an analyst" right={<Tag colour={llm?.available ? "var(--color-accent)" : "var(--color-ink-3)"}>{llm?.available ? llm.model : "LLM off"}</Tag>}>
      {!llm?.available ? (
        <Note>
          {llm?.detail ?? "No language model is configured."} Add <span className="num text-ink">ANTHROPIC_API_KEY</span> to <span className="num text-ink">.env</span> to
          enable questions. Everything else on this page is computed without a language model.
        </Note>
      ) : (
        <form onSubmit={submit}>
          <Choice
            size="sm"
            value={role}
            onChange={setRole}
            options={[
              { value: "climate", label: "Climate" },
              { value: "thermal", label: "Thermal" },
              { value: "planner", label: "Planner" },
            ]}
          />
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), submit(e))}
            placeholder={examples[role]}
            rows={2}
            maxLength={600}
            className="mt-2 w-full resize-none border border-line-2 bg-inset px-2.5 py-2 text-[12px] leading-snug text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10.5px] text-ink-3">Answers use tool data only and cannot change the facility.</span>
            <Btn type="submit" kind="primary" disabled={busy || question.trim().length < 3}>
              <Icon name="send" size={12} />
              {busy ? "Asking" : "Ask"}
            </Btn>
          </div>
        </form>
      )}
      {busy && (
        <div className="mt-3">
          <Skeleton lines={3} />
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Note tone="warn">{error} The briefing above does not depend on the language model.</Note>
        </div>
      )}
      {answer && !busy && (
        <div className="rise mt-3 border border-line bg-inset p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="label">{answer.analyst}</span>
            <span className="num text-[10.5px] text-ink-3">{dayClock(answer.generated_at, offset)}</span>
          </div>
          <div className="mt-1.5 text-[11px] text-ink-3">{answer.question}</div>
          <div className="mt-2 whitespace-pre-wrap text-[12px] leading-[1.55] text-ink">{answer.answer}</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
            <span className="text-[10.5px] text-ink-3">Data used:</span>
            {answer.tools_used.length ? (
              answer.tools_used.map((t) => <Tag key={t}>{TOOL_LABEL[t] ?? t}</Tag>)
            ) : (
              <span className="text-[10.5px] text-warn">no plant data was read for this answer</span>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function Log({ briefing }: { briefing: Briefing }) {
  const offset = useOffset();
  const resetConfig = useApp((s) => s.resetConfig);
  const busy = useApp((s) => s.busy);
  const [confirm, setConfirm] = useState(false);
  const colour = { applied: "var(--color-accent)", dismissed: "var(--color-ink-3)", reset: "var(--color-warn)" };
  return (
    <Section title="Decision log" right={<span className="num text-[11px] text-ink-3">{briefing.audit.length}</span>} pad={false}>
      {briefing.audit.length === 0 && <div className="px-3 pb-3 text-[11.5px] text-ink-3">No operator decisions yet.</div>}
      <ul className="max-h-[220px] overflow-y-auto">
        {briefing.audit.map((entry, i) => (
          <li key={`${entry.at}-${i}`} className="border-t border-line px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[11.5px] text-ink">
                <Tag colour={colour[entry.action]}>{entry.action}</Tag>
                {entry.source}
              </span>
              <span className="num shrink-0 text-[10.5px] text-ink-3">{dateClock(entry.at, offset)}</span>
            </div>
            <div className="mt-1 text-[11px] text-ink-3">
              {entry.approved_by}
              {entry.changes.length ? ` · ${entry.changes.length} set point${entry.changes.length > 1 ? "s" : ""} changed` : ""}
              {entry.note ? ` · ${entry.note}` : ""}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
        <span className="text-[11px] text-ink-3">Restore the reference baseline set points.</span>
        {confirm ? (
          <span className="flex gap-1.5">
            <Btn
              kind="danger"
              disabled={busy}
              onClick={async () => {
                await resetConfig();
                setConfirm(false);
              }}
            >
              Confirm reset
            </Btn>
            <Btn kind="quiet" onClick={() => setConfirm(false)}>
              Cancel
            </Btn>
          </span>
        ) : (
          <Btn kind="quiet" onClick={() => setConfirm(true)}>
            Reset
          </Btn>
        )}
      </div>
    </Section>
  );
}

function Assumptions() {
  const assumptions = useApp((s) => s.overview?.assumptions ?? []);
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Model assumptions"
      right={
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-ink-2 hover:text-ink" aria-expanded={open}>
          {open ? "Hide" : `Show ${assumptions.length}`}
          <Icon name="chevron" size={10} className={open ? "-rotate-90" : "rotate-90"} />
        </button>
      }
    >
      <p className="text-[11.5px] leading-snug text-ink-2">
        Every figure comes from a simplified steady-state model of a synthetic reference facility. It is a screening model, not a validated plant model.
      </p>
      {open && (
        <dl className="mt-2.5 space-y-2.5">
          {assumptions.map((a) => (
            <div key={a.id}>
              <dt className="label mb-1">{a.area}</dt>
              <dd className="text-[11.5px] leading-snug text-ink-2">
                {a.text}
                {a.reference && <span className="mt-0.5 block text-[10.5px] text-ink-3">{a.reference}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

export default function Intelligence() {
  const overview = useApp((s) => s.overview);
  const briefing = useApp((s) => s.briefing);
  const status = useApp((s) => s.briefingStatus);
  const loadBriefing = useApp((s) => s.loadBriefing);
  const offset = useOffset();
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);

  useEffect(() => {
    if (status === "idle") loadBriefing();
  }, [status, loadBriefing]);

  if (!overview) return null;
  const basis = briefing?.basis;

  return (
    <div className="flex h-full min-h-0 bg-panel">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-3 py-2">
          <div className="flex items-baseline gap-2.5">
            <span className="label">Operations briefing</span>
            {basis && <span className="text-[11px] text-ink-3">generated {dayClock(briefing!.generated_at, offset)} by fixed rules, no language model</span>}
          </div>
          {basis && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
              <span className="flex items-center gap-1.5">
                Weather: <span className="text-ink-2">{basis.weather_source}</span>
                <Tag colour={basis.weather_status === "live" ? "var(--color-accent)" : "var(--color-warn)"}>{basis.weather_synthetic ? "synthetic" : basis.weather_status}</Tag>
              </span>
              <span>
                Forecast: <span className="num text-ink-2">{dayClock(basis.forecast_from, offset)} to {dayClock(basis.forecast_to, offset)}</span>
              </span>
              <span>
                Configuration: <span className="text-ink-2">{basis.config_source}</span>
              </span>
              <button onClick={loadBriefing} className="flex items-center gap-1 text-ink-2 hover:text-ink" title="Rebuild the briefing from the current data">
                <Icon name="refresh" size={11} />
                Rebuild
              </button>
            </div>
          )}
        </div>
        {briefing ? (
          <div className={`grid min-h-0 flex-1 grid-cols-3 transition-opacity ${status === "loading" ? "opacity-60" : ""}`}>
            {briefing.sections.map((section) => (
              <Analyst key={section.role} section={section} />
            ))}
          </div>
        ) : status === "error" ? (
          <div className="p-3">
            <Note tone="crit">The briefing could not be built. Check the backend connection.</Note>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-6 p-3">
            <Skeleton lines={5} />
            <Skeleton lines={5} />
            <Skeleton lines={5} />
          </div>
        )}
      </div>

      <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-line">
        {briefing ? (
          <>
            <RecommendationPanel briefing={briefing} onApprove={setApproval} />
            <Ask />
            <Log briefing={briefing} />
            <Assumptions />
          </>
        ) : (
          <div className="p-3">
            <Skeleton lines={6} />
          </div>
        )}
      </aside>

      {approval && <ApprovalDialog request={approval} onClose={() => setApproval(null)} />}
    </div>
  );
}
