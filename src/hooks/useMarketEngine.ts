import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateMarket,
  marketFromKlines,
  mergeLiveKlines,
  applyLiveTick,
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
import {
  syncPools,
  computeStats,
  loadPoolLog,
  type PoolRecord,
} from "../lib/validation";

export type Source = "live" | "sim" | "connecting";

export interface Toast {
  id: string;
  title: string;
  detail: string;
  side: "long" | "short";
}

// ---------- persistencia de selecciones ----------
const LS_KEY = "liqradar:prefs:v1";

interface Prefs {
  symbol: string;
  tfKey: string;
  paused: boolean;
}

function loadPrefs(): Prefs {
  const d: Prefs = { symbol: SYMBOLS[0].symbol, tfKey: "5m", paused: false };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      if (SYMBOLS.some((s) => s.symbol === p.symbol)) d.symbol = p.symbol as string;
      if (TIMEFRAMES.some((t) => t.key === p.tfKey)) d.tfKey = p.tfKey as string;
      if (typeof p.paused === "boolean") d.paused = p.paused;
    }
  } catch {
    /* almacenamiento no disponible → valores por defecto */
  }
  return d;
}

export function useMarketEngine() {
  const [prefs] = useState<Prefs>(loadPrefs);
  const [symbol, setSymbol] = useState(prefs.symbol);
  const [tfKey, setTfKey] = useState(prefs.tfKey);
  const [paused, setPaused] = useState(prefs.paused);
  const [source, setSource] = useState<Source>("connecting");
  const [livePrices, setLivePrices] = useState<Record<string, TickerInfo>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [state, setState] = useState<MarketState>(() => {
    const m = SYMBOLS.find((s) => s.symbol === prefs.symbol) ?? SYMBOLS[0];
    const tf = TIMEFRAMES.find((t) => t.key === prefs.tfKey)?.minutes ?? 5;
    return generateMarket(m, tf, hashStr(m.symbol + prefs.tfKey) + 7);
  });

  const lastEvtId = useRef<string | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const lastPatchRef = useRef(0);

  // laboratorio de validación: track record de pools persistido
  const [poolLog, setPoolLog] = useState<PoolRecord[]>(loadPoolLog);
  const stateRef = useRef<MarketState | null>(null);
  stateRef.current = state;
  // latencia real medida: hora local − hora del evento en el servidor
  const wsLatencyRef = useRef<number | null>(null);

  const meta: SymbolMeta = useMemo(
    () => SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0],
    [symbol]
  );
  const tfMinutes = useMemo(
    () => TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5,
    [tfKey]
  );
  const tfRef = useRef(tfMinutes);
  tfRef.current = tfMinutes;

  // guardar selecciones (sobreviven a recargas de la página)
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ symbol, tfKey, paused }));
    } catch {
      /* sin almacenamiento */
    }
  }, [symbol, tfKey, paused]);

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
      if (t.eventTime > 0) {
        const raw = Date.now() - t.eventTime;
        // filtro de valores atípicos (relojes desincronizados)
        if (raw > -500 && raw < 4000) wsLatencyRef.current = raw;
      }
      const now = Date.now();
      // throttle: evita redibujar el canvas en cada mensaje del socket
      if (pausedRef.current || now - lastPatchRef.current < 220) return;
      lastPatchRef.current = now;
      setState((s) =>
        s.meta.symbol === t.symbol ? applyLiveTick(s, t.price, tfRef.current) : s
      );
    });
  }, []);

  // ticks: mantienen vivos los paneles (latencia, eventos, calor)
  useEffect(() => {
    if (paused || source === "connecting") return;
    const live = source === "live";
    const id = window.setInterval(
      () =>
        setState((s) =>
          tickMarket(s, {
            drift: !live,
            latencyMs: live && wsLatencyRef.current != null ? wsLatencyRef.current : undefined,
          })
        ),
      live ? 750 : 700
    );
    return () => window.clearInterval(id);
  }, [paused, source]);

  // refrescos en vivo: libro (1.5s), klines (20s), funding/OI (45s)
  useEffect(() => {
    if (source !== "live" || paused) return;

    const bookId = window.setInterval(async () => {
      try {
        const d = await fetchDepth(symbol);
        setState((s) => (s.meta.symbol === symbol ? { ...s, ...depthToState(d) } : s));
      } catch {
        /* se mantiene el último libro válido */
      }
    }, 1500);

    const klineId = window.setInterval(async () => {
      try {
        const kl = await fetchKlines(symbol, toBinanceInterval(tfKey), CANDLE_COUNT);
        setState((s) => (s.meta.symbol === symbol ? mergeLiveKlines(s, kl) : s));
      } catch {
        /* el websocket sigue actualizando la última vela */
      }
    }, 20_000);

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
      window.clearInterval(klineId);
      window.clearInterval(foId);
    };
  }, [source, symbol, tfKey, paused]);

  // alertas de liquidaciones grandes (el bootstrap nunca dispara toast)
  useEffect(() => {
    const e = state.events[0];
    if (!e) return;
    if (lastEvtId.current === null) {
      // primera vez tras cargar o cambiar de símbolo: solo calibra
      lastEvtId.current = e.id;
      return;
    }
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

  // laboratorio: cada 3 s registra pools nuevos y actualiza su estado
  // (barrido / expirado / resultado) con el precio vivo del mercado
  useEffect(() => {
    if (paused || source === "connecting") return;
    const id = window.setInterval(() => {
      const s = stateRef.current;
      if (!s) return;
      const price = s.candles[s.candles.length - 1].c;
      setPoolLog(syncPools(s.meta.symbol, s.clusters, price, Date.now()));
    }, 3000);
    return () => window.clearInterval(id);
  }, [paused, source]);

  const poolStats = useMemo(() => computeStats(poolLog, symbol), [poolLog, symbol]);

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
    poolLog,
    poolStats,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
  };
}
