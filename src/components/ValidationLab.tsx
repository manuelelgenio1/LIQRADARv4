import { useEffect, useState } from "react";
import type { PoolRecord, PoolStats } from "../lib/validation";
import { fmtAgo } from "../lib/validation";
import { fmtPrice, fmtUsd } from "../lib/format";

interface Props {
  log: PoolRecord[];
  stats: PoolStats;
  symbol: string;
  decimals: number;
  lastSync: number;
}

function pct(v: number, digits = 0): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";
}

function StatusBadge({ r }: { r: PoolRecord }) {
  if (r.status === "pendiente") {
    return (
      <span className="flex items-center gap-1 border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-mist-400">
        <span className="h-1 w-1 animate-pulse rounded-full bg-mist-400" />
        esperando
      </span>
    );
  }
  if (r.status === "expirado") {
    return (
      <span className="border border-ink-700 bg-ink-850 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-mist-600">
        expirado
      </span>
    );
  }
  if (!r.outcome) {
    return (
      <span className="border border-flare-400/50 bg-flare-400/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-flare-300">
        barrido · midiendo…
      </span>
    );
  }
  const map = {
    reversion: { t: "reversó ✓", c: "border-long-500/50 bg-long-900/50 text-long-300" },
    continuacion: { t: "atravesó", c: "border-short-500/50 bg-short-900/50 text-short-300" },
    neutral: { t: "barrido · neutral", c: "border-ink-600 bg-ink-800 text-mist-400" },
  } as const;
  const m = map[r.outcome];
  return (
    <span className={`border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider ${m.c}`}>
      {m.t}
    </span>
  );
}

export default function ValidationLab({ log, stats, symbol, decimals, lastSync }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // evidencia de recolección: registros de este símbolo y sus extremos temporales
  const symRecords = log.filter((r) => r.symbol === symbol);
  const firstRec = symRecords.length ? symRecords[symRecords.length - 1] : null;
  const lastRec = symRecords.length ? symRecords[0] : null;
  const syncAgo = lastSync > 0 ? Math.max(0, Math.round((now - lastSync) / 1000)) : null;

  const rows = log.filter((r) => r.symbol === symbol).slice(0, 12);
  const delta = Number.isFinite(stats.hitRate) && Number.isFinite(stats.controlHitRate)
    ? stats.hitRate - stats.controlHitRate
    : NaN;

  const stackTotal = Math.max(1, stats.pending + stats.swept + stats.expired);

  return (
    <section className="panel panel-corner anim-reveal" style={{ animationDelay: "0.6s" }}>
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffb224" strokeWidth="2" strokeLinecap="round">
              <path d="M9 3h6M10 3v5.5L4.6 18a2 2 0 0 0 1.8 3h11.2a2 2 0 0 0 1.8-3L14 8.5V3" />
              <path d="M7.5 14h9" />
            </svg>
            Laboratorio de validación
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            ¿el precio barre los pools detectados? · track record persistido · {symbol}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* prueba visible de recolección: reloj de la última sincronización */}
          <span
            className={`flex items-center gap-1.5 border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${
              syncAgo !== null && syncAgo <= 6
                ? "border-long-500/50 bg-long-900/40 text-long-300"
                : "border-ink-600 bg-ink-800 text-mist-500"
            }`}
            title="El laboratorio sincroniza con el mercado cada 3 segundos"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${syncAgo !== null && syncAgo <= 6 ? "bg-long-400" : "bg-mist-600"}`}
              style={{ animation: syncAgo !== null && syncAgo <= 6 ? "liveBlink 1.4s ease-out infinite" : "none" }}
            />
            {syncAgo === null ? "sync —" : `sync hace ${syncAgo}s`}
          </span>
          <span className="border border-flare-400/40 bg-flare-400/10 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-flare-300">
            {symRecords.length} registros {symbol}
          </span>
          <span className="hidden border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-mist-500 sm:block">
            hipótesis: barrido + reversión
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12">
        {/* ---- métricas del track record ---- */}
        <div className="grid grid-cols-2 gap-px border-b border-ink-700/50 bg-ink-700/30 sm:grid-cols-4 lg:col-span-4 lg:border-b-0 lg:border-r">
          <div className="bg-ink-900/60 px-4 py-3">
            <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">Tasa de barrido</div>
            <div className="tick-num mt-1 font-display text-2xl font-bold text-mist-100">{pct(stats.hitRate)}</div>
            <div className="mt-1 font-mono text-[9px] text-mist-600">
              {Number.isFinite(stats.hitRate) ? (
                Number.isFinite(delta) ? (
                  <span className={delta >= 0 ? "text-long-300" : "text-short-300"}>
                    {delta >= 0 ? "+" : ""}{(delta * 100).toFixed(0)} pts vs azar
                  </span>
                ) : (
                  "vs control: midiendo…"
                )
              ) : (
                "aún sin resueltos"
              )}
            </div>
          </div>
          <div className="bg-ink-900/60 px-4 py-3">
            <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">Reversión tras barrido</div>
            <div className={`tick-num mt-1 font-display text-2xl font-bold ${stats.reversalRate >= 0.5 ? "text-long-300" : "text-mist-100"}`}>
              {pct(stats.reversalRate)}
            </div>
            <div className="mt-1 font-mono text-[9px] text-mist-600">
              {stats.reversals}↑ / {stats.continuations}↓ resueltos
            </div>
          </div>
          <div className="bg-ink-900/60 px-4 py-3">
            <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">Tiempo al barrido</div>
            <div className="tick-num mt-1 font-display text-2xl font-bold text-mist-100">
              {Number.isFinite(stats.avgSweepMin) ? `${stats.avgSweepMin.toFixed(0)}m` : "—"}
            </div>
            <div className="mt-1 font-mono text-[9px] text-mist-600">media desde detección</div>
          </div>
          <div className="bg-ink-900/60 px-4 py-3">
            <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">En espera</div>
            <div className="tick-num mt-1 font-display text-2xl font-bold text-flare-300">{stats.pending}</div>
            <div className="mt-1 font-mono text-[9px] text-mist-600">
              {stats.swept} barridos · {stats.expired} expirados
            </div>
          </div>

          {/* barra apilada de estados */}
          <div className="col-span-2 bg-ink-900/60 px-4 py-3 sm:col-span-4">
            <div className="mb-1.5 flex justify-between font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
              <span>Ciclo de vida de los pools</span>
              <span>ventana: 6 h · resolución: 15 min</span>
            </div>
            <div className="flex h-2 overflow-hidden bg-ink-800">
              <div className="h-full bg-mist-500/70 transition-all duration-700" style={{ width: `${(stats.pending / stackTotal) * 100}%` }} />
              <div className="h-full bg-flare-400/85 transition-all duration-700" style={{ width: `${(stats.swept / stackTotal) * 100}%` }} />
              <div className="h-full bg-ink-600 transition-all duration-700" style={{ width: `${(stats.expired / stackTotal) * 100}%` }} />
            </div>
            <div className="mt-1.5 flex gap-4 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-mist-500" />pendiente</span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-flare-400" />barrido</span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-ink-600" />expirado</span>
              <span className="ml-auto flex items-center gap-1.5 text-mist-500"><span className="h-1.5 w-1.5 border border-dashed border-mist-500" />control = nivel al azar</span>
            </div>
          </div>
        </div>

        {/* ---- bitácora de pools ---- */}
        <div className="scroll-slim overflow-x-auto lg:col-span-8">
          <div className="min-w-[680px]">
          <div className="grid grid-cols-[64px_46px_1fr_60px_76px_118px_54px] items-center gap-2 border-b border-ink-700/40 px-4 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">
            <span>Detectado</span><span>Lado</span><span>Nivel del pool</span><span className="text-right">Dist.</span><span className="text-right">Nocional</span><span>Estado</span><span className="text-right">Edad</span>
          </div>
          <div className="scroll-slim max-h-[248px] overflow-y-auto">
            {rows.length === 0 && (
              <div className="flex h-32 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-mist-600">
                sembrando pools de referencia… el laboratorio empieza a medir ya
              </div>
            )}
            {rows.map((r) => {
              const dist = ((r.price - r.detectedPrice) / r.detectedPrice) * 100;
              return (
                <div
                  key={r.id}
                  className={`grid grid-cols-[64px_46px_1fr_60px_76px_118px_54px] items-center gap-2 border-b border-ink-700/25 px-4 py-[7px] transition-colors hover:bg-ink-750/50 ${
                    r.isControl ? "opacity-60" : ""
                  }`}
                >
                  <span className="font-mono text-[9.5px] text-mist-500">{fmtAgo(r.detectedAt, now)}</span>
                  <span
                    className={`w-fit border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase ${
                      r.side === "long"
                        ? "border-long-500/40 bg-long-900/50 text-long-300"
                        : "border-short-500/40 bg-short-900/50 text-short-300"
                    }`}
                  >
                    {r.side === "long" ? "↓ L" : "↑ S"}
                  </span>
                  <span className="tick-num font-mono text-[11px] font-semibold text-mist-200">
                    {fmtPrice(r.price, decimals)}
                    {r.isControl && (
                      <span className="ml-2 border border-dashed border-mist-600 px-1 font-mono text-[7.5px] uppercase tracking-wider text-mist-500">
                        control
                      </span>
                    )}
                  </span>
                  <span className={`tick-num text-right font-mono text-[10px] ${dist < 0 ? "text-short-300" : "text-long-300"}`}>
                    {dist >= 0 ? "+" : ""}{dist.toFixed(2)}%
                  </span>
                  <span className="tick-num text-right font-mono text-[10px] text-mist-400">
                    {r.isControl ? "—" : fmtUsd(r.sizeUsd)}
                  </span>
                  <span><StatusBadge r={r} /></span>
                  <span className="tick-num text-right font-mono text-[9px] text-mist-600">
                    {r.status === "barrido" && r.sweptAt ? fmtAgo(r.sweptAt, now) : fmtAgo(r.detectedAt, now)}
                  </span>
                </div>
              );
            })}
          </div>
          </div>
        </div>
      </div>

      <footer className="border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5">
        {/* evidencia de que la recolección está activa y persistida */}
        <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[9px] uppercase tracking-widest">
          <span className="flex items-center gap-1.5 text-mist-500">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#14c4a6" strokeWidth="2.4" strokeLinecap="round">
              <path d="M20 6 L9 17 L4 12" />
            </svg>
            recolectando
          </span>
          <span className="text-mist-600">
            primer registro: <b className="tick-num text-mist-400">{firstRec ? fmtAgo(firstRec.detectedAt, now) : "—"}</b>
          </span>
          <span className="text-mist-600">
            último registro: <b className="tick-num text-mist-400">{lastRec ? fmtAgo(lastRec.detectedAt, now) : "—"}</b>
          </span>
          <span className="text-mist-600">
            en localStorage: <b className="tick-num text-mist-400">{log.length}</b>
          </span>
          <span className="text-mist-600">
            ciclo: <b className="tick-num text-mist-400">3 s</b>
          </span>
        </div>
        <p className="font-mono text-[9px] leading-relaxed text-mist-600">
          <span className="text-flare-300">◈</span> Metodología: cada pool se marca <b className="text-mist-400">barrido</b> cuando el precio
          toca su nivel (±0,12 %); 15 min después se clasifica <b className="text-long-300">reversó</b> (rebotó ≥0,4 %) o{" "}
          <b className="text-short-300">atravesó</b>. Si la tasa de barrido de los pools supera a la de los{" "}
          <b className="text-mist-400">controles al azar</b>, el radar aporta señal real; si son iguales, es ruido. Los nocionales son
          estimados (Binance no publica su stream de liquidaciones) — lo que se valida aquí es el comportamiento de los niveles, no el monto.
        </p>
      </footer>
    </section>
  );
}
