// ============================================================
// Acceso seguro a localStorage: nunca lanza, siempre devuelve
// un valor válido (el fallback) si el almacenamiento falla o
// el dato está corrupto.
// ============================================================

export function readLS<T>(key: string, fallback: T, validate?: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw) as unknown;
    if (validate && !validate(v)) return fallback;
    return v as T;
  } catch {
    return fallback;
  }
}

export function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* almacenamiento no disponible */
  }
}
