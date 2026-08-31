import { useMemo, useState } from "react";
import type { LiqCluster, MarketState } from "../lib/market";
import { hashStr, RADAR_CLUSTER_LIMIT } from "../lib/market";
import { fmtPct, fmtPrice, fmtUsd } from "../lib/format";

interface Props { state: MarketState; }

const S = 320;
const C = S / 2;

const BANDS: { lev: string; frac: number }[] = [
  { lev: "x100", frac: 0.07 },
  { lev: "x50", frac: 0.16 },
  { lev: "x20", frac: 0.27 },
  { lev: "x10", frac: 0.39 },
  { lev: "x5", frac: 0.49 },
];
const radiusFor = (frac: number) => 24 + Math.min(0.55, frac) * 245;

export default function RadarScope({ state }: Props) {
  const [hovered, setHovered] = useState<{ cl: LiqCluster; x: number; y: number } | null>(null);

  const cur = state.candles[state.candles.length - 1].c;
  const span = state.pMax - state.pMin || 1;

  const blips = useMemo(
    () =>
      state.clusters.slice(0, RADAR_CLUSTER_LIMIT).map((cl) => {
        const frac = Math.abs(cl.price - cur) / span;
        const r = radiusFor(frac);
        const jitter = (hashStr(cl.id) % 100) / 100;
        const angle =
          cl.side === "short"
            ? (-150 + jitter * 120) * (Math.PI / 180)
            : (30 + jitter * 120) * (Math.PI / 180);
        return {
          cl,
          x: C + Math.cos(angle) * r,
          y: C + Math.sin(angle) * r,
          size: Math.min(8.5, 3 + Math.sqrt(cl.sizeUsd / 1e6) * 1.5),
        };
      }),
    [state.clusters, cur, span]
  );

  const longBelow = state.clusters.filter((c) => c.side === "long");
  const shortAbove = state.clusters.filter((c) => c.side === "short");
  const totalInRange = state.clusters.reduce((s, c) => s + c.sizeUsd, 0);

  return (
    <section className="panel panel-corner anim-reveal flex h-full flex-col" style={{ animationDelay: "0.12s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">Radar de liquidez</h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            clústeres por apalancamiento · x100 → x5
          </p>
        </div>
        <span className="ml-auto flex items-center gap-1.5 border border-long-500/40 bg-long-900/30 px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-widest text-long-300">
          <svg width="10" height="10" viewBox="0 0 10 10" className="animate-spin" style={{ animationDuration: "4.8s" }}>
            <path d="M5 5 L5 0 A5 5 0 0 1 9.3 2.5 Z" fill="currentColor" />
          </svg>
          barriendo · {blips.length}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-4">
        <div className="relative w-full max-w-[420px]">
          <svg viewBox={`0 0 ${S} ${S}`} className="w-full" onMouseLeave={() => setHovered(null)}>
            <defs>
              <radialGradient id="scopeBg" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="rgba(45,224,192,0.07)" />
                <stop offset="70%" stopColor="rgba(14,23,41,0.4)" />
                <stop offset="100%" stopColor="rgba(7,12,22,0.7)" />
              </radialGradient>
            </defs>

            <circle cx={C} cy={C} r={152} fill="url(#scopeBg)" stroke="#1a2740" strokeWidth="1.5" />

            {BANDS.map((b) => (
              <g key={b.lev}>
                <circle cx={C} cy={C} r={radiusFor(b.frac)} fill="none" stroke="#1a2740" strokeWidth="1" strokeDasharray="2 5" />
                <text x={C + 5} y={C - radiusFor(b.frac) + 11} fill="#48597a" fontSize="8.5" fontFamily="IBM Plex Mono, monospace">
                  {b.lev}
                </text>
              </g>
            ))}

            <line x1={C} y1={12} x2={C} y2={S - 12} stroke="#1a2740" strokeWidth="1" />
            <line x1={12} y1={C} x2={S - 12} y2={C} stroke="#1a2740" strokeWidth="1" />
            {Array.from({ length: 24 }).map((_, i) => {
              const a = (i * 15 * Math.PI) / 180;
              const r1 = 146, r2 = 152;
              return (
                <line
                  key={i}
                  x1={C + Math.cos(a) * r1} y1={C + Math.sin(a) * r1}
                  x2={C + Math.cos(a) * r2} y2={C + Math.sin(a) * r2}
                  stroke="#253650" strokeWidth="1.5"
                />
              );
            })}

            <text x={C} y={24} fill="#5f7396" fontSize="8.5" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" letterSpacing="2">
              SHORTS ↑
            </text>
            <text x={C} y={S - 16} fill="#5f7396" fontSize="8.5" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" letterSpacing="2">
              LONGS ↓
            </text>

            <g style={{ transformOrigin: `${C}px ${C}px`, animation: "radarSweep 4.8s linear infinite" }}>
              <path d={`M ${C} ${C} L ${C} ${C - 150} A 150 150 0 0 1 ${C + 99} ${C - 113} Z`} fill="rgba(45,224,192,0.05)" />
              <path d={`M ${C} ${C} L ${C} ${C - 150} A 150 150 0 0 1 ${C + 62} ${C - 137} Z`} fill="rgba(45,224,192,0.10)" />
              <path d={`M ${C} ${C} L ${C} ${C - 150} A 150 150 0 0 1 ${C + 27} ${C - 147.5} Z`} fill="rgba(45,224,192,0.20)" />
              <line x1={C} y1={C} x2={C} y2={C - 150} stroke="#7df0da" strokeWidth="1.8" />
            </g>

            {blips.map((b) => {
              const col = b.cl.side === "long" ? "#2de0c0" : "#ff5d7e";
              const isHov = hovered?.cl.id === b.cl.id;
              return (
                <g
                  key={b.cl.id}
                  onMouseEnter={() => setHovered({ cl: b.cl, x: b.x, y: b.y })}
                  style={{ cursor: "pointer" }}
                >
                  <circle cx={b.x} cy={b.y} r={b.size + 10} fill="transparent" />
                  <circle
                    cx={b.x} cy={b.y} r={b.size + 3}
                    fill="none" stroke={col} strokeWidth="1"
                    style={{
                      transformOrigin: `${b.x}px ${b.y}px`,
                      animation: "blipPulse 2.4s ease-in-out infinite",
                    }}
                  />
                  <circle
                    cx={b.x} cy={b.y} r={b.size}
                    fill={col}
                    opacity={isHov ? 1 : 0.8}
                    stroke="#070c16" strokeWidth="1"
                    style={{
                      transform: isHov ? "scale(1.35)" : "scale(1)",
                      transformOrigin: `${b.x}px ${b.y}px`,
                      transition: "transform 0.2s ease, opacity 0.2s ease",
                      filter: isHov ? `drop-shadow(0 0 5px ${col})` : "none",
                    }}
                  />
                  {isHov && <circle cx={b.x} cy={b.y} r={b.size + 7} fill="none" stroke={col} strokeWidth="1" strokeDasharray="3 3" />}
                </g>
              );
            })}

            <circle cx={C} cy={C} r="5" fill="#dbe6f7" />
            <circle cx={C} cy={C} r="9" fill="none" stroke="rgba(219,230,247,0.4)" strokeWidth="1" />
          </svg>

          {hovered && (
            <div
              className="pointer-events-none absolute z-20 w-48 -translate-x-1/2 border border-ink-600 bg-ink-900/95 px-3 py-2 text-center font-mono text-[10px] shadow-xl"
              style={{
                left: `${(hovered.x / S) * 100}%`,
                top: `calc(${(hovered.y / S) * 100}% + 26px)`,
              }}
            >
              <div className={`font-semibold ${hovered.cl.side === "long" ? "text-long-300" : "text-short-300"}`}>
                {hovered.cl.side === "long" ? "LIQ. LONGS" : "LIQ. SHORTS"} · {hovered.cl.leverage}
              </div>
              <div className="tick-num mt-0.5 text-mist-200">
                {fmtPrice(hovered.cl.price, state.meta.decimals)} · {fmtUsd(hovered.cl.sizeUsd)}
              </div>
              <div className="mt-0.5 text-[9px] uppercase tracking-widest text-mist-600">
                a {fmtPct(((hovered.cl.price - cur) / cur) * 100, 2)} del precio · {hovered.cl.exchange}
              </div>
            </div>
          )}

          {blips.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-widest text-mist-600">
              escaneando liquidez…
            </div>
          )}
        </div>
      </div>

      <footer className="grid grid-cols-3 divide-x divide-ink-700/50 border-t border-ink-700/50 bg-ink-900/50">
        <div className="px-3 py-2.5 text-center transition-colors duration-200 hover:bg-ink-800/60">
          <div className="font-mono text-[9px] uppercase tracking-widest text-mist-600">Longs ↓</div>
          <div className="tick-num mt-0.5 font-display text-sm font-bold text-long-300">
            {longBelow.length} · {fmtUsd(longBelow.reduce((s, c) => s + c.sizeUsd, 0))}
          </div>
        </div>
        <div className="px-3 py-2.5 text-center transition-colors duration-200 hover:bg-ink-800/60">
          <div className="font-mono text-[9px] uppercase tracking-widest text-mist-600">En rango</div>
          <div className="tick-num mt-0.5 font-display text-sm font-bold text-flare-300">{fmtUsd(totalInRange)}</div>
        </div>
        <div className="px-3 py-2.5 text-center transition-colors duration-200 hover:bg-ink-800/60">
          <div className="font-mono text-[9px] uppercase tracking-widest text-mist-600">Shorts ↑</div>
          <div className="tick-num mt-0.5 font-display text-sm font-bold text-short-300">
            {shortAbove.length} · {fmtUsd(shortAbove.reduce((s, c) => s + c.sizeUsd, 0))}
          </div>
        </div>
      </footer>
    </section>
  );
}
