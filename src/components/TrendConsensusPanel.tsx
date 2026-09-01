import type { MarketState } from "../lib/market";
import type { IndicatorBundle, IndicatorCfg, TrendDir } from "../lib/indicators";
import { adxThrOf } from "../lib/indicators";
import type { MarketKind } from "../lib/live";
import type { Calibration } from "../hooks/useIndicators";
import { fmtPct } from "../lib/format";
import { MeterBar } from "./MeterBar";

interface Props {
  state: MarketState;
  tfKey: string;
  ind: IndicatorBundle;
  cfg: IndicatorCfg;
  calibration: Calibration;
  setCalibration: (c: Calibration) => void;
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
  market?: MarketKind;
}

const DIR_META: Record<TrendDir, { label: string; c: string; bar: string }> = {
  alcista: { label: "Alcista", c: "border-long-500/50 bg-long-900/40 text-long-300", bar: "#2de0c0" },
  bajista: { label: "Bajista", c: "border-short-500/50 bg-short-900/40 text-short-300", bar: "#ff5d7e" },
  lateral: { label: "Lateral", c: "border-flare-400/50 bg-flare-400/10 text-flare-300", bar: "#ffb224" },
};

function DirArrow({ dir }: { dir: TrendDir }) {
  if (dir === "lateral")
    return <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M4 12 H20" strokeLinecap="round" /></svg>;
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
      {dir === "alcista" ? <path d="M12 4 L21 18 H3 Z" /> : <path d="M12 20 L3 6 H21 Z" />}
    </svg>
  );
}

export default function TrendConsensusPanel({ state, tfKey, ind, cfg, calibration, setCalibration, confluence, market = "perp" }: Props) {
  const cons = ind.consensus;
  const meta = DIR_META[cons.dir];
  const bullishVotes = cons.votes.filter((v) => v.dir === "alcista").length;
  const bearishVotes = cons.votes.filter((v) => v.dir === "bajista").length;
  const angle = cons.score * 82;
  const thr = adxThrOf(cfg);
  const adxNow = ind.adx[ind.adx.length - 1] ?? 0;
  const dirs = (confluence ?? []).filter((c) => c.dir !== "lateral");
  const mtfAgree = dirs.length ? dirs.filter((c) => c.dir === cons.dir).length : null;

  const close = state.candles[state.candles.length - 1]?.c ?? 0;
  const VALUE_OF: Record<string, string> = {
    "Cruce EMA": `Δ ${fmtPct(((ind.emaFast[ind.emaFast.length - 1] - ind.emaSlow[ind.emaSlow.length - 1]) / (ind.emaSlow[ind.emaSlow.length - 1] || 1)) * 100, 2)}`,
    "MACD": `hist ${(ind.hist[ind.hist.length - 1] ?? 0).toFixed(2)}`,
    "RSI": `rsi ${(ind.rsi[ind.rsi.length - 1] ?? 50).toFixed(0)}`,
    "Supertrend": `${(((close - ind.st[ind.st.length - 1]) / (close || 1)) * 100).toFixed(1)}% del ST`,
    "ADX": `+DI ${(ind.pdi[ind.pdi.length - 1] ?? 0).toFixed(0)} / −DI ${(ind.mdi[ind.mdi.length - 1] ?? 0).toFixed(0)}`,
  };

  return (
    <section className="panel panel-corner anim-reveal flex h-full flex-col" style={{ animationDelay: "0.16s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">Consenso de tendencia</h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            5 indicadores · {tfKey} · {market === "perp" ? "futuros" : "spot"} · calibrado
          </p>
        </div>
        <span className={`ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${meta.c}`}>
          {bullishVotes}↑ · {bearishVotes}↓
        </span>
      </header>

      <div className="flex items-center gap-5 px-4 py-4">
        <svg viewBox="0 0 180 104" className="w-[46%] max-w-[190px] shrink-0">
          <circle cx="90" cy="88" r="52"
            fill={cons.dir === "alcista" ? "rgba(45,224,192,0.10)" : cons.dir === "bajista" ? "rgba(255,93,126,0.10)" : "rgba(95,115,150,0.07)"}
            style={{ opacity: 0.25 + cons.strength * 0.75, transition: "opacity 0.9s ease, fill 0.9s ease" }} />
          <path d="M 90 22 A 66 66 0 0 1 156 88" stroke="rgba(45,224,192,0.55)" strokeWidth="9" fill="none" strokeLinecap="round" />
          <path d="M 24 88 A 66 66 0 0 1 90 22" stroke="rgba(255,93,126,0.5)" strokeWidth="9" fill="none" strokeLinecap="round" />
          <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: "90px 88px", transition: "transform 0.9s cubic-bezier(0.22, 1, 0.36, 1)" }}>
            <line x1="90" y1="88" x2="90" y2="34"
              stroke={cons.score > 0.05 ? "#7df0da" : cons.score < -0.05 ? "#ff93a9" : "#dbe6f7"}
              strokeWidth="2.4" strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 ${2 + cons.strength * 5}px ${cons.score > 0.05 ? "rgba(45,224,192,0.8)" : cons.score < -0.05 ? "rgba(255,93,126,0.8)" : "rgba(219,230,247,0.5)"})`, transition: "stroke 0.9s ease, filter 0.9s ease" }} />
          </g>
          <circle cx="90" cy="88" r="5" fill="#dbe6f7" />
          <text x="16" y="102" fill="#ff5d7e" fontSize="8" fontFamily="IBM Plex Mono, monospace">BAJ</text>
          <text x="146" y="102" fill="#2de0c0" fontSize="8" fontFamily="IBM Plex Mono, monospace">ALC</text>
        </svg>

        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-mist-600">veredicto del radar</div>
          <div key={cons.dir} className={`anim-feed-in mt-1 flex items-center gap-2 font-display text-[24px] font-bold uppercase leading-none tracking-wider ${meta.c.split(" ").pop()}`}>
            <DirArrow dir={cons.dir} />
            {meta.label}
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="tick-num font-display text-lg font-bold text-mist-100 transition-all duration-700"
              style={cons.strength > 0.5 ? { textShadow: "0 0 12px rgba(255,178,36,0.55)" } : undefined}>
              {Math.round(cons.strength * 100)}%
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">convicción</span>
            <span className={`tick-num ml-auto font-mono text-[11px] font-semibold ${cons.score >= 0 ? "text-long-300" : "text-short-300"}`}>
              {cons.score >= 0 ? "+" : ""}{cons.score.toFixed(2)}
            </span>
          </div>
          {mtfAgree !== null && (
            <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
              {mtfAgree === dirs.length && (
                <span className="h-1.5 w-1.5 rounded-full bg-flare-400" style={{ animation: "liveBlink 1.6s ease-out infinite" }} />
              )}
              confluencia MTF <b className="text-mist-300">{mtfAgree}/{dirs.length}</b> coinciden
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 border-t border-ink-700/50">
        {cons.votes.map((v, i) => {
          const vm = DIR_META[v.dir];
          return (
            <div key={v.name} className="anim-feed-in group flex items-center gap-3 border-b border-ink-700/25 px-4 py-[7px] transition-colors last:border-b-0 hover:bg-ink-750/50"
              style={{ animationDelay: `${i * 50}ms` }} title={`${v.note} · peso ×${v.weight}`}>
              <span className="w-[86px] shrink-0 font-mono text-[10px] font-semibold text-mist-300 transition-colors group-hover:text-mist-100">{v.name}</span>
              <span className="tick-num w-[92px] shrink-0 truncate font-mono text-[8.5px] text-mist-500 transition-colors group-hover:text-mist-300">{VALUE_OF[v.name] ?? v.note}</span>
              <span className={`flex w-[72px] shrink-0 items-center justify-center gap-1 border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider transition-transform duration-200 group-hover:scale-105 ${vm.c}`}>
                <DirArrow dir={v.dir} />
                {vm.label}
              </span>
              <MeterBar v={v.strength} color={vm.bar} height={4} minPct={4} track="bg-ink-800" />
              <span className="tick-num w-[30px] shrink-0 text-right font-mono text-[9px] text-mist-500 transition-colors group-hover:text-mist-200">
                {Math.round(v.strength * 100)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 divide-x divide-ink-700/50 border-t border-ink-700/50 bg-ink-900/40">
        <div className="group px-3 py-2.5 transition-colors hover:bg-ink-800/50">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">Régimen ADX</div>
          <div className={`mt-1 font-display text-[13px] font-bold ${adxNow >= thr ? "text-flare-300" : "text-mist-400"}`}>
            {adxNow >= thr ? "TENDENCIA" : "RANGO"} <span className="tick-num font-mono text-[10px] text-mist-500">{adxNow.toFixed(0)}/{thr}</span>
          </div>
        </div>
        <div className="group px-3 py-2.5 transition-colors hover:bg-ink-800/50">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">Semilla ind.</div>
          <div className="tick-num mt-1 font-display text-[13px] font-bold text-long-300">
            {(state.warm && state.warm.length >= 128 ? state.warm.length : state.candles.length)} <span className="font-mono text-[10px] font-medium text-mist-500">velas</span>
          </div>
        </div>
      </div>

      <div className="border-t border-ink-700/50 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-mist-400">Calibración fina</span>
          <button
            onClick={() => setCalibration({ stAdj: 0, adxThr: 25 })}
            disabled={calibration.stAdj === 0 && calibration.adxThr === 25}
            className={`border px-2 py-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-wider transition-all ${
              calibration.stAdj === 0 && calibration.adxThr === 25
                ? "cursor-default border-ink-700 text-mist-600"
                : "border-flare-400/40 bg-flare-400/10 text-flare-300 hover:bg-flare-400/20"
            }`}
          >
            Restaurar
          </button>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <label className="block">
            <span className="flex justify-between font-mono text-[8.5px] uppercase tracking-wider text-mist-600">
              <span>Mult. Supertrend</span>
              <span className="tick-num font-bold text-long-300">{cfg.stMult.toFixed(2)}</span>
            </span>
            <input type="range" min={-0.4} max={0.6} step={0.05} value={calibration.stAdj}
              onChange={(e) => setCalibration({ stAdj: Number(e.target.value), adxThr: calibration.adxThr })}
              className="mt-1 w-full accent-long-400" />
            <span className="mt-0.5 block font-mono text-[8px] text-mist-600">↑ menos giros · ↓ más sensible</span>
          </label>
          <label className="block">
            <span className="flex justify-between font-mono text-[8.5px] uppercase tracking-wider text-mist-600">
              <span>Umbral ADX</span>
              <span className="tick-num font-bold text-flare-300">{calibration.adxThr}</span>
            </span>
            <input type="range" min={15} max={35} step={1} value={calibration.adxThr}
              onChange={(e) => setCalibration({ stAdj: calibration.stAdj, adxThr: Number(e.target.value) })}
              className="mt-1 w-full accent-flare-400" />
            <span className="mt-0.5 block font-mono text-[8px] text-mist-600">↑ exige tendencias más fuertes</span>
          </label>
        </div>
      </div>
    </section>
  );
}
