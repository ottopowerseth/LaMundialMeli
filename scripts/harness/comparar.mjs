import { readFileSync } from "node:fs";
const [, , dirA, dirB] = process.argv;
const nombres = (process.env.SOLICITUDES ?? "tablero_30d,tablero_120d,tablero_sept,metrics_sept,metrics_mes").split(",");
function diff(a, b, ruta, out) {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") { out.push({ ruta, a, b }); return; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push({ ruta, a: "[tipo]", b: "[tipo]" }); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ ruta: ruta + ".length", a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], ruta + "[" + i + "]", out);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) out.push({ ruta: ruta + "." + k, a: "(no existe)", b: "(nuevo)" });
    else if (!(k in b)) out.push({ ruta: ruta + "." + k, a: "(existe)", b: "(no existe)" });
    else diff(a[k], b[k], ruta + "." + k, out);
  }
}
for (const n of nombres) {
  const A = JSON.parse(readFileSync(dirA + "/" + n + ".json", "utf-8"));
  const B = JSON.parse(readFileSync(dirB + "/" + n + ".json", "utf-8"));
  const d = [];
  diff(A, B, "", d);
  // agrupar por la primera clave de primer y segundo nivel
  const grupos = {};
  for (const x of d) { const g = x.ruta.split(/[.\[]/).filter(Boolean).slice(0, 2).join("."); grupos[g] = (grupos[g] || 0) + 1; }
  console.log(`== ${n}: ${d.length} diferencias`, JSON.stringify(grupos));
  if (process.env.DETALLE) for (const x of d.slice(0, Number(process.env.DETALLE))) console.log("   ", x.ruta, JSON.stringify(x.a), "→", JSON.stringify(x.b));
}
