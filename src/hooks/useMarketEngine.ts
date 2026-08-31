import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyLiveTick,
  applyTradeFlow,
  generateMarket,
  hashStr,
  injectLiqEvents,
  marketFromKlines,
  mergeLiveKlines,
  tickMarket,
  CANDLE_COUNT,
  SYMBOLS,
  TIMEFRAMES,
  type Candle,
  type LiquidationEvent,
  type MarketState,
} from "../lib/market";
import { computeIndicators, getIndicatorCfg, type TrendDir } from "../lib/indicators";
import {
  connectLiquidations,
  connectTickers,
  connectTrades,
  fetchContractValue,
  fetchDepth,
  fetchFundingOi,
  fetchKlines,
  fetchLongShortRatio,
  depthToState,
  toBinanceInterval,
  type LongShortRatio,
  type MarketKind,
  type RawLiq,
  type TickerInfo,
} from "../lib/live";
import { loadPoolLog, syncPools, computeStats, type PoolRecord } from "../lib/validation";
import { playAlertBlip, playMillionLiq } from "../lib/sound";
import { readFlag, readLS, writeFlag, writeLS } from "../lib/storage";

export type Source = "live" | "sim" | "connecting";

export interface Toast {
  id: string;
  title: string;
  detail: string;
  side: "long" | "short";
}

const LS_KEY = "liqradar:prefs:v1";
const CAL_KEY = "liqradar:cal:v1";
const MKT_KEY = "liqradar:market:v1";
const ALERTS_KEY = "liqradar:alerts:v1";
const WARMUP_COUNT = 500;

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
  const v = readLS<MarketKind>(MKT_KEY, "perp");
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
  const ctValRef = useRef<Record<string, number>>({});

  const [confluence, setConfluence] = useState<{ tf: string; dir: TrendDir; strength: number }[] | null>(null);
  const [confluenceAt, setConfluenceAt] = useState(0);
  const [confluenceErr, setConfluenceErr] = useState(false);
  const reloadConfluenceRef = useRef<() => void>(() => {});

  const [calibration, setCalibration] = useState<{ stAdj: number; adxThr: number }>(() => {
    const d = { stAdj: 0, adxThr: 25 };
    const p = readLS<Partial<{ stAdj: number; adxThr: number }>>(CAL_KEY, {});
    if (Number.isFinite(p.stAdj)) d.stAdj = Math.max(-0.4, Math.min(0.6, p.stAdj as number));
    if (Number.isFinite(p.adxThr)) d.adxThr = Math.max(15, Math.min(35, p.adxThr as number));
    return d;
  });
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  useEffect(() => {
    writeLS(CAL_KEY, calibration);
  }, [calibration]);

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
  const sweptIdsRef = useRef<Set<string>>(new Set());

  // persistencia de selecciones
  useEffect(() => {
    writeLS(LS_KEY, { symbol, tfKey, paused });
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
      const fut = market === "perp";
      let warmKl: Candle[];
      try {
        warmKl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, market);
      } catch {
        if (fut) {
          warmKl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, "spot");
          if (!cancelled) setMarket("spot");
        } else {
          if (!cancelled) {
            setState(generateMarket(m, tf, seed));
            setSource("sim");
          }
          return;
        }
      }
      if (cancelled) return;
      let st = marketFromKlines(m, tf, warmKl.slice(-CANDLE_COUNT), seed);
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
          st = {
            ...st,
            funding: fo.value.funding,
            fundingNextMs: Math.max(0, fo.value.nextMs),
            oi: Number.isFinite(fo.value.oi) ? fo.value.oi : st.oi,
          };
        }
        if (ls.status === "fulfilled" && ls.value) setSentiment(ls.value);
      } catch {
        /* se mantienen los valores del modelo */
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

  // ---------- precios reales (websocket) ----------
  useEffect(() => {
    return connectTickers(
      SYMBOLS.map((s) => s.symbol),
      (t) => {
        setLivePrices((p) => ({ ...p, [t.symbol]: t }));
        if (t.evtTime) wsLatencyRef.current = Date.now() - t.evtTime;
        const now = Date.now();
        if (pausedRef.current || now - lastPatchRef.current < 220) return;
        lastPatchRef.current = now;
        setState((s) =>
          s.meta.symbol === t.symbol ? applyLiveTick(s, t.price, tfRef.current) : s
        );
      },
      market,
      () => {
        if (marketRef.current === "perp") setMarket("spot");
      }
    );
  }, [market]);

  const tfMinutes = TIMEFRAMES.find((t) => t.key === tfKey)?.minutes ?? 5;
  const tfRef = useRef(tfMinutes);
  tfRef.current = tfMinutes;

  // ---------- trades reales (CVD) ----------
  useEffect(() => {
    tradeDeltaRef.current = 0;
    tradeCountRef.current = 0;
    realCvdRef.current = false;
    setRealCvd(false);
    return connectTrades(
      symbol,
      (delta) => {
        if (pausedRef.current) return;
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
    (async () => {
      for (const base of ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB"]) {
        if (ctValRef.current[base] == null) {
          const v = await fetchContractValue(base);
          if (v != null) ctValRef.current[base] = v;
        }
      }
    })();
    return connectLiquidations((l) => {
      const ct = ctValRef.current[l.base] ?? 1;
      liqBufferRef.current.push({ ...l, usd: l.usd * ct });
    });
  }, []);

  // ---------- ticks (paneles vivos) ----------
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

  // ---------- refresco libro / velas / funding ----------
  useEffect(() => {
    if (source !== "live" || paused) return;
    const bookId = window.setInterval(async () => {
      try {
        const d = await fetchDepth(symbol, marketRef.current);
        setState((s) => (s.meta.symbol === symbol ? { ...s, ...depthToState(d) } : s));
      } catch {
        /* se mantiene el último libro válido */
      }
    }, 1500);
    const klineId = window.setInterval(async () => {
      try {
        const kl = await fetchKlines(symbol, toBinanceInterval(tfKey), WARMUP_COUNT, marketRef.current);
        setState((s) =>
          s.meta.symbol === symbol ? { ...mergeLiveKlines(s, kl.slice(-CANDLE_COUNT)), warm: kl } : s
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

  // recalcular confluencia al mover la calibración (debounce)
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

      // inyectar liquidaciones REALES de OKX
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

      // alerta: pool barrido + campana de liquidación millonaria
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

  const poolStats = useMemo(() => computeStats(poolLog, symbol, market), [poolLog, symbol, market]);
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
