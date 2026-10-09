// axios mínimo (create().get) con grabación / reproducción por URL + params.
const H = () => globalThis.__H;
function clave(url, params) {
  const p = params ? Object.keys(params).sort().map((k) => k + "=" + params[k]).join("&") : "";
  return url + (p ? "?" + p : "");
}
function error(status, data) { const e = new Error("HTTP " + status); e.response = { status, data }; return e; }
const axios = {
  create(cfg) {
    return {
      async get(url, opts = {}) {
        const h = H();
        const k = clave(url, opts.params);
        if (h.mode === "replay") {
          const r = h.db.ml[k];
          if (!r) throw error(599, { harness: "url no grabada: " + k });
          if (r.status >= 400) throw error(r.status, r.data);
          return { data: JSON.parse(JSON.stringify(r.data)), status: r.status };
        }
        // record: GET real (solo lectura)
        const qs = opts.params ? "?" + new URLSearchParams(Object.fromEntries(Object.entries(opts.params).map(([a, b]) => [a, String(b)]))).toString() : "";
        const full = url.startsWith("http") ? url : (cfg?.baseURL ?? "") + url;
        const res = await fetch(full + (full.includes("?") && qs ? "&" + qs.slice(1) : qs), { headers: { Authorization: "Bearer " + h.token, ...(opts.headers ?? {}) } });
        if (res.status === 401) { console.error("401 -> me detengo"); process.exit(2); }
        let data = null; try { data = await res.json(); } catch { /* sin cuerpo */ }
        h.db.ml[k] = { status: res.status, data };
        if (res.status >= 400) throw error(res.status, data);
        return { data: JSON.parse(JSON.stringify(data)), status: res.status };
      },
    };
  },
};
export default axios;
