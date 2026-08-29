import type { TrendDir } from "../lib/indicators";

interface Item {
  tf: string;
  dir: TrendDir;
  strength: number;
}

interface Props {
  confluence: Item[] | null;
  symbol: string;
}

const DIR_META: Record<TrendDir, { label: string; arrow: string; c: string; bar: string }> = {
  alcista: { label: "Alcista", arrow: "▲", c: "text-long-300", bar: "#2de0c0" },
  bajista: { label: "Bajista", arrow: "▼", c: "text-short-300", bar: "#ff5d7e" },
  lateral: { label: "Lateral", arrow: "◆", c: "text-flare-300", bar: "#ffb224" },
};

export default function ConfluenceStrip({ confluence, symbol }: Props) {
  if (!confluence || !confluence.length) return null;

  const bulls = confluence.filter((c) => c.dir === "alcista").length;
  const bears = confluence.filter((c) => c.dir === "bajista").length;
  const total = confluence.length;
  const alignedBull = bulls >= Math.ceil(total * 0.8);
  const alignedBear = bears >= Math.ceil(total * 0.8);
  const aligned = alignedBull || alignedBear;
  const verdict = alignedBull ? "ALCISTA" : alignedBear ? "BAJISTA" : null;
  const verdictC = alignedBull ? "text-long-300" : "text-short-300";

  return (
    <section className="panel anim-reveal" style={{ animationDelay: "0.02s" }}>
      <div className="flex items-stretch">
        {/* etiqueta */}
        <div className="flex shrink-0 flex-col justify-center gap-1 border-r border-ink-700/50 px-4 py-2.5">
          <span className="font-display text-[11px] font-bold uppercase tracking-[0.16em] text-mist-100">
            Confluencia
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">
            multi-tf · {symbol}
          </span>
        </div>

        {/* celdas por temporalidad */}
        <div className="scroll-slim grid flex-1 auto-cols-fr grid-flow-col overflow-x-auto">
          {confluence.map((c) => {
            const m = DIR_META[c.dir];
            return (
              <div
                key={c.tf}
                className="group relative flex min-w-[92px] flex-col justify-center gap-1 border-r border-ink-700/30 px-3.5 py-2.5 transition-colors last:border-r-0 hover:bg-ink-750/50"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[10px] font-semibold tracking-widest text-mist-400">{c.tf}</span>
                  <span className={`font-mono text-[10px] ${m.c}`}>{m.arrow}</span>
                </div>
                <div className={`font-mono text-[9px] font-semibold uppercase tracking-wider ${m.c}`}>
                  {m.label}
                </div>
                <div className="h-1 overflow-hidden bg-ink-800">
                  <div
                    className="h-full transition-all duration-700"
                    style={{ width: `${Math.round(c.strength * 100)}%`, background: m.bar, opacity: 0.85 }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* veredicto de alineación */}
        <div className="flex shrink-0 items-center border-l border-ink-700/50 px-4">
          {aligned && verdict ? (
            <div className="flex flex-col items-end gap-0.5">
              <span className={`font-display text-sm font-bold uppercase tracking-[0.14em] ${verdictC}`}>
                Alineación {verdict}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">
                {Math.max(bulls, bears)}/{total} timeframes
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-0.5">
              <span className="font-display text-sm font-bold uppercase tracking-[0.14em] text-mist-500">
                Sin alineación
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">
                {bulls}↑ · {bears}↓ · {total - bulls - bears}◆
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
