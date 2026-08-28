import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateMarket,
  marketFromKlines,
  patchPrice,
  tickMarket,
  hashStr,
  SYMBOLS,
  TIMEFRAMES,
  CANDLE_COUNT,
  type MarketState,
  type SymbolMeta,
} from "../lib/market";
import {
  connectTickers,
  fetchKlines,
  fetchDepth,
  fetchFundingOi,
  toBinanceInterval,
  depthToState,
  type TickerInfo,
} from "../lib/live";

export type Source = "live" | "sim" | "connecting";

export interface Toast {
  id: string;
  title: string;
  detail: string;
  side: "long" | "short";
}

export function useMarketEngine() {
  const [symbol, setSymbol] = useState(SYMBOLS[0].symbol);
  const [tfKey, setTfKey] = useState("5m");
  const [paused, setPaused] = useState(false);
  const [source, setSource] = useState<Source>("connecting");
  const [livePrices, setLivePrices] = useState<Record<string, TickerInfo>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [state, setState] = useState<MarketState>(() =>
    generateMarket(SYMBOLS[0], 5, hashStr(SYMBOLS[0].symbol + "5m") + 7)
  );
  const lastEvtId = useRef<string | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const meta: SymbolMeta = useMemo(
    () => SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0],
    [symbol]
  );
  const tfMinutes = useMemo(
    () => TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5,
    [tfKey]
  );

  // carga de datos reales (velas + libro + funding), con fallback simulado
  useEffect(() => {
    let cancelled = false;
    lastEvtId.current = null;
    setSource("connecting");
    (async () => {
      const m = SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0];
      const tf = TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5;
      const seed = hashStr(symbol + tfKey) + 7;
      try {
        const klines = await fetchKlines(symbol, toBinanceInterval(tfKey), CANDLE_COUNT);
        if (cancelled) return;
        let st = marketFromKlines(m, tf, klines, seed);
        try {
          const [depth, fo] = await Promise.allSettled([fetchDepth(symbol), fetchFundingOi(symbol)]);
          if (cancelled) return;
          if (depth.status === "fulfilled") st = { ...st, ...depthToState(depth.value) };
          if (fo.status === "fulfilled" && fo.value) {
            st = {
              ...st,
              funding: fo.value.funding,
              fundingNextMs: Math.max(0, fo.value.nextMs),
              oi: Number.isFinite(fo.value.oi) ? fo.value.oi : st.oi,
            };
          }
        } catch {
          /* libro/funding estimados por el modelo */
        }
        if (!cancelled) {
          setState(st);
          setSource("live");
        }
      } catch {
        if (!cancelled) {
          setState(generateMarket(m, tf, seed));
          setSource("sim");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, tfKey]);

  // precios reales en tiempo real (websocket, todos los símbolos)
  useEffect(() => {
    return connectTickers(SYMBOLS.map((s) => s.symbol), (t) => {
      setLivePrices((p) => ({ ...p, [t.symbol]: t }));
      if (!pausedRef.current) {
        setState((s) => (s.meta.symbol === t.symbol ? patchPrice(s, t.price) : s));
      }
    });
  }, []);

  // ticks: en live solo mantienen vivos los paneles (sin deriva artificial de precio)
  useEffect(() => {
    if (paused || source === "connecting") return;
    const live = source === "live";
    const id = window.setInterval(
      () => setState((s) => tickMarket(s, { drift: !live })),
      live ? 1100 : 700
    );
    return () => window.clearInterval(id);
  }, [paused, source]);

  // refresco del libro real y de funding/OI mientras estamos en live
  useEffect(() => {
    if (source !== "live" || paused) return;
    const bookId = window.setInterval(async () => {
      try {
        const d = await fetchDepth(symbol);
        setState((s) => ({ ...s, ...depthToState(d) }));
      } catch {
        /* se mantiene el último libro válido */
      }
    }, 2600);
    const foId = window.setInterval(async () => {
      try {
        const f = await fetchFundingOi(symbol);
        if (f) {
          setState((s) => ({
            ...s,
            funding: f.funding,
            fundingNextMs: Math.max(0, f.nextMs),
            oi: Number.isFinite(f.oi) ? f.oi : s.oi,
          }));
        }
      } catch {
        /* se mantienen las últimas métricas */
      }
    }, 45_000);
    return () => {
      window.clearInterval(bookId);
      window.clearInterval(foId);
    };
  }, [source, symbol, paused]);

  // alertas de liquidaciones grandes
  useEffect(() => {
    const e = state.events[0];
    if (!e) return;
    if (lastEvtId.current === e.id) return;
    lastEvtId.current = e.id;
    const threshold = state.meta.liqScale * 1e6 * 0.3;
    if (e.qtyUsd >= threshold) {
      const toast: Toast = {
        id: e.id,
        title: `Liq. ${e.side === "long" ? "LONG" : "SHORT"} ${e.symbol.replace("USDT", "")} · $${(e.qtyUsd / 1e6).toFixed(2)}M`,
        detail: `${e.exchange} @ ${e.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} — cascada detectada por el radar`,
        side: e.side,
      };
      setToasts((t) => [...t.slice(-3), toast]);
      window.setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== toast.id));
      }, 5200);
    }
  }, [state.events, state.meta]);

  const dismissToast = (id: string) => setToasts((t) => t.filter((x) => x.id !== id));

  return {
    state,
    meta,
    symbol,
    setSymbol,
    tfKey,
    setTfKey,
    paused,
    setPaused,
    source,
    livePrices,
    toasts,
    dismissToast,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
  };
}
