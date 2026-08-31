import { useMemo } from "react";
import type { MarketState } from "../lib/market";
import { computeLiqRegime } from "../lib/overlays";
import { fmtCompact } from "../lib/format";
import type { IndicatorBundle, TrendDir } from "../lib/indicators";
import { DivergingBar } from "./MeterBar";

interface Props {
  state: MarketState;
  ind: IndicatorBundle;
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
  market?: "perp" | "spot";
}

interface SignalPart {
  label: string;
  value: number;   // -1 (bajista) … +1 (alcista)
  weight: number;
  note: string;
  color: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function RadarSignalPanel({ state, ind, confluence, market = "perp" }: Props) {
  const parts = useMemo<SignalPart[]>(() => {
    const out: SignalPart[] = [];

    // 1 · Consenso de 5 indicadores
    const cons = ind.consensus;
    const consSign = cons.dir === "alcista" ? 1 : cons.dir === "bajista" ? -1 : 0;
    out.push({
      label: "Consenso 5-ind",
      value: consSign * cons.strength,
      weight: 1.2,
      note: `${cons.dir} · convicción ${(cons.strength * 100).toFixed(0)}%`,
      color: consSign > 0 ? "#2de0c0" : consSign < 0 ? "#ff5d7e" : "#5f7396",
    });

    // 2 · Confluencia multi-timeframe
    if (confluence && confluence.length) {
      const dirs = confluence.filter((c) => c.dir !== "lateral");
      const up = dirs.filter((c) => c.dir === "alcista").length;
      const align = dirs.length ? (up - (dirs.length - up)) / dirs.length : 0;
      out.push({
        label: "Confluencia MTF",
        value: align,
        weight: 1.0,
        note: `${up}/${dirs.length} temporalidades alcistas`,
        color: align > 0 ? "#2de0c0" : align < 0 ? "#ff5d7e" : "#5f7396",
      });
    }

    // 3 · Régimen de liquidez (funding + OI)
    const regime = computeLiqRegime(state.funding, state.oiDelta1h);
    let regVal = 0;
    if (regime.tone === "long") regVal = 0.6;
    else if (regime.tone === "short") regVal = -0.6;
    else if (regime.tone === "warn") regVal = -0.2 * Math.sign(state.funding || 1);
    out.push({
      label: "Funding + OI",
      value: regVal,
      weight: 0.8,
      note: regime.label,
      color: regVal > 0 ? "#2de0c0" : regVal < 0 ? "#ff5d7e" : "#5f7396",
    });

    // 4 · Order flow (CVD): pendiente reciente normalizada
    const cvd = state.cvd;
    if (cvd.length >= 2) {
      const last = cvd[cvd.length - 1];
      const prev = cvd[Math.max(0, cvd.length - 20)];
      const slope = last - prev;
      const tail = cvd.slice(-40);
      let mag = 0;
      for (const v of tail) mag += Math.abs(v);
      mag = mag / Math.max(1, tail.length) || 1;
      const cvdVal = clamp(slope / (mag * 1.5), -1, 1);
      out.push({
        label: "CVD (order flow)",
        value: cvdVal,
        weight: 0.9,
        note: `${
          cvdVal > 0.1 ? "flujo comprador" : cvdVal < -0.1 ? "flujo vendedor" : "flujo neutro"
        } reciente · CVD acumulado ${fmtCompact(last)}`,
        color: cvdVal > 0 ? "#2de0c0" : cvdVal < 0 ? "#ff5d7e" : "#5f7396",
      });
    }

    // 5 · Asimetría de pools: el precio tiende a cazar el lado con más liquidez
    const clusters = state.clusters;
    if (clusters.length) {
      let longLiq = 0, shortLiq = 0;
      for (const c of clusters) {
        if (c.side === "long") longLiq += c.sizeUsd;
        else shortLiq += c.sizeUsd;
      }
      const asym = shortLiq + longLiq > 0 ? (shortLiq - longLiq) / (shortLiq + longLiq) : 0;
      out.push({
        label: "Asimetría de pools",
        value: clamp(asym, -1, 1),
        weight: 0.7,
        note: asym > 0 ? "más liquidez arriba → imán alcista" : "más liquidez abajo → imán bajista",
        color: asym > 0 ? "#2de0c0" : asym < 0 ? "#ff5d7e" : "#5f7396",
      });
    }

    return out;
  }, [state, ind, confluence]);

  const { bias, conviction } = useMemo(() => {
    let num = 0, den = 0, conv = 0;
    for (const p of parts) {
      num += p.value * p.weight;
      den += p.weight;
      conv += Math.abs(p.value) * p.weight;
    }
    return {
      bias: den ? num / den : 0,
      conviction: den ? conv / den : 0,
    };
  }, [parts]);

  const dir: TrendDir = bias > 0.15 ? "alcista" : bias < -0.15 ? "bajista" : "lateral";
  const dirMeta =
    dir === "alcista"
      ? { label: "Sesgo alcista", text: "text-long-300", chip: "border-long-500/50 bg-long-900/40" }
      : dir === "bajista"
        ? { label: "Sesgo bajista", text: "text-short-300", chip: "border-short-500/50 bg-short-900/40" }
        : { label: "Sin sesgo claro", text: "text-mist-300", chip: "border-ink-600 bg-ink-800" };

  const biasPct = clamp(bias, -1, 1) * 100;
  const needleLeft = 50 + biasPct / 2;

  return (
    <section className="panel panel-corner anim-reveal" style={{ animationDelay: "0.01s" }}>
      <div className="flex flex-col gap-4 px-4 py-3.5 lg:flex-row lg:items-center lg:gap-8">
        {/* ---- veredicto ---- */}
        <div className="flex items-center gap-3 lg:w-[250px] lg:shrink-0">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center border"
            style={{
              borderColor: dir === "alcista" ? "#2de0c066" : dir === "bajista" ? "#ff5d7e66" : "#253650",
              background: dir === "alcista" ? "#2de0c012" : dir === "bajista" ? "#ff5d7e12" : "transparent",
            }}
          >
            {dir === "lateral" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8fa3c4" strokeWidth="2.4" strokeLinecap="round">
                <path d="M4 12 H20" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill={dir === "alcista" ? "#2de0c0" : "#ff5d7e"}>
                {dir === "alcista" ? <path d="M12 3 L22 20 H2 Z" /> : <path d="M12 21 L2 4 H22 Z" />}
              </svg>
            )}
          </div>
          <div className="leading-none">
            <div className="flex items-center gap-2 font-mono text-[8.5px] uppercase tracking-[0.2em] text-mist-600">
              Señal del radar
              <span
                className={`border px-1 py-px font-mono text-[7px] font-bold tracking-widest ${
                  market === "perp"
                    ? "border-long-500/40 bg-long-900/40 text-long-300"
                    : "border-mist-500/40 bg-ink-800 text-mist-400"
                }`}
                title={
                  market === "perp"
                    ? "Señal integrada con datos del perpetuo de Binance Futuros"
                    : "Señal integrada con datos del mercado SPOT"
                }
              >
                {market}
              </span>
            </div>
            <div className={`mt-1 font-display text-lg font-bold uppercase tracking-wide ${dirMeta.text}`}>
              {dirMeta.label}
            </div>
          </div>
        </div>

        {/* ---- medidor de sesgo + convicción ---- */}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
              Sesgo integrado · bajista ↔ alcista
            </span>
            <span className="font-mono text-[9px] text-mist-500">
              convicción{" "}
              <b className={`tick-num text-[11px] ${conviction > 0.5 ? "text-flare-300" : "text-mist-300"}`}>
                {(conviction * 100).toFixed(0)}%
              </b>
            </span>
          </div>
          <div className="relative h-3 overflow-hidden border border-ink-700 bg-ink-800">
            <div
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(90deg, rgba(240,62,99,0.75) 0%, rgba(240,62,99,0.25) 30%, rgba(37,54,80,0.6) 50%, rgba(20,196,166,0.25) 70%, rgba(45,224,192,0.75) 100%)",
              }}
            />
            <div className="absolute inset-y-0 left-[42.5%] w-[15%] border-x border-dashed border-ink-600/70" />
            <div
              className="absolute inset-y-0 w-[3px] -translate-x-1/2 transition-all duration-700 ease-out"
              style={{
                left: `${needleLeft}%`,
                background: "#eef4fd",
                boxShadow: "0 0 8px rgba(238,244,253,0.9)",
              }}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[7.5px] uppercase tracking-widest text-mist-600">
            <span className="text-short-400">bajista</span>
            <span>neutral</span>
            <span className="text-long-400">alcista</span>
          </div>
        </div>

        {/* ---- contribuciones ---- */}
        <div className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-3 lg:w-[330px] lg:grid-cols-1">
          {parts.map((p) => (
            <div key={p.label} className="flex items-center gap-2" title={p.note}>
              <span className="w-[108px] shrink-0 truncate font-mono text-[8px] uppercase tracking-wider text-mist-500">
                {p.label}
              </span>
              <DivergingBar v={p.value} color={p.color} />
              <span
                className={`tick-num w-[34px] shrink-0 text-right font-mono text-[8.5px] font-semibold ${
                  p.value > 0 ? "text-long-300" : p.value < 0 ? "text-short-300" : "text-mist-500"
                }`}
              >
                {p.value > 0 ? "+" : ""}
                {(p.value * 100).toFixed(0)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
