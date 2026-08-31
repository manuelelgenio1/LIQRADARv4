interface Props {
  v: number; // 0..1
  color: string;
  height?: number;
  minPct?: number;
  track?: string;
}

export function MeterBar({ v, color, height = 5, minPct = 0, track = "bg-ink-700/60" }: Props) {
  const pct = Number.isFinite(v) ? Math.max(minPct, Math.min(100, v * 100)) : 0;
  return (
    <div className={`h-[${height}px] flex-1 overflow-hidden rounded-sm ${track}`} style={{ height }}>
      <div
        className="h-full rounded-sm transition-all duration-700"
        style={{ width: `${pct}%`, background: color, opacity: 0.85 }}
      />
    </div>
  );
}

interface DivProps {
  v: number; // -1..1
  color: string;
}

export function DivergingBar({ v, color }: DivProps) {
  const val = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return (
    <span className="relative h-[5px] flex-1 overflow-hidden bg-ink-700/60">
      <span className="absolute inset-y-0 left-1/2 w-px bg-ink-600" />
      <span
        className="absolute inset-y-0 transition-all duration-700"
        style={{
          left: val >= 0 ? "50%" : `${50 + val * 50}%`,
          width: `${Math.abs(val) * 50}%`,
          background: color,
          opacity: 0.85,
        }}
      />
    </span>
  );
}
