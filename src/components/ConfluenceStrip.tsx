import { useEffect, useRef, useState } from "react";
import type { TrendDir } from "../lib/indicators";
import { pctOf } from "../lib/format";

interface Props {
  confluence: { tf: string; dir: TrendDir; strength: number }[] | null;
  symbol: string;
  activeTf: string;
  updatedAt?: number;
  market?: "perp" | "spot";
}

const DIR_META: Record<TrendDir, { label: string; dot: string; text: string; bar: string; arrow: string }> = {
  alcista: { label: "ALCISTA", dot: "bg-long-400", text: "text-long-300", bar: "#2de0c0", arrow: "▲" },
  bajista: { label: "BAJISTA", dot: "bg-short-400", text: "text-short-300", bar: "#ff5d7e", arrow: "▼" },
  lateral: { label: "LATERAL", dot: "bg-mist-500", text: "text-mist-400", bar: "#5f7396", arrow: "—" },
};

export default function ConfluenceStrip({ confluence, symbol, activeTf, updatedAt = 0, market = "perp" }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const ago = updatedAt > 0 ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null;

  // pulso al cambiar de dirección (el color cambia al instante; el pulso lo anuncia)
  const prevDirs = useRef<Record<string, TrendDir>>({});
  const pulseTimer = useRef<number | null>(null);
  const [pulsing, setPulsing] = useState<Set<string>>(new Set());
  useEffect(() => {
    const changed = new Set<string>();
    for (const c of confluence ?? []) {
      const prev = prevDirs.current[c.tf];
      if (prev !== undefined && prev !== c.dir) changed.add(c.tf);
      prevDirs.current[c.tf] = c.dir;
    }
    if (changed.size) {
      setPulsing(changed);
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setPulsing(new Set()), 900);
    }
  }, [confluence]);
  useEffect(
    () => () => {
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    },
    []
  );
  // al cambiar de símbolo no comparar contra el activo anterior
  useEffect(() => {
    prevDirs.current = {};
    setPulsing(new Set());
  }, [symbol]);

  const ups = (confluence ?? []).filter((c) => c.dir === "alcista").length;
  const downs = (confluence ?? []).filter((c) => c.dir === "bajista").length;
  const flats = (confluence ?? []).filter((c) => c.dir === "lateral").length;

  const dirs = (confluence ?? []).filter((c) => c.dir !== "lateral");
  const aligned =
    dirs.length >= 4 && dirs.every((c) => c.dir === dirs[0].dir) ? dirs[0].dir : null;

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
          <span
            className={`border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-widest ${
              market === "perp"
                ? "border-long-500/40 bg-long-900/40 text-long-300"
                : "border-mist-500/40 bg-ink-800 text-mist-400"
            }`}
            title={
              market === "perp"
                ? "Tendencias calculadas sobre velas del PERPETUO de Binance Futuros (misma fuente que el radar)"
                : "Tendencias calculadas sobre velas del mercado SPOT"
            }
          >
            {market}
          </span>
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
              const isPulsing = pulsing.has(c.tf);
              return (
                <div
                  key={c.tf}
                  className={`relative flex items-center gap-2 border px-2.5 py-1.5 transition-all ${
                    isActive
                      ? "border-flare-400/50 bg-flare-400/10 shadow-[0_0_12px_rgba(255,178,36,0.15)]"
                      : "border-ink-700 bg-ink-850/80"
                  }`}
                  title={`${c.tf}${isActive ? " (temporalidad activa)" : ""}: ${m.label} · convicción ${pctOf(c.strength)}`}
                >
                  {isPulsing && (
                    <span
                      className="pointer-events-none absolute inset-0 border border-mist-200/70"
                      style={{ animation: "blipPulse 0.9s ease-out 1" }}
                    />
                  )}
                  <span className={`font-mono text-[10px] font-bold ${isActive ? "text-flare-300" : "text-mist-300"}`}>
                    {c.tf}
                    {isActive && <span className="ml-1 text-[7px]">●</span>}
                  </span>
                  <span className={`h-2 w-2 rounded-full ${m.dot}`} />
                  <span className={`font-mono text-[8.5px] font-bold uppercase tracking-wider ${m.text}`}>
                    {m.arrow} {m.label}
                  </span>
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
          <>
            <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-mist-600">
              <span className="text-long-300">▲{ups}</span>
              <span className="text-short-300">▼{downs}</span>
              <span>—{flats}</span>
            </div>
            <div
              className={`flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${
                aligned === "alcista"
                  ? "border-long-500/50 bg-long-900/40 text-long-300"
                  : aligned === "bajista"
                    ? "border-short-500/50 bg-short-900/40 text-short-300"
                    : "border-ink-600 bg-ink-800 text-mist-400"
              }`}
              title="Requiere ≥4 temporalidades direccionales coincidiendo"
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  aligned === "alcista" ? "bg-long-400" : aligned === "bajista" ? "bg-short-400" : "bg-mist-500"
                }`}
                style={aligned ? { animation: "liveBlink 1.6s ease-out infinite" } : undefined}
              />
              {aligned ? `alineado ${aligned}` : "sin alineación"}
            </div>
            <span className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600" title="Refresco: 30 s en vivo · 500 velas por temporalidad">
              {ago != null ? `hace ${ago}s` : "…"} · 500v
            </span>
          </>
        )}
      </div>
    </section>
  );
}
