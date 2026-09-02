// Barras de métrica compartidas (0..1 y divergente -1..1).

export function MeterBar({
  v,
  color,
  height = 5,
  minPct = 0,
  track = "bg-ink-700/60",
}: {
  v: number;
  color: string;
  height?: number;
  minPct?: number;
  track?: string;
}) {
  const w = Number.isFinite(v) ? Math.max(minPct, Math.min(100, v * 100)) : 0;
  return (
    <div className={`h-[${height}px] flex-1 overflow-hidden ${track}`} style={{ height }}>
      <div
        className="h-full transition-all duration-700"
        style={{ width: `${w}%`, background: color, opacity: 0.85 }}
      />
    </div>
  );
}

export function DivergingBar({
  v,
  color,
  height = 5,
}: {
  v: number;
  color: string;
  height?: number;
}) {
  const safe = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return (
    <div className="relative flex-1 overflow-hidden bg-ink-700/60" style={{ height }}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-ink-600" />
      <span
        className="absolute inset-y-0 transition-all duration-700"
        style={{
          left: safe >= 0 ? "50%" : `${50 + safe * 50}%`,
          width: `${Math.abs(safe) * 50}%`,
          background: color,
          opacity: 0.85,
        }}
      />
    </div>
  );
}
