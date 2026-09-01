import { useEffect, useRef, useState } from "react";
import type { PoolRecord } from "../lib/validation";

// Respaldo de los datos de la app (viven en localStorage del navegador):
// track record del laboratorio, calibración, preferencias de paneles, etc.
// El respaldo del CÓDIGO es aparte: `node scripts/backup.mjs`.

const PREFIX = "liqradar:";
const LAST_KEY = "liqradar:vaultlast:v1";

interface VaultFile {
  app: "LIQRADAR";
  version: 1;
  exportedAt: string;
  data: Record<string, string>;
}

function collectData(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && k !== LAST_KEY) out[k] = localStorage.getItem(k) ?? "";
    }
  } catch {
    /* sin almacenamiento */
  }
  return out;
}

function poolCount(data: Record<string, string>): number {
  try {
    const raw = data["liqradar:poolog:v1"];
    if (!raw) return 0;
    const p = JSON.parse(raw) as PoolRecord[];
    return Array.isArray(p) ? p.length : 0;
  } catch {
    return 0;
  }
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function DataVault() {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [lastExport, setLastExport] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(LAST_KEY)) || 0;
    } catch {
      return 0;
    }
  });
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!confirmWipe) return;
    const t = window.setTimeout(() => setConfirmWipe(false), 3500);
    return () => window.clearTimeout(t);
  }, [confirmWipe]);

  const data = collectData();
  const pools = poolCount(data);
  const prefs = Object.keys(data).length;

  const doExport = () => {
    try {
      const file: VaultFile = { app: "LIQRADAR", version: 1, exportedAt: new Date().toISOString(), data };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      a.download = `liqradar-datos-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      const now = Date.now();
      setLastExport(now);
      try {
        localStorage.setItem(LAST_KEY, String(now));
      } catch {
        /* sin almacenamiento */
      }
      setFlash("ok");
    } catch {
      setFlash("err");
    }
  };

  const doImport = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as VaultFile;
        if (parsed.app !== "LIQRADAR" || typeof parsed.data !== "object") throw new Error("formato");
        let n = 0;
        for (const [k, v] of Object.entries(parsed.data)) {
          if (k.startsWith(PREFIX) && typeof v === "string") {
            localStorage.setItem(k, v);
            n++;
          }
        }
        if (!n) throw new Error("vacío");
        setFlash("ok");
        // recarga para que todos los paneles lean los datos restaurados
        window.setTimeout(() => window.location.reload(), 900);
      } catch {
        setFlash("err");
      }
    };
    reader.readAsText(f);
  };

  const doWipe = () => {
    if (!confirmWipe) {
      setConfirmWipe(true);
      return;
    }
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch {
      /* sin almacenamiento */
    }
    window.setTimeout(() => window.location.reload(), 400);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`relative flex items-center gap-2 border px-2.5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-all ${
          open
            ? "border-long-500/50 bg-long-900/40 text-long-300"
            : "border-ink-700 bg-ink-850/80 text-mist-500 hover:border-ink-600 hover:text-mist-300"
        }`}
        title="Respaldo de los datos de la app (laboratorio y preferencias)"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="5" rx="1" />
          <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
          <path d="M10 13h4" />
        </svg>
        <span className="hidden xl:inline">Respaldo</span>
        {pools > 0 && (
          <span className="tick-num absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-long-500/60 bg-ink-900 px-1 font-mono text-[8px] font-bold text-long-300">
            {pools}
          </span>
        )}
      </button>

      {open && (
        <div className="anim-feed-in absolute right-0 top-full z-40 mt-2 w-[320px] border border-ink-600 bg-ink-900/95 shadow-2xl backdrop-blur-md">
          {/* cabecera */}
          <div className="flex items-center gap-2 border-b border-ink-700/60 px-3.5 py-2.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2de0c0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="5" rx="1" />
              <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
              <path d="M10 13h4" />
            </svg>
            <span className="font-display text-[11px] font-bold uppercase tracking-[0.16em] text-mist-100">
              Respaldo de datos
            </span>
            {flash === "ok" && (
              <span className="ml-auto flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-long-300">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M4 12l6 6L20 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                listo
              </span>
            )}
            {flash === "err" && (
              <span className="ml-auto font-mono text-[9px] font-bold uppercase tracking-wider text-short-300">error</span>
            )}
          </div>

          {/* inventario */}
          <div className="grid grid-cols-2 divide-x divide-ink-700/60 border-b border-ink-700/60">
            <div className="px-3.5 py-2.5">
              <div className="tick-num font-display text-lg font-bold leading-none text-long-300">{pools}</div>
              <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.16em] text-mist-600">
                pools del laboratorio
              </div>
            </div>
            <div className="px-3.5 py-2.5">
              <div className="tick-num font-display text-lg font-bold leading-none text-mist-200">{prefs}</div>
              <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.16em] text-mist-600">
                claves guardadas
              </div>
            </div>
          </div>

          {/* acciones */}
          <div className="flex flex-col gap-1.5 px-3.5 py-3">
            <button
              onClick={doExport}
              className="flex items-center justify-center gap-2 border border-long-500/50 bg-long-900/40 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-long-300 transition-all hover:bg-long-900/70"
              title="Descarga un .json con todo el track record y las preferencias"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              Exportar (.json)
            </button>

            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center justify-center gap-2 border border-ink-600 bg-ink-850 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-mist-300 transition-all hover:border-mist-500/50 hover:text-mist-100"
              title="Carga un respaldo .json exportado anteriormente"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15V3m0 0 4 4m-4-4-4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              Restaurar archivo
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doImport(f);
                e.target.value = "";
              }}
            />

            <button
              onClick={doWipe}
              className={`flex items-center justify-center gap-2 border px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition-all ${
                confirmWipe
                  ? "border-short-500 bg-short-900/70 text-short-300"
                  : "border-ink-700 bg-transparent text-mist-600 hover:border-short-500/40 hover:text-short-300"
              }`}
              title="Elimina el track record y las preferencias de este navegador"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              </svg>
              {confirmWipe ? "¿Seguro? clic otra vez" : "Borrar datos"}
            </button>
          </div>

          {/* pie */}
          <div className="border-t border-ink-700/60 bg-ink-950/50 px-3.5 py-2.5">
            <div className="flex items-center justify-between font-mono text-[8.5px] text-mist-600">
              <span>Último respaldo</span>
              <span className="tick-num text-mist-400">{lastExport ? fmtWhen(lastExport) : "—"}</span>
            </div>
            <p className="mt-1.5 font-mono text-[8px] leading-relaxed text-mist-600">
              Guarda tu track record si cambias de navegador o de equipo. El{" "}
              <b className="text-mist-400">código</b> se respalda aparte con{" "}
              <code className="text-long-300">node scripts/backup.mjs</code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
