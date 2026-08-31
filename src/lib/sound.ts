// Sonidos con WebAudio (sin archivos externos).
// El navegador exige un gesto del usuario antes de reproducir audio:
// unlockAudio() se registra una vez y desbloquea con el primer click/tecla.

let ctx: AudioContext | null = null;
let unlocked = false;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended" && unlocked) void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  const unlock = () => {
    unlocked = true;
    const c = getCtx();
    if (c && c.state === "suspended") void c.resume();
  };
  window.addEventListener("pointerdown", unlock, { once: false });
  window.addEventListener("keydown", unlock, { once: false });
}

function tone(
  c: AudioContext,
  freq: number,
  t0: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  glideTo?: number
) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// blip corto de alerta (pools barridos / giros de Supertrend)
export function playAlertBlip(): void {
  const c = getCtx();
  if (!c || !unlocked) return;
  const t = c.currentTime;
  tone(c, 880, t, 0.12, "sine", 0.06, 1320);
  tone(c, 1760, t + 0.05, 0.1, "sine", 0.03);
}

// campana de liquidación millonaria: golpe grave + campanita aguda
export function playMillionLiq(): void {
  const c = getCtx();
  if (!c || !unlocked) return;
  const t = c.currentTime;
  tone(c, 220, t, 0.28, "triangle", 0.14, 90);
  tone(c, 1568, t + 0.16, 0.5, "sine", 0.07);
  tone(c, 2349, t + 0.16, 0.4, "sine", 0.035);
  tone(c, 1568, t + 0.42, 0.35, "sine", 0.04);
}
