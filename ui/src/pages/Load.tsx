import { useEffect, useState } from "react";

import { api, type LoadResult, type Preset, type WireRequest } from "../api";
import { Empty } from "../components/common";
import { LoadView } from "../components/LoadView";
import { useStored } from "../hooks";
import { JobStatus } from "./Bench";
import { useJob } from "./useJob";
import { useLab } from "../state";

const LEVELS = [1, 2, 4, 8, 16, 32];

export function LoadPage({ handoff }: { handoff: WireRequest | null }) {
  const { engines, fail, label } = useLab();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [source, setSource] = useState<string>(handoff ? "playground" : "01-support-triage");
  const [engine, setEngine] = useStored("lab.load.engine", "");
  const [levels, setLevels] = useStored<number[]>("lab.load.levels", [1, 2, 4, 8]);
  const [perLevel, setPerLevel] = useStored("lab.load.per", 32);
  const job = useJob("loadtest");

  useEffect(() => {
    api.presets().then(setPresets).catch(fail);
  }, [fail]);
  useEffect(() => {
    if (handoff) setSource("playground");
  }, [handoff]);

  const ready = engines.filter((e) => e.run?.status === "ready");
  const target = ready.find((e) => e.id === engine) ?? ready[0];
  const request = source === "playground" ? handoff : (presets.find((p) => p.id === source)?.request ?? null);
  const total = levels.length * perLevel;
  const running = job.snapshot?.status === "running";

  async function start() {
    if (!target || !request) return;
    try {
      job.track(await api.loadtest({ engine: target.id, request, levels: [...levels].sort((a, b) => a - b), per_level: perLevel }));
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Load test</h1>
          <p>
            Send the same request at rising concurrency and watch throughput, tail latency, CPU and memory. Each engine answers one
            request at a time, so beyond one in flight you are measuring the queue, which is how these servers behave in practice.
          </p>
        </div>
      </div>

      <div className="card card-pad stack">
        <div className="row wrap" style={{ gap: 16, alignItems: "flex-end" }}>
          <label className="field" style={{ minWidth: 220 }}>
            Engine
            <select className="select" value={target?.id ?? ""} onChange={(e) => setEngine(e.target.value)} disabled={!ready.length}>
              {ready.length === 0 && <option value="">no engine running</option>}
              {ready.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} · {e.run!.device}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 240 }}>
            Request
            <select className="select" value={source} onChange={(e) => setSource(e.target.value)}>
              {handoff && <option value="playground">From the playground</option>}
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  Preset: {p.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Requests per level
            <input
              className="input num"
              style={{ width: 90 }}
              type="number"
              min={1}
              max={500}
              value={perLevel}
              onChange={(e) => setPerLevel(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            />
          </label>
          <span className="grow" />
          <button className="btn primary" onClick={() => void start()} disabled={running || !target || !request || !levels.length || total > 2000}>
            Run load test
          </button>
        </div>
        <div className="row wrap">
          <span className="small ink-2" style={{ marginRight: 4 }}>
            Concurrency
          </span>
          {LEVELS.map((c) => (
            <button
              key={c}
              className="engine-chip"
              aria-pressed={levels.includes(c)}
              onClick={() => setLevels((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]))}
            >
              {c}
            </button>
          ))}
          <span className={`small ${total > 2000 ? "" : "muted"}`} style={total > 2000 ? { color: "var(--critical-text)" } : undefined}>
            {total} requests{total > 2000 ? " · the limit is 2,000" : ""}
          </span>
        </div>
        {target?.remote && <div className="callout warn"><span className="icon">!</span><div>Load-testing {target.label} sends every request to its hosted provider and is billed; it also counts against your rate limit.</div></div>}
      </div>

      {job.snapshot && <JobStatus job={job.snapshot} onCancel={job.cancel} label={label} />}
      <div style={{ marginTop: 14 }}>
        {job.snapshot?.result && "levels" in job.snapshot.result && job.snapshot.result.levels.length > 0 ? (
          <LoadView result={job.snapshot.result as LoadResult} />
        ) : (
          !job.snapshot && (
            <div className="card">
              <Empty title="No load test yet">Pick a running engine and a request.</Empty>
            </div>
          )
        )}
      </div>
    </div>
  );
}
