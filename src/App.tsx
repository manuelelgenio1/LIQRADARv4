import { Component, useMemo, type ReactNode } from "react";
import { useMarketEngine } from "./hooks/useMarketEngine";
import { useIndicators } from "./hooks/useIndicators";
import TopBar from "./components/TopBar";
import TickerTape from "./components/TickerTape";
import ConfluenceStrip from "./components/ConfluenceStrip";
import RadarSignalPanel from "./components/RadarSignalPanel";
import HeatmapChart from "./components/HeatmapChart";
import RadarScope from "./components/RadarScope";
import TrendConsensusPanel from "./components/TrendConsensusPanel";
import MarketMakerPanel from "./components/MarketMakerPanel";
import LiquidationFeed from "./components/LiquidationFeed";
import OrderBookPanel from "./components/OrderBookPanel";
import ClusterList from "./components/ClusterList";
import { FundingOIPanel, DataQualityPanel } from "./components/MetricsPanels";
import ValidationLab from "./components/ValidationLab";
import TradingViewPanel from "./components/TradingViewPanel";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-ink-950 p-6">
          <div className="max-w-md border border-short-500/60 bg-ink-900 p-6">
            <h1 className="font-display text-lg font-bold uppercase tracking-widest text-short-300">Algo salió mal</h1>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-mist-400">{this.state.error.message}</p>
            <button onClick={() => window.location.reload()}
              className="mt-4 border border-long-500/50 bg-long-900/40 px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-long-300 hover:bg-long-900/70">
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

  // confluencia fusionada: fuerza la TF activa a coincidir con el consenso del heatmap
  const mergedConfluence = useMemo(() => {
    if (!engine.confluence) return null;
    return engine.confluence.map((c) =>
      c.tf === engine.tfKey ? { ...c, dir: ind.consensus.dir, strength: ind.consensus.strength } : c
    );
  }, [engine.confluence, engine.tfKey, ind.consensus]);

  return (
    <div className="min-h-screen">
      <div className="ambient" />
      <TopBar
        meta={engine.state.meta}
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
        <ConfluenceStrip
          confluence={mergedConfluence}
          symbol={engine.symbol}
          activeTf={engine.tfKey}
          updatedAt={engine.confluenceAt}
          market={engine.market}
          error={engine.confluenceErr}
        />

        <RadarSignalPanel state={state} ind={ind} confluence={mergedConfluence} market={engine.market} />

        {/* Heatmap a ancho completo */}
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

        {/* Radar + Consenso + MM Path */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
          <MarketMakerPanel state={state} ind={ind} cfg={cfg} confluence={mergedConfluence} market={engine.market} />
        </div>

        {/* Liquidaciones + Libro + Clústeres */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <LiquidationFeed state={state} paused={engine.paused} liqSource={engine.liqSource} />
          <OrderBookPanel state={state} live={engine.source === "live"} market={engine.market} />
          <ClusterList state={state} market={engine.market} />
        </div>

        {/* Funding & OI + Calidad */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <FundingOIPanel state={state} sentiment={engine.sentiment} live={engine.source === "live"} />
          <DataQualityPanel state={state} source={engine.source} liqSource={engine.liqSource} market={engine.market} />
        </div>

        <ValidationLab
          log={engine.poolLog}
          stats={engine.poolStats}
          symbol={engine.symbol}
          decimals={engine.state.meta.decimals}
          lastSync={engine.lastPoolSync}
          market={engine.market}
          candles={state.candles}
        />

        <TradingViewPanel base={engine.state.meta.base} tfKey={engine.tfKey} market={engine.market} />
      </main>

      <footer className="border-t border-ink-700/50 bg-ink-900/70">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 px-4 py-3 lg:px-6">
          <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">
            LIQRADAR v2.1 · radar de liquidez y liquidaciones
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">
            {engine.source === "live"
              ? engine.liqSource === "okx"
                ? "datos en vivo · binance (ws + rest) · liquidaciones reales OKX · CVD real (aggTrade)"
                : "datos en vivo · binance (ws + rest) · liquidaciones estimadas · validadas por el laboratorio"
              : engine.source === "sim"
                ? "modo simulado — sin conexión con binance · fines educativos"
                : "conectando con el mercado…"}
          </span>
        </div>
      </footer>

      {/* toasts de alertas */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {engine.toasts.map((t) => (
          <div key={t.id}
            className={`anim-toast flex items-start gap-3 border bg-ink-900/95 px-4 py-3 shadow-2xl backdrop-blur-md ${
              t.side === "long" ? "border-long-500/60" : "border-short-500/60"
            }`}>
            <svg width="13" height="15" viewBox="0 0 11 13" fill={t.side === "long" ? "#2de0c0" : "#ff5d7e"} className="mt-0.5 shrink-0">
              <path d="M6.5 0 L0 7.5 H4 L3.2 13 L11 5 H6.2 Z" />
            </svg>
            <div className="min-w-0">
              <div className={`font-display text-xs font-bold uppercase tracking-wider ${t.side === "long" ? "text-long-300" : "text-short-300"}`}>
                {t.title}
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-mist-500">{t.detail}</div>
            </div>
            <button onClick={() => engine.dismissToast(t.id)} className="ml-2 shrink-0 font-mono text-[11px] text-mist-500 hover:text-mist-200">
              ✕
            </button>
          </div>
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
