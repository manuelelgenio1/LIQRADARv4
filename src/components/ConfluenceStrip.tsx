import type { TrendDir } from "../lib/indicators";
import { pctOf } from "../lib/format";

interface Props {
  confluence: { tf: string; dir: TrendDir; strength: number }[] | null;
  symbol: string;
  activeTf?: string;
}

const DIR_META: Record<TrendDir, { label: string; dot: string; text: string; bar: string }> = {
  alcista: { label: "ALCISTA", dot: "bg-long-400", text: "text-long-300", bar: "#2de0c0" },
  bajista: { label: "BAJISTA", dot: "bg-short-400", text: "text-short-300", bar: "#ff5d7e" },
  lateral: { label: "LATERAL", dot: "bg-mist-500", text: "text-mist-400", bar: "#5f7396" },
};

export default function ConfluenceStrip({ confluence, symbol, activeTf }: Props) {
  const aligned =
    confluence && confluence.length >= 4
      ? confluence.filter((c) => c.dir !== "lateral").every((c) => c.dir === confluence.filter((x) => x.dir !== "lateral")[0]?.dir)
        ? confluence.filter((c) => c.dir !== "lateral")[0]?.dir
        : null
      : null;

  return (
    <section className="panel anim-reveal" style={{ animationDelay: "0.02s" }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8fa3c4" strokeWidth="2" strokeLinecap="round">
            <path d="M3 17l5-5 4 4 7-8" />
            <path d="M14 8h5v5" />
          </svg>
          <span className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-mist-300">
            Confluencia multi-TF
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">{symbol}</span>
        </div>

        {!confluence && (
          <span className="font-mono text-[9.5px] uppercase tracking-widest text-mist-600">
            cargando tendencias…
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
                  className={`flex items-center gap-2 border px-2.5 py-1.5 transition-all ${
                    isActive
                      ? "border-flare-400/50 bg-flare-400/10 shadow-[0_0_12px_rgba(255,178,36,0.15)]"
                      : "border-ink-700 bg-ink-850/80"
                  }`}
                  title={`${c.tf}${isActive ? " (temporalidad activa)" : ""}: ${m.label} · convicción ${pctOf(c.strength)}`}
                >
                  <span className={`font-mono text-[10px] font-bold ${isActive ? "text-flare-300" : "text-mist-300"}`}>
                    {c.tf}
                    {isActive && <span className="ml-1 text-[7px]">●</span>}
                  </span>
                  <span className={`h-2 w-2 rounded-full ${m.dot}`} />
                  <span className={`font-mono text-[8.5px] font-bold uppercase tracking-wider ${m.text}`}>{m.label}</span>
                  <span className="h-1 w-8 overflow-hidden bg-ink-700">
                    <span
                      className="block h-full transition-all duration-700"
                      style={{ width: pctOf(c.strength), background: m.bar }}
                    />
                  </span>
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
          >
            <span
              className={`h-2 w-2 rounded-full ${
                aligned === "alcista" ? "bg-long-400" : aligned === "bajista" ? "bg-short-400" : "bg-mist-500"
              }`}
              style={aligned ? { animation: "liveBlink 1.6s ease-out infinite" } : undefined}
            />
            {aligned ? `alineado ${aligned}` : "sin alineación"}
          </div>
        )}
      </div>
    </section>
  );
}
