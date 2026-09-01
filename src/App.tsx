import { Component, useMemo, type ReactNode } from "react";
import { useMarketEngine, type Toast } from "./hooks/useMarketEngine";
import { useIndicators } from "./hooks/useIndicators";
import type { TrendDir } from "./lib/indicators";
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
import DataVault from "./components/DataVault";

// ---------- ErrorBoundary: ningún fallo interno deja la pantalla en blanco ----------
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-ink-950 p-6">
          <div className="max-w-md border border-short-500/60 bg-ink-900 p-6 text-center">
            <div className="font-display text-sm font-bold uppercase tracking-[0.2em] text-short-300">
              Error interno del radar
            </div>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-mist-400">
              {this.state.error.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 border border-long-500/50 bg-long-900/40 px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-long-300 hover:bg-long-900/70"
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

// ---------- Toasts de alertas de liquidación ----------
function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-20 z-[70] flex w-[320px] flex-col gap-2">
      {toasts.map((t) => {
        const long = t.side === "long";
        return (
          <div
            key={t.id}
            className={`anim-toast pointer-events-auto border bg-ink-900/95 p-3 shadow-2xl backdrop-blur-sm ${
              long ? "border-long-500/60" : "border-short-500/60"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className={`flex items-center gap-1.5 font-display text-[11px] font-bold uppercase tracking-wider ${long ? "text-long-300" : "text-short-300"}`}>
                <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden>
                  <path d="M6.5 0 L0 7.5 H4 L3.2 13 L11 5 H6.2 Z" />
                </svg>
                {t.title}
              </div>
              <button
                onClick={() => onDismiss(t.id)}
                className="shrink-0 font-mono text-[11px] text-mist-500 hover:text-mist-200"
                aria-label="Cerrar alerta"
              >
                ×
              </button>
            </div>
            <p className="mt-1 font-mono text-[9.5px] uppercase tracking-wider text-mist-500">{t.detail}</p>
          </div>
        );
      })}
    </div>
  );
}

function Dashboard() {
  const engine = useMarketEngine();
  const { state } = engine;
  const { ind, cfg } = useIndicators(state, engine.tfKey, engine.calibration);

  // Confluencia fusionada: la temporalidad activa se fuerza al MISMO consenso
  // que alimenta la insignia del heatmap, para que nunca difieran.
  const mergedConfluence = useMemo(() => {
    if (!engine.confluence) return null;
    const active: { tf: string; dir: TrendDir; strength: number } = {
      tf: engine.tfKey,
      dir: ind.consensus.dir,
      strength: ind.consensus.strength,
    };
    return [active, ...engine.confluence.filter((c) => c.tf !== engine.tfKey)];
  }, [engine.confluence, engine.tfKey, ind.consensus]);

  return (
    <div className="relative min-h-screen">
      <div className="ambient" aria-hidden />

      <TopBar
        meta={state.meta}
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
        {/* confluencia multi-timeframe */}
        <ConfluenceStrip
          confluence={mergedConfluence}
          symbol={engine.symbol}
          activeTf={engine.tfKey}
          market={engine.market}
          error={engine.confluenceErr}
        />

        {/* señal integrada del radar */}
        <RadarSignalPanel state={state} ind={ind} confluence={mergedConfluence} market={engine.market} />

        {/* heatmap de liquidaciones (protagonista, a ancho completo) */}
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

        {/* análisis: radar + consenso + market maker path */}
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

        {/* datos en vivo: feed + libro + clústeres */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <LiquidationFeed state={state} paused={engine.paused} liqSource={engine.liqSource} />
          <OrderBookPanel state={state} live={engine.source === "live"} market={engine.market} />
          <ClusterList state={state} market={engine.market} />
        </div>

        {/* métricas: funding/OI + calidad de datos */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <FundingOIPanel state={state} sentiment={engine.sentiment} live={engine.source === "live"} />
          <DataQualityPanel state={state} source={engine.source} liqSource={engine.liqSource} market={engine.market} />
        </div>

        {/* laboratorio de validación */}
        <ValidationLab
          log={engine.poolLog}
          stats={engine.poolStats}
          symbol={engine.symbol}
          decimals={state.meta.decimals}
          lastSync={engine.lastPoolSync}
          market={engine.market}
          candles={state.warm ?? state.candles}
        />

        {/* análisis clásico (TradingView) */}
        <TradingViewPanel base={state.meta.base} tfKey={engine.tfKey} market={engine.market} />
      </main>

      <footer className="border-t border-ink-700/50 bg-ink-900/60">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 px-4 py-4 font-mono text-[9px] uppercase tracking-widest text-mist-600 lg:px-6">
          <span>LIQRADAR v2.1 · radar de liquidez y liquidaciones</span>
          <span>
            {engine.source === "live"
              ? engine.liqSource === "okx"
                ? "datos en vivo · binance + liquidaciones reales OKX · CVD real (aggTrade)"
                : "datos en vivo · binance (ws + rest) · liquidaciones estimadas · validadas por el laboratorio"
              : engine.source === "sim"
                ? "modo simulado — sin conexión con binance · fines educativos"
                : "conectando con el mercado…"}
          </span>
          <DataVault />
        </div>
      </footer>

      <ToastStack toasts={engine.toasts} onDismiss={engine.dismissToast} />
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
