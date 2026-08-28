import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateMarket,
  hashStr,
  tickMarket,
  SYMBOLS,
  TIMEFRAMES,
  type MarketState,
  type SymbolMeta,
} from "../lib/market";

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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [state, setState] = useState<MarketState>(() =>
    generateMarket(SYMBOLS[0], 5, hashStr(SYMBOLS[0].symbol + "5m") + 7)
  );
  const lastEvtId = useRef<string | null>(null);

  const meta: SymbolMeta = useMemo(
    () => SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0],
    [symbol]
  );
  const tfMinutes = useMemo(
    () => TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5,
    [tfKey]
  );

  // regenerar al cambiar símbolo o timeframe
  useEffect(() => {
    const m = SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0];
    const tf = TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5;
    lastEvtId.current = null;
    setState(generateMarket(m, tf, hashStr(symbol + tfKey) + 7));
  }, [symbol, tfKey]);

  // loop de ticks en vivo
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => setState((s) => tickMarket(s)), 700);
    return () => window.clearInterval(id);
  }, [paused]);

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
    toasts,
    dismissToast,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
  };
}
