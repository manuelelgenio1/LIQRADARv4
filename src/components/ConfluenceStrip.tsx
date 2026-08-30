import { useEffect, useState } from "react";
import type { TrendDir } from "../lib/indicators";
import { pctOf } from "../lib/format";

interface Props {
  confluence: { tf: string; dir: TrendDir; strength: number }[] | null;
  symbol: string;
  activeTf?: string;
  updatedAt?: number; // timestamp de la última actualización (frescura)
}

const DIR_META: Record<TrendDir, { label: string; dot: string; text: string; bar: string }> = {
  alcista: { label: "ALCISTA", dot: "bg-long-400", text: "text-long-300", bar: "#2de0c0" },
  bajista: { label: "BAJISTA", dot: "bg-short-400", text: "text-short-300", bar: "#ff5d7e" },
  lateral: { label: "LATERAL", dot: "bg-mist-500", text: "text-mist-400", bar: "#5f7396" },
};

export default function ConfluenceStrip({ confluence, symbol, activeTf, updatedAt = 0 }: Props) {
  // reloj de frescura ("hace Xs")
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const dirs = (confluence ?? []).filter((c) => c.dir !== "lateral").map((c) => c.dir);
  const nUp = dirs.filter((d) => d === "alcista").length;
  const nDown = dirs.filter((d) => d === "bajista").length;
  const nLat = (confluence?.length ?? 0) - nUp - nDown;

  // alineación: todos los direccionales apuntan al mismo lado (≥4 para ser significativa)
  const aligned: TrendDir | null =
    dirs.length >= 4 && dirs.every((d) => d === dirs[0]) ? dirs[0] : null;

  const ago = updatedAt > 0 ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null;

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

        {/* contadores de dirección */}
        {confluence && (
          <div className="flex items-center gap-2 font-mono text-[9.5px] font-bold uppercase tracking-wider">
            <span className="flex items-center gap-1 text-long-300">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4 L21 18 H3 Z" /></svg>
              {nUp}
            </span>
            <span className="flex items-center gap-1 text-short-300">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20 L3 6 H21 Z" /></svg>
              {nDown}
            </span>
            <span className="flex items-center gap-1 text-mist-500">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M4 12 H20" strokeLinecap="round" /></svg>
              {nLat}
            </span>
          </div>
        )}

        {!confluence && (
          <span className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-widest text-mist-600">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mist-500" />
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
                  title={`${c.tf}${isActive ? " (temporalidad activa del gráfico)" : ""}: ${m.label} · convicción ${pctOf(c.strength)}`}
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
          <div className="flex items-center gap-3">
            {/* veredicto de alineación */}
            <div
              className={`flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${
                aligned === "alcista"
                  ? "border-long-500/50 bg-long-900/40 text-long-300"
                  : aligned === "bajista"
                    ? "border-short-500/50 bg-short-900/40 text-short-300"
                    : "border-ink-600 bg-ink-800 text-mist-400"
              }`}
              title={
                aligned
                  ? `${nUp + nDown} temporalidades direccionales coinciden en ${aligned}`
                  : "Las temporalidades no coinciden: mercado mixto"
              }
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  aligned === "alcista" ? "bg-long-400" : aligned === "bajista" ? "bg-short-400" : "bg-mist-500"
                }`}
                style={aligned ? { animation: "liveBlink 1.6s ease-out infinite" } : undefined}
              />
              {aligned ? `alineado ${aligned}` : "sin alineación"}
            </div>

            {/* frescura + ventana */}
            <div className="hidden flex-col items-end leading-tight lg:flex" title="Cada chip se calcula sobre 500 velas reales, igual que la insignia del gráfico. Se actualiza cada 60 s.">
              <span className="tick-num font-mono text-[9px] text-mist-500">
                {ago != null ? `hace ${ago}s` : "—"}
              </span>
              <span className="font-mono text-[7.5px] uppercase tracking-widest text-mist-600">
                500 velas · 60 s
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
