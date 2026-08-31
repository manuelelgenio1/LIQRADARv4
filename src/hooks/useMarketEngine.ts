import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateMarket,
  marketFromKlines,
  mergeLiveKlines,
  applyLiveTick,
  tickMarket,
  applyTradeFlow,
  injectLiqEvents,
  hashStr,
  SYMBOLS,
  TIMEFRAMES,
  CANDLE_COUNT,
  type Candle,
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
import { getIndicatorCfg, computeIndicators, type TrendDir } from "../lib/indicators";
import { readLS, writeLS } from "../lib/storage";
import { syncPools, computeStats, loadPoolLog, type PoolRecord, type PoolStats } from "../lib/validation";
import { playAlertBlip, playMillionLiq } from "../lib/sound";

export type Source = "live" | "sim" | "connecting";
export type MarketKind = "perp" | "spot";

export interface Toast {
  id: string;
  title: string;
  detail: string;
  side: "long" | "short";
}

const WARMUP_COUNT = 500;
const LS_KEY = "liqradar:prefs:v1";
const CAL_KEY = "liqradar:cal:v1";
const MKT_KEY = "liqradar:market:v1";

interface Prefs {
  symbol: string;
  tfKey: string;
  paused: boolean;
}

function loadPrefs(): Prefs {
  const d: Prefs = { symbol: SYMBOLS[0].symbol, tfKey: "5m", paused: false };
  const p = readLS<Partial<Prefs>>(LS_KEY, {});
  if (SYMBOLS.some((s) => s.symbol === p.symbol)) d.symbol = p.symbol as string;
  if (TIMEFRAMES.some((t) => t.key === p.tfKey)) d.tfKey = p.tfKey as string;
  if (typeof p.paused === "boolean") d.paused = p.paused;
  return d;
}

function loadMarket(): MarketKind {
  const v = readLS<string>(MKT_KEY, "perp");
  return v === "spot" || v === "perp" ? v : "perp";
}

export function useMarketEngine() {
  const [prefs] = useState<Prefs>(loadPrefs);
  const [symbol, setSymbol] = useState(prefs.symbol);
  const [tfKey, setTfKey] = useState(prefs.tfKey);
  const [paused, setPaused] = useState(prefs.paused);

  // mercado fuente (persistido; los efectos lo leen por ref)
  const [market, setMarketState] = useState<MarketKind>(loadMarket);
  const marketRef = useRef<MarketKind>(market);
  marketRef.current = market;
  const setMarket = (m: MarketKind) => {
    setMarketState(m);
    try {
      localStorage.setItem(MKT_KEY, m);
    } catch {
      /* sin almacenamiento */
    }
  };

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

  // sentimiento real
  const [sentiment, setSentiment] = useState<LongShortRatio | null>(null);

  // datos reales: trades (CVD) + liquidaciones OKX
  const [liqSource, setLiqSource] = useState<"okx" | "sim">("sim");
  const [realCvd, setRealCvd] = useState(false);
  const tradeDeltaRef = useRef(0);
  const realCvdRef = useRef(false);
  const tradeCountRef = useRef(0);
  const liqBufferRef = useRef<RawLiq[]>([]);
  const liqSeqRef = useRef(0);
  const ctValRef = useRef<Record<string, number>>({});

  // confluencia multi-TF
  const [confluence, setConfluence] = useState<{ tf: string; dir: TrendDir; strength: number }[] | null>(null);
  const [confluenceAt, setConfluenceAt] = useState(0);
  const [confluenceErr, setConfluenceErr] = useState(false);
  const reloadConfluenceRef = useRef<() => void>(() => {});

  // calibración fina (persistida)
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

  // alertas
  const [alertsOn, setAlertsOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem("liqradar:alerts:v1") === "1";
    } catch {
      return false;
    }
  });
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  const toggleAlerts = () => {
    setAlertsOn((v) => {
      try {
        localStorage.setItem("liqradar:alerts:v1", v ? "0" : "1");
      } catch {
        /* sin almacenamiento */
      }
      return !v;
    });
  };

  // laboratorio de validación
  const [poolLog, setPoolLog] = useState<PoolRecord[]>(loadPoolLog);
  const poolLogRef = useRef(poolLog);
  poolLogRef.current = poolLog;
  const [lastPoolSync, setLastPoolSync] = useState(0);
  const stateRef = useRef<MarketState | null>(null);
  stateRef.current = state;
  const sweptIdsRef = useRef<Set<string>>(new Set());

  // ---------- persistencia de selecciones ----------
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ symbol, tfKey, paused }));
    } catch {
      /* sin almacenamiento */
    }
  }, [symbol, tfKey, paused]);

  // ---------- carga inicial (velas + libro + funding/OI + sentimiento) ----------
  useEffect(() => {
    let cancelled = false;
    lastEvtId.current = null;
    setSource("connecting");
    (async () => {
      const m = SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0];
      const tf = TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5;
      const seed = hashStr(symbol + tfKey) + 7;
      try {
        const fut = market === "perp";
        let warmKl: Candle[];
        try {
          warmKl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, fut);
        } catch {
          if (fut) {
            // futuros no disponible (bloqueo regional) → caer a spot
            warmKl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, false);
            if (!cancelled) setMarket("spot");
          } else {
            throw new Error("sin velas");
          }
        }
        if (cancelled) return;
        const klines = warmKl.slice(-CANDLE_COUNT);
        let st = marketFromKlines(m, tf, klines, seed);
        st = { ...st, warm: warmKl };
        try {
          const [depth, fo, ls] = await Promise.allSettled([
            fetchDepth(symbol, marketRef.current === "perp"),
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
  }, [symbol, tfKey, market]);

  // ---------- precios reales (websocket, todos los símbolos) ----------
  useEffect(() => {
    return connectTickers(
      SYMBOLS.map((s) => s.symbol),
      (t) => {
        setLivePrices((p) => ({ ...p, [t.symbol]: t }));
        if (t.evtTime) {
          const lat = Date.now() - t.evtTime;
          if (lat >= 0 && lat < 3000) wsLatencyRef.current = lat;
        }
        const now = Date.now();
        if (pausedRef.current || now - lastPatchRef.current < 220) return;
        lastPatchRef.current = now;
        setState((s) =>
          s.meta.symbol === t.symbol ? applyLiveTick(s, t.price, s.tfMinutes) : s
        );
      },
      market === "perp",
      () => {
        // futuros no disponible en esta región → caer a spot
        if (marketRef.current === "perp") setMarket("spot");
      }
    );
  }, [market]);

  // ---------- trades reales (CVD) ----------
  useEffect(() => {
    setRealCvd(false);
    realCvdRef.current = false;
    tradeCountRef.current = 0;
    tradeDeltaRef.current = 0;
    return connectTrades(
      symbol,
      (delta) => {
        tradeDeltaRef.current += delta;
        tradeCountRef.current += 1;
        if (!realCvdRef.current && tradeCountRef.current >= 40) {
          realCvdRef.current = true;
          setRealCvd(true);
        }
      },
      marketRef.current === "perp"
    );
  }, [symbol, paused, market]);

  // ---------- liquidaciones reales (OKX) ----------
  useEffect(() => {
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
      if (liqBufferRef.current.length > 80) liqBufferRef.current.shift();
    });
  }, []);

  // ---------- ticks: aplican el flujo real + mantienen paneles vivos ----------
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

  // ---------- refrescos: libro (1.5s) · klines (20s) · funding/OI/sentimiento (45s) ----------
  useEffect(() => {
    if (source !== "live" || paused) return;

    const bookId = window.setInterval(async () => {
      try {
        const d = await fetchDepth(symbol, marketRef.current === "perp");
        setState((s) => (s.meta.symbol === symbol ? { ...s, ...depthToState(d) } : s));
      } catch {
        /* se mantiene el último libro válido */
      }
    }, 1500);

    const klineId = window.setInterval(async () => {
      try {
        const kl = await fetchKlines(
          symbol,
          toBinanceInterval(tfKey),
          WARMUP_COUNT,
          marketRef.current === "perp"
        );
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
  }, [source, symbol, tfKey, paused, market]);

  // ---------- CONFLUENCIA MULTI-TF (misma ventana que el gráfico: WARMUP_COUNT) ----------
  useEffect(() => {
    if (source === "connecting") return;
    // al cambiar símbolo/mercado/fuente se invalida la confluencia anterior:
    // nunca mostrar tendencias de otro activo bajo el símbolo nuevo
    setConfluence(null);
    setConfluenceErr(false);
    let cancelled = false;
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
            const kl = await fetchKlines(symbol, toBinanceInterval(tf), WARMUP_COUNT, marketRef.current === "perp");
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
          setConfluenceErr(false);
        } else {
          // las 7 peticiones fallaron → marcar indisponible (no datos viejos)
          setConfluenceErr(true);
        }
      } else {
        if (cancelled) return;
        const items = tfs.map((tf) => {
          const minutes = TIMEFRAMES.find((t) => t.key === tf)?.minutes ?? 5;
          const sim = generateMarket(m, minutes, hashStr(symbol + tf) + 7);
          const ind = computeIndicators(sim.candles, cfgFor(tf), minutes);
          return { tf, dir: ind.consensus.dir, strength: ind.consensus.strength };
        });
        setConfluence(items);
        setConfluenceAt(Date.now());
        setConfluenceErr(false);
      }
    };
    reloadConfluenceRef.current = () => void load();
    load();
    const id = window.setInterval(load, source === "live" ? 30_000 : 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      reloadConfluenceRef.current = () => {};
    };
  }, [source, symbol, market]);

  // al mover los sliders de calibración, recalcular la confluencia (debounce)
  useEffect(() => {
    const t = window.setTimeout(() => reloadConfluenceRef.current(), 900);
    return () => window.clearTimeout(t);
  }, [calibration]);

  // ---------- laboratorio: cada 3 s sincroniza pools + drena liquidaciones OKX ----------
  useEffect(() => {
    if (paused || source === "connecting") return;
    const id = window.setInterval(() => {
      const s = stateRef.current;
      if (!s) return;

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
      setPoolLog((prev) => syncPools(prev, s.meta.symbol, marketRef.current, s.clusters, price, Date.now()));
      setLastPoolSync(Date.now());

      // ---------- alertas: liquidaciones grandes + giros de Supertrend ----------
      if (!alertsOnRef.current) return;
      const log = poolLogRef.current;
      if (sweptIdsRef.current.size > 400) sweptIdsRef.current.clear();
      let sweptNow = false;
      for (const r of log) {
        if (r.symbol !== s.meta.symbol || r.status !== "barrido" || r.isControl) continue;
        if (sweptIdsRef.current.has(r.id)) continue;
        sweptIdsRef.current.add(r.id);
        sweptNow = true;
      }
      if (sweptNow) playAlertBlip();
    }, 3000);
    return () => window.clearInterval(id);
  }, [paused, source]);

  // ---------- alertas: toasts + campana >$1M ----------
  useEffect(() => {
    const e = state.events[0];
    if (!e) return;
    if (lastEvtId.current === null) {
      lastEvtId.current = e.id;
      return;
    }
    if (lastEvtId.current === e.id) return;
    lastEvtId.current = e.id;
    // campana con cada liquidación que supera el millón (real o estimada)
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

  const poolStats = useMemo<PoolStats>(
    () => computeStats(poolLog, symbol, market),
    [poolLog, symbol, market]
  );

  const dismissToast = (id: string) => setToasts((t) => t.filter((x) => x.id !== id));

  return {
    state,
    meta: state.meta as SymbolMeta,
    symbol,
    setSymbol,
    tfKey,
    setTfKey,
    paused,
    setPaused,
    market,
    setMarket,
    source,
    livePrices,
    toasts,
    dismissToast,
    sentiment,
    alertsOn,
    toggleAlerts,
    liqSource,
    realCvd,
    confluence,
    confluenceAt,
    confluenceErr,
    calibration,
    setCalibration,
    poolLog,
    poolStats,
    lastPoolSync,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
  };
}
