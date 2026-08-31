import { describe, it, expect } from "vitest";
import type { Candle } from "./market";
import {
  emaSeries,
  rsiSeries,
  supertrendSeries,
  computeIndicators,
  sliceIndicators,
  getIndicatorCfg,
  adxThrOf,
  mtfAdjust,
} from "./indicators";

// velas sintéticas helpers
const flat = (n: number, price = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 60000, o: price, h: price + 1, l: price - 1, c: price, v: 10, delta: 0 }));

const trending = (n: number, step = 1): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + i * step;
    return { t: i * 60000, o: c - step, h: c + 0.5, l: c - step - 0.5, c, v: 10, delta: step > 0 ? 5 : -5 };
  });

describe("emaSeries", () => {
  it("converge al valor constante cuando la entrada es constante", () => {
    const out = emaSeries(flat(200).map((k) => k.c), 20);
    expect(out[out.length - 1]).toBeCloseTo(100, 6);
  });

  it("tiene la misma longitud que la entrada", () => {
    const out = emaSeries(trending(50).map((k) => k.c), 10);
    expect(out).toHaveLength(50);
  });
});

describe("rsiSeries", () => {
  it("queda acotado entre 0 y 100", () => {
    const out = rsiSeries(trending(120, 2).map((k) => k.c), 14);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("marca sobrecompra (>70) en una subida sostenida", () => {
    const out = rsiSeries(trending(120, 2).map((k) => k.c), 14);
    expect(out[out.length - 1]).toBeGreaterThan(70);
  });

  it("marca sobreventa (<30) en una bajada sostenida", () => {
    const out = rsiSeries(trending(120, -2).map((k) => k.c), 14);
    expect(out[out.length - 1]).toBeLessThan(30);
  });
});

describe("supertrendSeries", () => {
  it("detecta tendencia alcista en una subida sostenida", () => {
    const { up } = supertrendSeries(trending(80, 2), 10, 2);
    expect(up[up.length - 1]).toBe(true);
  });

  it("los giros confirmados (upConf) nunca son más volátiles que los crudos", () => {
    // zigzag: alterna subidas y bajadas para provocar latigazos
    const candles: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 120; i++) {
      const dir = Math.floor(i / 6) % 2 === 0 ? 1 : -1;
      p += dir * 1.2;
      candles.push({ t: i * 60000, o: p - dir, h: p + 0.6, l: p - dir - 0.6, c: p, v: 10, delta: dir * 4 });
    }
    const { up, upConf } = supertrendSeries(candles, 10, 2);
    const flips = (a: boolean[]) => {
      let n = 0;
      for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1]) n++;
      return n;
    };
    expect(flips(upConf)).toBeLessThanOrEqual(flips(up));
  });
});

describe("computeIndicators + sliceIndicators (semilla extendida)", () => {
  it("sliceIndicators alinea las series a las últimas n velas", () => {
    const cfg = getIndicatorCfg("5m");
    const full = computeIndicators(trending(300), cfg, 5);
    const sliced = sliceIndicators(full, 128);
    expect(sliced.emaFast).toHaveLength(128);
    expect(sliced.stUpConf).toHaveLength(128);
    // el último valor del slice coincide con el último del cálculo completo
    expect(sliced.emaFast[127]).toBeCloseTo(full.emaFast[299], 8);
  });

  it("el consenso nunca produce NaN ni convicción fuera de [0,1]", () => {
    const cfg = getIndicatorCfg("1H");
    for (const cs of [trending(200, 3), trending(200, -3), flat(200)]) {
      const { consensus } = computeIndicators(cs, cfg, 60);
      expect(Number.isFinite(consensus.score)).toBe(true);
      expect(consensus.strength).toBeGreaterThanOrEqual(0);
      expect(consensus.strength).toBeLessThanOrEqual(1);
      expect(["alcista", "bajista", "lateral"]).toContain(consensus.dir);
    }
  });

  it("una subida fuerte da consenso alcista; una bajada, bajista", () => {
    const cfg = getIndicatorCfg("1H");
    const upC = computeIndicators(trending(200, 3), cfg, 60).consensus;
    const downC = computeIndicators(trending(200, -3), cfg, 60).consensus;
    expect(upC.dir).toBe("alcista");
    expect(downC.dir).toBe("bajista");
  });
});

describe("mtfAdjust", () => {
  it("premia la convicción cuando los TFs superiores coinciden", () => {
    const cons = computeIndicators(trending(200, 2), getIndicatorCfg("5m"), 5).consensus;
    const withMtf = mtfAdjust(cons, [
      { dir: "alcista" }, { dir: "alcista" }, { dir: "alcista" }, { dir: "alcista" }, { dir: "alcista" },
    ]);
    expect(withMtf.strength).toBeGreaterThanOrEqual(cons.strength);
    expect(withMtf.agree).toBe(5);
  });

  it("no altera un consenso lateral", () => {
    const cons = computeIndicators(flat(200), getIndicatorCfg("5m"), 5).consensus;
    const res = mtfAdjust(cons, [{ dir: "alcista" }]);
    expect(res.agree).toBeNull();
  });
});

describe("adxThrOf", () => {
  it("usa 25 por defecto y respeta la calibración", () => {
    expect(adxThrOf(getIndicatorCfg("5m"))).toBe(25);
    expect(adxThrOf({ ...getIndicatorCfg("5m"), adxThr: 30 })).toBe(30);
    expect(adxThrOf({ ...getIndicatorCfg("5m"), adxThr: NaN })).toBe(25);
  });
});
