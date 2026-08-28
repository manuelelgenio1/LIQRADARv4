import { useMarketEngine } from "./hooks/useMarketEngine";
import TopBar from "./components/TopBar";
import TickerTape from "./components/TickerTape";
import HeatmapChart from "./components/HeatmapChart";
import RadarScope from "./components/RadarScope";
import OrderBookPanel from "./components/OrderBookPanel";
import ClusterList from "./components/ClusterList";
import { FundingOIPanel, DataQualityPanel } from "./components/MetricsPanels";
import MarketMakerPanel from "./components/MarketMakerPanel";
import LiquidationFeed from "./components/LiquidationFeed";

export default function App() {
  const engine = useMarketEngine();
  const { state, toasts, dismissToast } = engine;

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
      />
      <TickerTape livePrices={engine.livePrices} />

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 lg:px-6 lg:py-5">
        {/* fila 1: heatmap + radar */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          <div className="xl:col-span-8">
            <HeatmapChart
              state={state}
              tfKey={engine.tfKey}
              setTfKey={engine.setTfKey}
              timeframes={engine.timeframes}
            />
          </div>
          <div className="xl:col-span-4">
            <RadarScope state={state} />
          </div>
        </div>

        {/* fila 2: libro + clústeres + métricas */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
          <div className="xl:col-span-4">
            <OrderBookPanel state={state} live={engine.source === "live"} />
          </div>
          <div className="xl:col-span-4">
            <ClusterList state={state} />
          </div>
          <div className="space-y-4 md:col-span-2 xl:col-span-4">
            <FundingOIPanel state={state} />
            <DataQualityPanel state={state} />
          </div>
        </div>

        {/* fila 3: feed + market maker path */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          <div className="xl:col-span-7">
            <LiquidationFeed state={state} paused={engine.paused} />
          </div>
          <div className="xl:col-span-5">
            <MarketMakerPanel state={state} />
          </div>
        </div>

        <footer className="flex flex-col items-center justify-between gap-2 border-t border-ink-700/50 pb-4 pt-5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-mist-600 sm:flex-row">
          <span>
            <span className="text-long-400">◉</span> LIQRADAR v2.1 — radar de liquidez y liquidaciones
          </span>
          <span>
            {engine.source === "live"
              ? "precios, velas y libro en vivo · binance market data · liquidaciones estimadas por modelo"
              : engine.source === "sim"
                ? "sin conexión con binance · feed simulado con fines educativos"
                : "conectando con binance…"}{" "}
            · no es asesoramiento financiero
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
