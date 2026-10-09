// Loader hooks: resuelve "@/..." contra HARNESS_ROOT y reemplaza axios, next/server,
// sheets y ml-token por stubs (grabación / reproducción).
import { pathToFileURL } from "url";
let ROOT = "", STUBS = "";
export async function initialize(data) { ROOT = data.root; STUBS = data.stubs; }
const stub = (n) => ({ url: pathToFileURL(STUBS + "/" + n).href, shortCircuit: true });
export async function resolve(spec, ctx, next) {
  if (spec === "axios") return stub("axios.mjs");
  if (spec === "next/server") return stub("next-server.mjs");
  if (spec === "@/lib/sheets") return stub("sheets.mjs");
  if (spec === "@/lib/ml-token") return stub("ml-token.mjs");
  if (spec.startsWith("@/")) return { url: pathToFileURL(ROOT + "/" + spec.slice(2) + ".ts").href, shortCircuit: true };
  return next(spec, ctx);
}
