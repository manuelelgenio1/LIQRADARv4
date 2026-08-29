import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  symbol: string;   // p. ej. "BTCUSDT"
  base: string;     // p. ej. "BTC"
  tfKey: string;    // temporalidad del radar: "1m" | "5m" | ... | "1D" | "1W"
}

// ---------- estudios disponibles en el widget oficial ----------
const STUDIES = [
  { id: "EMA", label: "EMA", study: "STD;EMA" },
  { id: "MACD", label: "MACD", study: "STD;MACD" },
  { id: "RSI", label: "RSI", study: "STD;RSI" },
  { id: "ADX", label: "ADX", study: "STD;ADX" },
  { id: "ATR", label: "ATR", study: "STD;ATR" },
  { id: "VWAP", label: "VWAP", study: "STD;VWAP" },
  { id: "ST", label: "Supertrend", study: "STD;Supertrend" },
  { id: "VP", label: "Vol. Profile", study: "STD;Volume Profile" },
] as const;

const DEFAULT_ON = ["EMA", "MACD", "RSI", "ADX", "ST"];

// temporalidad del radar → intervalo de TradingView
const TV_INTERVAL: Record<string, string> = {
  "1m": "1", "5m": "5", "15m": "15", "1H": "60", "4H": "240", "1D": "D", "1W": "W",
};

const OPEN_KEY = "liqradar:tvopen:v1";
const STUDY_KEY = "liqradar:tvstudies:v1";

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function loadStudies(): string[] {
  try {
    const raw = localStorage.getItem(STUDY_KEY);
    if (raw) {
      const p = JSON.parse(raw) as string[];
      const valid = p.filter((id) => STUDIES.some((s) => s.id === id));
      if (valid.length) return valid;
    }
  } catch {
    /* valores por defecto */
  }
  return [...DEFAULT_ON];
}

export default function TradingViewPanel({ symbol, base, tfKey }: Props) {
  const [open, setOpen] = useState<boolean>(loadOpen);
  const [active, setActive] = useState<string[]>(loadStudies);
  const holderRef = useRef<HTMLDivElement>(null);

  const tvInterval = TV_INTERVAL[tfKey] ?? "5";
  const tvSymbol = `BINANCE:${symbol}`;

  // persistencia de preferencias
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch { /* sin almacenamiento */ }
  }, [open]);
  useEffect(() => {
    try {
      localStorage.setItem(STUDY_KEY, JSON.stringify(active));
    } catch { /* sin almacenamiento */ }
  }, [active]);

  const studies = useMemo(
    () => STUDIES.filter((s) => active.includes(s.id)).map((s) => s.study),
    [active]
  );

  // inyección del widget oficial (se recarga al cambiar símbolo, TF o estudios)
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || !open) return;
    holder.innerHTML = "";

    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "100%";
    inner.style.width = "100%";
    holder.appendChild(inner);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval: tvInterval,
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "es",
      enable_publishing: false,
      backgroundColor: "rgba(10, 17, 32, 1)",
      gridColor: "rgba(26, 39, 64, 0.55)",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      studies,
      support_host: "https://www.tradingview.com",
    });
    holder.appendChild(script);

    return () => {
      holder.innerHTML = "";
    };
  }, [open, tvSymbol, tvInterval, studies]);

  const toggleStudy = (id: string) =>
    setActive((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <section className="panel panel-corner anim-reveal" style={{ animationDelay: "0.1s" }}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7df0da" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M7 13l3.5-4 3 2.5L18 6" />
            </svg>
            Análisis clásico · TradingView
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            gráfico interactivo · sincronizado con el radar ·{" "}
            <span className="text-long-300">{tvSymbol}</span> · <span className="text-flare-300">{tfKey}</span>
          </p>
        </div>

        {/* selector de indicadores pre-cargados */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
            indicadores
          </span>
          {STUDIES.map((s) => {
            const on = active.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleStudy(s.id)}
                className={`border px-2 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-wider transition-all duration-150 ${
                  on
                    ? "border-long-500/50 bg-long-900/40 text-long-300 shadow-[inset_0_-2px_0_rgba(45,224,192,0.5)]"
                    : "border-ink-700 bg-ink-850 text-mist-600 hover:border-ink-600 hover:text-mist-400"
                }`}
                title={on ? `Quitar ${s.label} del gráfico` : `Añadir ${s.label} al gráfico`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* abrir / cerrar panel */}
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest transition-all ${
            open
              ? "border-ink-600 bg-ink-800 text-mist-400 hover:border-ink-600 hover:text-mist-200"
              : "border-long-500/40 bg-long-900/30 text-long-300 hover:bg-long-900/60"
          }`}
          title={open ? "Ocultar la gráfica de TradingView" : "Mostrar la gráfica de TradingView"}
        >
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
            style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.25s" }}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {open ? "Ocultar" : "Abrir gráfica"}
        </button>
      </header>

      {open && (
        <div className="relative">
          {/* marcador mientras carga el widget */}
          <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center bg-ink-900">
            <div className="flex flex-col items-center gap-3">
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none" className="text-long-400" style={{ animation: "radarSweep 1.8s linear infinite", transformOrigin: "18px 18px" }}>
                <path d="M18 18 L18 4 A14 14 0 0 1 30 11 Z" fill="currentColor" opacity="0.5" />
                <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
              </svg>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-mist-500">
                cargando gráfico de TradingView…
              </span>
            </div>
          </div>
          {/* el widget oficial se inyecta aquí */}
          <div ref={holderRef} className="tradingview-widget-container relative z-10" style={{ height: 560 }} />
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/50 bg-ink-900/50 px-4 py-2 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
        <span>
          {active.length} indicadores activos · velas japonesas · zona UTC
        </span>
        <span>
          datos del gráfico por{" "}
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-mist-400 underline decoration-ink-600 underline-offset-2 transition-colors hover:text-long-300"
          >
            TradingView
          </a>
        </span>
      </footer>
    </section>
  );
}
