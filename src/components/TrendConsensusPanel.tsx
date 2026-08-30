import type { MarketState } from "../lib/market";
import {
  adxThrOf,
  mtfAdjust,
  type IndicatorBundle,
  type IndicatorCfg,
  type TrendDir,
} from "../lib/indicators";

interface Props {
  state: MarketState;
  tfKey: string;
  ind: IndicatorBundle;   // calculado UNA vez en el Dashboard (hook compartido)
  cfg: IndicatorCfg;
  calibration?: { stAdj: number; adxThr: number };
  setCalibration?: (c: { stAdj: number; adxThr: number }) => void;
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
}

const DIR_META: Record<TrendDir, { label: string; c: string; bar: string; chip: string }> = {
  alcista: { label: "Alcista", c: "text-long-300", bar: "#2de0c0", chip: "border-long-500/40 bg-long-900/50 text-long-300" },
  bajista: { label: "Bajista", c: "text-short-300", bar: "#ff5d7e", chip: "border-short-500/40 bg-short-900/50 text-short-300" },
  lateral: { label: "Lateral", c: "text-flare-300", bar: "#ffb224", chip: "border-flare-400/40 bg-flare-400/10 text-flare-300" },
};

// punto sobre el arco del gauge: ángulo en grados (0 = arriba, ±90 = extremos)
function pt(a: number, r: number, cx: number, cy: number): string {
  const rad = (a * Math.PI) / 180;
  return `${(cx + r * Math.sin(rad)).toFixed(2)},${(cy - r * Math.cos(rad)).toFixed(2)}`;
}
function arc(a1: number, a2: number, r: number, cx: number, cy: number): string {
  return `M ${pt(a1, r, cx, cy)} A ${r} ${r} 0 0 1 ${pt(a2, r, cx, cy)}`;
}

function DirArrow({ dir }: { dir: TrendDir }) {
  if (dir === "lateral")
    return (
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
        <path d="M4 12 H20" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
      {dir === "alcista" ? <path d="M12 4 L21 18 H3 Z" /> : <path d="M12 20 L3 6 H21 Z" />}
    </svg>
  );
}

export default function TrendConsensusPanel({ state, tfKey, ind, cfg, calibration, setCalibration, confluence }: Props) {
  const cons = ind.consensus;
  const mtf = mtfAdjust(cons, confluence);
  const meta = DIR_META[cons.dir];
  const angle = cons.score * 82;
  const bullishVotes = cons.votes.filter((v) => v.dir === "alcista").length;
  const bearishVotes = cons.votes.filter((v) => v.dir === "bajista").length;

  // ---- lecturas de precisión ----
  const adxNow = ind.adx[ind.adx.length - 1] ?? 0;
  const thr = adxThrOf(cfg);
  const regime = adxNow >= thr ? "TENDENCIA" : "RANGO";
  // giros de Supertrend confirmados en las últimas 60 velas
  let flips = 0;
  for (let i = Math.max(1, ind.stUpConf.length - 60); i < ind.stUpConf.length; i++) {
    if (ind.stUpConf[i] !== ind.stUpConf[i - 1]) flips++;
  }
  const seeded = !!state.warm && state.warm.length >= state.candles.length;
  const seedLen = seeded ? (state.warm as { length: number }).length : state.candles.length;

  const stAdj = calibration?.stAdj ?? 0;
  const adxThr = calibration?.adxThr ?? 25;
  const isDefault = stAdj === 0 && adxThr === 25;

  return (
    <section className="panel panel-corner anim-reveal flex h-full flex-col" style={{ animationDelay: "0.54s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Consenso de tendencia
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            5 indicadores · {tfKey} · calibrado
          </p>
        </div>
        <span className={`ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${meta.chip}`}>
          {bullishVotes}↑ · {bearishVotes}↓
        </span>
      </header>

      <div className="flex items-center gap-5 px-4 py-4">
        {/* gauge semicircular */}
        <svg viewBox="0 0 180 104" className="w-[46%] max-w-[190px] shrink-0">
          <path d={arc(-90, -22, 66, 90, 88)} stroke="rgba(255,93,126,0.5)" strokeWidth="9" fill="none" />
          <path d={arc(-22, 22, 66, 90, 88)} stroke="#253650" strokeWidth="9" fill="none" />
          <path d={arc(22, 90, 66, 90, 88)} stroke="rgba(45,224,192,0.55)" strokeWidth="9" fill="none" />
          {[-90, -45, 0, 45, 90].map((a) => (
            <line
              key={a}
              x1={pt(a, 74, 90, 88).split(",")[0]}
              y1={pt(a, 74, 90, 88).split(",")[1]}
              x2={pt(a, 80, 90, 88).split(",")[0]}
              y2={pt(a, 80, 90, 88).split(",")[1]}
              stroke="#48597a"
              strokeWidth="1.5"
            />
          ))}
          <text x="16" y="102" fill="#ff5d7e" fontSize="8" fontFamily="IBM Plex Mono, monospace">BAJISTA</text>
          <text x="128" y="102" fill="#2de0c0" fontSize="8" fontFamily="IBM Plex Mono, monospace">ALCISTA</text>
          <g
            style={{
              transform: `rotate(${angle}deg)`,
              transformOrigin: "90px 88px",
              transition: "transform 0.9s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            <line x1="90" y1="88" x2="90" y2="34" stroke="#dbe6f7" strokeWidth="2.4" strokeLinecap="round" />
          </g>
          <circle cx="90" cy="88" r="5" fill="#dbe6f7" />
          <circle cx="90" cy="88" r="9" fill="none" stroke="rgba(219,230,247,0.35)" strokeWidth="1" />
        </svg>

        {/* veredicto */}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-mist-600">veredicto del radar</div>
          <div className={`mt-1 flex items-center gap-2 font-display text-[26px] font-bold uppercase leading-none tracking-wider ${meta.c}`}>
            <DirArrow dir={cons.dir} />
            {meta.label}
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="tick-num font-display text-lg font-bold text-mist-100">
              {Math.round(mtf.strength * 100)}%
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">convicción</span>
            <span className={`tick-num ml-auto font-mono text-[11px] font-semibold ${meta.c}`}>
              {cons.score >= 0 ? "+" : ""}{cons.score.toFixed(2)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden bg-ink-800">
            <div
              className="h-full transition-all duration-700"
              style={{ width: `${Math.round(mtf.strength * 100)}%`, background: meta.bar }}
            />
          </div>
        </div>
      </div>

      {/* votos de cada indicador */}
      <div className="flex-1 border-t border-ink-700/50">
        {cons.votes.map((v) => {
          const vm = DIR_META[v.dir];
          return (
            <div
              key={v.name}
              className="group flex items-center gap-3 border-b border-ink-700/25 px-4 py-[7px] transition-colors last:border-b-0 hover:bg-ink-750/50"
            >
              <span className="w-[86px] shrink-0 font-mono text-[10px] font-semibold text-mist-300">{v.name}</span>
              <span className="w-[84px] shrink-0 font-mono text-[8.5px] uppercase tracking-wider text-mist-600">{v.note}</span>
              <span className={`flex w-[72px] shrink-0 items-center justify-center gap-1 border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider ${vm.chip}`}>
                <DirArrow dir={v.dir} />
                {vm.label}
              </span>
              <div className="h-1 flex-1 overflow-hidden bg-ink-800">
                <div
                  className="h-full transition-all duration-700"
                  style={{ width: `${Math.max(4, Math.round(v.strength * 100))}%`, background: vm.bar, opacity: 0.85 }}
                />
              </div>
              <span className="tick-num w-[30px] shrink-0 text-right font-mono text-[9px] text-mist-500">
                {Math.round(v.strength * 100)}
              </span>
            </div>
          );
        })}
      </div>

      {/* ---- franja de precisión ---- */}
      <div className="grid grid-cols-2 divide-x divide-ink-700/50 border-t border-ink-700/50 bg-ink-900/40 sm:grid-cols-4">
        <div className="px-3 py-2.5">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">Régimen ADX</div>
          <div className={`mt-1 font-display text-[13px] font-bold ${adxNow >= thr ? "text-flare-300" : "text-mist-400"}`}>
            {regime} <span className="tick-num font-mono text-[10px] text-mist-500">{adxNow.toFixed(0)}/{thr}</span>
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">Giros ST conf.</div>
          <div className="tick-num mt-1 font-display text-[13px] font-bold text-mist-200">
            {flips} <span className="font-mono text-[10px] font-medium text-mist-500">/ 60 velas</span>
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">Semilla ind.</div>
          <div className={`tick-num mt-1 font-display text-[13px] font-bold ${seeded ? "text-long-300" : "text-mist-400"}`}>
            {seedLen} <span className="font-mono text-[10px] font-medium text-mist-500">velas</span>
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">Confluencia MTF</div>
          <div className="mt-1.5 flex items-center gap-1">
            {(confluence ?? []).map((c) => (
              <span
                key={c.tf}
                title={`${c.tf}: ${c.dir}`}
                className={`h-2.5 w-2.5 rounded-full border ${
                  c.dir === "alcista"
                    ? "border-long-400 bg-long-400/80"
                    : c.dir === "bajista"
                      ? "border-short-400 bg-short-400/80"
                      : "border-mist-500 bg-transparent"
                }`}
              />
            ))}
            <span className="tick-num ml-1 font-mono text-[10px] font-semibold text-mist-400">
              {mtf.total != null ? `${mtf.agree}/${mtf.total}` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* ---- calibración fina ---- */}
      {setCalibration && (
        <div className="border-t border-ink-700/50 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-mist-400">
              Calibración fina
            </span>
            <button
              onClick={() => setCalibration({ stAdj: 0, adxThr: 25 })}
              disabled={isDefault}
              className={`border px-2 py-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-wider transition-all ${
                isDefault
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
              <input
                type="range"
                min={-0.4}
                max={0.6}
                step={0.05}
                value={stAdj}
                onChange={(e) => setCalibration({ stAdj: Number(e.target.value), adxThr })}
                className="mt-1 w-full accent-long-400"
              />
              <span className="mt-0.5 block font-mono text-[8px] text-mist-600">
                ↑ menos giros (más fiable) · ↓ más giros (más sensible)
              </span>
            </label>
            <label className="block">
              <span className="flex justify-between font-mono text-[8.5px] uppercase tracking-wider text-mist-600">
                <span>Umbral ADX</span>
                <span className="tick-num font-bold text-flare-300">{adxThr}</span>
              </span>
              <input
                type="range"
                min={15}
                max={35}
                step={1}
                value={adxThr}
                onChange={(e) => setCalibration({ stAdj, adxThr: Number(e.target.value) })}
                className="mt-1 w-full accent-flare-400"
              />
              <span className="mt-0.5 block font-mono text-[8px] text-mist-600">
                ↑ exige tendencias más fuertes · ↓ acepta más señales
              </span>
            </label>
          </div>
        </div>
      )}

      <footer className="border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5">
        <p className="font-mono text-[9px] leading-relaxed text-mist-600">
          <span className="text-flare-300">◈</span> Precisión: semilla extendida de {seedLen} velas, giros de Supertrend
          confirmados y consenso ponderado por la confluencia multi-timeframe. El ADX veta mercados en rango (&lt;{thr}).
        </p>
      </footer>
    </section>
  );
}
