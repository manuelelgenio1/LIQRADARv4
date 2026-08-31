import { useEffect, useMemo, useRef, useState } from "react";
import {
  CANDLE_COUNT,
  SYMBOLS,
  TIMEFRAMES,
  generateMarket,
  hashStr,
  marketFromKlines,
  applyLiveTick,
  mergeLiveKlines,
  tickMarket,
  applyTradeFlow,
  injectLiqEvents,
  type Candle,
  type MarketState,
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
  toBinanceInterval,
  depthToState,
  type MarketKind,
  type TickerInfo,
  type LongShortRatio,
  type RawLiq,
} from "../lib/live";
import { computeIndicators, getIndicatorCfg, type TrendDir } from "../lib/indicators";
import { loadPoolLog, syncPools, computeStats, type PoolRecord, type PoolStats } from "../lib/validation";
import { playAlertBlip, playMillionLiq } from "../lib/sound";
import { readLS, writeLS, readFlag, writeFlag } from "../lib/storage";
import type { Calibration } from "./useIndicators";

export type Source = "live" | "sim" | "connecting";

export interface Toast {
  id: string;
  title: string;
  detail: string;
  side: "long" | "short";
}

interface Prefs {
  symbol: string;
  tfKey: string;
  paused: boolean;
}

const PREFS_KEY = "liqradar:prefs:v1";
const MKT_KEY = "liqradar:market:v1";
const CAL_KEY = "liqradar:cal:v1";
const ALERTS_KEY = "liqradar:alerts:v1";
const WARMUP_COUNT = 500;

function loadPrefs(): Prefs {
  const d: Prefs = { symbol: SYMBOLS[0].symbol, tfKey: "5m", paused: false };
  const p = readLS<Partial<Prefs>>(PREFS_KEY, {});
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

  const [market, setMarketState] = useState<MarketKind>(loadMarket);
  const marketRef = useRef<MarketKind>(market);
  marketRef.current = market;
  const setMarket = (m: MarketKind) => {
    setMarketState(m);
    writeLS(MKT_KEY, m);
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

  const [sentiment, setSentiment] = useState<LongShortRatio | null>(null);
  const [liqSource, setLiqSource] = useState<"okx" | "sim">("sim");
  const [realCvd, setRealCvd] = useState(false);
  const tradeDeltaRef = useRef(0);
  const realCvdRef = useRef(false);
  const tradeCountRef = useRef(0);
  const liqBufferRef = useRef<RawLiq[]>([]);
  const liqSeqRef = useRef(0);
  const [confluence, setConfluence] = useState<{ tf: string; dir: TrendDir; strength: number }[] | null>(null);
  const [confluenceAt, setConfluenceAt] = useState(0);
  const [confluenceErr, setConfluenceErr] = useState(false);
  const reloadConfluenceRef = useRef<() => void>(() => {});

  const [calibration, setCalibrationState] = useState<Calibration>(() => readLS<Calibration>(CAL_KEY, { stAdj: 0, adxThr: 25 }));
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  const setCalibration = (c: Calibration) => {
    setCalibrationState(c);
    writeLS(CAL_KEY, c);
  };

  const [alertsOn, setAlertsOn] = useState<boolean>(() => readFlag(ALERTS_KEY));
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  const toggleAlerts = () => {
    setAlertsOn((v) => {
      writeFlag(ALERTS_KEY, !v);
      return !v;
    });
  };

  const [poolLog, setPoolLog] = useState<PoolRecord[]>(loadPoolLog);
  const poolLogRef = useRef(poolLog);
  poolLogRef.current = poolLog;
  const [lastPoolSync, setLastPoolSync] = useState(0);
  const stateRef = useRef<MarketState | null>(null);
  stateRef.current = state;

  // persistir preferencias
  useEffect(() => {
    writeLS(PREFS_KEY, { symbol, tfKey, paused });
  }, [symbol, tfKey, paused]);

  // ---------- carga inicial de datos reales ----------
  useEffect(() => {
    let cancelled = false;
    lastEvtId.current = null;
    setSource("connecting");
    (async () => {
      const m = SYMBOLS.find((s) => s.symbol === symbol) ?? SYMBOLS[0];
      const tf = TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5;
      const seed = hashStr(symbol + tfKey) + 7;
      let warmKl: Candle[];
      try {
        warmKl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, market);
      } catch {
        if (market === "perp") {
          try {
            warmKl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, "spot");
            if (!cancelled) setMarket("spot");
          } catch {
            if (!cancelled) {
              setState(generateMarket(m, tf, seed));
              setSource("sim");
            }
            return;
          }
        } else {
          if (!cancelled) {
            setState(generateMarket(m, tf, seed));
            setSource("sim");
          }
          return;
        }
      }
      if (cancelled) return;
      const klines = warmKl.slice(-CANDLE_COUNT);
      let st = marketFromKlines(m, tf, klines, seed);
      st = { ...st, warm: warmKl };
      try {
        const [depth, fo, ls] = await Promise.allSettled([
          fetchDepth(symbol, marketRef.current),
          fetchFundingOi(symbol),
          fetchLongShortRatio(symbol),
        ]);
        if (cancelled) return;
        if (depth.status === "fulfilled") st = { ...st, ...depthToState(depth.value) };
        if (fo.status === "fulfilled" && fo.value) {
          const f = fo.value;
          st = { ...st, funding: f.funding, fundingNextMs: Math.max(0, f.nextMs), oi: Number.isFinite(f.oi) ? f.oi : st.oi };
        }
        if (ls.status === "fulfilled" && ls.value) setSentiment(ls.value);
      } catch {
        /* se usan los valores del modelo */
      }
      if (!cancelled) {
        setState(st);
        setSource("live");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, tfKey, market]);

  // ---------- precios en tiempo real ----------
  useEffect(() => {
    return connectTickers(
      SYMBOLS.map((s) => s.symbol),
      (t) => {
        setLivePrices((p) => ({ ...p, [t.symbol]: t }));
        if (t.evtTime) wsLatencyRef.current = Math.max(0, Date.now() - t.evtTime);
        const now = Date.now();
        if (pausedRef.current || now - lastPatchRef.current < 220) return;
        lastPatchRef.current = now;
        setState((s) => (s.meta.symbol === t.symbol ? applyLiveTick(s, t.price, tfMinutesRef.current) : s));
      },
      market,
      () => {
        if (marketRef.current === "perp") setMarket("spot");
      }
    );
  }, [market]);

  const tfMinutes = TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5;
  const tfMinutesRef = useRef(tfMinutes);
  tfMinutesRef.current = tfMinutes;

  // ---------- CVD real (aggTrade) ----------
  useEffect(() => {
    tradeDeltaRef.current = 0;
    tradeCountRef.current = 0;
    realCvdRef.current = false;
    setRealCvd(false);
    return connectTrades(
      symbol,
      (delta) => {
        tradeDeltaRef.current += delta;
        tradeCountRef.current += 1;
        if (tradeCountRef.current >= 40 && !realCvdRef.current) {
          realCvdRef.current = true;
          setRealCvd(true);
        }
      },
      market
    );
  }, [symbol, market]);

  // ---------- liquidaciones reales (OKX) ----------
  useEffect(() => {
    return connectLiquidations((l) => {
      liqBufferRef.current.push(l);
      if (liqBufferRef.current.length > 200) liqBufferRef.current.shift();
    });
  }, []);

  // ---------- ticks del modelo / paneles vivos ----------
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

  // ---------- refresco periódico (depth, klines, funding) ----------
  useEffect(() => {
    if (source !== "live" || paused) return;
    const bookId = window.setInterval(async () => {
      try {
        const d = await fetchDepth(symbol, marketRef.current);
        setState((s) => (s.meta.symbol === symbol ? { ...s, ...depthToState(d) } : s));
      } catch {
        /* se mantiene el último libro */
      }
    }, 1500);
    const klineId = window.setInterval(async () => {
      try {
        const kl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, marketRef.current);
        setState((s) =>
          s.meta.symbol === symbol ? { ...mergeLiveKlines(s, kl.slice(-CANDLE_COUNT)), warm: kl } : s
        );
      } catch {
        /* el websocket sigue actualizando */
      }
    }, 20_000);
    const foId = window.setInterval(async () => {
      try {
        const [f, ls] = await Promise.allSettled([fetchFundingOi(symbol), fetchLongShortRatio(symbol)]);
        if (f.status === "fulfilled" && f.value) {
          const fv = f.value;
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

  // ---------- confluencia multi-TF ----------
  useEffect(() => {
    if (source === "connecting") return;
    setConfluence(null);
    setConfluenceErr(false);
    let cancelled = false;
    const tfs = ["1m", "5m", "15m", "1H", "4H", "1D", "1W"];
    const m = SYMBOLS.find((x) => x.symbol === symbol) ?? SYMBOLS[0];
    const cfgFor = (tf: string) => {
      const base = getIndicatorCfg(tf);
      return {
        ...base,
        stMult: +(base.stMult * (1 + calibrationRef.current.stAdj)).toFixed(2),
        adxThr: calibrationRef.current.adxThr,
      };
    };
    const load = async () => {
      if (source === "live") {
        const res = await Promise.allSettled(
          tfs.map(async (tf) => {
            const minutes = TIMEFRAMES.find((t) => t.key === tf)?.minutes ?? 5;
            const kl = await fetchKlines(symbol, toBinanceInterval(tf), WARMUP_COUNT, marketRef.current);
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

  useEffect(() => {
    const t = window.setTimeout(() => reloadConfluenceRef.current(), 900);
    return () => window.clearTimeout(t);
  }, [calibration]);

  // ---------- laboratorio + alertas ----------
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
      const log = syncPools(poolLogRef.current, s.meta.symbol, marketRef.current, s.clusters, price, Date.now());
      setPoolLog(log);
      setLastPoolSync(Date.now());

      const e = s.events[0];
      if (e && lastEvtId.current !== e.id) {
        if (lastEvtId.current !== null) {
          if (e.qtyUsd >= 1e6) playMillionLiq();
          const threshold = s.meta.liqScale * 1e6 * 0.3;
          if (e.qtyUsd >= threshold && alertsOnRef.current) {
            playAlertBlip();
            const toast: Toast = {
              id: e.id,
              title: `Liq. ${e.side === "long" ? "LONG" : "SHORT"} ${e.symbol.replace("USDT", "")} · $${(e.qtyUsd / 1e6).toFixed(2)}M`,
              detail: `${e.isReal ? "REAL · " : ""}${e.exchange} @ ${e.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
              side: e.side,
            };
            setToasts((t) => [...t.slice(-3), toast]);
            window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), 5200);
          }
        }
        lastEvtId.current = e.id;
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [paused, source]);

  const poolStats = useMemo<PoolStats>(() => computeStats(poolLog, symbol, market), [poolLog, symbol, market]);

  const dismissToast = (id: string) => setToasts((t) => t.filter((x) => x.id !== id));

  return {
    state, symbol, setSymbol, tfKey, setTfKey, paused, setPaused,
    market, setMarket, source, livePrices, toasts, dismissToast,
    sentiment, alertsOn, toggleAlerts,
    liqSource, realCvd, confluence, confluenceAt, confluenceErr,
    calibration, setCalibration,
    poolLog, poolStats, lastPoolSync,
    symbols: SYMBOLS, timeframes: TIMEFRAMES,
  };
}
