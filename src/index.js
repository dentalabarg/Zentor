// Intermediario YiQi -> Zentor (Dentalab)
// Lee los costos de compra de YiQi (smarties ARS y USD) y los carga en Zentor
// por su servidor MCP (disponible en todos los planes de Zentor).

const YIQI_BASE = "https://api.yiqi.com.ar";
const ZENTOR_API = "https://api.zentor.io/api";
const ZENTOR_MCP = "https://api.zentor.io/api/mcp";
const MAX_PAGINAS = 300;
const LOTE_ZENTOR = 2000;
const ENTIDADES_BOM = ["BOM", "LISTA_DE_MATERIALES", "BOM_ARTICULO", "FORMULA", "RECETA", "KIT", "COMBO", "PRECIO_ARTICULO_COMP"];
const COSTO_MIN_USD = 1;
const COSTO_MIN_ARS = 100;

// ---------------------------------------------------------------- utilidades

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function parseNum(v) {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  let s = String(v).trim().replace(/[^\d.,-]/g, "");
  if (!s) return NaN;
  // "1.234,56" -> 1234.56 ; "1,234.56" -> 1234.56
  const lc = s.lastIndexOf(","), lp = s.lastIndexOf(".");
  if (lc > lp) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  return Number(s);
}

const ALICUOTAS = [0, 10.5, 21, 27];
function calcularIva(neto, final) {
  if (!(neto > 0) || !(final > 0)) return { iva: null, aviso: "sin neto/final para calcular IVA" };
  const pct = (final / neto - 1) * 100;
  let mejor = null;
  for (const a of ALICUOTAS) if (Math.abs(pct - a) <= 0.6 && (mejor === null || Math.abs(pct - a) < Math.abs(pct - mejor))) mejor = a;
  if (mejor === null) return { iva: Math.round(pct * 100) / 100, aviso: `IVA raro: ${pct.toFixed(2)}%` };
  return { iva: mejor, aviso: null };
}

function html(titulo, cuerpo, status = 200) {
  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
<style>
:root{--bg:#f6f7f9;--fg:#1d2330;--card:#fff;--mut:#5b6475;--ok:#11734b;--bad:#b42318;--acc:#1f5fd1}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e7eaf0;--card:#1d222a;--mut:#9aa3b2;--ok:#4cc38a;--bad:#ff8a80;--acc:#7aa7ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border-radius:12px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px #0002}
h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:0 0 8px}
.mut{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}
label{display:block;margin:10px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #8884;background:var(--bg);color:var(--fg);font-size:15px}
button,.btn{display:inline-block;margin-top:14px;padding:10px 16px;border:0;border-radius:8px;background:var(--acc);color:#fff;font-size:15px;cursor:pointer;text-decoration:none}
code,pre{font-family:ui-monospace,monospace;font-size:13px}
pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);padding:10px;border-radius:8px;max-height:420px;overflow:auto}
pre.full{max-height:none}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #8883;padding:4px 6px;text-align:left}
.secret{font-size:16px;font-weight:700;user-select:all;background:var(--bg);padding:8px;border-radius:6px;display:block;word-break:break-all}
</style></head><body><main>${cuerpo}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

function iguales(a, b) {
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hashClave(clave) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("dentalab-panel:" + String(clave).trim()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sesionOk(env, request, url) {
  const real = String(env.CLAVE_PANEL || "").trim();
  if (!real) return false;
  const dada = (url.searchParams.get("clave") || "").trim();
  if (dada && iguales(real, dada)) return true;
  const cookie = (request.headers.get("cookie") || "").match(/(?:^|;\s*)panel=([a-f0-9]{64})/);
  return !!cookie && iguales(await hashClave(real), cookie[1]);
}

function paginaEntrar(error = "") {
  return html("Entrar", `<h1>Panel YiQi → Zentor</h1>
${error}
<form class="card" method="post" action="/entrar">
<label>Clave del panel</label><input name="clave" type="password" required autofocus>
<button type="submit">Entrar</button></form>`, error ? 401 : 200);
}

// ---------------------------------------------------------------- YiQi

async function yiqiLogin(env) {
  if (!env.YIQI_USUARIO || !env.YIQI_CLAVE) throw new Error("Faltan los secretos YIQI_USUARIO y/o YIQI_CLAVE en Cloudflare.");
  const r = await fetch(`${YIQI_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", username: env.YIQI_USUARIO, password: env.YIQI_CLAVE }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`YiQi rechazó el login (HTTP ${r.status}): ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  if (!j.access_token) throw new Error("YiQi no devolvió access_token.");
  return j.access_token;
}

async function yiqiSmartie(env, token, smartieId, maxPaginas = MAX_PAGINAS, entidad = "PRECIO_ARTICULO_COMP") {
  const filas = [];
  let columnas = null, total = null, filasPorPagina = null, paginas = 0;
  for (let page = 1; page <= maxPaginas; page++) {
    const u = new URL(`${YIQI_BASE}/api/public/${entidad}/smartie`);
    u.searchParams.set("smartieId", smartieId);
    u.searchParams.set("schemaId", env.YIQI_SCHEMA_ID);
    u.searchParams.set("page", String(page));
    u.searchParams.set("pageSize", "500");
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    const txt = await r.text();
    if (!r.ok) throw new Error(`YiQi smartie ${smartieId} página ${page} (HTTP ${r.status}): ${txt.slice(0, 300)}`);
    const j = JSON.parse(txt);
    if (!columnas) columnas = j.columns || [];
    if (total === null) total = j.total ?? null;
    const data = j.data || [];
    if (filasPorPagina === null) filasPorPagina = data.length;
    paginas++;
    filas.push(...data);
    if (!data.length || (total !== null && filas.length >= total)) break;
  }
  return { filas, columnas: columnas || [], total, filasPorPagina, paginas };
}

// Encuentra la clave de la fila que corresponde a una columna por su título visible.
function buscarClave(columnas, filas, titulos) {
  const objetivos = titulos.map(norm);
  const claves = new Set(filas.length ? Object.keys(filas[0]) : []);
  for (const col of columnas) {
    const valores = Object.values(col || {}).filter((v) => typeof v === "string");
    if (valores.some((v) => objetivos.includes(norm(v)))) {
      const k = valores.find((v) => claves.has(v));
      if (k) return k;
    }
  }
  for (const k of claves) if (objetivos.includes(norm(k))) return k;
  return null;
}

async function leerCostos(env, token, moneda, maxPaginas) {
  const smartieId = moneda === "USD" ? env.SMARTIE_USD : env.SMARTIE_ARS;
  const { filas, columnas, total, filasPorPagina, paginas } = await yiqiSmartie(env, token, smartieId, maxPaginas);
  const k = {
    sku: buscarClave(columnas, filas, ["Art. SKU", "SKU"]),
    nombre: buscarClave(columnas, filas, ["Artículo - Nombre", "Nombre"]),
    neto: buscarClave(columnas, filas, ["Neto c/Dto", "Neto c/ Dto"]),
    final: buscarClave(columnas, filas, ["Final c/ Dto", "Final c/Dto"]),
  };
  const avisos = [];
  for (const [n, v] of Object.entries(k)) if (!v && n !== "nombre") avisos.push(`No encontré la columna "${n}" en el smartie ${smartieId}`);
  const items = [], vistos = new Set();
  const excluidos = { discontinuados: 0 };
  for (const f of filas) {
    const sku = String(f[k.sku] ?? "").trim();
    if (!sku) continue;
    const costo = parseNum(f[k.neto]);
    const final = parseNum(f[k.final]);
    const nombre = k.nombre ? String(f[k.nombre] ?? "") : "";
    if (norm(nombre).includes("discontinuado")) { excluidos.discontinuados++; continue; }
    if (!(costo > 0)) { avisos.push(`${sku}: costo vacío o 0, no se envía`); continue; }
    if (costo < (moneda === "USD" ? COSTO_MIN_USD : COSTO_MIN_ARS)) { avisos.push(`${sku}: costo ${costo} demasiado bajo, no se envía`); continue; }
    if (vistos.has(sku)) { avisos.push(`${sku}: SKU repetido, se usa el primero`); continue; }
    vistos.add(sku);
    const { iva, aviso } = calcularIva(costo, final);
    if (aviso) avisos.push(`${sku}: ${aviso}`);
    items.push({ sku, nombre, costo: Math.round(costo * 100) / 100, iva, moneda });
  }
  const titulos = {};
  for (const [n, key] of Object.entries(k)) {
    const col = columnas.find((c) => Object.values(c || {}).includes(key));
    titulos[n] = { clave: key, columna: col ? Object.values(col).filter((v) => typeof v === "string" && v !== key).join(" / ") : null };
  }
  return { excluidos, titulos, smartieId, total, filasPorPagina, paginas, filasLeidas: filas.length, columnasDetectadas: k, columnas, items, avisos, muestraCruda: filas.slice(0, 3) };
}

async function leerBom(env, token) {
  const smartieId = env.SMARTIE_BOM;
  if (!smartieId) return null;
  const candidatas = env.YIQI_ENTIDAD_BOM ? [env.YIQI_ENTIDAD_BOM] : ENTIDADES_BOM;
  let res = null, entidad = null;
  const errores = [];
  for (const e of candidatas) {
    try { res = await yiqiSmartie(env, token, smartieId, 5, e); entidad = e; break; }
    catch (err) { errores.push(`${e}: ${err.message.slice(0, 120)}`); }
  }
  if (!res) throw new Error(`No pude leer el smartie de BOM ${smartieId}. Intentos:\n${errores.join("\n")}`);
  const { filas, columnas, total } = res;
  const k = {
    sku: buscarClave(columnas, filas, ["Descripción", "Descripcion"]),
    nombre: buscarClave(columnas, filas, ["Artículo resultante - Nombre"]),
    costo: buscarClave(columnas, filas, ["Costo total"]),
    fecha: buscarClave(columnas, filas, ["Fecha de creación"]),
  };
  const avisos = [];
  for (const n of ["sku", "costo"]) if (!k[n]) avisos.push(`No encontré la columna "${n}" en el smartie de BOM ${smartieId}`);
  const porSku = new Map();
  for (const f of filas) {
    const sku = String(f[k.sku] ?? "").trim();
    const costo = parseNum(f[k.costo]);
    if (!sku) continue;
    if (!(costo > 0)) { avisos.push(`BOM ${sku}: costo vacío o 0`); continue; }
    const fecha = k.fecha ? String(f[k.fecha] ?? "") : "";
    const prev = porSku.get(sku);
    if (prev) avisos.push(`BOM ${sku}: hay más de un BOM, se usa el más reciente`);
    if (!prev || fecha > prev.fecha) porSku.set(sku, { sku, nombre: k.nombre ? String(f[k.nombre] ?? "") : "", costo: Math.round(costo * 100) / 100, fecha });
  }
  return { smartieId, entidad, total, filasLeidas: filas.length, columnasDetectadas: k, items: [...porSku.values()], avisos, muestraCruda: filas.slice(0, 2), columnas };
}

// ---------------------------------------------------------------- Zentor (MCP)

let rpcId = 1;
async function mcpRpc(env, method, params) {
  if (!env.ZENTOR_CLIENT_ID || !env.ZENTOR_CLIENT_SECRET) throw new Error("Faltan los secretos ZENTOR_CLIENT_ID y/o ZENTOR_CLIENT_SECRET en Cloudflare.");
  const auth = "Basic " + btoa(`${env.ZENTOR_CLIENT_ID}:${env.ZENTOR_CLIENT_SECRET}`);
  const id = rpcId++;
  const r = await fetch(ZENTOR_MCP, {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }),
  });
  const txt = await r.text();
  if (r.status === 429) throw new Error(`Zentor pidió esperar (429). Retry-After: ${r.headers.get("retry-after")}`);
  if (!r.ok) throw new Error(`Zentor MCP ${method} (HTTP ${r.status}): ${txt.slice(0, 400)}`);
  let msg = null;
  if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const linea of txt.split("\n")) {
      if (!linea.startsWith("data:")) continue;
      try { const j = JSON.parse(linea.slice(5).trim()); if (j.id === id) msg = j; } catch {}
    }
  } else msg = JSON.parse(txt);
  if (!msg) throw new Error(`Respuesta de Zentor sin contenido para ${method}`);
  if (msg.error) throw new Error(`Zentor ${method}: ${JSON.stringify(msg.error).slice(0, 400)}`);
  return msg.result;
}

async function mcpInit(env) {
  return mcpRpc(env, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dentalab-yiqi-sync", version: "1.0.0" },
  });
}

async function zentorTool(env, name, args) {
  const res = await mcpRpc(env, "tools/call", { name, arguments: args || {} });
  const texto = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let datos = res.structuredContent ?? null;
  if (!datos) { try { datos = JSON.parse(texto); } catch { datos = texto; } }
  if (res.isError) throw new Error(`Zentor ${name} devolvió error: ${String(texto).slice(0, 500)}`);
  return datos;
}

// Formato de load_costs_config: { currency, costsData: [{ sku, cost, iva }] }
function armarArgsCarga(items, moneda) {
  return {
    currency: moneda,
    costsData: items.map((it) => (it.iva != null ? { sku: it.sku, cost: it.costo, iva: it.iva } : { sku: it.sku, cost: it.costo })),
  };
}

async function cargarEnZentor(env, items, moneda) {
  const resultados = [];
  for (let i = 0; i < items.length; i += LOTE_ZENTOR) {
    const lote = items.slice(i, i + LOTE_ZENTOR);
    const r = await zentorTool(env, "load_costs_config", armarArgsCarga(lote, moneda));
    resultados.push({ desde: i + 1, hasta: i + lote.length, respuesta: r });
  }
  return resultados;
}

// ---------------------------------------------------------------- sincronización

async function prepararCargas(env, token, maxPaginas) {
  const usd = await leerCostos(env, token, "USD", maxPaginas);
  const ars = await leerCostos(env, token, "ARS", maxPaginas);
  let bom = null, errorBom = null;
  try { bom = await leerBom(env, token); } catch (e) { errorBom = e.message; }
  // BOM: el costo del combo (ARS, sin IVA) reemplaza al del smartie de precios.
  const reemplazosBom = [];
  if (bom) {
    const ivaDe = new Map([...ars.items, ...usd.items].map((i) => [i.sku, i.iva]));
    const skusBom = new Set(bom.items.map((b) => b.sku));
    for (const lista of [usd, ars]) lista.items = lista.items.filter((i) => !skusBom.has(i.sku));
    for (const b of bom.items) {
      ars.items.push({ sku: b.sku, nombre: b.nombre, costo: b.costo, iva: ivaDe.get(b.sku) ?? null, moneda: "ARS", deBom: true });
      reemplazosBom.push(b);
    }
  }
  const skusUsd = new Set(usd.items.map((i) => i.sku));
  const enAmbas = ars.items.filter((i) => skusUsd.has(i.sku));
  ars.items = ars.items.filter((i) => !skusUsd.has(i.sku));
  // SKU con costo manual en Zentor: no se envían.
  const manuales = new Set(String(env.SKUS_COSTO_MANUAL || "").split(",").map((x) => x.trim()).filter(Boolean));
  const excluidosManual = [];
  for (const lista of [usd, ars]) lista.items = lista.items.filter((i) => (manuales.has(i.sku) ? (excluidosManual.push(i), false) : true));
  return { USD: usd, ARS: ars, BOM: bom, errorBom, reemplazosBom, enAmbas, excluidosManual };
}

async function sincronizar(env, { enviar }) {
  const inicio = Date.now();
  const informe = { fecha: new Date().toISOString(), envio: enviar ? "activo" : "solo prueba (no se envió nada)", monedas: {} };
  const token = await yiqiLogin(env);
  const cargas = await prepararCargas(env, token);
  if (cargas.errorBom) throw new Error("No se envió nada: falló la lectura de los BOM (si se envía igual, los combos quedarían con el costo equivocado).\n" + cargas.errorBom);
  informe.enAmbasListas = cargas.enAmbas.length;
  informe.combosBom = cargas.reemplazosBom.length;
  informe.costoManualNoEnviados = cargas.excluidosManual.map((i) => i.sku);
  if (cargas.BOM?.avisos.length) informe.avisosBom = cargas.BOM.avisos.slice(0, 30);
  if (enviar) await mcpInit(env);
  for (const moneda of ["USD", "ARS"]) {
    const c = cargas[moneda];
    const r = { smartie: c.smartieId, filasLeidas: c.filasLeidas, articulosEnviados: c.items.length, discontinuados: c.excluidos.discontinuados, avisos: c.avisos.slice(0, 50), cantidadAvisos: c.avisos.length };
    if (enviar && c.items.length) r.zentor = await cargarEnZentor(env, c.items, moneda);
    informe.monedas[moneda] = r;
  }
  informe.segundos = Math.round((Date.now() - inicio) / 1000);
  console.log(JSON.stringify({ resumen: { ...informe, monedas: Object.fromEntries(Object.entries(informe.monedas).map(([m, v]) => [m, { filas: v.filasLeidas, enviados: v.articulosEnviados, avisos: v.cantidadAvisos }])) } }));
  return informe;
}

// ---------------------------------------------------------------- páginas

function paginaConfigurar(url, mensaje = "") {
    return html("Conectar Zentor", `
<h1>Conectar con Zentor</h1>
<p class="mut">Esto crea una credencial de integración en tu cuenta de Zentor (tipo MCP, con permisos para consultar y cargar costos). Tu email y contraseña se usan solo para esta operación y no se guardan.</p>
${mensaje}
<form class="card" method="post" action="/configurar-zentor">
<label>Email de Zentor (usuario administrador)</label><input name="email" type="email" required autocomplete="username">
<label>Contraseña de Zentor</label><input name="password" type="password" required autocomplete="current-password">
<button type="submit">Crear credencial</button>
</form>`);
}

async function crearCredencialZentor(email, password) {
  const r1 = await fetch(`${ZENTOR_API}/v1/management/auth/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const t1 = await r1.text();
  if (!r1.ok) throw new Error(`Zentor rechazó el email/contraseña (HTTP ${r1.status}): ${t1.slice(0, 300)}`);
  const mgmt = JSON.parse(t1).access_token;
  const r2 = await fetch(`${ZENTOR_API}/v1/integration-clients`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mgmt}` },
    body: JSON.stringify({ name: "YiQi costos (Cloudflare)", channel: "mcp", permissions: ["products:view-all", "products:massive:load-costs"] }),
  });
  const t2 = await r2.text();
  if (!r2.ok) throw new Error(`Zentor no permitió crear la credencial (HTTP ${r2.status}): ${t2.slice(0, 400)}`);
  return JSON.parse(t2);
}

function paginaPanel(url, env) {
  const tiene = (k) => (env[k] ? '<span class="ok">cargado</span>' : '<span class="bad">falta</span>');
  return html("Panel YiQi → Zentor", `
<h1>YiQi → Zentor</h1>
<p class="mut">Envía los costos de compra de YiQi (smarties ${esc(env.SMARTIE_ARS)} en ARS y ${esc(env.SMARTIE_USD)} en USD) a Zentor. Envío automático: <b>${env.ENVIO_ACTIVO === "si" ? '<span class="ok">ACTIVO</span>' : '<span class="bad">DESACTIVADO (modo prueba)</span>'}</b></p>
<div class="card"><h2>Configuración</h2>
<table><tr><td>YIQI_USUARIO / YIQI_CLAVE</td><td>${tiene("YIQI_USUARIO")} / ${tiene("YIQI_CLAVE")}</td></tr>
<tr><td>ZENTOR_CLIENT_ID / ZENTOR_CLIENT_SECRET</td><td>${tiene("ZENTOR_CLIENT_ID")} / ${tiene("ZENTOR_CLIENT_SECRET")}</td></tr></table></div>
<div class="card"><h2>Acciones</h2>
<a class="btn" href="/configurar-zentor">1. Conectar Zentor</a>
<a class="btn" href="/diagnostico">2. Diagnóstico</a>
<a class="btn" href="/probar-sku">3. Probar con un SKU</a>
<a class="btn" href="/sincronizar">4. Sincronizar ahora</a>
<a class="btn" href="/exportar-costos">5. Descargar costos (CSV)</a></div>`);
}

async function paginaDiagnostico(env) {
  const bloques = [];
  try {
    const token = await yiqiLogin(env);
    bloques.push(`<div class="card"><h2 class="ok">YiQi: conexión correcta</h2></div>`);
    const cargas = await prepararCargas(env, token);
    if (cargas.errorBom) bloques.push(`<div class="card"><h2 class="bad">BOM: error</h2><pre>${esc(cargas.errorBom)}</pre></div>`);
    if (cargas.BOM) {
      const b = cargas.BOM;
      bloques.push(`<div class="card"><h2>Smartie ${esc(b.smartieId)} (BOM / combos, ARS)</h2>
<p>Entidad detectada: <b>${esc(b.entidad)}</b> · Filas: <b>${b.filasLeidas}</b> de ${esc(b.total)} · Combos con costo: <b>${b.items.length}</b> · Avisos: ${b.avisos.length}</p>
<p class="mut">Columnas usadas: ${esc(JSON.stringify(b.columnasDetectadas))}</p>
<table><tr><th>SKU</th><th>Nombre</th><th>Costo BOM</th><th>IVA %</th></tr>
${cargas.ARS.items.filter((i) => i.deBom).slice(0, 50).map((i) => `<tr><td>${esc(i.sku)}</td><td>${esc(i.nombre)}</td><td>${i.costo}</td><td>${i.iva ?? "(sin dato, no se envía)"}</td></tr>`).join("")}</table>
${b.avisos.length ? `<details><summary>Ver avisos</summary><pre>${esc(b.avisos.join("\n"))}</pre></details>` : ""}
<details><summary>Datos crudos</summary><pre>${esc(JSON.stringify({ columnas: b.columnas, filas: b.muestraCruda }, null, 2))}</pre></details></div>`);
    }
    for (const moneda of ["ARS", "USD"]) {
      const c = cargas[moneda];
      bloques.push(`<div class="card"><h2>Smartie ${esc(c.smartieId)} (${moneda})</h2>
<p>Filas leídas: <b>${c.filasLeidas}</b> de ${esc(c.total)} · Se enviarían: <b>${c.items.length}</b> · Discontinuados excluidos: ${c.excluidos.discontinuados} · Avisos: ${c.avisos.length}${moneda === "ARS" ? ` · Quitados por estar también en USD: <b>${cargas.enAmbas.length}</b>` : ""}</p>
<p class="mut">Columnas usadas: ${Object.entries(c.titulos).map(([n, t]) => `<b>${esc(n)}</b> = ${esc(t.columna || "?")} <code>${esc(t.clave)}</code>`).join(" · ")}</p>
<table><tr><th>SKU</th><th>Nombre</th><th>Costo</th><th>IVA %</th></tr>
${c.items.filter((i) => !i.deBom).slice(0, 8).map((i) => `<tr><td>${esc(i.sku)}</td><td>${esc(i.nombre)}</td><td>${i.costo}</td><td>${i.iva ?? "-"}</td></tr>`).join("")}</table>
${c.avisos.length ? `<details><summary>Ver avisos</summary><pre>${esc(c.avisos.slice(0, 300).join("\n"))}</pre></details>` : ""}
${moneda === "ARS" && cargas.enAmbas.length ? `<details><summary>SKU que están en ARS y en USD (se usa USD)</summary><pre>${esc(cargas.enAmbas.map((i) => `${i.sku}  ${i.nombre}  (ARS ${i.costo} / USD ${cargas.USD.items.find((u) => u.sku === i.sku)?.costo})`).join("\n"))}</pre></details>` : ""}
</div>`);
    }
  } catch (e) {
    bloques.push(`<div class="card"><h2 class="bad">YiQi: error</h2><pre>${esc(e.message)}</pre></div>`);
  }
  try {
    await mcpInit(env);
    const tools = await mcpRpc(env, "tools/list", {});
    const lista = tools.tools || [];
    const carga = lista.find((t) => t.name === "load_costs_config");
    const consulta = lista.find((t) => t.name === "get_sku_costs");
    let muestra = "";
    if (consulta) {
      try { muestra = JSON.stringify(await zentorTool(env, "get_sku_costs", {}), null, 2).slice(0, 3000); }
      catch (e) { muestra = "Error: " + e.message; }
    }
    bloques.push(`<div class="card"><h2 class="ok">Zentor: conexión correcta</h2>
<p>Herramientas habilitadas: ${esc(lista.map((t) => t.name).join(", "))}</p>
<h2>Formato de carga de costos</h2><pre class="full">${esc(JSON.stringify(carga || "NO DISPONIBLE: falta el permiso products:massive:load-costs", null, 2))}</pre>
<h2>Costos actuales en Zentor (muestra)</h2><pre>${esc(muestra)}</pre></div>`);
  } catch (e) {
    bloques.push(`<div class="card"><h2 class="bad">Zentor: error</h2><pre>${esc(e.message)}</pre></div>`);
  }
  return html("Diagnóstico", `<h1>Diagnóstico</h1><p class="mut">Copiá esta página completa y pasásela a Claude para terminar de ajustar el envío.</p>${bloques.join("")}`);
}

async function paginaProbarSku(request, env) {
  const form = `<form class="card" method="post" action="/probar-sku"><label>SKU a probar</label><input name="sku" required>
<button type="submit">Enviar el costo de este SKU a Zentor</button></form>`;
  if (request.method !== "POST")
    return html("Probar un SKU", `<h1>Probar con un SKU</h1><p class="mut">Envía a Zentor el costo e IVA de un solo SKU, tal como lo haría la sincronización. Después revisá en Zentor que el margen mínimo de ese SKU siga igual.</p>${form}`);
  const sku = String((await request.formData()).get("sku") || "").trim();
  const token = await yiqiLogin(env);
  const cargas = await prepararCargas(env, token);
  let moneda = null, item = null;
  for (const m of ["USD", "ARS"]) { const it = cargas[m].items.find((i) => i.sku === sku); if (it) { moneda = m; item = it; break; } }
  if (!item) return html("Probar un SKU", `<h1>Probar con un SKU</h1><div class="card bad">El SKU <b>${esc(sku)}</b> no está entre los que se enviarían (no existe, está discontinuado o tiene un aviso).</div>${form}`);
  await mcpInit(env);
  let antes = null;
  try { antes = await zentorTool(env, "get_sku_costs", { skus: [sku] }); } catch (e) { antes = "No se pudo leer: " + e.message; }
  const args = armarArgsCarga([item], moneda);
  const resp = await zentorTool(env, "load_costs_config", args);
  return html("Probar un SKU", `<h1 class="ok">Enviado</h1>
<div class="card"><p><b>${esc(item.sku)}</b> ${esc(item.nombre)}</p>
<h2>Antes (según Zentor)</h2><pre class="full">${esc(JSON.stringify(antes, null, 2))}</pre>
<h2>Lo que se envió</h2><pre class="full">${esc(JSON.stringify(args, null, 2))}</pre>
<h2>Respuesta de Zentor</h2><pre class="full">${esc(JSON.stringify(resp, null, 2))}</pre></div>
<p>Ahora abrí ese SKU en Zentor y fijate que el costo sea el nuevo y que el <b>margen mínimo</b> siga como estaba.</p>${form}`);
}

// ---------------------------------------------------------------- entrada

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!String(env.CLAVE_PANEL || "").trim())
      return html("Falta configurar", `<h1>Falta la clave del panel</h1><p>Cargá el secreto <code>CLAVE_PANEL</code> en Cloudflare (Settings → Variables and Secrets, tipo Secret) y volvé a entrar.</p>`, 503);
    if (url.pathname === "/entrar" && request.method === "POST") {
      const f = await request.formData();
      const dada = String(f.get("clave") || "").trim();
      if (!iguales(String(env.CLAVE_PANEL).trim(), dada)) return paginaEntrar(`<div class="card bad">Clave incorrecta.</div>`);
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": `panel=${await hashClave(dada)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` },
      });
    }
    if (!(await sesionOk(env, request, url))) return paginaEntrar();

    try {
      if (url.pathname === "/configurar-zentor") {
        if (request.method === "POST") {
          const f = await request.formData();
          try {
            const c = await crearCredencialZentor(String(f.get("email") || ""), String(f.get("password") || ""));
            return html("Credencial creada", `<h1 class="ok">Credencial creada</h1>
<div class="card"><p><b>Importante:</b> Zentor muestra el secreto una sola vez. Copiá estos dos valores ahora y cargalos como <b>secretos</b> en Cloudflare (Workers → zentor-yiqi → Settings → Variables and Secrets → Add → tipo <i>Secret</i>).</p>
<label>Nombre: ZENTOR_CLIENT_ID</label><span class="secret">${esc(c.client_id)}</span>
<label>Nombre: ZENTOR_CLIENT_SECRET</label><span class="secret">${esc(c.client_secret)}</span>
<p class="mut">Permisos: ${esc((c.permissions || []).join(", "))} · Canal: ${esc(c.channel)}</p></div>`);
          } catch (e) {
            return paginaConfigurar(url, `<div class="card bad"><b>No se pudo crear la credencial.</b><pre>${esc(e.message)}</pre></div>`);
          }
        }
        return paginaConfigurar(url);
      }
      if (url.pathname === "/diagnostico") return await paginaDiagnostico(env);
      if (url.pathname === "/exportar-costos") {
        const token = await yiqiLogin(env);
        const c = await prepararCargas(env, token);
        const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
        const lineas = ["sku;moneda;costo;iva;origen;nombre"];
        for (const m of ["ARS", "USD"]) for (const i of c[m].items)
          lineas.push([q(i.sku), m, String(i.costo).replace(".", ","), i.iva ?? "", i.deBom ? "BOM" : "Lista", q(i.nombre)].join(";"));
        return new Response("\ufeff" + lineas.join("\r\n"), {
          headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="costos_yiqi.csv"', "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/probar-sku") return await paginaProbarSku(request, env);
      if (url.pathname === "/sincronizar") {
        const inf = await sincronizar(env, { enviar: env.ENVIO_ACTIVO === "si" });
        return html("Sincronización", `<h1>Sincronización</h1><div class="card"><pre>${esc(JSON.stringify(inf, null, 2))}</pre></div>`);
      }
      return paginaPanel(url, env);
    } catch (e) {
      return html("Error", `<h1 class="bad">Error</h1><pre>${esc(e.message)}</pre>`, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sincronizar(env, { enviar: env.ENVIO_ACTIVO === "si" }).catch((e) => console.error("Fallo la sincronización:", e.message))
    );
  },
};
