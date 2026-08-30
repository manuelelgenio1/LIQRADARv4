import { Component, useMemo, type ReactNode } from "react";
import { useMarketEngine } from "./hooks/useMarketEngine";
import { useIndicators } from "./hooks/useIndicators";
import TopBar from "./components/TopBar";
import TickerTape from "./components/TickerTape";
import HeatmapChart from "./components/HeatmapChart";
import RadarScope from "./components/RadarScope";
import OrderBookPanel from "./components/OrderBookPanel";
import ClusterList from "./components/ClusterList";
import { FundingOIPanel, DataQualityPanel } from "./components/MetricsPanels";
import MarketMakerPanel from "./components/MarketMakerPanel";
import LiquidationFeed from "./components/LiquidationFeed";
import TrendConsensusPanel from "./components/TrendConsensusPanel";
import ValidationLab from "./components/ValidationLab";
import TradingViewPanel from "./components/TradingViewPanel";
import RadarSignalPanel from "./components/RadarSignalPanel";
import ConfluenceStrip from "./components/ConfluenceStrip";

// ---------- ErrorBoundary: evita pantallas en blanco ante un error interno ----------
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-ink-950 px-6">
          <div className="panel max-w-md border-short-500/50 px-6 py-8 text-center">
            <div className="font-display text-lg font-bold uppercase tracking-widest text-short-300">
              Algo falló en el radar
            </div>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-mist-400">
              {this.state.error.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 border border-long-500/50 bg-long-900/40 px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-long-300 transition-all hover:bg-long-900/70"
            >
              Recargar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Dashboard() {
  const engine = useMarketEngine();
  const { state } = engine;
  const { ind, cfg } = useIndicators(state, engine.tfKey, engine.calibration);

  // Confluencia fusionada: la temporalidad activa se fuerza a coincidir con el
  // consenso del heatmap (mismo cálculo, misma ventana) para que nunca difieran.
  const mergedConfluence = useMemo(() => {
    const base = engine.confluence;
    if (!base) return base;
    return base.map((c) =>
      c.tf === engine.tfKey
        ? { ...c, dir: ind.consensus.dir, strength: ind.consensus.strength }
        : c
    );
  }, [engine.confluence, engine.tfKey, ind.consensus]);

  return (
    <div className="min-h-screen">
      <div className="ambient" aria-hidden />

      <TopBar
        meta={engine.meta}
        state={state}
        symbols={engine.symbols}
        symbol={engine.symbol}
        setSymbol={engine.setSymbol}
        paused={engine.paused}
        setPaused={engine.setPaused}
        source={engine.source}
        livePrices={engine.livePrices}
        alertsOn={engine.alertsOn}
        toggleAlerts={engine.toggleAlerts}
        market={engine.market}
        onMarket={engine.setMarket}
      />

      <TickerTape livePrices={engine.livePrices} paused={engine.paused} />

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 lg:px-6 lg:py-5">
        {/* franja de confluencia multi-timeframe */}
        <ConfluenceStrip
          confluence={mergedConfluence}
          symbol={engine.symbol}
          activeTf={engine.tfKey}
          updatedAt={engine.confluenceAt}
          market={engine.market}
        />

        {/* señal integrada del radar */}
        <RadarSignalPanel state={state} ind={ind} confluence={mergedConfluence} market={engine.market} />

        {/* Heatmap de liquidaciones a ANCHO COMPLETO */}
        <HeatmapChart
          state={state}
          tfKey={engine.tfKey}
          setTfKey={engine.setTfKey}
          timeframes={engine.timeframes}
          realCvd={engine.realCvd}
          ind={ind}
          cfg={cfg}
          confluence={mergedConfluence}
          market={engine.market}
        />

        {/* fila de análisis: radar + consenso + market maker path */}
        <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-3">
          <RadarScope state={state} />
          <TrendConsensusPanel
            state={state}
            tfKey={engine.tfKey}
            ind={ind}
            cfg={cfg}
            calibration={engine.calibration}
            setCalibration={engine.setCalibration}
            confluence={mergedConfluence}
            market={engine.market}
          />
          <MarketMakerPanel
            state={state}
            ind={ind}
            cfg={cfg}
            confluence={mergedConfluence}
            market={engine.market}
          />
        </div>

        {/* fila de datos en vivo: liquidaciones + libro + clústeres */}
        <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-3">
          <LiquidationFeed state={state} paused={engine.paused} liqSource={engine.liqSource} />
          <OrderBookPanel state={state} live={engine.source === "live"} market={engine.market} />
          <ClusterList state={state} market={engine.market} />
        </div>

        {/* fila de métricas: funding/OI + calidad de datos */}
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
          <FundingOIPanel state={state} sentiment={engine.sentiment} live={engine.source === "live"} />
          <DataQualityPanel
            state={state}
            source={engine.source}
            liqSource={engine.liqSource}
            market={engine.market}
          />
        </div>

        {/* laboratorio de validación */}
        <ValidationLab
          log={engine.poolLog}
          stats={engine.poolStats}
          symbol={engine.symbol}
          decimals={engine.meta.decimals}
          lastSync={engine.lastPoolSync}
          market={engine.market}
          candles={state.warm ?? state.candles}
        />

        {/* análisis clásico (TradingView) */}
        <TradingViewPanel base={engine.meta.base} tfKey={engine.tfKey} market={engine.market} />
      </main>

      <footer className="border-t border-ink-700/40 px-4 py-4 text-center">
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">
          LIQRADAR v4 · radar de liquidez y liquidaciones ·{" "}
          {engine.source === "live"
            ? engine.market === "perp"
              ? "datos en vivo · binance futuros (perp) + okx"
              : "datos en vivo · binance spot + okx"
            : "modo simulado — sin conexión"}{" "}
          · no es asesoría financiera
        </p>
      </footer>

      {/* toasts de alertas */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {engine.toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => engine.dismissToast(t.id)}
            className={`anim-toast pointer-events-auto border px-3 py-2.5 text-left shadow-2xl backdrop-blur-md ${
              t.side === "long"
                ? "border-long-500/60 bg-long-900/80"
                : "border-short-500/60 bg-short-900/80"
            }`}
          >
            <div
              className={`font-display text-[11px] font-bold uppercase tracking-wider ${
                t.side === "long" ? "text-long-300" : "text-short-300"
              }`}
            >
              {t.title}
            </div>
            <div className="mt-0.5 font-mono text-[9px] leading-relaxed text-mist-300">{t.detail}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Dashboard />
    </ErrorBoundary>
  );
}
