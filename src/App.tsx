import React from "react";
import { useMarketEngine } from "./hooks/useMarketEngine";
import { useIndicators } from "./hooks/useIndicators";
import TopBar from "./components/TopBar";
import TickerTape from "./components/TickerTape";
import RadarSignalPanel from "./components/RadarSignalPanel";
import HeatmapChart from "./components/HeatmapChart";
import RadarScope from "./components/RadarScope";
import OrderBookPanel from "./components/OrderBookPanel";
import ClusterList from "./components/ClusterList";
import { FundingOIPanel, DataQualityPanel } from "./components/MetricsPanels";
import MarketMakerPanel from "./components/MarketMakerPanel";
import LiquidationFeed from "./components/LiquidationFeed";
import TrendConsensusPanel from "./components/TrendConsensusPanel";
import ValidationLab from "./components/ValidationLab";
import ConfluenceStrip from "./components/ConfluenceStrip";
import TradingViewPanel from "./components/TradingViewPanel";

// ---------- ErrorBoundary: nunca más una pantalla en blanco ----------
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center px-4">
          <div className="panel panel-corner w-full max-w-md px-6 py-8 text-center">
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" className="mx-auto text-flare-400">
              <circle cx="22" cy="22" r="19" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
              <path d="M22 12v12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              <circle cx="22" cy="30.5" r="1.6" fill="currentColor" />
            </svg>
            <h1 className="mt-4 font-display text-lg font-bold uppercase tracking-[0.14em] text-mist-100">
              Señal perdida
            </h1>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-mist-500">
              El radar encontró un error interno y dejó de emitir. Recarga para restablecer la conexión con el mercado.
            </p>
            <p className="mt-3 truncate border border-ink-700 bg-ink-900/70 px-3 py-2 font-mono text-[9.5px] text-short-300">
              {this.state.error.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 border border-long-500/50 bg-long-900/40 px-5 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-long-300 transition-colors hover:bg-long-900/70"
            >
              Recargar radar
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
  const { state, toasts, dismissToast } = engine;

  // Indicadores calculados UNA sola vez y compartidos por el Heatmap y el
  // panel de Consenso (antes cada uno los recalculaba por su cuenta).
  const { ind, cfg } = useIndicators(state, engine.tfKey, engine.calibration);

  // Confluencia con la temporalidad ACTIVA forzada a coincidir con el heatmap:
  // la entrada de tfKey se toma del mismo consenso (ind) que alimenta la
  // insignia del gráfico, así el chip activo y la insignia nunca difieren.
  const mergedConfluence = engine.confluence
    ? [
        ...engine.confluence.filter((c) => c.tf !== engine.tfKey),
        { tf: engine.tfKey, dir: ind.consensus.dir, strength: ind.consensus.strength },
      ].sort(
        (a, b) =>
          engine.timeframes.findIndex((t) => t.key === a.tf) -
          engine.timeframes.findIndex((t) => t.key === b.tf)
      )
    : null;

  return (
    <div className="min-h-screen font-body">
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
      />
      <TickerTape livePrices={engine.livePrices} paused={engine.paused} />

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 lg:px-6 lg:py-5">
        {/* franja de confluencia multi-timeframe */}
        <ConfluenceStrip
          confluence={mergedConfluence}
          symbol={engine.symbol}
          activeTf={engine.tfKey}
          updatedAt={engine.confluenceAt}
        />

        {/* señal integrada del radar (sesgo + convicción + contribuciones) */}
        <RadarSignalPanel state={state} ind={ind} confluence={mergedConfluence} />

        {/* fila 1: heatmap a ANCHO COMPLETO — todo el espacio de la fila para el gráfico */}
        <HeatmapChart
          state={state}
          tfKey={engine.tfKey}
          setTfKey={engine.setTfKey}
          timeframes={engine.timeframes}
          realCvd={engine.realCvd}
          ind={ind}
          cfg={cfg}
          confluence={mergedConfluence}
        />

        {/* fila 2: radar + consenso + market maker path — juntos bajo el heatmap */}
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-12">
          <div className="xl:col-span-4">
            <RadarScope state={state} />
          </div>
          <div className="xl:col-span-4">
            <TrendConsensusPanel
              state={state}
              tfKey={engine.tfKey}
              ind={ind}
              cfg={cfg}
              calibration={engine.calibration}
              setCalibration={engine.setCalibration}
              confluence={engine.confluence}
            />
          </div>
          <div className="md:col-span-2 xl:col-span-4">
            <MarketMakerPanel
              state={state}
              ind={ind}
              cfg={cfg}
              confluence={mergedConfluence}
            />
          </div>
        </div>

        {/* fila 3: feed + libro + clústeres — datos en vivo */}
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-12">
          <div className="xl:col-span-4">
            <LiquidationFeed state={state} paused={engine.paused} liqSource={engine.liqSource} />
          </div>
          <div className="xl:col-span-4">
            <OrderBookPanel state={state} live={engine.source === "live"} />
          </div>
          <div className="md:col-span-2 xl:col-span-4">
            <ClusterList state={state} />
          </div>
        </div>

        {/* fila 4: funding/OI + calidad de datos — lado a lado */}
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
          <FundingOIPanel state={state} sentiment={engine.sentiment} />
          <DataQualityPanel state={state} />
        </div>

        {/* fila 4: laboratorio de validación (track record + backtest histórico) */}
        <ValidationLab
          log={engine.poolLog}
          stats={engine.poolStats}
          symbol={engine.symbol}
          decimals={engine.meta.decimals}
          lastSync={engine.lastPoolSync}
          candles={state.warm ?? state.candles}
        />

        {/* gráfica interactiva de TradingView con los indicadores del radar (al final, con su propio espacio) */}
        <TradingViewPanel base={engine.meta.base} tfKey={engine.tfKey} />

        <footer className="flex flex-col items-center justify-between gap-2 border-t border-ink-700/50 pb-4 pt-5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-mist-600 sm:flex-row">
          <span>
            <span className="text-long-400">◉</span> LIQRADAR v2.1 — radar de liquidez y liquidaciones
          </span>
          <span>
            {engine.source === "live"
              ? engine.liqSource === "okx"
                ? "datos en vivo · binance (ws + rest) · liquidaciones reales OKX · CVD real (aggTrade)"
                : "datos en vivo · binance (ws + rest) · liquidaciones estimadas (marcadas EST) · validadas por el laboratorio"
              : engine.source === "sim"
                ? "modo simulado — sin conexión con binance · fines educativos"
                : "conectando con el mercado…"}
          </span>
        </footer>
      </main>

      {/* toasts de liquidaciones grandes */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[320px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`anim-toast pointer-events-auto border bg-ink-900/95 px-3.5 py-3 shadow-2xl backdrop-blur ${
              t.side === "long" ? "border-long-500/50" : "border-short-500/50"
            }`}
            style={{
              borderLeftWidth: 3,
              borderLeftColor: t.side === "long" ? "#2de0c0" : "#ff5d7e",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className={`flex items-center gap-1.5 font-display text-xs font-bold uppercase tracking-wider ${t.side === "long" ? "text-long-300" : "text-short-300"}`}>
                  <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden>
                    <path d="M6.5 0 L0 7.5 H4 L3.2 13 L11 5 H6.2 Z" />
                  </svg>
                  {t.title}
                </div>
                <div className="mt-1 font-mono text-[9.5px] leading-relaxed text-mist-500">{t.detail}</div>
              </div>
              <button
                onClick={() => dismissToast(t.id)}
                className="shrink-0 font-mono text-xs text-mist-600 transition-colors hover:text-mist-200"
                aria-label="Cerrar alerta"
              >
                ✕
              </button>
            </div>
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
