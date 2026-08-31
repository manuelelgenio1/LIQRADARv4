// Barras de métrica compartidas.

interface MeterProps {
  v: number;             // 0..1
  color: string;
  height?: number;       // px
  minPct?: number;       // ancho mínimo visible (%)
  track?: string;        // clase del fondo
}

export function MeterBar({ v, color, height = 5, minPct = 0, track = "bg-ink-700/60" }: MeterProps) {
  const w = Number.isFinite(v) ? Math.max(minPct, Math.min(100, v * 100)) : 0;
  return (
    <span className={`relative flex-1 overflow-hidden ${track}`} style={{ height }}>
      <span
        className="absolute inset-y-0 left-0 transition-all duration-700"
        style={{ width: `${w}%`, background: color, opacity: 0.85 }}
      />
    </span>
  );
}

export function DivergingBar({ v, color, height = 5, track = "bg-ink-700/60" }: Omit<MeterProps, "minPct">) {
  const clamped = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return (
    <span className={`relative flex-1 overflow-hidden ${track}`} style={{ height }}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-ink-600" />
      <span
        className="absolute inset-y-0 transition-all duration-700"
        style={{
          left: clamped >= 0 ? "50%" : `${50 + clamped * 50}%`,
          width: `${Math.abs(clamped) * 50}%`,
          background: color,
          opacity: 0.85,
        }}
      />
    </span>
  );
}
