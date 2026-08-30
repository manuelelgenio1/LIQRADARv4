import { useEffect, useMemo, useState } from "react";
import type { MarketState } from "../lib/market";
import { fmtClock, fmtPrice, fmtUsd } from "../lib/format";

interface Props { state: MarketState; paused: boolean; liqSource?: "okx" | "sim"; }

type Filter = "all" | "long" | "short" | "real";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "long", label: "Longs" },
  { id: "short", label: "Shorts" },
  { id: "real", label: "Reales" },
];

// tiempo relativo legible
function ago(t: number, now: number): string {
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export default function LiquidationFeed({ state, paused, liqSource = "sim" }: Props) {
  const { events, meta } = state;
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());

  // reloj vivo para tiempos relativos y ritmo
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const whaleThr = meta.liqScale * 1e6 * 0.12;
  const sessionTotal = events.reduce((s, e) => s + e.qtyUsd, 0);
  const realCount = events.filter((e) => e.isReal).length;
  const estCount = events.length - realCount;
  const longCount = events.filter((e) => e.side === "long").length;
  const shortCount = events.length - longCount;
  const hasReal = realCount > 0;
  const ratePerMin = events.filter((e) => now - e.time < 60_000).length;

  const filtered = useMemo(() => {
    switch (filter) {
      case "long": return events.filter((e) => e.side === "long");
      case "short": return events.filter((e) => e.side === "short");
      case "real": return events.filter((e) => e.isReal);
      default: return events;
    }
  }, [events, filter]);

  // flujo de liquidaciones: 20 cubos de 30 s (últimos 10 min)
  const buckets = useMemo(() => {
    const N = 20;
    const win = 10 * 60_000;
    const arr = Array.from({ length: N }, () => ({ long: 0, short: 0 }));
    for (const e of events) {
      const age = now - e.time;
      if (age < 0 || age > win) continue;
      const pos = N - 1 - Math.min(N - 1, Math.floor((age / win) * N));
      if (e.side === "long") arr[pos].long += e.qtyUsd;
      else arr[pos].short += e.qtyUsd;
    }
    return arr;
  }, [events, now]);
  const bucketMax = Math.max(...buckets.map((b) => b.long + b.short), 1);

  return (
    <section className="panel anim-reveal flex flex-col overflow-hidden" style={{ animationDelay: "0.48s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${paused ? "bg-flare-400" : "bg-short-400"}`}
          style={{ animation: paused ? "none" : "liveBlink 1.3s ease-out infinite" }}
        />
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Liquidaciones {hasReal ? "reales" : "en vivo"}
            {hasReal && (
              <span className="flex items-center gap-1 border border-long-500/50 bg-long-900/40 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest text-long-300">
                <span className="h-1 w-1 animate-pulse rounded-full bg-long-400" />
                OKX en vivo
              </span>
            )}
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {hasReal ? `${realCount} reales + modelo` : "estimadas por modelo"} · {fmtUsd(sessionTotal)} en sesión
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 font-mono text-[9px] uppercase tracking-widest text-mist-600">
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-long-400" />long</span>
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-short-400" />short</span>
        </div>
      </header>

      {/* franja de métricas de sesión */}
      <div className="grid grid-cols-4 divide-x divide-ink-700/40 border-b border-ink-700/50 bg-ink-900/40">
        <div className="px-3 py-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-mist-600">Eventos</div>
          <div className="tick-num mt-0.5 font-display text-base font-bold text-mist-100">{events.length}</div>
        </div>
        <div className="px-3 py-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-mist-600">Reales</div>
          <div className="tick-num mt-0.5 font-display text-base font-bold text-long-300">{realCount}</div>
        </div>
        <div className="px-3 py-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-mist-600">Estim.</div>
          <div className="tick-num mt-0.5 font-display text-base font-bold text-mist-400">{estCount}</div>
        </div>
        <div className="px-3 py-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-mist-600">Ritmo</div>
          <div className="tick-num mt-0.5 font-display text-base font-bold text-flare-300">
            {ratePerMin}<span className="font-mono text-[9px] font-medium text-mist-500">/min</span>
          </div>
        </div>
      </div>

      {/* filtros */}
      <div className="flex items-center gap-1 border-b border-ink-700/50 bg-ink-900/30 px-3 py-2">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          const count =
            f.id === "all" ? events.length
            : f.id === "long" ? longCount
            : f.id === "short" ? shortCount
            : realCount;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex items-center gap-1.5 border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider transition-all ${
                active
                  ? "border-long-500/50 bg-long-900/40 text-long-300"
                  : "border-transparent text-mist-500 hover:border-ink-600 hover:bg-ink-750 hover:text-mist-300"
              }`}
            >
              {f.label}
              <span className={`tick-num ${active ? "text-long-300" : "text-mist-600"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* lista con altura ACOTADA y scroll interno (el panel no se estira) */}
      <div className="relative">
        <div className="scroll-slim max-h-[380px] min-h-[240px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="text-ink-600">
                <circle cx="20" cy="20" r="16" stroke="currentColor" strokeWidth="1.5" />
                <path d="M20 20 L20 6 A14 14 0 0 1 32 13 Z" fill="currentColor" opacity="0.4" />
              </svg>
              <p className="font-mono text-[10px] uppercase tracking-widest text-mist-600">
                {filter !== "all"
                  ? "sin eventos para este filtro"
                  : paused
                    ? "feed en pausa — reanuda para capturar eventos"
                    : "escaneando el radar…"}
              </p>
            </div>
          )}
          {filtered.map((e, i) => {
            const isLong = e.side === "long";
            const big = e.qtyUsd > whaleThr;
            return (
              <div
                key={e.id}
                className={`group relative flex items-center gap-2 border-b border-ink-700/25 px-3 py-[7px] transition-colors hover:bg-ink-750/60 ${i === 0 ? "anim-feed-in" : ""}`}
              >
                {big && (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 bg-flare-400 shadow-[0_0_8px_rgba(255,178,36,0.7)]" />
                )}
                <span
                  className={`shrink-0 border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider ${
                    isLong ? "border-long-500/40 bg-long-900/50 text-long-300" : "border-short-500/40 bg-short-900/50 text-short-300"
                  }`}
                >
                  {isLong ? "L" : "S"}
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="shrink-0 font-mono text-[10.5px] font-semibold text-mist-300">{e.symbol.replace("USDT", "")}</span>
                  <span className="tick-num truncate font-mono text-[9.5px] text-mist-500">@ {fmtPrice(e.price, meta.decimals)}</span>
                </span>
                {e.isReal ? (
                  <span
                    className="shrink-0 border border-long-500/50 bg-long-900/50 px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider text-long-300"
                    title="Liquidación REAL recibida por el websocket de OKX"
                  >
                    REAL
                  </span>
                ) : (
                  <span
                    className="shrink-0 border border-ink-700 bg-ink-800 px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider text-mist-500"
                    title="Estimación del modelo (Binance no publica su stream de liquidaciones)"
                  >
                    EST
                  </span>
                )}
                <span className={`tick-num shrink-0 font-mono text-[11px] font-bold ${big ? "text-flare-300" : "text-mist-200"}`}>
                  {fmtUsd(e.qtyUsd)}
                </span>
                <span
                  className="tick-num w-[40px] shrink-0 text-right font-mono text-[8.5px] text-mist-600"
                  title={fmtClock(e.time)}
                >
                  {ago(e.time, now)}
                </span>
              </div>
            );
          })}
        </div>
        {/* fundido inferior: indica que hay más contenido scrolleable */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-ink-900/90 to-transparent" />
      </div>

      {/* flujo de liquidaciones (últimos 10 min) */}
      <div className="border-t border-ink-700/50 bg-ink-900/40 px-4 py-2.5">
        <div className="mb-1.5 flex items-center justify-between font-mono text-[8px] uppercase tracking-[0.16em] text-mist-600">
          <span>Flujo · 10 min</span>
          <span>{longCount}↓L · {shortCount}↑S</span>
        </div>
        <div className="flex h-10 items-end gap-[2px]">
          {buckets.map((b, i) => {
            const total = b.long + b.short;
            const h = total <= 0 ? 2 : Math.max(3, (total / bucketMax) * 100);
            const shortDominant = b.short >= b.long && b.short > 0;
            return (
              <div
                key={i}
                className={`flex-1 rounded-[1px] transition-all duration-500 ${
                  total <= 0 ? "bg-ink-700/70" : shortDominant ? "bg-long-400/80" : "bg-short-400/80"
                }`}
                style={{ height: `${h}%` }}
                title={`${fmtUsd(b.long)} longs · ${fmtUsd(b.short)} shorts`}
              />
            );
          })}
        </div>
      </div>

      <footer className="flex items-center justify-between border-t border-ink-700/50 bg-ink-900/50 px-4 py-2 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
        <span>ballena ≥ {fmtUsd(whaleThr)}</span>
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-flare-400" : "bg-long-400"}`} />
          {paused ? "buffer congelado" : liqSource === "okx" ? "okx ws + modelo" : "streaming ws"}
        </span>
      </footer>
    </section>
  );
}
