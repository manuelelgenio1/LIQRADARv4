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
  applyTradeFlow,
  injectLiqEvents,
  type MarketState,
  type SymbolMeta,
  type LiquidationEvent,
} from "../lib/market";
import {
  connectTickers,
  connectTrades,
  connectLiquidations,
  fetchKlines,
  fetchDepth,
  fetchFundingOi,
  fetchLongShortRatio,
  fetchContractValue,
  toBinanceInterval,
  depthToState,
  type TickerInfo,
  type LongShortRatio,
  type RawLiq,
} from "../lib/live";
import {
  computeIndicators,
  getIndicatorCfg,
  supertrendSeries,
  type TrendDir,
} from "../lib/indicators";
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
  const [lastPoolSync, setLastPoolSync] = useState<number>(0);
  const stateRef = useRef<MarketState | null>(null);
  stateRef.current = state;
  // latencia real medida: hora local − hora del evento en el servidor
  const wsLatencyRef = useRef<number | null>(null);

  // sentimiento real (ratio long/short de cuentas y top traders)
  const [sentiment, setSentiment] = useState<LongShortRatio | null>(null);

  // ---- datos 100% reales: trades (CVD) + liquidaciones OKX ----
  const [liqSource, setLiqSource] = useState<"okx" | "sim">("sim");
  const [realCvd, setRealCvd] = useState(false);
  const tradeDeltaRef = useRef(0);
  const realCvdRef = useRef(false);
  const liqBufferRef = useRef<RawLiq[]>([]);
  const liqSeqRef = useRef(0);

  // confluencia multi-timeframe (tendencia en 5 TFs del símbolo activo)
  const [confluence, setConfluence] = useState<{ tf: string; dir: TrendDir; strength: number }[] | null>(null);

  // ---- sistema de alertas (notificación + sonido) ----
  const [alertsOn, setAlertsOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem("liqradar:alerts:v1") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("liqradar:alerts:v1", alertsOn ? "1" : "0");
    } catch {
      /* sin almacenamiento */
    }
  }, [alertsOn]);
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  const sweptIdsRef = useRef<Set<string>>(new Set());
  const stDirRef = useRef<boolean | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  const beep = () => {
    try {
      if (!audioRef.current) {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        audioRef.current = new Ctx();
      }
      const ctx = audioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(520, t + 0.18);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.24);
    } catch {
      /* sin audio */
    }
  };

  const notify = (title: string, body: string) => {
    if (!alertsOnRef.current) return;
    beep();
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, tag: title });
      }
    } catch {
      /* sin notificaciones */
    }
  };

  // al activar alertas, pedir permiso de notificación (gesto del usuario)
  const toggleAlerts = () => {
    const next = !alertsOn;
    setAlertsOn(next);
    if (next && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };

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
          const [depth, fo, ls] = await Promise.allSettled([
            fetchDepth(symbol),
            fetchFundingOi(symbol),
            fetchLongShortRatio(symbol),
          ]);
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
          if (ls.status === "fulfilled" && ls.value) setSentiment(ls.value);
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
    const id = window.setInterval(() => {
      const d = tradeDeltaRef.current;
      tradeDeltaRef.current = 0;
      setState((s) => {
        let n = s;
        if (d !== 0 && n.meta.symbol === symbol) n = applyTradeFlow(n, d);
        return tickMarket(n, {
          drift: !live,
          latencyMs: live && wsLatencyRef.current != null ? wsLatencyRef.current : undefined,
        });
      });
    }, live ? 750 : 700);
    return () => window.clearInterval(id);
  }, [paused, source, symbol]);

  // ---- CVD REAL: stream aggTrade del símbolo activo (solo en vivo) ----
  useEffect(() => {
    if (source !== "live") return;
    // al cambiar de símbolo se descarta el delta pendiente del stream anterior
    tradeDeltaRef.current = 0;
    return connectTrades(symbol, (d) => {
      if (!pausedRef.current) tradeDeltaRef.current += d;
      if (!realCvdRef.current) {
        realCvdRef.current = true;
        setRealCvd(true);
      }
    });
  }, [source, symbol]);

  // ---- LIQUIDACIONES REALES: WebSocket público de OKX (todos los símbolos) ----
  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | null = null;
    (async () => {
      const ct: Record<string, number> = {};
      await Promise.all(
        SYMBOLS.map(async (s) => {
          try {
            ct[s.base] = await fetchContractValue(`${s.base}-USDT-SWAP`, s.base);
          } catch {
            ct[s.base] = 1;
          }
        })
      );
      if (cancelled) return;
      close = connectLiquidations(
        SYMBOLS.map((s) => s.base),
        ct,
        (e) => {
          liqBufferRef.current.push(e);
        }
      );
    })();
    return () => {
      cancelled = true;
      close?.();
    };
  }, []);

  // ---- CONFLUENCIA MULTI-TF: tendencia en 5 temporalidades del símbolo ----
  useEffect(() => {
    if (source === "connecting") return;
    let cancelled = false;
    const tfs = ["5m", "15m", "1H", "4H", "1D"];
    const m = SYMBOLS.find((x) => x.symbol === symbol) ?? SYMBOLS[0];
    const load = async () => {
      if (source === "live") {
        const res = await Promise.allSettled(
          tfs.map(async (tf) => {
            const minutes = TIMEFRAMES.find((t) => t.key === tf)?.minutes ?? 5;
            const kl = await fetchKlines(symbol, toBinanceInterval(tf), CANDLE_COUNT);
            const ind = computeIndicators(kl, getIndicatorCfg(tf), minutes);
            return { tf, dir: ind.consensus.dir, strength: ind.consensus.strength };
          })
        );
        if (cancelled) return;
        const items = res
          .filter((r): r is PromiseFulfilledResult<{ tf: string; dir: TrendDir; strength: number }> => r.status === "fulfilled")
          .map((r) => r.value);
        if (items.length) setConfluence(items);
      } else {
        // modo simulado: velas sintéticas deterministas por símbolo+tf
        if (cancelled) return;
        const items = tfs.map((tf) => {
          const minutes = TIMEFRAMES.find((t) => t.key === tf)?.minutes ?? 5;
          const sim = generateMarket(m, minutes, hashStr(symbol + tf) + 7);
          const ind = computeIndicators(sim.candles, getIndicatorCfg(tf), minutes);
          return { tf, dir: ind.consensus.dir, strength: ind.consensus.strength };
        });
        setConfluence(items);
      }
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [source, symbol]);

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
        const [f, ls] = await Promise.allSettled([fetchFundingOi(symbol), fetchLongShortRatio(symbol)]);
        const fov = f.status === "fulfilled" ? f.value : null;
        if (fov) {
          setState((s) => ({
            ...s,
            funding: fov.funding,
            fundingNextMs: Math.max(0, fov.nextMs),
            oi: Number.isFinite(fov.oi) ? fov.oi : s.oi,
          }));
        }
        const lsv = ls.status === "fulfilled" ? ls.value : null;
        if (lsv) setSentiment(lsv);
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

  // al cambiar de símbolo/temporalidad se reinicia la dirección de Supertrend
  // para no disparar un giro falso al comparar contra el activo anterior
  useEffect(() => {
    stDirRef.current = null;
  }, [symbol, tfKey]);

  // laboratorio: cada 3 s registra pools nuevos, actualiza su estado
  // (barrido / expirado / resultado) y dispara alertas de eventos clave
  useEffect(() => {
    if (paused || source === "connecting") return;
    const id = window.setInterval(() => {
      const s = stateRef.current;
      if (!s) return;

      // inyectar liquidaciones REALES de OKX acumuladas en el buffer
      const buf = liqBufferRef.current;
      liqBufferRef.current = [];
      if (buf.length) {
        const sym = s.meta.symbol;
        const mapped: LiquidationEvent[] = buf
          .filter((e) => `${e.base}USDT` === sym)
          .map((e) => ({
            id: `okx-${++liqSeqRef.current}`,
            time: e.ts,
            symbol: sym,
            side: e.side,
            price: e.px,
            qtyUsd: e.usd,
            exchange: "OKX",
          }));
        if (mapped.length) {
          setLiqSource("okx");
          setState((st) => (st.meta.symbol === sym ? injectLiqEvents(st, mapped) : st));
        }
      }

      const price = s.candles[s.candles.length - 1].c;
      const log = syncPools(s.meta.symbol, s.clusters, price, Date.now());
      setPoolLog(log);
      setLastPoolSync(Date.now());

      // alerta: pool de liquidación recién barrido por el precio
      if (sweptIdsRef.current.size > 400) sweptIdsRef.current.clear();
      for (const r of log) {
        if (r.symbol !== s.meta.symbol || r.status !== "barrido" || r.isControl) continue;
        if (sweptIdsRef.current.has(r.id)) continue;
        sweptIdsRef.current.add(r.id);
        const dir = r.side === "long" ? "longs" : "shorts";
        notify(
          `Pool de ${dir} barrido · ${s.meta.base}`,
          `El precio tocó ${r.price.toFixed(s.meta.decimals)} — midiendo la reacción (reversión vs continuación).`
        );
      }

      // alerta: giro del Supertrend en la temporalidad activa
      const cfg = getIndicatorCfg(tfKey);
      const st = supertrendSeries(s.candles, cfg.atr, cfg.stMult);
      const up = st.up[st.up.length - 1];
      if (stDirRef.current !== null && stDirRef.current !== up) {
        notify(
          `Supertrend ${up ? "ALCISTA" : "BAJISTA"} · ${s.meta.base}`,
          `Giro de tendencia en ${tfKey} (ATR ${cfg.atr} × ${cfg.stMult}).`
        );
      }
      stDirRef.current = up;
    }, 3000);
    return () => window.clearInterval(id);
  }, [paused, source, tfKey]);

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
    lastPoolSync,
    sentiment,
    alertsOn,
    toggleAlerts,
    liqSource,
    realCvd,
    confluence,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
  };
}
