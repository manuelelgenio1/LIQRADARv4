import { useEffect, useState } from "react";
import type { MarketState, SymbolMeta } from "../lib/market";
import type { Source } from "../hooks/useMarketEngine";
import type { TickerInfo } from "../lib/live";
import { fmtClock, fmtPct, fmtPrice } from "../lib/format";

function RadarLogo() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden>
      <circle cx="17" cy="17" r="14" stroke="#2de0c0" strokeWidth="1.6" opacity="0.85" />
      <circle cx="17" cy="17" r="8.5" stroke="#2de0c0" strokeWidth="1" opacity="0.4" />
      <g style={{ transformOrigin: "17px 17px", animation: "radarSweep 3.6s linear infinite" }}>
        <path d="M17 17 L17 3 A14 14 0 0 1 29.1 10 Z" fill="#2de0c0" opacity="0.32" />
        <line x1="17" y1="17" x2="17" y2="3" stroke="#7df0da" strokeWidth="1.6" />
      </g>
      <circle cx="22.5" cy="11.5" r="2.1" fill="#ff5d7e" />
      <circle cx="11.5" cy="21.5" r="1.7" fill="#ffb224" />
      <circle cx="17" cy="17" r="1.6" fill="#dbe6f7" />
    </svg>
  );
}

interface Props {
  meta: SymbolMeta;
  state: MarketState;
  symbols: SymbolMeta[];
  symbol: string;
  setSymbol: (s: string) => void;
  paused: boolean;
  setPaused: (p: boolean) => void;
  source: Source;
  livePrices: Record<string, TickerInfo>;
  alertsOn: boolean;
  toggleAlerts: () => void;
}

const SOURCE_CHIP: Record<Source, { t: string; c: string }> = {
  live: { t: "LIVE · BINANCE", c: "border-long-500/50 bg-long-900/40 text-long-300" },
  sim: { t: "SIMULADO", c: "border-flare-400/50 bg-flare-400/10 text-flare-300" },
  connecting: { t: "CONECTANDO…", c: "border-ink-600 bg-ink-800 text-mist-400" },
};

export default function TopBar({ meta, state, symbols, symbol, setSymbol, paused, setPaused, source, livePrices, alertsOn, toggleAlerts }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const lp = livePrices[meta.symbol];
  // con el feed en pausa la barra se congela en el último dato procesado
  const price = lp && !paused ? lp.price : state.candles[state.candles.length - 1].c;
  const change = lp && !paused ? lp.change24h : state.change24h;
  const up = change >= 0;
  const chip = SOURCE_CHIP[source];

  return (
    <header className="sticky top-0 z-40 border-b border-ink-700/60 bg-ink-900/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4 lg:px-6">
        {/* logo */}
        <div className="flex items-center gap-3">
          <RadarLogo />
          <div className="leading-none">
            <div className="font-display text-lg font-bold tracking-[0.18em] text-mist-100">
              LIQ<span className="text-long-400">RADAR</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="border border-long-500/40 bg-long-900/40 px-1 font-mono text-[9px] font-semibold tracking-widest text-long-300">v2.1</span>
              <span className={`border px-1 font-mono text-[9px] font-semibold tracking-widest ${chip.c}`}>{chip.t}</span>
            </div>
          </div>
        </div>

        <div className="hidden h-9 w-px bg-ink-700/70 md:block" />

        {/* tabs de símbolos */}
        <nav className="scroll-slim hidden items-center gap-1 overflow-x-auto md:flex">
          {symbols.map((s) => {
            const active = s.symbol === symbol;
            const sp = livePrices[s.symbol];
            return (
              <button
                key={s.symbol}
                onClick={() => setSymbol(s.symbol)}
                className={`shrink-0 border px-2.5 py-1.5 font-mono text-[11px] font-semibold tracking-wide transition-all duration-200 ${
                  active
                    ? "border-long-500/60 bg-long-900/40 text-long-300 shadow-[0_0_16px_rgba(45,224,192,0.18)]"
                    : "border-transparent text-mist-500 hover:border-ink-600 hover:bg-ink-800 hover:text-mist-300"
                }`}
              >
                {s.base}
                {sp && (
                  <span className={`ml-1.5 text-[9px] ${sp.change24h >= 0 ? "text-long-400" : "text-short-400"}`}>
                    {sp.change24h >= 0 ? "▲" : "▼"}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* precio en vivo */}
          <div className="text-right leading-none">
            <div className="flex items-baseline justify-end gap-2">
              <span className="hidden font-mono text-[10px] uppercase tracking-widest text-mist-500 sm:block">{meta.name}</span>
              <span className={`tick-num font-display text-xl font-bold ${up ? "text-long-300 text-glow-long" : "text-short-300 text-glow-short"}`}>
                {fmtPrice(price, meta.decimals)}
              </span>
              <span
                className={`tick-num border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                  up ? "border-long-500/40 bg-long-900/50 text-long-300" : "border-short-500/40 bg-short-900/50 text-short-300"
                }`}
              >
                {fmtPct(change)}
              </span>
            </div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-mist-600">
              {source === "live" ? "perpetuo · usdt · ws en vivo" : "perpetuo · usdt"}
            </div>
          </div>

          <div className="hidden h-9 w-px bg-ink-700/70 lg:block" />

          {/* alertas */}
          <button
            onClick={toggleAlerts}
            className={`relative border p-2 transition-all ${
              alertsOn
                ? "border-flare-400/60 bg-flare-400/10 text-flare-300 shadow-[0_0_14px_rgba(255,178,36,0.25)]"
                : "border-ink-600 bg-ink-800 text-mist-500 hover:border-ink-600 hover:text-mist-300"
            }`}
            title={alertsOn ? "Alertas activadas (giro Supertrend + pools barridos)" : "Activar alertas"}
          >
            <svg
              width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={alertsOn ? { transformOrigin: "50% 10%", animation: "bellSwing 2.4s ease-in-out infinite" } : undefined}
            >
              <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
            </svg>
            {alertsOn && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-flare-400" style={{ animation: "liveBlink 1.6s ease-out infinite" }} />}
          </button>

          {/* estado del feed */}
          <button
            onClick={() => setPaused(!paused)}
            className={`group flex items-center gap-2 border px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] transition-all ${
              paused
                ? "border-flare-400/50 bg-flare-400/10 text-flare-300 hover:bg-flare-400/20"
                : "border-long-500/40 bg-long-900/30 text-long-300 hover:bg-long-900/60"
            }`}
            title={paused ? "Reanudar feed" : "Pausar feed"}
          >
            <span
              className={`h-2 w-2 rounded-full ${paused ? "bg-flare-400" : "bg-long-400"}`}
              style={{ animation: paused ? "none" : "liveBlink 1.6s ease-out infinite" }}
            />
            {paused ? "Reanudar" : "En vivo"}
          </button>

          {/* reloj UTC */}
          <div className="hidden leading-none xl:block">
            <div className="tick-num font-mono text-sm font-medium text-mist-300">{fmtClock(now)}</div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-mist-600">UTC · {symbols.length} feeds</div>
          </div>
        </div>
      </div>

      {/* tabs móviles */}
      <nav className="scroll-slim flex items-center gap-1 overflow-x-auto border-t border-ink-700/50 px-3 py-2 md:hidden">
        {symbols.map((s) => (
          <button
            key={s.symbol}
            onClick={() => setSymbol(s.symbol)}
            className={`shrink-0 border px-2.5 py-1 font-mono text-[11px] font-semibold ${
              s.symbol === symbol
                ? "border-long-500/60 bg-long-900/40 text-long-300"
                : "border-transparent text-mist-500"
            }`}
          >
            {s.base}
          </button>
        ))}
      </nav>
    </header>
  );
}
