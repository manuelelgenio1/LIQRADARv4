import { useEffect, useRef, useState } from "react";

interface Props {
  symbol: string; // BTCUSDT
  base: string;   // BTC
  tfKey: string;  // 5m
}

// estudios pre-cargados (los mismos indicadores del radar)
const STUDIES = [
  { id: "EMA", tv: "STD;EMA" },
  { id: "MACD", tv: "STD;MACD" },
  { id: "RSI", tv: "STD;RSI" },
  { id: "ADX", tv: "STD;ADX" },
  { id: "ATR", tv: "STD;ATR" },
  { id: "VWAP", tv: "STD;VWAP" },
  { id: "ST", tv: "STD;Supertrend" },
  { id: "VP", tv: "STD;Volume Profile" },
];

const TV_TF: Record<string, string> = {
  "1m": "1", "5m": "5", "15m": "15", "1H": "60", "4H": "240", "1D": "D", "1W": "W",
};

const OPEN_KEY = "liqradar:tvopen:v1";
const STUDY_KEY = "liqradar:tvstudies:v1";
const HEIGHT_KEY = "liqradar:tvheight:v1";

// modo compatible: embed clásico por iframe (dominio alternativo al widget)
const LEGACY_STUDIES: Record<string, string> = {
  EMA: "MASimple@tv-basicstudies",
  MACD: "MACD@tv-basicstudies",
  RSI: "RSI@tv-basicstudies",
  VWAP: "VWAP@tv-basicstudies",
  VP: "VolumeProfile@tv-basicstudies",
};

// alturas predefinidas del gráfico (px)
const HEIGHTS = [
  { id: "S", px: 640, label: "Compacta" },
  { id: "M", px: 900, label: "Normal" },
  { id: "L", px: 1200, label: "Grande" },
] as const;

type LoadMode = "widget" | "legacy" | "none";

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
      if (Array.isArray(p) && p.length) return p;
    }
  } catch {
    /* valores por defecto */
  }
  return ["EMA", "MACD", "RSI", "ADX", "ST"];
}
function loadHeight(): (typeof HEIGHTS)[number]["id"] {
  try {
    const v = localStorage.getItem(HEIGHT_KEY);
    if (v === "S" || v === "M" || v === "L") return v;
  } catch {
    /* valor por defecto */
  }
  return "L";
}

// URL directa a TradingView con símbolo y timeframe ya cargados
function tvUrl(base: string, tfKey: string): string {
  return `https://www.tradingview.com/chart/?symbol=BINANCE%3A${base}USDT&interval=${TV_TF[tfKey] ?? "5"}`;
}

function LoadingMark({ mode }: { mode: LoadMode }) {
  return (
    <div className="absolute inset-0 z-0 flex flex-col items-center justify-center gap-3 bg-ink-900/60">
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none" className="text-long-400">
        <circle cx="22" cy="22" r="18" stroke="currentColor" strokeWidth="1.4" opacity="0.4" />
        <g style={{ transformOrigin: "22px 22px", animation: "radarSweep 2.2s linear infinite" }}>
          <path d="M22 22 L22 5 A17 17 0 0 1 37 13.5 Z" fill="currentColor" opacity="0.35" />
        </g>
        <circle cx="22" cy="22" r="2" fill="currentColor" />
      </svg>
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-mist-500">
        {mode === "widget"
          ? "cargando widget de TradingView…"
          : mode === "legacy"
            ? "cargando modo compatible…"
            : "gráfica no disponible aquí"}
      </p>
    </div>
  );
}

export default function TradingViewPanel({ symbol, base, tfKey }: Props) {
  const [open, setOpen] = useState<boolean>(loadOpen);
  const [active, setActive] = useState<string[]>(loadStudies);
  const [heightId, setHeightId] = useState<(typeof HEIGHTS)[number]["id"]>(loadHeight);
  const [fullscreen, setFullscreen] = useState(false);
  const [mode, setMode] = useState<LoadMode>("widget");
  const holderRef = useRef<HTMLDivElement>(null);
  const fsHolderRef = useRef<HTMLDivElement>(null);

  const heightPx = HEIGHTS.find((h) => h.id === heightId)?.px ?? 1200;

  // persistencia de preferencias
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
      localStorage.setItem(STUDY_KEY, JSON.stringify(active));
      localStorage.setItem(HEIGHT_KEY, heightId);
    } catch {
      /* sin almacenamiento */
    }
  }, [open, active, heightId]);

  // ESC cierra la pantalla completa
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [fullscreen]);

  // inyección del widget oficial con ALTURA EXPLÍCITA medida del contenedor.
  // Si el script no carga (bloqueador de anuncios, red…), el watchdog de 7 s
  // cae al modo compatible (iframe de otro dominio).
  useEffect(() => {
    if (!open && !fullscreen) return;
    const holder = fullscreen ? fsHolderRef.current : holderRef.current;
    if (!holder) return;

    setMode("widget");
    holder.innerHTML = "";

    const inject = () => {
      const rect = holder.getBoundingClientRect();
      const h = Math.max(320, Math.floor(rect.height));
      const inner = document.createElement("div");
      inner.className = "tradingview-widget-container__widget";
      inner.style.height = `${h}px`;
      inner.style.width = "100%";
      holder.appendChild(inner);

      const s = document.createElement("script");
      s.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
      s.type = "text/javascript";
      s.async = true;
      s.innerHTML = JSON.stringify({
        autosize: false,
        height: h,
        width: "100%",
        symbol: `BINANCE:${base}USDT`,
        interval: TV_TF[tfKey] ?? "5",
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "es",
        backgroundColor: "rgba(7, 12, 22, 1)",
        gridColor: "rgba(26, 39, 64, 0.5)",
        hide_top_toolbar: false,
        hide_legend: false,
        withdateranges: true,
        allow_symbol_change: true,
        studies: STUDIES.filter((st) => active.includes(st.id)).map((st) => st.tv),
        support_host: "https://www.tradingview.com",
      });
      s.onerror = () => setMode("legacy");
      holder.appendChild(s);
    };

    // medir tras un frame, cuando el contenedor ya tiene su tamaño definitivo
    const raf = requestAnimationFrame(inject);

    // watchdog: si en 7 s no apareció el iframe del widget → modo compatible
    const dog = window.setTimeout(() => {
      if (!holder.querySelector("iframe")) setMode("legacy");
    }, 7000);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(dog);
    };
  }, [open, fullscreen, base, tfKey, active]);

  // iframe del modo compatible
  const legacySrc = `https://s.tradingview.com/widgetembed/?frameElementId=tv-liqradar&symbol=BINANCE%3A${base}USDT&interval=${
    TV_TF[tfKey] ?? "5"
  }&hidesidetoolbar=0&symboledit=1&theme=dark&style=1&locale=es&studies=${encodeURIComponent(
    STUDIES.filter((st) => active.includes(st.id) && LEGACY_STUDIES[st.id])
      .map((st) => LEGACY_STUDIES[st.id])
      .join(",")
  )}`;

  const body = (isFs: boolean) =>
    mode === "legacy" ? (
      <iframe
        title="TradingView (modo compatible)"
        src={legacySrc}
        className="relative z-10 h-full w-full border-0"
        allow="fullscreen"
      />
    ) : (
      <>
        <LoadingMark mode={mode} />
        <div
          ref={isFs ? fsHolderRef : holderRef}
          className="tradingview-widget-container relative z-10 h-full w-full"
        />
      </>
    );

  return (
    <>
      <section className="panel anim-reveal" style={{ animationDelay: "0.66s" }}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-700/50 px-4 py-3">
          <div className="leading-none">
            <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
              Análisis clásico · TradingView
              <span
                className={`border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest ${
                  mode === "widget"
                    ? "border-long-500/50 bg-long-900/40 text-long-300"
                    : mode === "legacy"
                      ? "border-flare-400/50 bg-flare-400/10 text-flare-300"
                      : "border-ink-600 bg-ink-800 text-mist-500"
                }`}
              >
                {mode === "widget" ? "widget oficial" : mode === "legacy" ? "modo compatible" : "—"}
              </span>
            </h2>
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
              {base}USDT · {tfKey} · sincronizado con el radar
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* selector de indicadores */}
            <div className="flex flex-wrap items-center border border-ink-700 bg-ink-850/80">
              {STUDIES.map((st) => {
                const on = active.includes(st.id);
                return (
                  <button
                    key={st.id}
                    onClick={() =>
                      setActive((p) => (on ? p.filter((x) => x !== st.id) : [...p, st.id]))
                    }
                    className={`px-2 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider transition-all duration-150 ${
                      on
                        ? "bg-long-500/15 text-long-300 shadow-[inset_0_-2px_0_rgba(45,224,192,0.55)]"
                        : "text-mist-600 hover:bg-ink-750 hover:text-mist-400"
                    }`}
                    title={st.tv}
                  >
                    {st.id}
                  </button>
                );
              })}
            </div>

            {/* selector de altura */}
            <div className="flex items-center border border-ink-700 bg-ink-850/80" title="Altura del gráfico">
              {HEIGHTS.map((h) => (
                <button
                  key={h.id}
                  onClick={() => setHeightId(h.id)}
                  className={`px-2 py-1.5 font-mono text-[9px] font-bold transition-colors ${
                    h.id === heightId
                      ? "bg-mist-200/15 text-mist-100"
                      : "text-mist-600 hover:bg-ink-750 hover:text-mist-400"
                  }`}
                >
                  {h.id}
                </button>
              ))}
            </div>

            <button
              onClick={() => setFullscreen(true)}
              className="flex items-center gap-1.5 border border-flare-400/40 bg-flare-400/10 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-flare-300 transition-all hover:bg-flare-400/20"
              title="Ver la gráfica a pantalla completa"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Pantalla completa
            </button>

            <button
              onClick={() => setOpen(!open)}
              className="flex items-center gap-1.5 border border-ink-700 bg-ink-850/80 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-mist-400 transition-all hover:border-ink-600 hover:text-mist-200"
              title={open ? "Ocultar el panel" : "Mostrar el panel"}
            >
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                className={`transition-transform duration-200 ${open ? "" : "rotate-180"}`}
              >
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {open ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        </header>

        {open && (
          <div className="relative bg-ink-900/40">
            <div className="relative w-full" style={{ height: heightPx }}>
              {body(false)}
            </div>
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/50 bg-ink-900/50 px-4 py-2 font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
          <span>
            widget oficial de TradingView · mismo símbolo y temporalidad del radar
            {mode === "legacy" && " · (embed alternativo porque el widget oficial no cargó)"}
          </span>
          <a
            href={tvUrl(base, tfKey)}
            target="_blank"
            rel="noreferrer"
            className="border border-ink-700 bg-ink-850 px-2 py-1 text-mist-400 transition-colors hover:border-long-500/40 hover:text-long-300"
          >
            ¿no se ve? abrir en TradingView ↗
          </a>
        </footer>
      </section>

      {/* ---- pantalla completa ---- */}
      {fullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-ink-950">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-700/60 bg-ink-900/90 px-4">
            <span className="font-display text-xs font-bold uppercase tracking-[0.18em] text-mist-100">
              Análisis clásico · <span className="text-long-400">{base}USDT</span> · {tfKey}
            </span>
            <div className="scroll-slim ml-auto flex items-center gap-1 overflow-x-auto">
              {STUDIES.map((st) => {
                const on = active.includes(st.id);
                return (
                  <button
                    key={st.id}
                    onClick={() =>
                      setActive((p) => (on ? p.filter((x) => x !== st.id) : [...p, st.id]))
                    }
                    className={`shrink-0 border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider transition-colors ${
                      on
                        ? "border-long-500/50 bg-long-900/40 text-long-300"
                        : "border-ink-700 bg-ink-850 text-mist-600 hover:text-mist-400"
                    }`}
                  >
                    {st.id}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setFullscreen(false)}
              className="flex shrink-0 items-center gap-1.5 border border-short-500/50 bg-short-900/50 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-short-300 transition-all hover:bg-short-900/80"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Salir · ESC
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            {body(true)}
          </div>
        </div>
      )}
    </>
  );
}
