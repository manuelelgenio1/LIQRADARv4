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
const HEIGHT_KEY = "liqradar:tvheight:v1";

// alturas predefinidas del gráfico (px) — más generosas para ver bien la gráfica
const HEIGHTS = [
  { id: "S", px: 620, label: "Compacta" },
  { id: "M", px: 820, label: "Normal" },
  { id: "L", px: 1080, label: "Grande" },
] as const;

function loadHeight(): (typeof HEIGHTS)[number]["id"] {
  try {
    const v = localStorage.getItem(HEIGHT_KEY);
    if (v === "S" || v === "M" || v === "L") return v;
  } catch { /* valor por defecto */ }
  return "M";
}

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

// inyecta el widget oficial en el contenedor indicado
function injectWidget(
  holder: HTMLDivElement,
  tvSymbol: string,
  tvInterval: string,
  studies: string[]
) {
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
}

function LoadingMark() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center bg-ink-900">
      <div className="flex flex-col items-center gap-3">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" className="text-long-400" style={{ animation: "radarSweep 1.8s linear infinite", transformOrigin: "18px 18px" }}>
          <path d="M18 18 L18 4 A14 14 0 0 1 30 11 Z" fill="currentColor" opacity="0.5" />
          <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
        </svg>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-mist-500">
          cargando gráfico de TradingView…
        </span>
        <span className="max-w-[280px] text-center font-mono text-[9px] leading-relaxed text-mist-600">
          si no aparece en unos segundos, revisa tu bloqueador de anuncios
        </span>
      </div>
    </div>
  );
}

export default function TradingViewPanel({ symbol, base, tfKey }: Props) {
  const [open, setOpen] = useState<boolean>(loadOpen);
  const [active, setActive] = useState<string[]>(loadStudies);
  const [heightId, setHeightId] = useState<(typeof HEIGHTS)[number]["id"]>(loadHeight);
  const [fs, setFs] = useState(false);
  const holderRef = useRef<HTMLDivElement>(null);
  const fsHolderRef = useRef<HTMLDivElement>(null);

  const heightPx = HEIGHTS.find((h) => h.id === heightId)?.px ?? 820;

  const tvInterval = TV_INTERVAL[tfKey] ?? "5";
  const tvSymbol = `BINANCE:${symbol}`;

  const studies = useMemo(
    () => STUDIES.filter((s) => active.includes(s.id)).map((s) => s.study),
    [active]
  );

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
  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, heightId);
    } catch { /* sin almacenamiento */ }
  }, [heightId]);

  // inyección del widget: va al contenedor activo (panel normal o pantalla completa)
  useEffect(() => {
    const holder = fs ? fsHolderRef.current : holderRef.current;
    if (!holder || !open) return;
    injectWidget(holder, tvSymbol, tvInterval, studies);
    return () => {
      holder.innerHTML = "";
      if (fsHolderRef.current) fsHolderRef.current.innerHTML = "";
    };
  }, [open, fs, tvSymbol, tvInterval, studies]);

  // ESC sale de pantalla completa + bloquea el scroll del fondo
  useEffect(() => {
    if (!fs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFs(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [fs]);

  const toggleStudy = (id: string) =>
    setActive((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  // chips de indicadores (reutilizados en la cabecera normal y en pantalla completa)
  const studyChips = (
    <>
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
    </>
  );

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
            {fs && <span className="text-long-400">· pantalla completa</span>}
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
          {studyChips}
        </div>

        {/* tamaño del gráfico */}
        <div className="flex items-stretch border border-ink-700 bg-ink-900/70" title="Altura del gráfico">
          {HEIGHTS.map((h, i) => (
            <button
              key={h.id}
              onClick={() => setHeightId(h.id)}
              className={`px-2.5 font-mono text-[10px] font-bold transition-colors ${
                i > 0 ? "border-l border-ink-700" : ""
              } ${
                heightId === h.id
                  ? "bg-long-500/20 text-long-300"
                  : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"
              }`}
              title={h.label}
            >
              {h.id}
            </button>
          ))}
        </div>

        {/* pantalla completa */}
        <button
          onClick={() => setFs((f) => !f)}
          className={`flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest transition-all ${
            fs
              ? "border-short-500/50 bg-short-900/50 text-short-300 hover:bg-short-900/80"
              : "border-flare-400/40 bg-flare-400/10 text-flare-300 hover:bg-flare-400/20"
          }`}
          title={fs ? "Salir de pantalla completa (ESC)" : "Ver la gráfica a pantalla completa"}
        >
          {fs ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {fs ? "Salir" : "Pantalla completa"}
        </button>

        {/* abrir / cerrar panel */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 border border-ink-600 bg-ink-800 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-mist-400 transition-all hover:text-mist-200"
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

      {open && !fs && (
        <div className="relative">
          <LoadingMark />
          {/* el widget oficial se inyecta aquí */}
          <div
            ref={holderRef}
            className="tradingview-widget-container relative z-10"
            style={{ height: heightPx }}
          />
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/50 bg-ink-900/50 px-4 py-2 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
        <span>
          {active.length} indicadores activos · velas japonesas · zona UTC ·{" "}
          {HEIGHTS.find((h) => h.id === heightId)?.label.toLowerCase()}
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

      {/* ---------- pantalla completa ---------- */}
      {fs && (
        <div className="fixed inset-0 z-50 flex flex-col bg-ink-950">
          <div className="flex flex-wrap items-center gap-3 border-b border-ink-700/60 bg-ink-900/90 px-4 py-2.5 backdrop-blur-md">
            <span className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
              TradingView <span className="text-long-400">·</span>{" "}
              <span className="text-long-300">{base}USDT</span>{" "}
              <span className="text-flare-300">{tfKey}</span>
            </span>
            <div className="scroll-slim ml-auto flex items-center gap-1.5 overflow-x-auto">
              {studyChips}
            </div>
            <button
              onClick={() => setFs(false)}
              className="flex items-center gap-1.5 border border-short-500/50 bg-short-900/50 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-short-300 transition-all hover:bg-short-900/80"
              title="Salir (ESC)"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Salir
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            <LoadingMark />
            <div
              ref={fsHolderRef}
              className="tradingview-widget-container relative z-10 h-full w-full"
            />
          </div>
          <div className="pointer-events-none flex items-center justify-center gap-3 border-t border-ink-700/60 bg-ink-900/90 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-mist-500">
            <span>los indicadores se cambian desde la barra superior</span>
            <span className="text-ink-600">·</span>
            <span><b className="text-mist-300">ESC</b> salir</span>
          </div>
        </div>
      )}
    </section>
  );
}
