import { useMemo } from "react";
import { CANDLE_COUNT } from "../lib/market";
import {
  adxThrOf,
  computeIndicators,
  getIndicatorCfg,
  sliceIndicators,
  type IndicatorBundle,
  type IndicatorCfg,
} from "../lib/indicators";
import type { MarketState } from "../lib/market";

export interface Calibration {
  stAdj: number;
  adxThr: number;
}

/**
 * Cálculo de indicadores COMPARTIDO: una sola vez en el Dashboard,
 * sobre la semilla extendida (state.warm), recortado a CANDLE_COUNT.
 */
export function useIndicators(
  state: MarketState,
  tfKey: string,
  calibration?: Calibration
): { ind: IndicatorBundle; cfg: IndicatorCfg } {
  const cfg = useMemo<IndicatorCfg>(() => {
    const base = getIndicatorCfg(tfKey);
    const stAdj = calibration?.stAdj ?? 0;
    return {
      ...base,
      stMult: +(base.stMult * (1 + stAdj)).toFixed(2),
      adxThr: calibration?.adxThr ?? adxThrOf(base),
    };
  }, [tfKey, calibration]);

  const ind = useMemo(() => {
    const src = state.warm && state.warm.length >= CANDLE_COUNT ? state.warm : state.candles;
    const full = computeIndicators(src, cfg, state.tfMinutes);
    return src.length > CANDLE_COUNT ? sliceIndicators(full, CANDLE_COUNT) : full;
  }, [state.warm, state.candles, cfg, state.tfMinutes]);

  return { ind, cfg };
}
