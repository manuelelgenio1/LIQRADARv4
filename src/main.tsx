import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

// Capturadores globales: si algo falla fuera del ErrorBoundary (errores
// asíncronos), se muestra un mensaje en pantalla en lugar de dejarla en blanco.
function showFatal(label: string, msg: string) {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#04070d;padding:24px;font-family:monospace;">
      <div style="max-width:480px;border:1px solid rgba(240,62,99,0.6);background:#0e1729;padding:24px;color:#dbe6f7;">
        <div style="color:#ff93a9;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;font-size:13px;">${label}</div>
        <p style="margin-top:12px;font-size:12px;line-height:1.6;color:#8fa3c4;word-break:break-word;">${msg}</p>
        <button onclick="location.reload()" style="margin-top:20px;border:1px solid rgba(45,224,192,0.5);background:rgba(7,51,44,0.4);color:#7df0da;padding:8px 16px;cursor:pointer;letter-spacing:0.15em;text-transform:uppercase;font-size:11px;">Recargar</button>
      </div>
    </div>`;
}

window.addEventListener("error", (e) => {
  if (e.message) showFatal("Error interno del radar", `${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
  showFatal("Fallo de conexión de datos", String(e.reason?.message ?? e.reason ?? "No se pudieron cargar los datos del mercado."));
});

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
