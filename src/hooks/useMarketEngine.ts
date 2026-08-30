import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateMarket,
  marketFromKlines,
  mergeLiveKlines,
  applyLiveTick,
  applyTradeFlow,
  injectLiqEvents,
  tickMarket,
  hashStr,
  SYMBOLS,
  TIMEFRAMES,
  CANDLE_COUNT,
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
import { computeIndicators, getIndicatorCfg, supertrendSeries, type TrendDir } from "../lib/indicators";
import { playMillionLiq } from "../lib/sound";
import {
  syncPools,
  computeStats,
  loadPoolLog,
  type PoolRecord,
  type PoolStats,
} from "../lib/validation";

export type Source = "live" | "sim" | "connecting";

export interface Toast {
  id: string;
  title: string;
  detail: string;
  side: "long" | "short";
}

// velas usadas como semilla de los indicadores (no se dibujan todas)
const WARMUP_COUNT = 500;

// ---------- persistencia de selecciones ----------
const LS_KEY = "liqradar:prefs:v1";
const CAL_KEY = "liqradar:calibration:v1";

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
  const wsLatencyRef = useRef<number | null>(null);

  // laboratorio de validación: track record de pools persistido
  const [poolLog, setPoolLog] = useState<PoolRecord[]>(loadPoolLog);
  const [lastPoolSync, setLastPoolSync] = useState<number>(0);
  const poolLogRef = useRef<PoolRecord[]>(poolLog);
  poolLogRef.current = poolLog;
  const stateRef = useRef<MarketState | null>(null);
  stateRef.current = state;

  // ---- datos 100% reales: trades (CVD) + liquidaciones OKX ----
  const [liqSource, setLiqSource] = useState<"okx" | "sim">("sim");
  const [realCvd, setRealCvd] = useState(false);
  const tradeDeltaRef = useRef(0);
  const liqBufferRef = useRef<RawLiq[]>([]);
  const liqSeqRef = useRef(0);
  const ctValRef = useRef<Record<string, number>>({});

  // confluencia multi-timeframe (tendencia en las 7 TFs del símbolo activo)
  const [confluence, setConfluence] = useState<{ tf: string; dir: TrendDir; strength: number }[] | null>(null);
  const [confluenceAt, setConfluenceAt] = useState(0);

  // sentimiento real (ratio long/short de cuentas y top traders)
  const [sentiment, setSentiment] = useState<LongShortRatio | null>(null);

  // ---- calibración fina de indicadores (persistida) ----
  const [calibration, setCalibration] = useState<{ stAdj: number; adxThr: number }>(() => {
    const d = { stAdj: 0, adxThr: 25 };
    try {
      const raw = localStorage.getItem(CAL_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { stAdj?: number; adxThr?: number };
        if (Number.isFinite(p.stAdj)) d.stAdj = Math.max(-0.4, Math.min(0.6, p.stAdj as number));
        if (Number.isFinite(p.adxThr)) d.adxThr = Math.max(15, Math.min(35, p.adxThr as number));
      }
    } catch {
      /* valores por defecto */
    }
    return d;
  });
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  useEffect(() => {
    try {
      localStorage.setItem(CAL_KEY, JSON.stringify(calibration));
    } catch {
      /* sin almacenamiento */
    }
  }, [calibration]);

  // ---- sistema de alertas (notificación + sonido) ----
  const [alertsOn, setAlertsOn] = useState(false);
  const alertsOnRef = useRef(false);
  const stDirRef = useRef<boolean | null>(null);
  const sweptIdsRef = useRef<Set<string>>(new Set());

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

  // ---------- carga de datos reales (velas + libro + funding), fallback simulado ----------
  useEffect(() => {
    let cancelled = false;
    lastEvtId.current = null;
    setSource("connecting");
    (async () => {
      const m = SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0];
      const tf = TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5;
      const seed = hashStr(symbol + tfKey) + 7;
      try {
        // semilla extendida: 500 velas reales para calentar los indicadores;
        // el gráfico dibuja solo las últimas CANDLE_COUNT.
        const warmKl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT);
        if (cancelled) return;
        const klines = warmKl.slice(-CANDLE_COUNT);
        let st = marketFromKlines(m, tf, klines, seed);
        st = { ...st, warm: warmKl };
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

  // ---------- precios reales en tiempo real (websocket, todos los símbolos) ----------
  useEffect(() => {
    return connectTickers(SYMBOLS.map((s) => s.symbol), (t) => {
      setLivePrices((p) => ({ ...p, [t.symbol]: t }));
      // latencia real: hora local − eventTime del servidor
      if (t.evtTime) {
        const lat = Date.now() - t.evtTime;
        if (lat >= 0 && lat < 5000) wsLatencyRef.current = lat;
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

  // ---------- trades reales (aggTrade) → CVD real ----------
  useEffect(() => {
    if (source !== "live" || paused) return;
    // al (re)suscribir se parte de cero: ni delta residual del símbolo
    // anterior ni la etiqueta "CVD real" se heredan entre símbolos
    tradeDeltaRef.current = 0;
    setRealCvd(false);
    let got = 0;
    return connectTrades(symbol, (delta) => {
      tradeDeltaRef.current += delta;
      got += 1;
      // tras 40 trades confirmamos que el stream está vivo
      if (got === 40) setRealCvd(true);
    });
  }, [source, symbol, paused]);

  // ---------- liquidaciones REALES de OKX (buffer → inyección periódica) ----------
  useEffect(() => {
    if (source !== "live" || paused) return;
    // valor de contrato por símbolo para convertir a nocional USD
    for (const s of SYMBOLS) {
      if (!(s.base in ctValRef.current)) {
        fetchContractValue(s.base).then((v) => {
          if (v) ctValRef.current[s.base] = v;
        });
      }
    }
    return connectLiquidations((l) => {
      const ct = ctValRef.current[l.base] ?? 1;
      liqBufferRef.current.push({ ...l, usd: l.px * l.qty * ct });
      if (liqBufferRef.current.length > 200) liqBufferRef.current.shift();
    });
  }, [source, paused]);

  // ---------- ticks: mantienen vivos los paneles (latencia, eventos, calor) ----------
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

  // ---------- refrescos en vivo: libro (1.5s), klines (20s), funding/OI (45s) ----------
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
        const kl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT);
        setState((s) =>
          s.meta.symbol === symbol
            ? { ...mergeLiveKlines(s, kl.slice(-CANDLE_COUNT)), warm: kl }
            : s
        );
      } catch {
        /* el websocket sigue actualizando la última vela */
      }
    }, 20_000);

    const foId = window.setInterval(async () => {
      try {
        const [f, ls] = await Promise.allSettled([fetchFundingOi(symbol), fetchLongShortRatio(symbol)]);
        const fv = f.status === "fulfilled" ? f.value : null;
        if (fv) {
          setState((s) => ({
            ...s,
            funding: fv.funding,
            fundingNextMs: Math.max(0, fv.nextMs),
            oi: Number.isFinite(fv.oi) ? fv.oi : s.oi,
          }));
        }
        if (ls.status === "fulfilled" && ls.value) setSentiment(ls.value);
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

  // ---------- CONFLUENCIA MULTI-TF: tendencia en las 7 temporalidades ----------
  // COHERENCIA CON EL GRÁFICO: cada chip se calcula sobre WARMUP_COUNT (500)
  // velas, la MISMA ventana que usa useIndicators para la insignia del heatmap
  // (que lee state.warm). Así el chip de la temporalidad activa y la insignia
  // del gráfico jamás difieren: son el mismo cálculo sobre la misma ventana.
  const reloadConfluenceRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (source === "connecting") return;
    let cancelled = false;
    // Las 7 temporalidades, para que la activa (tfKey) siempre esté presente
    const tfs = ["1m", "5m", "15m", "1H", "4H", "1D", "1W"];
    const m = SYMBOLS.find((x) => x.symbol === symbol) ?? SYMBOLS[0];
    const cfgFor = (tf: string) => {
      const base = getIndicatorCfg(tf);
      const stAdj = calibrationRef.current.stAdj;
      return {
        ...base,
        stMult: +(base.stMult * (1 + stAdj)).toFixed(2),
        adxThr: calibrationRef.current.adxThr,
      };
    };
    const load = async () => {
      if (source === "live") {
        const res = await Promise.allSettled(
          tfs.map(async (tf) => {
            const minutes = TIMEFRAMES.find((t) => t.key === tf)?.minutes ?? 5;
            const kl = await fetchKlines(symbol, toBinanceInterval(tf), WARMUP_COUNT);
            const ind = computeIndicators(kl, cfgFor(tf), minutes);
            return { tf, dir: ind.consensus.dir, strength: ind.consensus.strength };
          })
        );
        if (cancelled) return;
        const items = res
          .filter((r): r is PromiseFulfilledResult<{ tf: string; dir: TrendDir; strength: number }> => r.status === "fulfilled")
          .map((r) => r.value);
        if (items.length) {
          setConfluence(items);
          setConfluenceAt(Date.now());
        }
      } else {
        // modo simulado: velas sintéticas deterministas por símbolo+tf
        // (misma ventana de 128 velas que dibuja el gráfico en simulación)
        if (cancelled) return;
        const items = tfs.map((tf) => {
          const minutes = TIMEFRAMES.find((t) => t.key === tf)?.minutes ?? 5;
          const sim = generateMarket(m, minutes, hashStr(symbol + tf) + 7);
          const ind = computeIndicators(sim.candles, cfgFor(tf), minutes);
          return { tf, dir: ind.consensus.dir, strength: ind.consensus.strength };
        });
        setConfluence(items);
        setConfluenceAt(Date.now());
      }
    };
    reloadConfluenceRef.current = () => void load();
    load();
    // 30 s en live (los chips se notan frescos); en simulado no cambia nada
    // entre recargas, así que no vale la pena recalcular tan a menudo.
    const id = window.setInterval(load, source === "live" ? 30_000 : 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      reloadConfluenceRef.current = () => {};
    };
  }, [source, symbol]);

  // al mover los sliders de calibración, recalcular la confluencia sin
  // esperar al intervalo de 60 s (con debounce para no saturar la API)
  useEffect(() => {
    const t = window.setTimeout(() => reloadConfluenceRef.current(), 900);
    return () => window.clearTimeout(t);
  }, [calibration]);

  // ---------- laboratorio + alertas (cada 3 s) ----------
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
        const mapped: Omit<LiquidationEvent, "isReal">[] = buf
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
      // opera sobre el log en memoria (React state), nunca relee localStorage
      setPoolLog((prev) => syncPools(prev, s.meta.symbol, s.clusters, price, Date.now()));
      setLastPoolSync(Date.now());

      if (!alertsOnRef.current) return;

      // alerta: pool de liquidación recién barrido por el precio (log en memoria)
      if (sweptIdsRef.current.size > 400) sweptIdsRef.current.clear();
      for (const r of poolLogRef.current) {
        if (r.symbol !== s.meta.symbol || r.status !== "barrido" || r.isControl) continue;
        if (sweptIdsRef.current.has(r.id)) continue;
        sweptIdsRef.current.add(r.id);
        if (r.sweptAt && Date.now() - r.sweptAt < 6000) {
          notify(
            `Pool ${r.side === "long" ? "LONG" : "SHORT"} barrido · ${s.meta.base}`,
            `El precio tocó ${r.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} (pool de ${
              r.isControl ? "control" : "liquidez"
            }).`
          );
        }
      }

      // alerta: giro CONFIRMADO del Supertrend (requiere persistencia de la vela
      // siguiente; coincide con el filtro que usan el consenso y el heatmap)
      const cfg = getIndicatorCfg(tfKey);
      const st = supertrendSeries(s.candles, cfg.atr, cfg.stMult);
      const up = st.upConf[st.upConf.length - 1];
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

  // al cambiar de símbolo/temporalidad se reinicia la dirección de Supertrend
  // para no disparar un giro falso al comparar contra el activo anterior
  useEffect(() => {
    stDirRef.current = null;
  }, [symbol, tfKey]);

  // ---------- notificación + sonido ----------
  const notify = (title: string, detail: string) => {
    if (!alertsOnRef.current) return;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(`LIQRADAR · ${title}`, { body: detail });
      }
    } catch {
      /* sin notificaciones */
    }
    // tono corto con WebAudio (solo tras gesto del usuario, como exige el navegador)
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 740;
      g.gain.setValueAtTime(0.06, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.36);
    } catch {
      /* sin audio */
    }
  };

  const toggleAlerts = () => {
    setAlertsOn((prev) => {
      const next = !prev;
      alertsOnRef.current = next;
      if (next && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {
          /* denegado: la alerta sonora sigue funcionando */
        });
      }
      return next;
    });
  };

  // ---------- alertas de liquidaciones grandes (el bootstrap nunca dispara toast) ----------
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
    // sonido distintivo cuando la liquidación supera el millón de dólares
    if (e.qtyUsd >= 1e6) playMillionLiq();
    const threshold = state.meta.liqScale * 1e6 * 0.3;
    if (e.qtyUsd >= threshold) {
      const toast: Toast = {
        id: e.id,
        title: `Liq. ${e.side === "long" ? "LONG" : "SHORT"} ${e.symbol.replace("USDT", "")} · $${(e.qtyUsd / 1e6).toFixed(2)}M`,
        detail: `${e.isReal ? "REAL · OKX" : e.exchange} @ ${e.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} — cascada detectada por el radar`,
        side: e.side,
      };
      setToasts((t) => [...t.slice(-3), toast]);
      window.setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== toast.id));
      }, 5200);
    }
  }, [state.events]);

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
    confluenceAt,
    calibration,
    setCalibration,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
  };
}
