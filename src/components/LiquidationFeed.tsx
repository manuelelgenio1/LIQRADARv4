import { useEffect, useMemo, useState } from "react";
import type { MarketState } from "../lib/market";
import { fmtAgo, fmtClock, fmtPct, fmtPrice, fmtUsd } from "../lib/format";

interface Props { state: MarketState; paused: boolean; liqSource?: "okx" | "sim"; }

type Filter = "all" | "long" | "short" | "real";

export default function LiquidationFeed({ state, paused, liqSource = "sim" }: Props) {
  const { events, meta } = state;
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const whaleThr = meta.liqScale * 1e6 * 0.12;

  const filtered = useMemo(() => {
    if (filter === "long") return events.filter((e) => e.side === "long");
    if (filter === "short") return events.filter((e) => e.side === "short");
    if (filter === "real") return events.filter((e) => e.isReal);
    return events;
  }, [events, filter]);

  const counts = useMemo(() => ({
    all: events.length,
    long: events.filter((e) => e.side === "long").length,
    short: events.filter((e) => e.side === "short").length,
    real: events.filter((e) => e.isReal).length,
  }), [events]);

  const totalUsd = filtered.reduce((s, e) => s + e.qtyUsd, 0);
  const realCount = events.filter((e) => e.isReal).length;
  const isReal = liqSource === "okx";

  // flujo por buckets de 30s (últimos 10 min)
  const buckets = useMemo(() => {
    const B = 20;
    const out = Array.from({ length: B }, () => ({ long: 0, short: 0 }));
    for (const e of events) {
      const age = now - e.time;
      if (age < 0 || age > 10 * 60_000) continue;
      const idx = B - 1 - Math.floor(age / 30_000);
      if (idx >= 0 && idx < B) {
        if (e.side === "long") out[idx].long += e.qtyUsd;
        else out[idx].short += e.qtyUsd;
      }
    }
    return out;
  }, [events, now]);
  const bucketMax = Math.max(...buckets.map((b) => b.long + b.short), 1);

  const ratePerMin = useMemo(() => {
    const recent = events.filter((e) => now - e.time < 60_000).length;
    return recent;
  }, [events, now]);

  return (
    <section className="panel anim-reveal flex h-full flex-col" style={{ animationDelay: "0.48s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <span className={`h-2.5 w-2.5 rounded-full ${paused ? "bg-flare-400" : "bg-short-400"}`}
          style={{ animation: paused ? "none" : "liveBlink 1.3s ease-out infinite" }} />
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Liquidaciones {isReal ? "reales" : "en vivo"}
            {isReal && (
              <span className="flex items-center gap-1 border border-long-500/50 bg-long-900/40 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest text-long-300">
                <span className="h-1 w-1 animate-pulse rounded-full bg-long-400" />
                OKX en vivo
              </span>
            )}
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {filtered.length} eventos · {fmtUsd(totalUsd)} · {isReal ? `${realCount} reales (OKX) + modelo` : "estimadas por modelo"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 font-mono text-[9px] uppercase tracking-widest text-mist-600">
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-long-400" />long</span>
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-short-400" />short</span>
        </div>
      </header>

      {/* filtros */}
      <div className="flex items-center gap-1 border-b border-ink-700/40 px-4 py-2">
        {([
          { id: "all" as Filter, label: `Todos · ${counts.all}` },
          { id: "long" as Filter, label: `Longs · ${counts.long}` },
          { id: "short" as Filter, label: `Shorts · ${counts.short}` },
          { id: "real" as Filter, label: `Reales · ${counts.real}` },
        ]).map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider transition-all ${
              filter === f.id
                ? "border-flare-400/50 bg-flare-400/10 text-flare-300"
                : "border-ink-700 bg-ink-850/60 text-mist-500 hover:text-mist-300"
            }`}>
            {f.label}
          </button>
        ))}
        <span className="ml-auto tick-num font-mono text-[9px] text-mist-500">
          <b className="text-mist-300">{ratePerMin}</b>/min
        </span>
      </div>

      {/* sparkline de flujo */}
      <div className="flex h-12 items-end gap-px border-b border-ink-700/40 px-4 py-2" title="Flujo de liquidaciones · últimos 10 min">
        {buckets.map((b, i) => {
          const tot = b.long + b.short;
          const h = Math.max(2, (tot / bucketMax) * 28);
          const dom = b.short >= b.long ? "bg-long-400/80" : "bg-short-400/80";
          return (
            <div key={i} className="flex-1">
              <div className={`w-full rounded-t-sm transition-all duration-300 ${tot > 0 ? dom : "bg-ink-700/50"}`}
                style={{ height: h }}
                title={`${b.short >= b.long ? "shorts liquidados (presión alcista)" : "longs liquidados (presión bajista)"} · ${fmtUsd(tot)}`} />
            </div>
          );
        })}
      </div>

      <div className="scroll-slim min-h-[240px] flex-1 overflow-y-auto lg:min-h-0 lg:max-h-[380px]">
        {filtered.length === 0 && (
          <div className="flex h-full min-h-[120px] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-mist-600">
            {paused ? "feed en pausa — reanuda para capturar eventos" : filter === "real" ? "sin liquidaciones reales aún" : "escaneando el radar…"}
          </div>
        )}
        {filtered.map((e, i) => {
          const isL = e.side === "long";
          const big = e.qtyUsd >= 1e6;
          const whale = e.qtyUsd >= whaleThr;
          return (
            <div key={e.id}
              className={`relative flex items-center gap-2 border-b border-ink-700/25 px-3 py-[7px] transition-colors hover:bg-ink-750/50 ${i === 0 ? "anim-feed-in" : ""}`}>
              <span className="tick-num shrink-0 font-mono text-[9px] text-mist-600">{fmtClock(e.time)}</span>
              <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider ${
                isL ? "border-long-500/40 bg-long-900/50 text-long-300" : "border-short-500/40 bg-short-900/50 text-short-300"
              }`}>
                {isL ? "L" : "S"}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="shrink-0 font-mono text-[10.5px] font-semibold text-mist-300">{e.symbol.replace("USDT", "")}</span>
                <span className="tick-num truncate font-mono text-[9.5px] text-mist-500">@ {fmtPrice(e.price, meta.decimals)}</span>
              </span>
              {e.isReal && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-long-400" title="Liquidación real (OKX)" />}
              <span className={`tick-num shrink-0 font-mono text-[11px] font-bold ${big ? "text-flare-300" : "text-mist-200"}`}>
                {fmtUsd(e.qtyUsd)}
              </span>
              <span className="hidden w-10 shrink-0 text-right font-mono text-[8px] uppercase tracking-wider text-mist-600 sm:block">
                {e.exchange}
              </span>
              <span className="tick-num hidden w-10 shrink-0 text-right font-mono text-[8px] text-mist-600 md:block" title={fmtClock(e.time)}>
                {fmtAgo(e.time, now)}
              </span>
              {big && (
                <span className="shrink-0" title={`Campana: liquidación > ${fmtUsd(1e6)}`}>
                  <svg width="11" height="13" viewBox="0 0 11 13" fill="#ffb224">
                    <path d="M6.5 0 L0 7.5 H4 L3.2 13 L11 5 H6.2 Z" />
                  </svg>
                </span>
              )}
              {whale && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 bg-flare-400 shadow-[0_0_8px_rgba(255,178,36,0.7)]" />
              )}
            </div>
          );
        })}
      </div>

      <footer className="flex items-center justify-between border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5 font-mono text-[9px] uppercase tracking-widest text-mist-600">
        <span>umbral ballena: {fmtUsd(whaleThr)}</span>
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-flare-400" : "bg-long-400"}`} />
          {paused ? "buffer congelado" : isReal ? "okx ws + simulación" : "streaming ws"}
        </span>
      </footer>
    </section>
  );
}
