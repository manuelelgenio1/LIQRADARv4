import type { MarketState } from "../lib/market";
import type { IndicatorBundle, IndicatorCfg, TrendDir } from "../lib/indicators";
import { adxThrOf } from "../lib/indicators";
import { fmtPct, fmtPrice, fmtUsd } from "../lib/format";

interface Props {
  state: MarketState;
  ind: IndicatorBundle;
  cfg: IndicatorCfg;
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
  market?: "perp" | "spot";
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

export default function MarketMakerPanel({ state, ind, cfg, confluence, market = "perp" }: Props) {
  const cur = state.candles[state.candles.length - 1].c;
  const target = state.clusters[0];
  if (!target) return null;

  const span = state.pMax - state.pMin || 1;
  const distAbs = Math.abs(target.price - cur);
  const distPct = ((target.price - cur) / cur) * 100;
  const up = target.price > cur;
  const col = up ? "#ff5d7e" : "#2de0c0";

  // Fase RELATIVA al rango visible (no umbrales absolutos): escala con la temporalidad
  const rel = distAbs / span;
  const phase = rel < 0.12 ? 2 : rel < 0.35 ? 1 : 0;

  // ---- escalera de liquidez: los 7 clústeres más cercanos (ambos lados) ----
  const near = state.clusters.slice(0, 7);
  const rungs: Rung[] = near.map((c) => ({
    id: c.id,
    price: c.price,
    side: c.side,
    sizeUsd: c.sizeUsd,
    leverage: c.leverage,
    isTarget: c.id === target.id,
    isSpot: false,
  }));
  rungs.push({ id: "spot", price: cur, side: up ? "short" : "long", sizeUsd: 0, leverage: "", isTarget: false, isSpot: true });
  // ordenar por precio: arriba = más caro
  rungs.sort((a, b) => b.price - a.price);
  const hi = rungs[0].price;
  const lo = rungs[rungs.length - 1].price;
  const rungSpan = hi - lo || 1;
  // mapeo 4%..96% para que ningún peldaño se recorte en los bordes
  const posOf = (p: number) => 4 + ((hi - p) / rungSpan) * 92;

  // layout anti-solape: cada fila necesita ~9% de separación mínima; si los
  // precios están muy juntos, redistribuir uniformemente para que NUNCA se
  // pisen (los precios van etiquetados, así que no se pierde información).
  const layout = rungs.map((r) => ({ r, top: posOf(r.price) }));
  for (let i = 1; i < layout.length; i++) {
    if (layout[i].top < layout[i - 1].top + 9) layout[i].top = layout[i - 1].top + 9;
  }
  if (layout.length > 1 && layout[layout.length - 1].top > 96) {
    layout.forEach((l, i) => {
      l.top = 4 + (i * 92) / (layout.length - 1);
    });
  }
  const topOf = (id: string) => layout.find((l) => l.r.id === id)?.top ?? 50;

  // ---- factores de probabilidad (transparentes, derivados de datos reales) ----
  const thr = adxThrOf(cfg);
  const adxNow = ind.adx[ind.adx.length - 1] ?? 0;
  // 1 · fuerza del clúster objetivo (qué tan denso es el calor en ese nivel)
  const fClu = target.strength;
  // 2 · régimen ADX: una tendencia fuerte empuja el barrido; un rango lo frena
  const fAdx = adxNow >= thr ? Math.min(1, adxNow / 50) : (adxNow / thr) * 0.4;
  // 3 · confluencia MTF: cuántos TFs superiores apuntan en la dirección del barrido
  let fMtf: number | null = null;
  let mtfAgree = 0, mtfTotal = 0;
  if (confluence && confluence.length) {
    const want: TrendDir = up ? "alcista" : "bajista";
    const dirs = confluence.filter((c) => c.dir !== "lateral");
    mtfTotal = dirs.length;
    mtfAgree = dirs.filter((c) => c.dir === want).length;
    fMtf = mtfTotal > 0 ? mtfAgree / mtfTotal : null;
  }
  const factors: { label: string; v: number; bar: string; note: string }[] = [
    { label: "Fuerza del clúster", v: fClu, bar: col, note: "densidad de liquidez en el nivel objetivo" },
    { label: "Régimen ADX", v: fAdx, bar: "#ffb224", note: adxNow >= thr ? `tendencia fuerte (${adxNow.toFixed(0)})` : `rango (${adxNow.toFixed(0)})` },
    ...(fMtf != null
      ? [{ label: "Confluencia MTF", v: fMtf, bar: "#8fa3c4", note: `${mtfAgree}/${mtfTotal} TFs a favor` }]
      : []),
  ];
  // sesgo combinado (media simple, claramente etiquetado como derivado)
  const bias = factors.reduce((s, f) => s + f.v, 0) / factors.length;

  const spotTop = topOf("spot");
  const targetTop = topOf(target.id);

  return (
    <section className="panel panel-corner anim-reveal flex h-full flex-col" style={{ animationDelay: "0.42s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Market maker path
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: col, animation: "liveBlink 1.5s ease-out infinite" }}
            />
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            ruta de liquidez · objetivo = pool más cercano · {market === "perp" ? "futuros" : "spot"}
          </p>
        </div>
        <span
          className={`ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${
            market === "perp"
              ? "border-long-500/40 bg-long-900/40 text-long-300"
              : "border-mist-500/40 bg-ink-800 text-mist-400"
          }`}
          title={
            market === "perp"
              ? "Escalera y fases calculadas sobre el PERPETUO de Binance Futuros"
              : "Escalera y fases calculadas sobre el mercado SPOT"
          }
        >
          {market}
        </span>
        <span
          className="border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest"
          style={{ color: col, borderColor: `${col}66`, background: `${col}14` }}
        >
          {up ? "↑ barrido alto" : "↓ barrido bajo"}
        </span>
      </header>

      <div className="grid flex-1 grid-cols-[184px_1fr] gap-4 px-4 py-4">
        {/* ---- escalera de liquidez (posición real por precio) ---- */}
        <div className="relative min-h-[240px]">
          {/* carril vertical */}
          <div className="absolute left-[7px] top-0 h-full w-px bg-ink-700/70" />
          {/* trayectoria spot → objetivo */}
          <div
            className="absolute left-[7px] w-px"
            style={{
              top: `${Math.min(spotTop, targetTop)}%`,
              height: `${Math.abs(targetTop - spotTop)}%`,
              background: col,
              opacity: 0.8,
              backgroundImage: "repeating-linear-gradient(180deg, transparent, transparent 4px, rgba(7,12,22,0.9) 4px, rgba(7,12,22,0.9) 8px)",
              animation: "dashFlow 1.4s linear infinite",
            }}
          />
          {layout.map(({ r, top }) => {
            if (r.isSpot) {
              return (
                <div key={r.id} className="absolute left-0 right-0 -translate-y-1/2" style={{ top: `${top}%` }}>
                  <div className="flex items-center gap-2">
                    <span className="relative z-10 h-[15px] w-[15px] shrink-0 rounded-full border-2 border-mist-100 bg-ink-900">
                      <span className="absolute inset-[3px] animate-ping rounded-full bg-mist-100/60" />
                    </span>
                    <div className="flex min-w-0 items-baseline gap-1.5 border border-mist-200/40 bg-ink-800/90 px-1.5 py-0.5">
                      <span className="font-mono text-[7.5px] font-bold uppercase tracking-wider text-mist-400">spot</span>
                      <span className="tick-num truncate font-mono text-[10px] font-bold text-mist-100">
                        {fmtPrice(cur, state.meta.decimals)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            }
            const isL = r.side === "long";
            const c = isL ? "#2de0c0" : "#ff5d7e";
            return (
              <div key={r.id} className="absolute left-0 right-0 -translate-y-1/2" style={{ top: `${top}%` }}>
                <div className="group flex items-center gap-2">
                  <span
                    className="relative z-10 h-[9px] w-[9px] shrink-0 rounded-full transition-transform duration-200 group-hover:scale-125"
                    style={{
                      background: r.isTarget ? c : "rgba(37,54,80,0.9)",
                      border: `1.5px solid ${c}`,
                      boxShadow: r.isTarget ? `0 0 10px ${c}` : undefined,
                    }}
                  />
                  <div
                    className={`flex min-w-0 flex-1 items-baseline gap-1.5 border px-1.5 py-0.5 transition-all duration-200 group-hover:bg-ink-750/70 ${
                      r.isTarget ? "border-current/40" : "border-ink-700/60"
                    }`}
                    style={r.isTarget ? { borderColor: `${c}55`, background: `${c}0f` } : undefined}
                  >
                    <span className={`font-mono text-[7.5px] font-bold uppercase tracking-wider ${isL ? "text-long-300" : "text-short-300"}`}>
                      {r.leverage}
                    </span>
                    <span className={`tick-num truncate font-mono text-[9.5px] ${r.isTarget ? "font-bold text-mist-100" : "text-mist-300"}`}>
                      {fmtPrice(r.price, state.meta.decimals)}
                    </span>
                    <span className="tick-num ml-auto shrink-0 font-mono text-[8px] text-mist-500">{fmtUsd(r.sizeUsd)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- fases ---- */}
        <div className="flex flex-col justify-center gap-2.5">
          {PHASES.map((p, i) => {
            const active = i === phase;
            return (
              <div
                key={p.n}
                className={`border px-3 py-2 transition-all duration-500 ${
                  active ? "border-ink-600 bg-ink-800/80" : "border-ink-700/40 opacity-50"
                }`}
                style={active ? { boxShadow: `inset 3px 0 0 ${col}` } : undefined}
              >
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[9px] font-bold ${active ? "text-flare-300" : "text-mist-600"}`}>{p.n}</span>
                  <span className={`font-display text-[11px] font-bold uppercase tracking-wider ${active ? "text-mist-100" : "text-mist-500"}`}>
                    {p.t}
                  </span>
                  {active && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full" style={{ background: col, animation: "liveBlink 1.4s ease-out infinite" }} />
                  )}
                </div>
                {active && <p className="mt-1 font-mono text-[9px] leading-relaxed text-mist-500">{p.d}</p>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- factores de probabilidad (transparentes) ---- */}
      <div className="border-t border-ink-700/50 bg-ink-900/40 px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.18em] text-mist-400">
            Factores de probabilidad
          </span>
          <span className="font-mono text-[8px] uppercase tracking-wider text-mist-600" title="Media simple de los factores — orientación, no una certeza">
            sesgo derivado <b className="tick-num text-[10px]" style={{ color: col }}>{Math.round(bias * 100)}%</b>
          </span>
        </div>
        <div className="space-y-2">
          {factors.map((f) => (
            <div key={f.label} className="group" title={f.note}>
              <div className="mb-0.5 flex items-baseline justify-between">
                <span className="font-mono text-[8.5px] uppercase tracking-wider text-mist-500 transition-colors group-hover:text-mist-300">
                  {f.label}
                </span>
                <span className="tick-num font-mono text-[9px] font-semibold text-mist-300">{Math.round(f.v * 100)}%</span>
              </div>
              <div className="h-1 overflow-hidden bg-ink-800">
                <div
                  className="h-full transition-all duration-700"
                  style={{ width: `${Math.max(3, Math.round(f.v * 100))}%`, background: f.bar, opacity: 0.85 }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <footer className="grid grid-cols-3 divide-x divide-ink-700/50 border-t border-ink-700/50 bg-ink-900/50">
        <div className="px-3 py-2.5 text-center">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Objetivo</div>
          <div className="tick-num mt-0.5 font-mono text-[11px] font-bold text-mist-200">{fmtPrice(target.price, state.meta.decimals)}</div>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Distancia</div>
          <div className={`tick-num mt-0.5 font-mono text-[11px] font-bold ${up ? "text-short-300" : "text-long-300"}`}>{fmtPct(distPct)}</div>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Apalancamiento</div>
          <div className="tick-num mt-0.5 font-mono text-[11px] font-bold" style={{ color: col }}>{target.leverage}</div>
        </div>
      </footer>
    </section>
  );
}
