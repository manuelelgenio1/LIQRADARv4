// Formateadores a prueba de NaN: ningún valor no finito llega a la pantalla.

export function fmtUsd(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(digits)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function fmtPrice(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function pctOf(v: number, digits = 0): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";
}

export function fmtClock(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function fmtHM(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

// Etiqueta del eje temporal según la temporalidad:
// intradía → HH:MM · diario → "12 May" · semanal → "May '25"
export function fmtAxisTime(ts: number, tfMinutes: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  if (tfMinutes < 60) return fmtHM(ts);
  if (tfMinutes < 10080) return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
  return `${MESES[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

// tiempo relativo ("12s", "3m", "1h 5m") — usado por el feed y el laboratorio
export function fmtAgo(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(sec)}`;
}
