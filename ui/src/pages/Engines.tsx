import { useMemo, useState } from "react";

import { api, ApiError, type Engine, type Metrics } from "../api";
import { ChartCard, Sparkline, TimeLines, type Series } from "../components/charts";
import { EngineName, StatusPill } from "../components/common";
import { engineColor } from "../lib/colors";
import { bytes, byteTicks, cpu, params, secs } from "../lib/format";
import { useLab } from "../state";

function bucketed(metrics: Metrics | null, ids: string[], pick: (s: { cpu_percent: number; footprint: number }) => number) {
  if (!metrics) return [];
  const rows = new Map<number, Record<string, number | null>>();
  for (const id of ids) {
    for (const s of metrics.engines[id]?.samples ?? []) {
      const t = Math.round(s.t);
      const row = rows.get(t) ?? { t };
      const prev = row[id];
      row[id] = prev === undefined || prev === null ? pick(s) : Math.max(prev, pick(s));
      rows.set(t, row);
    }
  }
  return [...rows.values()].sort((a, b) => (a.t as number) - (b.t as number));
}

function percentTicks(max: number): number[] {
  const step = max <= 200 ? 50 : max <= 400 ? 100 : 200;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

export function EnginesPage() {
  const { engines, metrics, system } = useLab();
  const running = engines.filter((e) => e.run);
  const series: Series[] = running.map((e) => ({ id: e.id, label: e.label }));
  const ids = running.map((e) => e.id);
  const mem = useMemo(() => bucketed(metrics, ids, (s) => s.footprint), [metrics, ids.join()]);
  const cpuRows = useMemo(() => bucketed(metrics, ids, (s) => s.cpu_percent), [metrics, ids.join()]);
  const gpu = useMemo(
    () => (metrics?.system ?? []).map((s) => ({ t: s.t, gpu: s.gpu_percent, cpu: s.cpu_percent })),
    [metrics],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Engines</h1>
          <p>
            Each local engine is its own process in a macOS sandbox: no outbound network, offline weights, no secrets in its
            environment, and file writes limited to its project and caches. Memory is the process's physical footprint, which on
            Apple Silicon includes GPU buffers that RSS misses.
          </p>
        </div>
        {system && (
          <div className="muted small" style={{ textAlign: "right" }}>
            {system.chip} · {system.cores} cores · {bytes(system.memory_total)}
            <br />
            macOS {system.macos} · sandbox {system.sandbox ? "on" : "off"}
          </div>
        )}
      </div>

      {running.length > 0 && (
        <>
          <div className="chart-grid">
            <ChartCard title="Memory footprint" sub="Per engine process, last 5 minutes" legend={series}>
              <TimeLines data={mem} series={series} fmt={(v) => bytes(v)} ticks={byteTicks(Math.max(1, ...mem.flatMap((r) => ids.map((id) => r[id] ?? 0))))} />
            </ChartCard>
            <ChartCard title="CPU" sub="Per engine process; 100% is one core busy" legend={series}>
              <TimeLines data={cpuRows} series={series} fmt={(v) => cpu(v)} ticks={percentTicks(Math.max(100, ...cpuRows.flatMap((r) => ids.map((id) => r[id] ?? 0))))} />
            </ChartCard>
          </div>
          <div className="chart-grid" style={{ marginTop: 14 }}>
            <ChartCard title="Apple GPU and CPU, whole machine" sub="GPU utilisation is system-wide: macOS does not attribute GPU time per process without root">
              <MachineChart rows={gpu} />
            </ChartCard>
          </div>
        </>
      )}

      <div className="section-title">All engines</div>
      <div className="engine-grid">
        {engines.map((e) => (
          <EngineCard key={e.id} engine={e} />
        ))}
      </div>
    </div>
  );
}

function MachineChart({ rows }: { rows: Array<{ t: number; gpu: number | null; cpu: number }> }) {
  const data = rows.map((r) => ({ t: r.t, "gpu-sys": r.gpu, "cpu-sys": r.cpu }));
  return (
    <>
      <TimeLines
        data={data}
        series={[
          { id: "gpu-sys", label: "GPU" },
          { id: "cpu-sys", label: "CPU (all cores)" },
        ]}
        fmt={(v) => `${v.toFixed(0)}%`}
        domain={[0, 100]}
        height={160}
      />
      <div className="legend" style={{ padding: "4px 0 0" }}>
        <span>
          <i className="swatch" style={{ background: engineColor("gpu-sys") }} />
          GPU
        </span>
        <span>
          <i className="swatch" style={{ background: engineColor("cpu-sys") }} />
          CPU, all cores
        </span>
      </div>
    </>
  );
}

function EngineCard({ engine: e }: { engine: Engine }) {
  const { refreshEngines, fail, toast, metrics, system } = useLab();
  const [device, setDevice] = useState(e.run?.device ?? e.devices[0]!);
  const [threads, setThreads] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsForce, setNeedsForce] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const run = e.run;
  const samples = metrics?.engines[e.id]?.samples ?? [];
  const lastCold = e.cold_starts[0];
  const need = e.memory_needed[device] ?? 0;
  const tight = !run && system && need > system.memory_available;

  async function start(force = false) {
    setBusy(true);
    setNeedsForce(null);
    try {
      await api.start(e.id, { device, threads: threads ? Number(threads) : null, force });
      refreshEngines();
    } catch (err) {
      if (err instanceof ApiError && err.status === 507) setNeedsForce(err.message);
      else fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await api.stop(e.id);
      toast(`${e.label} stopped`);
      refreshEngines();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function showLog() {
    try {
      setLog((await api.log(e.id)).log || "(empty)");
    } catch (err) {
      fail(err);
    }
  }

  const failed = run && (run.status === "error" || run.status === "exited");
  const cold = run?.cold_start;

  return (
    <div className="card engine" data-engine={e.id}>
      <div className="engine-top">
        <div className="row spread">
          <span className="engine-name">
            <EngineName id={e.id} label={e.label} />
          </span>
          <StatusPill run={run} remote={e.remote} />
        </div>
        <div className="engine-arch">{e.architecture}</div>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="tag">{e.license}</span>
          {e.remote && <span className="tag">remote · sends data off this Mac</span>}
          <a className="small" href={e.source.startsWith("http") ? e.source : undefined} target="_blank" rel="noreferrer">
            {e.source.startsWith("http") ? "source ↗" : e.source}
          </a>
        </div>
        {e.note && <div className="small muted">{e.note}</div>}
      </div>

      <dl className="facts" style={{ margin: 0 }}>
        <div>
          <dt>Params</dt>
          <dd>{params(e.params)}</dd>
        </div>
        <div>
          <dt>On disk</dt>
          <dd>{e.remote ? "—" : bytes(e.weights_bytes)}</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd title="Peak seen in an earlier run, or an estimate from the parameter count">{e.remote ? "—" : `~${bytes(need)}`}</dd>
        </div>
        <div>
          <dt>Cold start</dt>
          <dd>{secs(run?.cold_start.total_s ?? lastCold?.total_s)}</dd>
        </div>
      </dl>

      <div className="engine-live">
        {e.missing_secrets.length > 0 ? (
          e.missing_secrets.includes("TYPESAFE_API_KEY") ? <JevSetup /> : <RemoteSetup engine={e} />
        ) : e.missing_weights.length > 0 ? (
          <div className="callout warn">
            <span className="icon">↓</span>
            <div>
              Weights not downloaded yet. Run <code>make weights-all</code>
              <div className="small muted">Missing: {e.missing_weights.join(", ")}</div>
            </div>
          </div>
        ) : !e.installed ? (
          <div className="callout warn">
            <span className="icon">!</span>
            <div>
              Not installed. Run <code>make setup</code>.
            </div>
          </div>
        ) : run && !failed ? (
          <>
            <div className="live-stats">
              <div>
                <span>CPU now</span>
                <strong>{cpu(run.cpu_percent)}</strong>
              </div>
              <div>
                <span>Footprint</span>
                <strong>{bytes(run.footprint)}</strong>
              </div>
              <div>
                <span>Peak</span>
                <strong>{bytes(run.peak_footprint)}</strong>
              </div>
            </div>
            <div className="row spread">
              <span className="small muted">
                {run.status === "ready" && cold
                  ? `start ${secs(cold.process_s)} · load ${secs(cold.load_s)} · warm-up ${secs((cold.warmup_ms ?? 0) / 1000)}`
                  : `${run.device} · ${run.status}…`}
              </span>
              <Sparkline values={samples.map((s) => s.footprint)} color={engineColor(e.id)} />
            </div>
            <div className="small muted">
              {run.device} · pid {run.pid} · {run.requests} requests · RSS {bytes(run.rss)}
            </div>
          </>
        ) : failed ? (
          <div className="callout bad">
            <span className="icon">✕</span>
            <div style={{ minWidth: 0 }}>
              {run.status === "error" ? "Failed to load." : "The process exited."}
              <pre>{run.error}</pre>
            </div>
          </div>
        ) : (
          <div className="small muted">
            {lastCold ? `Last start on ${lastCold.device}: load ${secs(lastCold.load_s)}, total ${secs(lastCold.total_s)}.` : "Not started yet."}
            {tight && (
              <div className="callout warn" style={{ marginTop: 8 }}>
                <span className="icon">!</span>
                <div>
                  Needs ~{bytes(need)}; {bytes(system?.memory_available)} is free right now.
                </div>
              </div>
            )}
          </div>
        )}
        {needsForce && (
          <div className="callout warn">
            <span className="icon">!</span>
            <div>
              {needsForce}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => void start(true)}>
                  Start anyway
                </button>
                <button className="btn sm ghost" onClick={() => setNeedsForce(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="engine-actions">
        {run && !failed ? (
          <button className="btn" onClick={() => void stop()} disabled={busy || run.status === "stopping"}>
            Stop
          </button>
        ) : (
          <>
            {e.devices.length > 1 && (
              <select className="select" aria-label="Device" value={device} onChange={(ev) => setDevice(ev.target.value)}>
                {e.devices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            {!e.remote && (
              <input
                className="input"
                style={{ width: 92 }}
                aria-label="CPU threads"
                placeholder="threads"
                inputMode="numeric"
                value={threads}
                onChange={(ev) => setThreads(ev.target.value.replace(/\D/g, ""))}
              />
            )}
            <button
              className="btn primary"
              onClick={() => (failed ? void stop().then(() => start()) : void start())}
              disabled={busy || !e.installed || e.missing_secrets.length > 0 || e.missing_weights.length > 0}
            >
              {failed ? "Restart" : "Start"}
            </button>
          </>
        )}
        <button className="btn ghost" onClick={() => void showLog()} style={{ marginLeft: "auto" }}>
          Log
        </button>
      </div>

      {log !== null && (
        <div className="modal-back" onClick={() => setLog(null)}>
          <div className="card modal" onClick={(ev) => ev.stopPropagation()} role="dialog" aria-label={`${e.label} log`}>
            <div className="card-head">
              <h3>{e.label} · log</h3>
              <button className="btn ghost sm" onClick={() => setLog(null)}>
                Close
              </button>
            </div>
            <div className="body">
              <pre className="log">{log}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteSetup({ engine }: { engine: Engine }) {
  return (
    <div className="callout">
      <span className="icon">🔑</span>
      <div className="small">
        <strong>Needs API credentials</strong>
        <div>Put {engine.missing_secrets.map((key) => <code key={key}>{key}=… </code>)} in <code>.env</code> at the lab root.</div>
        <div className="muted">The lab picks it up without a restart. Only this engine receives these credentials. Starting a hosted engine runs a billable warm-up.</div>
      </div>
    </div>
  );
}

function JevSetup() {
  return (
    <div className="callout">
      <span className="icon">🔑</span>
      <div className="small">
        <strong>Needs a TypeSafe API key</strong>
        <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <li>
            Sign up at{" "}
            <a href="https://console.typesafe.ai" target="_blank" rel="noreferrer">
              console.typesafe.ai
            </a>{" "}
            (no waitlist; $5 free credit).
          </li>
          <li>
            Create a key under <b>Settings → API keys</b>.
          </li>
          <li>
            Put <code>TYPESAFE_API_KEY=…</code> in <code>.env</code> at the lab root.
          </li>
        </ol>
        <div className="muted" style={{ marginTop: 4 }}>
          The lab picks it up without a restart. Only the Jev engine ever sees it.
        </div>
      </div>
    </div>
  );
}
