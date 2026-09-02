import type { TrendDir } from "../lib/indicators";
import type { MarketKind } from "../lib/live";

interface Props {
  confluence: { tf: string; dir: TrendDir; strength: number }[] | null;
  symbol: string;
  activeTf: string;
  updatedAt?: number;
  market?: MarketKind;
  error?: boolean;
}

const DIR_META: Record<TrendDir, { label: string; dot: string; text: string; arrow: string }> = {
  alcista: { label: "ALCISTA", dot: "bg-long-400", text: "text-long-300", arrow: "▲" },
  bajista: { label: "BAJISTA", dot: "bg-short-400", text: "text-short-300", arrow: "▼" },
  lateral: { label: "LATERAL", dot: "bg-mist-500", text: "text-mist-400", arrow: "—" },
};

export default function ConfluenceStrip({ confluence, symbol, activeTf, market = "perp", error = false }: Props) {
  const aligned =
    confluence && confluence.length >= 4
      ? (() => {
          const dirs = confluence.filter((c) => c.dir !== "lateral");
          if (!dirs.length) return null;
          const first = dirs[0].dir;
          return dirs.every((c) => c.dir === first) ? first : null;
        })()
      : null;
  const ups = confluence?.filter((c) => c.dir === "alcista").length ?? 0;
  const downs = confluence?.filter((c) => c.dir === "bajista").length ?? 0;
  const flats = confluence?.filter((c) => c.dir === "lateral").length ?? 0;

  return (
    <section className="panel anim-reveal" style={{ animationDelay: "0.02s" }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8fa3c4" strokeWidth="2" strokeLinecap="round">
            <path d="M3 17l5-5 4 4 7-8" />
            <path d="M14 8h5v5" />
          </svg>
          <span className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-mist-300">Confluencia multi-TF</span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">{symbol}</span>
          <span
            className={`border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-widest ${
              market === "perp" ? "border-long-500/40 bg-long-900/40 text-long-300" : "border-mist-500/40 bg-ink-800 text-mist-400"
            }`}
            title={market === "perp" ? "Tendencias sobre velas del PERPETUO de Binance Futuros" : "Tendencias sobre velas del mercado SPOT"}
          >
            {market}
          </span>
        </div>

        {!confluence && (
          <span className={`font-mono text-[9.5px] uppercase tracking-widest ${error ? "text-flare-300" : "text-mist-600"}`}>
            {error ? "tendencias no disponibles · reintentando" : "cargando tendencias…"}
          </span>
        )}

        {confluence && (
          <div className="flex flex-1 flex-wrap items-center gap-2">
            {confluence.map((c) => {
              const m = DIR_META[c.dir];
              const isActive = c.tf === activeTf;
              return (
                <div
                  key={c.tf}
                  className={`flex items-center gap-2 border px-2.5 py-1.5 transition-all duration-300 ${
                    isActive ? "border-flare-400/50 bg-flare-400/10 shadow-[0_0_12px_rgba(255,178,36,0.15)]" : "border-ink-700 bg-ink-850/80"
                  }`}
                  title={`${c.tf}${isActive ? " (temporalidad activa)" : ""}: ${m.label} · fuerza ${(c.strength * 100).toFixed(0)}%`}
                >
                  <span className={`font-mono text-[10px] font-bold ${isActive ? "text-flare-300" : "text-mist-300"}`}>
                    {c.tf}
                    {isActive && <span className="ml-1 text-[7px]">●</span>}
                  </span>
                  <span className={`h-2 w-2 rounded-full ${m.dot}`} />
                  <span className={`font-mono text-[8.5px] font-bold uppercase tracking-wider ${m.text}`}>{m.arrow} {m.label}</span>
                </div>
              );
            })}
          </div>
        )}

        {confluence && (
          <div
            className={`flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${
              aligned === "alcista"
                ? "border-long-500/50 bg-long-900/40 text-long-300"
                : aligned === "bajista"
                  ? "border-short-500/50 bg-short-900/40 text-short-300"
                  : "border-ink-600 bg-ink-800 text-mist-400"
            }`}
            title="Se declara alineación cuando ≥4 temporalidades direccionales coinciden"
          >
            <span
              className={`h-2 w-2 rounded-full ${aligned === "alcista" ? "bg-long-400" : aligned === "bajista" ? "bg-short-400" : "bg-mist-500"}`}
              style={aligned ? { animation: "liveBlink 1.6s ease-out infinite" } : undefined}
            />
            {aligned ? `alineado ${aligned}` : "sin alineación"}
            <span className="ml-1 font-normal normal-case tracking-normal text-mist-500">
              ▲{ups} ▼{downs} —{flats}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
