import { describe, it, expect } from "vitest";
import type { LiqCluster } from "./market";
import { syncPools, computeStats, type PoolRecord } from "./validation";

const cluster = (price: number, side: "long" | "short", sizeUsd = 1e6): LiqCluster => ({
  id: `t-${price}`,
  price,
  side,
  sizeUsd,
  strength: 0.7,
  leverage: "x50",
  exchange: "Binance",
});

describe("syncPools", () => {
  it("registra los pools detectados dentro de la ventana de distancia", () => {
    const log = syncPools([], "BTCUSDT", [cluster(99_000, "long"), cluster(101_000, "short")], 100_000, 1000);
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log.every((r) => r.status === "pendiente")).toBe(true);
  });

  it("marca BARRIDO un pool cuando el precio toca su nivel (±0,12%)", () => {
    let log: PoolRecord[] = [
      {
        id: "p1", symbol: "BTCUSDT", side: "long", price: 99_500,
        detectedAt: 1000, detectedPrice: 100_000, sizeUsd: 1e6,
        isControl: false, status: "pendiente", outcome: null,
      },
    ];
    // precio toca el nivel
    log = syncPools(log, "BTCUSDT", [], 99_520, 2000);
    expect(log[0].status).toBe("barrido");
    expect(log[0].sweptAt).toBe(2000);
  });

  it("clasifica REVERSIÓN si tras el barrido el precio rebota hacia el lado esperado", () => {
    const sweptAt = 1000;
    let log: PoolRecord[] = [
      {
        id: "p1", symbol: "BTCUSDT", side: "long", price: 99_500,
        detectedAt: 500, detectedPrice: 100_000, sizeUsd: 1e6,
        isControl: false, status: "barrido", sweptAt, sweptPrice: 99_500, outcome: null,
      },
    ];
    // 15 min después el precio rebotó +0,5% (reversión esperada para un pool long)
    log = syncPools(log, "BTCUSDT", [], 99_500 * 1.005, sweptAt + 16 * 60_000);
    expect(log[0].outcome).toBe("reversion");
  });

  it("marca EXPIRADO un pool sin barrer tras 6 h", () => {
    let log: PoolRecord[] = [
      {
        id: "p1", symbol: "BTCUSDT", side: "short", price: 101_000,
        detectedAt: 0, detectedPrice: 100_000, sizeUsd: 1e6,
        isControl: false, status: "pendiente", outcome: null,
      },
    ];
    // precio lejos del nivel, 7 h después
    log = syncPools(log, "BTCUSDT", [], 98_000, 7 * 3600_000);
    expect(log[0].status).toBe("expirado");
  });

  it("no duplica el mismo pool mientras está pendiente", () => {
    const clusters = [cluster(99_000, "long")];
    let log = syncPools([], "BTCUSDT", clusters, 100_000, 1000);
    const before = log.filter((r) => !r.isControl).length;
    log = syncPools(log, "BTCUSDT", clusters, 100_000, 2000);
    const after = log.filter((r) => !r.isControl).length;
    expect(after).toBe(before);
  });

  it("ignora pools fuera de la ventana de distancia (demasiado cerca o lejos)", () => {
    const log = syncPools(
      [],
      "BTCUSDT",
      [cluster(99_999, "long"), cluster(106_000, "short")], // 0,001% y 6%
      100_000,
      1000
    );
    expect(log.filter((r) => !r.isControl)).toHaveLength(0);
  });
});

describe("computeStats", () => {
  it("calcula la tasa de barrido y la de los controles por separado", () => {
    const log: PoolRecord[] = [
      { id: "a", symbol: "BTCUSDT", side: "long", price: 1, detectedAt: 0, detectedPrice: 1, sizeUsd: 1, isControl: false, status: "barrido", outcome: "reversion", sweptAt: 1 },
      { id: "b", symbol: "BTCUSDT", side: "long", price: 2, detectedAt: 0, detectedPrice: 1, sizeUsd: 1, isControl: false, status: "expirado", outcome: null },
      { id: "c", symbol: "BTCUSDT", side: "long", price: 3, detectedAt: 0, detectedPrice: 1, sizeUsd: 0, isControl: true, status: "expirado", outcome: null },
    ];
    const s = computeStats(log, "BTCUSDT");
    expect(s.hitRate).toBeCloseTo(0.5);       // 1 barrido / 2 resueltos reales
    expect(s.controlHitRate).toBeCloseTo(0);  // 0 barridos / 1 control resuelto
    expect(s.reversalRate).toBeCloseTo(1);    // 1 reversión / 1 resuelto
    expect(s.total).toBe(2);
  });
});
