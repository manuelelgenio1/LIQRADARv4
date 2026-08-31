import { useEffect, useState } from "react";
import type { MarketState } from "../lib/market";
import type { IndicatorBundle, IndicatorCfg, TrendDir } from "../lib/indicators";
import { adxThrOf } from "../lib/indicators";
import type { MarketKind } from "../lib/live";
import { fmtPct, fmtPrice, fmtUsd } from "../lib/format";
import { MeterBar } from "./MeterBar";

interface Props {
  state: MarketState;
  ind: IndicatorBundle;
  cfg: IndicatorCfg;
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
  market?: MarketKind;
}

const PHASES = [
  { n: "01", t: "Acumulación", d: "El objetivo está lejos del precio: el mercado comprime y construye posición." },
  { n: "02", t: "Barrido", d: "El precio se acerca al clúster: stop-hunt en curso para capturar liquidez." },
  { n: "03", t: "Reversión", d: "Objetivo al alcance: la liquidez se captura y el precio tiende a revertir." },
];

interface Rung {
  id: string;
  price: number;
  side: "long" | "short";
  sizeUsd: number;
  leverage: string;
  isTarget: boolean;
  isSpot: boolean;
}

// Partícula que recorre la trayectoria spot → objetivo en su propio rAF.
function TravelerDot({ from, to, color, dur }: { from: number; to: number; color: string; dur: number }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const ms = Math.max(600, dur * 1000);
    const loop = (t: number) => {
      setP(((t - t0) % ms) / ms);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [dur]);
  const top = from + (to - from) * p;
  const fade = p > 0.94 ? (1 - p) / 0.06 : p < 0.06 ? p / 0.06 : 1;
  return (
    <span
      className="pointer-events-none absolute left-[7px] z-10 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{ top: `${top}%`, background: color, opacity: fade, boxShadow: `0 0 6px ${color}, 0 0 14px ${color}` }}
    />
  );
}

export default function MarketMakerPanel({ state, ind, cfg, confluence, market = "perp" }: Props) {
  const cur = state.candles[state.candles.length - 1].c;
  const target = state.clusters[0];
  if (!target) return null;

  const span = state.pMax - state.pMin || 1;
  const distAbs = Math.abs(target.price - cur);
  const distPct = ((target.price - cur) / cur) * 100;
  const up = target.price > cur;
  const col = up ? "#ff5d7e" : "#2de0c0";

  const rel = distAbs / span;
  const phase = rel < 0.12 ? 2 : rel < 0.35 ? 1 : 0;

  const rungs: Rung[] = state.clusters.slice(0, 7).map((c, i) => ({
    id: c.id, price: c.price, side: c.side, sizeUsd: c.sizeUsd, leverage: c.leverage,
    isTarget: i === 0, isSpot: false,
  }));
  rungs.push({ id: "spot", price: cur, side: target.side, sizeUsd: 0, leverage: "", isTarget: false, isSpot: true });
  rungs.sort((a, b) => b.price - a.price);

  const hi = rungs[0].price;
  const lo = rungs[rungs.length - 1].price;
  const rungSpan = hi - lo || 1;
  const posOf = (p: number) => 4 + ((hi - p) / rungSpan) * 92;

  const layout = new Map<string, number>();
  let prev = -Infinity;
  for (const r of rungs) {
    let pos = posOf(r.price);
    if (pos - prev < 9) pos = prev + 9;
    layout.set(r.id, pos);
    prev = pos;
  }
  if (prev > 96) {
    const n = rungs.length;
    rungs.forEach((r, i) => layout.set(r.id, 4 + (i * 92) / Math.max(1, n - 1)));
  }
  const topOf = (r: Rung) => layout.get(r.id) ?? posOf(r.price);

  const spotRung = rungs.find((r) => r.isSpot);
  const targetRung = rungs.find((r) => r.isTarget);
  const spotTop = spotRung ? topOf(spotRung) : 50;
  const targetTop = targetRung ? topOf(targetRung) : 50;

  const adxNow = ind.adx[ind.adx.length - 1] ?? 0;
  const thr = adxThrOf(cfg);
  const dirs = (confluence ?? []).filter((c) => c.dir !== "lateral");
  const ups = dirs.filter((c) => c.dir === "alcista").length;
  const mtfAlign = dirs.length ? (ups - (dirs.length - ups)) / dirs.length : 0;

  const factors = [
    { label: "Fuerza del clúster", v: target.strength, note: `Relativa al pico de calor del rango (${Math.round(target.strength * 100)}%)` },
    { label: "Régimen ADX", v: Math.min(1, adxNow / 50), note: adxNow >= thr ? `Tendencia fuerte (ADX ${adxNow.toFixed(0)} ≥ ${thr})` : `Rango (ADX ${adxNow.toFixed(0)} < ${thr})` },
    { label: "Confluencia MTF", v: Math.abs(mtfAlign), note: dirs.length ? `${ups}/${dirs.length} temporalidades alcistas` : "sin datos aún" },
  ];
  const derived = factors.reduce((s, f) => s + f.v, 0) / factors.length;
  const travelDur = 1.2 + rel * 3;

  return (
    <section className="panel panel-corner anim-reveal flex h-full flex-col" style={{ animationDelay: "0.42s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Market maker path
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: col, animation: "liveBlink 1.5s ease-out infinite" }} />
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            ruta de liquidez · objetivo = pool más cercano · {market === "perp" ? "futuros" : "spot"}
          </p>
        </div>
        <span key={up ? "u" : "d"}
          className="anim-feed-in ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest"
          style={{ color: col, borderColor: `${col}66`, background: `${col}14` }}>
          {up ? "↑ barrido alto" : "↓ barrido bajo"}
        </span>
      </header>

      <div className="grid flex-1 grid-cols-[184px_1fr] gap-4 px-4 py-4">
        <div className="relative min-h-[240px]">
          <div className="absolute left-[7px] top-0 h-full w-px bg-ink-700/70" />
          <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
            <line x1="7" y1={spotTop} x2="7" y2={targetTop}
              stroke={col} strokeWidth="0.8" strokeDasharray="2 2.5" vectorEffect="non-scaling-stroke"
              style={{ animation: "dashFlow 1.1s linear infinite", opacity: 0.9 }} />
          </svg>
          <TravelerDot from={spotTop} to={targetTop} color={col} dur={travelDur} />
          {rungs.map((r, idx) => {
            const top = topOf(r);
            if (r.isSpot) {
              return (
                <div key={r.id} className="anim-feed-in absolute left-0 flex w-full items-center gap-2" style={{ top: `${top}%`, transform: "translateY(-50%)", animationDelay: `${idx * 40}ms` }}>
                  <span className="relative h-[9px] w-[9px] shrink-0 rotate-45 border border-mist-200 bg-ink-900">
                    <span className="absolute inset-0 rotate-0 border border-mist-200/60" style={{ animation: "pingSlow 2s ease-out infinite" }} />
                  </span>
                  <div className="min-w-0 flex-1 border border-mist-500/40 bg-ink-800/90 px-2 py-1 transition-colors hover:border-mist-300/60">
                    <div className="font-mono text-[8px] font-bold uppercase tracking-wider text-mist-300">Spot</div>
                    <div className="tick-num font-mono text-[10px] font-semibold text-mist-100">{fmtPrice(r.price, state.meta.decimals)}</div>
                  </div>
                </div>
              );
            }
            const rc = r.side === "long" ? "#2de0c0" : "#ff5d7e";
            return (
              <div key={r.id} className="anim-feed-in absolute left-0 flex w-full items-center gap-2" style={{ top: `${top}%`, transform: "translateY(-50%)", animationDelay: `${idx * 40}ms` }}>
                <span className="h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: rc, boxShadow: r.isTarget ? `0 0 10px ${rc}` : "none", animation: r.isTarget ? "liveBlink 1.5s ease-out infinite" : "none" }} />
                <div className="min-w-0 flex-1 border px-2 py-1 transition-all duration-200 hover:brightness-125"
                  style={{ borderColor: r.isTarget ? `${rc}88` : "rgba(37,54,80,0.6)", background: r.isTarget ? `${rc}14` : "rgba(10,17,32,0.7)" }}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[8px] font-bold uppercase tracking-wider" style={{ color: rc }}>{r.leverage}</span>
                    {r.isTarget && (
                      <span className="border border-flare-400/50 bg-flare-400/10 px-1 font-mono text-[6.5px] font-bold uppercase tracking-wider text-flare-300">objetivo</span>
                    )}
                  </div>
                  <div className="tick-num font-mono text-[10px] font-semibold text-mist-200">{fmtPrice(r.price, state.meta.decimals)}</div>
                  <div className="tick-num font-mono text-[8px] text-mist-600">{fmtUsd(r.sizeUsd)}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-2.5">
          {PHASES.map((p, i) => {
            const active = i === phase;
            return (
              <div key={p.n}
                className={`border px-3 py-2 transition-all duration-500 ${active ? "border-ink-600 bg-ink-800/80" : "border-ink-700/40 opacity-55 hover:opacity-75"}`}
                style={active ? { boxShadow: `inset 3px 0 0 ${col}` } : undefined}>
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[9px] font-bold ${active ? "text-flare-300" : "text-mist-600"}`}>{p.n}</span>
                  <span className={`font-display text-[11px] font-bold uppercase tracking-wider ${active ? "text-mist-100" : "text-mist-500"}`}>{p.t}</span>
                  {active && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full" style={{ background: col, animation: "liveBlink 1.4s ease-out infinite" }} />
                  )}
                </div>
                {active && <p className="anim-feed-in mt-1 font-mono text-[9px] leading-relaxed text-mist-500">{p.d}</p>}
              </div>
            );
          })}

          <div className="mt-1 border border-ink-700/50 bg-ink-900/50 px-3 py-2">
            <div className="mb-1.5 font-mono text-[8px] font-bold uppercase tracking-[0.18em] text-mist-600">Factores de probabilidad</div>
            {factors.map((f, i) => (
              <div key={f.label}
                className="anim-feed-in -mx-1 mb-1 flex items-center gap-2 rounded-sm px-1 transition-colors last:mb-0 hover:bg-ink-800/40"
                style={{ animationDelay: `${i * 80}ms` }}
                title={f.note}>
                <span className="w-[104px] shrink-0 truncate font-mono text-[8px] uppercase tracking-wider text-mist-500 transition-colors group-hover:text-mist-300">{f.label}</span>
                <MeterBar v={f.v} color={col} />
                <span className="tick-num w-8 shrink-0 text-right font-mono text-[8.5px] font-semibold text-mist-300">{Math.round(f.v * 100)}</span>
              </div>
            ))}
            <div className="mt-1.5 border-t border-ink-700/40 pt-1.5 font-mono text-[8px] text-mist-600">
              Sesgo derivado <b className="tick-num text-mist-300">{Math.round(derived * 100)}%</b> — orientación, no certeza
            </div>
          </div>
        </div>
      </div>

      <footer className="grid grid-cols-3 divide-x divide-ink-700/50 border-t border-ink-700/50 bg-ink-900/50">
        <div className="px-3 py-2.5 text-center transition-colors duration-200 hover:bg-ink-800/60">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Objetivo</div>
          <div className="tick-num mt-0.5 font-mono text-[11px] font-bold text-mist-200">{fmtPrice(target.price, state.meta.decimals)}</div>
        </div>
        <div className="px-3 py-2.5 text-center transition-colors duration-200 hover:bg-ink-800/60">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Distancia</div>
          <div className={`tick-num mt-0.5 font-mono text-[11px] font-bold ${up ? "text-short-300" : "text-long-300"}`}>{fmtPct(distPct)}</div>
        </div>
        <div className="px-3 py-2.5 text-center transition-colors duration-200 hover:bg-ink-800/60">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Nocional*</div>
          <div className="tick-num mt-0.5 font-mono text-[11px] font-bold text-flare-300">{fmtUsd(target.sizeUsd)}</div>
        </div>
      </footer>
    </section>
  );
}
