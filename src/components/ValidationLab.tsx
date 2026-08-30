import { useEffect, useState } from "react";
import type { BacktestResult, PoolRecord, PoolStats } from "../lib/validation";
import { fmtAgo, runBacktest } from "../lib/validation";
import { fmtPrice, fmtUsd } from "../lib/format";
import type { Candle } from "../lib/market";

interface Props {
  log: PoolRecord[];
  stats: PoolStats;
  symbol: string;
  decimals: number;
  lastSync: number;
  market: "perp" | "spot";
  candles: Candle[];
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

export default function ValidationLab({ log, stats, symbol, decimals, lastSync, market, candles }: Props) {
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [btRunning, setBtRunning] = useState(false);

  const runBt = () => {
    setBtRunning(true);
    window.setTimeout(() => {
      setBt(runBacktest(candles, { seed: symbol.length * 7919 + candles.length }));
      setBtRunning(false);
    }, 60);
  };

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // registros de este símbolo Y mercado
  const symRecords = log.filter((r) => r.symbol === symbol && (r.market ?? "perp") === market);
  const firstRec = symRecords.length ? symRecords[symRecords.length - 1] : null;
  const lastRec = symRecords.length ? symRecords[0] : null;
  const syncAgo = lastSync > 0 ? Math.max(0, Math.round((now - lastSync) / 1000)) : null;

  const rows = symRecords.slice(0, 12);
  const delta = Number.isFinite(stats.hitRate) && Number.isFinite(stats.controlHitRate)
    ? stats.hitRate - stats.controlHitRate
    : NaN;

  const stackTotal = Math.max(1, stats.pending + stats.swept + stats.expired);

  const verdict = (() => {
    if (!Number.isFinite(stats.hitRate) || !Number.isFinite(stats.controlHitRate))
      return { label: "MIDIENDO", tone: "mist", note: "Esperando pools y controles resueltos…" };
    const d = (stats.hitRate - stats.controlHitRate) * 100;
    if (d >= 10) return { label: "SEÑAL REAL", tone: "long", note: `Los pools barren ${d.toFixed(0)} pts más que el azar` };
    if (d <= -5) return { label: "PEOR QUE AZAR", tone: "short", note: `Los controles barren más que los pools (Δ ${d.toFixed(0)} pts)` };
    return { label: "SIN VENTAJA AÚN", tone: "flare", note: `Pools y controles empatados (Δ ${d.toFixed(0)} pts)` };
  })();

  const trendPoints = (() => {
    const resolvedReal = symRecords.filter((r) => !r.isControl && (r.status === "barrido" || r.status === "expirado"));
    if (resolvedReal.length < 3) return [];
    const chrono = [...resolvedReal].reverse();
    let hits = 0;
    const pts: number[] = [];
    for (const r of chrono) {
      if (r.status === "barrido") hits++;
      pts.push(hits / (pts.length + 1));
    }
    return pts;
  })();

  const VERDICT_META: Record<string, string> = {
    long: "text-long-300 border-long-500/50 bg-long-900/40",
    short: "text-short-300 border-short-500/50 bg-short-900/40",
    flare: "text-flare-300 border-flare-400/50 bg-flare-400/10",
    mist: "text-mist-400 border-ink-600 bg-ink-800",
  };

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
            <span
              className={`border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest ${
                market === "perp"
                  ? "border-long-500/40 bg-long-900/40 text-long-300"
                  : "border-mist-500/40 bg-ink-800 text-mist-400"
              }`}
              title="Track record de este mercado (PERP y SPOT se validan por separado)"
            >
              {market}
            </span>
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            ¿el precio barre los pools detectados? · track record persistido · {symbol}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 border border-long-500/40 bg-long-900/30 px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-widest text-long-300">
            <span className="h-1.5 w-1.5 rounded-full bg-long-400" style={{ animation: "liveBlink 1.6s ease-out infinite" }} />
            {syncAgo != null ? `sync hace ${syncAgo}s` : "iniciando…"}
          </span>
          <span className="border border-flare-400/40 bg-flare-400/10 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-flare-300">
            {stats.total} registros
          </span>
          <button
            onClick={runBt}
            disabled={btRunning || candles.length < 90}
            className="flex items-center gap-1.5 border border-long-500/50 bg-long-900/40 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-long-300 transition-all hover:bg-long-900/70 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              candles.length < 90
                ? "Se necesitan al menos 90 velas históricas para el backtest"
                : `Reproducir las últimas ${candles.length} velas y comprobar si el radar bate al azar`
            }
          >
            {btRunning ? (
              <>
                <span className="h-2 w-2 animate-spin rounded-full border border-long-300 border-t-transparent" />
                calculando…
              </>
            ) : (
              <>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M3 12h4l3-8 4 16 3-8h4" />
                </svg>
                Backtest {candles.length}v
              </>
            )}
          </button>
        </div>
      </header>

      {bt && <BacktestBlock bt={bt} symbol={symbol} />}

      <div className="grid grid-cols-1 lg:grid-cols-12">
        <div className="grid grid-cols-2 gap-px border-b border-ink-700/50 bg-ink-700/30 sm:grid-cols-4 lg:col-span-4 lg:border-b-0 lg:border-r">
          {/* veredicto */}
          <div className="col-span-2 bg-ink-900/60 px-4 py-3 sm:col-span-4">
            <div className="flex items-center justify-between gap-3">
              <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
                ¿El radar bate al azar?
              </div>
              <span className={`border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest ${VERDICT_META[verdict.tone]}`}>
                {verdict.label}
              </span>
            </div>
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 font-mono text-[8.5px] uppercase tracking-wider text-mist-500">Pools</span>
                <div className="h-2 flex-1 overflow-hidden bg-ink-800">
                  <div
                    className="h-full bg-long-400/85 transition-all duration-700"
                    style={{ width: `${Number.isFinite(stats.hitRate) ? stats.hitRate * 100 : 0}%` }}
                  />
                </div>
                <span className="tick-num w-10 shrink-0 text-right font-mono text-[9.5px] font-bold text-long-300">
                  {pct(stats.hitRate)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 font-mono text-[8.5px] uppercase tracking-wider text-mist-500">Azar</span>
                <div className="h-2 flex-1 overflow-hidden bg-ink-800">
                  <div
                    className="h-full bg-mist-500/70 transition-all duration-700"
                    style={{ width: `${Number.isFinite(stats.controlHitRate) ? stats.controlHitRate * 100 : 0}%` }}
                  />
                </div>
                <span className="tick-num w-10 shrink-0 text-right font-mono text-[9.5px] font-bold text-mist-400">
                  {pct(stats.controlHitRate)}
                </span>
              </div>
            </div>
            <p className="mt-1.5 font-mono text-[8.5px] text-mist-600">{verdict.note}</p>
          </div>

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

          {/* ciclo de vida */}
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

          {/* tendencia acumulada */}
          <div className="col-span-2 bg-ink-900/60 px-4 py-3 sm:col-span-4">
            <div className="mb-1.5 flex justify-between font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
              <span>Tasa de barrido acumulada</span>
              <span>{trendPoints.length >= 3 ? `${trendPoints.length} resueltos` : "mín. 3 resueltos"}</span>
            </div>
            {trendPoints.length >= 3 ? (
              <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-10 w-full">
                <line x1="0" y1={30 - 0.5 * 28} x2="100" y2={30 - 0.5 * 28} stroke="rgba(95,115,150,0.25)" strokeDasharray="2 3" />
                <polyline
                  points={trendPoints.map((v, i) => `${(i / (trendPoints.length - 1)) * 100},${30 - v * 28}`).join(" ")}
                  fill="none" stroke="#2de0c0" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                />
                <polygon
                  points={`0,30 ${trendPoints.map((v, i) => `${(i / (trendPoints.length - 1)) * 100},${30 - v * 28}`).join(" ")} 100,30`}
                  fill="rgba(45,224,192,0.10)"
                />
              </svg>
            ) : (
              <p className="py-2 font-mono text-[9px] text-mist-600">
                Aún no hay suficientes pools resueltos para trazar la tendencia. La línea aparecerá con el track record.
              </p>
            )}
            <p className="mt-1 font-mono text-[8.5px] text-mist-600">
              Si la línea se mantiene alta y estable, la ventaja del radar es persistente; si decae, es ruido.
            </p>
          </div>
        </div>

        {/* bitácora */}
        <div className="lg:col-span-8">
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
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
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5">
        <p className="max-w-3xl font-mono text-[9px] leading-relaxed text-mist-600">
          <span className="text-flare-300">◈</span> Metodología: un pool se marca <b className="text-mist-400">barrido</b> cuando el
          precio toca su nivel (tolerancia adaptativa a su distancia, máx. 0,12 %); 15 min después se clasifica{" "}
          <b className="text-long-300">reversó</b> o <b className="text-short-300">atravesó</b> (umbral adaptativo, máx. 0,4 %). Si la
          tasa de barrido supera a la de los <b className="text-mist-400">controles al azar</b>, hay señal real. Los nocionales son
          estimados — se valida el comportamiento de los niveles, no el monto.
        </p>
        {firstRec && (
          <span className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
            recolectando · primer registro hace {fmtAgo(firstRec.detectedAt, now)}
            {lastRec ? ` · último hace ${fmtAgo(lastRec.detectedAt, now)}` : ""}
            {" · en localStorage: "}
            <b className="tick-num text-mist-400">{log.length}</b>
          </span>
        )}
      </footer>
    </section>
  );
}

function BacktestBlock({ bt, symbol }: { bt: BacktestResult; symbol: string }) {
  const SIGNAL_META: Record<BacktestResult["signal"], { label: string; c: string; note: string }> = {
    real: {
      label: "Señal real",
      c: "text-long-300 border-long-500/50 bg-long-900/40",
      note: "Los pools del radar se barren significativamente más que los niveles al azar: el modelo aporta edge histórico.",
    },
    ruido: {
      label: "Ruido",
      c: "text-short-300 border-short-500/50 bg-short-900/40",
      note: "Los pools se barren MENOS que el azar: en esta serie el modelo no aporta edge. Tómalo con cautela.",
    },
    neutral: {
      label: "Indeterminado",
      c: "text-mist-300 border-ink-600 bg-ink-800",
      note: "La diferencia contra el azar no es concluyente en esta serie. Sigue recolectando o prueba otra temporalidad.",
    },
    insuficiente: {
      label: "Datos insuficientes",
      c: "text-mist-400 border-ink-600 bg-ink-800",
      note: "No hay bastantes pools evaluados para una conclusión fiable. Usa una serie más larga.",
    },
  };
  const m = SIGNAL_META[bt.signal];

  const Bar = ({ v, color }: { v: number; color: string }) => (
    <div className="h-1.5 flex-1 overflow-hidden bg-ink-700/60">
      <div
        className="h-full transition-all duration-700"
        style={{ width: `${Number.isFinite(v) ? Math.min(100, v * 100) : 0}%`, background: color }}
      />
    </div>
  );

  return (
    <div className="anim-reveal grid grid-cols-1 gap-4 border-b border-ink-700/50 bg-ink-900/40 px-4 py-3 lg:grid-cols-12 lg:items-center">
      <div className="lg:col-span-3">
        <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
          Backtest histórico · {bt.candles} velas · {symbol}
        </div>
        <div className={`mt-1.5 inline-flex border px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest ${m.c}`}>
          {m.label}
        </div>
        <p className="mt-2 font-mono text-[8.5px] leading-relaxed text-mist-500">{m.note}</p>
      </div>

      <div className="space-y-2.5 lg:col-span-5">
        <div className="flex items-center gap-2">
          <span className="w-[130px] shrink-0 font-mono text-[8.5px] uppercase tracking-wider text-mist-500">
            Pools del radar
          </span>
          <Bar v={bt.hitRate} color="#2de0c0" />
          <span className="tick-num w-[42px] shrink-0 text-right font-mono text-[10px] font-bold text-long-300">
            {pct(bt.hitRate)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[130px] shrink-0 font-mono text-[8.5px] uppercase tracking-wider text-mist-500">
            Controles al azar
          </span>
          <Bar v={bt.controlHitRate} color="#5f7396" />
          <span className="tick-num w-[42px] shrink-0 text-right font-mono text-[10px] font-bold text-mist-400">
            {pct(bt.controlHitRate)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[130px] shrink-0 font-mono text-[8.5px] uppercase tracking-wider text-mist-500">
            Margen (edge)
          </span>
          <span
            className={`tick-num font-mono text-[10px] font-bold ${
              Number.isFinite(bt.margin) ? (bt.margin >= 0 ? "text-long-300" : "text-short-300") : "text-mist-500"
            }`}
          >
            {Number.isFinite(bt.margin) ? `${bt.margin >= 0 ? "+" : ""}${bt.margin.toFixed(0)} pts` : "—"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 font-mono text-[9px] sm:grid-cols-4 lg:col-span-4 lg:grid-cols-2">
        <div>
          <div className="text-[7.5px] uppercase tracking-widest text-mist-600">Pools probados</div>
          <div className="tick-num text-[12px] font-bold text-mist-200">{bt.tested}</div>
        </div>
        <div>
          <div className="text-[7.5px] uppercase tracking-widest text-mist-600">Barridos</div>
          <div className="tick-num text-[12px] font-bold text-flare-300">{bt.swept}</div>
        </div>
        <div>
          <div className="text-[7.5px] uppercase tracking-widest text-mist-600">Tasa de reversión</div>
          <div className="tick-num text-[12px] font-bold text-mist-200">{pct(bt.reversalRate)}</div>
        </div>
        <div>
          <div className="text-[7.5px] uppercase tracking-widest text-mist-600">Puntos de detección</div>
          <div className="tick-num text-[12px] font-bold text-mist-200">{bt.steps}</div>
        </div>
      </div>
    </div>
  );
}
