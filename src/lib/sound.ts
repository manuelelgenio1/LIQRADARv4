// ============================================================
// Sonido de liquidaciones millonarias (WebAudio, sin archivos).
// El AudioContext queda "suspendido" hasta el primer gesto del
// usuario (política de autoplay de los navegadores); un listener
// lo resume automáticamente con el primer click o tecla.
// ============================================================

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

function unlock(): void {
  const c = getCtx();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}

// Desbloquea el audio con el primer gesto del usuario (click o tecla).
if (typeof window !== "undefined") {
  const opts: AddEventListenerOptions = { once: true, passive: true };
  window.addEventListener("pointerdown", unlock, opts);
  window.addEventListener("keydown", unlock, opts);
}

/**
 * Sonido de liquidación > $1M: un golpe grave (el "impacto" de la
 * liquidación) seguido de una campanita aguda de dos parciales (el
 * "cha-ching" del dinero). Distintivo del blip de alerta normal.
 */
export function playMillionLiq(): void {
  const c = getCtx();
  if (!c) return;
  // Si sigue suspendido (aún sin gesto), intenta resumir; si no, salta sin error.
  if (c.state === "suspended") c.resume().catch(() => {});
  const t = c.currentTime;

  // ---- golpe grave descendente ----
  const thump = c.createOscillator();
  const thumpGain = c.createGain();
  thump.type = "sine";
  thump.frequency.setValueAtTime(180, t);
  thump.frequency.exponentialRampToValueAtTime(58, t + 0.24);
  thumpGain.gain.setValueAtTime(0.22, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  thump.connect(thumpGain);
  thumpGain.connect(c.destination);
  thump.start(t);
  thump.stop(t + 0.32);

  // ---- campanita aguda · parcial 1 ----
  const ching = c.createOscillator();
  const chingGain = c.createGain();
  ching.type = "triangle";
  ching.frequency.value = 1318.5; // E6
  chingGain.gain.setValueAtTime(0.0001, t);
  chingGain.gain.exponentialRampToValueAtTime(0.11, t + 0.02);
  chingGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  ching.connect(chingGain);
  chingGain.connect(c.destination);
  ching.start(t);
  ching.stop(t + 0.52);

  // ---- campanita aguda · parcial 2 (más brillante) ----
  const ching2 = c.createOscillator();
  const ching2Gain = c.createGain();
  ching2.type = "triangle";
  ching2.frequency.value = 1975.5; // B6
  ching2Gain.gain.setValueAtTime(0.0001, t);
  ching2Gain.gain.exponentialRampToValueAtTime(0.07, t + 0.05);
  ching2Gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  ching2.connect(ching2Gain);
  ching2Gain.connect(c.destination);
  ching2.start(t);
  ching2.stop(t + 0.62);
}
