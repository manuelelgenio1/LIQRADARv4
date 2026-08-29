import type { MarketState } from "../lib/market";
import type { LongShortRatio } from "../lib/live";
import { fmtCountdown, fmtPct, fmtUsd } from "../lib/format";

export function FundingOIPanel({ state, sentiment }: { state: MarketState; sentiment: LongShortRatio | null }) {
  // si hay datos reales de Binance se muestran; si no, el valor del modelo
  const real = sentiment != null;
  const ls = real ? sentiment.ratio : state.longShortRatio;
  const longPct = real ? sentiment.longPct : (ls / (1 + ls)) * 100;

  return (
    <section className="panel anim-reveal" style={{ animationDelay: "0.3s" }}>
      <header className="flex items-center justify-between border-b border-ink-700/50 px-4 py-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">Funding & OI</h2>
        <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">perpetuo</span>
      </header>

      <div className="grid grid-cols-2 divide-x divide-ink-700/50">
        <div className="px-4 py-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">Funding rate</div>
          <div className={`tick-num mt-1 font-display text-2xl font-bold ${state.funding >= 0 ? "text-long-300" : "text-short-300"}`}>
            {fmtPct(state.funding, 4)}
          </div>
          <div className="mt-1 font-mono text-[9px] text-mist-600">
            {state.funding >= 0 ? "longs pagan a shorts" : "shorts pagan a longs"}
          </div>
        </div>
        <div className="px-4 py-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">Próximo funding</div>
          <div className="tick-num mt-1 font-display text-2xl font-bold text-mist-200">{fmtCountdown(state.fundingNextMs)}</div>
          <div className="mt-1 flex items-center gap-1 font-mono text-[9px] text-mist-600">
            <svg width="9" height="9" viewBox="0 0 12 12" className="text-flare-400">
              <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 3v3l2 1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
            intervalo 8h
          </div>
        </div>
      </div>

      <div className="border-t border-ink-700/50 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">Open interest</span>
          <span className={`tick-num font-mono text-[10px] font-semibold ${state.oiDelta1h >= 0 ? "text-long-300" : "text-short-300"}`}>
            {fmtPct(state.oiDelta1h)} 1h
          </span>
        </div>
        <div className="tick-num mt-1 font-display text-xl font-bold text-mist-100">{fmtUsd(state.oi, 2)}</div>
        <div className="mt-2 h-1.5 overflow-hidden bg-ink-800">
          <div
            className={`h-full transition-all duration-700 ${state.oiDelta1h >= 0 ? "bg-long-400" : "bg-short-400"}`}
            style={{ width: `${Math.max(4, Math.min(100, 50 + state.oiDelta1h * 14))}%`, opacity: 0.85 }}
          />
        </div>

        <div className="mt-3 flex items-baseline justify-between">
          <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">
            Ratio long/short
            <span
              className={`border px-1 py-px text-[7.5px] font-bold ${
                real
                  ? "border-long-500/40 bg-long-900/50 text-long-300"
                  : "border-ink-600 bg-ink-800 text-mist-500"
              }`}
            >
              {real ? "REAL" : "MODELO"}
            </span>
          </span>
          <span className="tick-num font-mono text-[10px] font-semibold text-mist-300">{ls.toFixed(2)}</span>
        </div>
        <div className="mt-1.5 flex h-2 overflow-hidden bg-ink-800">
          <div className="h-full bg-long-400/85 transition-all duration-700" style={{ width: `${longPct}%` }} />
          <div className="h-full flex-1 bg-short-400/85" />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[8.5px] uppercase tracking-widest">
          <span className="text-long-300">longs {longPct.toFixed(0)}%</span>
          <span className="text-short-300">shorts {(100 - longPct).toFixed(0)}%</span>
        </div>

        {real && (
          <div className="mt-2.5 flex items-baseline justify-between border-t border-ink-700/40 pt-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">Top traders (posiciones)</span>
            <span
              className={`tick-num font-mono text-[10px] font-bold ${
                sentiment.topRatio >= 1 ? "text-long-300" : "text-short-300"
              }`}
            >
              {sentiment.topRatio.toFixed(2)} {sentiment.topRatio >= 1 ? "↑ long" : "↓ short"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

export function DataQualityPanel({ state }: { state: MarketState }) {
  const lat = state.latency;
  const cur = lat[lat.length - 1];
  const max = Math.max(...lat, 60);
  const pts = lat.map((v, i) => `${(i / (lat.length - 1)) * 100},${34 - (v / max) * 30}`).join(" ");
  const status = cur < 35 ? { t: "ÓPTIMA", c: "text-long-300 border-long-500/40 bg-long-900/40" }
    : cur < 70 ? { t: "ESTABLE", c: "text-flare-300 border-flare-400/40 bg-flare-400/10" }
    : { t: "DEGRADADA", c: "text-short-300 border-short-500/40 bg-short-900/50" };

  return (
    <section className="panel anim-reveal flex flex-1 flex-col" style={{ animationDelay: "0.36s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">Calidad de datos</h2>
        <span className={`ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${status.c}`}>
          {status.t}
        </span>
      </header>

      <div className="flex items-center gap-4 px-4 py-3">
        <div className="flex-1">
          <div className="mb-1 flex justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">
            <span>Latencia ws</span>
            <span className={`tick-num font-bold ${cur < 35 ? "text-long-300" : "text-flare-300"}`}>{cur.toFixed(0)} ms</span>
          </div>
          <svg viewBox="0 0 100 36" className="h-10 w-full" preserveAspectRatio="none">
            <polyline points={pts} fill="none" stroke={cur < 35 ? "#2de0c0" : "#ffb224"} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
            <polygon points={`0,36 ${pts} 100,36`} fill={cur < 35 ? "rgba(45,224,192,0.12)" : "rgba(255,178,36,0.12)"} />
          </svg>
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-ink-700/50 border-t border-ink-700/50">
        <div className="px-3 py-2.5 text-center">
          <div className="tick-num font-display text-base font-bold text-mist-200">{state.msgsPerSec.toFixed(0)}</div>
          <div className="mt-0.5 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">msg/seg</div>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="tick-num font-display text-base font-bold text-mist-200">{state.uptimePct.toFixed(2)}%</div>
          <div className="mt-0.5 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">uptime</div>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="tick-num font-display text-base font-bold text-mist-200">3/3</div>
          <div className="mt-0.5 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">exchanges</div>
        </div>
      </div>

      <div className="flex gap-1.5 border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5">
        {["Binance", "Bybit", "OKX"].map((ex, i) => (
          <span key={ex} className="flex items-center gap-1.5 border border-ink-700 bg-ink-850 px-2 py-1 font-mono text-[8.5px] uppercase tracking-wider text-mist-400">
            <span className="h-1.5 w-1.5 rounded-full bg-long-400" style={{ animation: `liveBlink 1.8s ease-out ${i * 0.4}s infinite` }} />
            {ex}
          </span>
        ))}
      </div>
    </section>
  );
}
