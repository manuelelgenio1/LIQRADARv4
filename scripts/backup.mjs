#!/usr/bin/env node
// ============================================================
// LIQRADAR · sistema de snapshots del proyecto
// ------------------------------------------------------------
// Uso:
//   node scripts/backup.mjs                 → crea un snapshot nuevo
//   node scripts/backup.mjs list            → lista los snapshots
//   node scripts/backup.mjs diff <nombre>   → compara snapshot vs. actual
//   node scripts/backup.mjs restore <nombre>→ restaura un snapshot (pide confirmación)
//   node scripts/backup.mjs prune [n]       → conserva solo los últimos n (default 15)
//
// Sin dependencias externas (solo node:fs / node:path / node:readline).
// ============================================================
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUPS = path.join(ROOT, "backups");

// qué se respalda (todo lo que define el proyecto)
const TARGETS = ["src", "scripts", "index.html", "package.json", "tsconfig.json", "vite.config.js", "README.md"];
const IGNORE_DIRS = new Set(["node_modules", "dist", "backups", ".git"]);

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[36m${s}\x1b[0m`,
  d: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function copyRecursive(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function collectProjectFiles() {
  const files = [];
  for (const t of TARGETS) {
    const p = path.join(ROOT, t);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) {
      for (const f of walk(p)) files.push(f);
    } else {
      files.push(p);
    }
  }
  return files;
}

function snapshotName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `snap-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readManifest(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(BACKUPS, name, "MANIFEST.json"), "utf8"));
  } catch {
    return null;
  }
}

function listSnapshots() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs
    .readdirSync(BACKUPS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("snap-"))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// ---------- comandos ----------

function cmdCreate(label) {
  const name = snapshotName();
  const dest = path.join(BACKUPS, name);
  const files = collectProjectFiles();
  if (!files.length) {
    console.log(c.r("✗ No se encontró nada que respaldar."));
    process.exit(1);
  }
  for (const f of files) copyRecursive(f, path.join(dest, rel(f)));
  const manifest = {
    name,
    createdAt: new Date().toISOString(),
    label: label || null,
    files: files.length,
    sizeKB: Math.round(files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1024),
  };
  fs.writeFileSync(path.join(dest, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  console.log(`${c.g("✓ Snapshot creado")} ${c.bold(name)}`);
  console.log(c.d(`  ${files.length} archivos · ${manifest.sizeKB} KB → backups/${name}/`));
  if (label) console.log(c.d(`  etiqueta: "${label}"`));
  console.log(c.d(`  restaurar: node scripts/backup.mjs restore ${name}`));
}

function cmdList() {
  const snaps = listSnapshots();
  if (!snaps.length) {
    console.log(c.y("No hay snapshots todavía."));
    console.log(c.d("Crea uno con: node scripts/backup.mjs"));
    return;
  }
  console.log(c.bold(`\n  ${snaps.length} snapshot(s) en backups/\n`));
  for (const s of snaps) {
    const m = readManifest(s);
    const when = m ? new Date(m.createdAt).toLocaleString() : "?";
    const extra = m?.label ? c.b(` · "${m.label}"`) : "";
    console.log(`  ${c.g("●")} ${c.bold(s)}  ${c.d(when)}  ${c.d(`${m?.files ?? "?"} archivos · ${m?.sizeKB ?? "?"} KB`)}${extra}`);
  }
  console.log("");
}

function cmdDiff(name) {
  const snapDir = path.join(BACKUPS, name);
  if (!fs.existsSync(snapDir)) {
    console.log(c.r(`✗ Snapshot "${name}" no existe. Usa "list" para ver los disponibles.`));
    process.exit(1);
  }
  const snapFiles = new Map();
  for (const f of walk(snapDir)) {
    const r = rel(f).replace(/^.*?backups\//, "").replace(new RegExp(`^${name}/`), "");
    if (r === "MANIFEST.json") continue;
    snapFiles.set(r, fs.readFileSync(f));
  }
  const curFiles = new Map(collectProjectFiles().map((f) => [rel(f), fs.readFileSync(f)]));

  const added = [...curFiles.keys()].filter((k) => !snapFiles.has(k));
  const removed = [...snapFiles.keys()].filter((k) => !curFiles.has(k));
  const changed = [...curFiles.keys()].filter((k) => snapFiles.has(k) && !snapFiles.get(k).equals(curFiles.get(k)));

  console.log(c.bold(`\n  Diferencias: ${name} → actual\n`));
  if (!added.length && !removed.length && !changed.length) {
    console.log(c.g("  ✓ Sin cambios: el proyecto es idéntico al snapshot.\n"));
    return;
  }
  for (const f of added) console.log(`  ${c.g("+ nuevo    ")} ${f}`);
  for (const f of changed) console.log(`  ${c.y("~ cambiado ")} ${f}`);
  for (const f of removed) console.log(`  ${c.r("− borrado  ")} ${f}`);
  console.log(c.d(`\n  resumen: +${added.length} nuevos · ~${changed.length} cambiados · −${removed.length} borrados\n`));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim().toLowerCase()); }));
}

async function cmdRestore(name) {
  const snapDir = path.join(BACKUPS, name);
  if (!fs.existsSync(snapDir)) {
    console.log(c.r(`✗ Snapshot "${name}" no existe. Usa "list" para ver los disponibles.`));
    process.exit(1);
  }
  const m = readManifest(name);
  console.log(c.y(`\n  ⚠ Vas a RESTAURAR "${name}" (${m?.files ?? "?"} archivos, ${m ? new Date(m.createdAt).toLocaleString() : "?"}).`));
  console.log(c.d("  Se hará un snapshot automático del estado actual antes de sobrescribir.\n"));
  const ok = await ask(c.bold("  ¿Continuar? [s/N] "));
  if (ok !== "s" && ok !== "si" && ok !== "sí") {
    console.log(c.d("  Cancelado."));
    return;
  }
  // 1 · snapshot de seguridad del estado actual
  cmdCreate(`auto-antes-de-restaurar-${name}`);
  // 2 · restaurar
  let count = 0;
  for (const f of walk(snapDir)) {
    const r = rel(f);
    if (r.endsWith("MANIFEST.json")) continue;
    const target = path.join(ROOT, r.replace(new RegExp(`^backups/${name}/`), ""));
    copyRecursive(f, target);
    count++;
  }
  console.log(c.g(`\n✓ Restaurados ${count} archivos desde "${name}".`));
  console.log(c.d("  Si algo salió mal, el estado previo quedó guardado (busca el snapshot \"auto-antes-de-restaurar-…\").\n"));
}

function cmdPrune(keep) {
  const snaps = listSnapshots();
  if (snaps.length <= keep) {
    console.log(c.d(`Nada que limpiar: hay ${snaps.length} snapshots (límite ${keep}).`));
    return;
  }
  const toDelete = snaps.slice(keep);
  for (const s of toDelete) fs.rmSync(path.join(BACKUPS, s), { recursive: true, force: true });
  console.log(c.g(`✓ Eliminados ${toDelete.length} snapshots antiguos, conservados los últimos ${keep}.`));
}

// ---------- entrada ----------
const [cmd, arg, arg2] = process.argv.slice(2);
switch (cmd) {
  case undefined:
  case "create":
    cmdCreate(arg);
    break;
  case "list":
  case "ls":
    cmdList();
    break;
  case "diff":
    if (!arg) { console.log(c.r("Uso: node scripts/backup.mjs diff <nombre>")); process.exit(1); }
    cmdDiff(arg);
    break;
  case "restore":
    if (!arg) { console.log(c.r("Uso: node scripts/backup.mjs restore <nombre>")); process.exit(1); }
    await cmdRestore(arg);
    break;
  case "prune":
    cmdPrune(Number(arg2 ?? arg ?? 15));
    break;
  default:
    console.log(c.r(`Comando desconocido: "${cmd}"`));
    console.log(c.d("Disponibles: create · list · diff <nombre> · restore <nombre> · prune [n]"));
    process.exit(1);
}
