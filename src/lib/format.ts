// Todos los formateadores son a prueba de NaN/Infinity: si el valor no es
// finito devuelven un valor neutro en lugar de "NaN" en pantalla.
const fin = (n: number, fb = 0): number => (Number.isFinite(n) ? n : fb);

export function fmtUsd(n: number, digits = 1): string {
  const v = fin(n);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(digits)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtCompact(n: number): string {
  const v = fin(n);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function fmtPrice(n: number, decimals: number): string {
  return fin(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(n: number, digits = 2): string {
  const v = fin(n);
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

// Porcentaje 0..100 a partir de una fracción 0..1, siempre finito.
export function pctOf(frac: number, digits = 0): string {
  return `${Math.round(fin(frac) * 100).toFixed(digits === 0 ? 0 : digits)}%`;
}

export function fmtClock(ts: number): string {
  const d = new Date(fin(ts, Date.now()));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function fmtHM(ts: number): string {
  const d = new Date(fin(ts, Date.now()));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

export function fmtAxisTime(ts: number, tfMinutes: number): string {
  const d = new Date(fin(ts, Date.now()));
  if (tfMinutes < 60) return fmtHM(ts);
  if (tfMinutes < 10080) return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
  return `${MESES[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(fin(ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(sec)}`;
}
