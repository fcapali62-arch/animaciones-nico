"use strict";
/**
 * ANIMACIONES NICO V6 - Servidor único (Node.js 20+).
 * Basado en el proyecto V5 original de 1067 líneas facilitado por Nico.
 * Sin paquetes npm externos. Es necesario configurar Appwrite y Google OAuth.
 * Esta versión está pensada para probarse EN UNA RAMA, no publicarse a ciegas.
 *
 * Seguridad:
 * - La clave API se usa solo en el servidor y jamás se entrega al navegador.
 * - Los medios pendientes no se muestran públicamente.
 * - Los likes y el chat comprueban la identidad mediante JWT de Appwrite.
 * - La contraseña de administrador continúa guardada en ADMIN_PASSWORD.
 * - El admin controla publicaciones, modificaciones y moderación.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const ENV = process.env;
const PORT = Number(ENV.PORT || 3000);
const ENDPOINT = (ENV.APPWRITE_ENDPOINT || "").replace(/\/+$/, "");
const PROJECT = ENV.APPWRITE_PROJECT_ID || "";
const KEY = ENV.APPWRITE_API_KEY || "";
const DB = ENV.APPWRITE_DATABASE_ID || "";
const TABLE_POSTS = ENV.APPWRITE_PUBLICACIONES_TABLE_ID || "";
const TABLE_LIKES = ENV.APPWRITE_GUSTOS_TABLE_ID || "";
const TABLE_CHAT = ENV.APPWRITE_MENSAJES_TABLE_ID || "";
const BUCKET = ENV.APPWRITE_BUCKET_ID || "";
const ADMIN_PASSWORD = ENV.ADMIN_PASSWORD || "";
const MAX_FILE_MB = 100;
const MAX_UPLOAD = MAX_FILE_MB * 1024 * 1024;
const MAX_BODY = MAX_UPLOAD + 512 * 1024;
const ALLOWED = new Map([
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);
const adminSessions = new Map();
const loginAttempts = new Map();
const lastMessage = new Map();
const lastUpload = new Map();
const lastLike = new Map();
const pendingUploads = new Set();
const APP_READY = [ENDPOINT, PROJECT, KEY, DB, TABLE_POSTS, TABLE_LIKES, TABLE_CHAT, BUCKET].every(Boolean);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function abort(status, message) { throw new HttpError(status, message); }
function text(v, max = 100) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  res.end(body);
}
function method(res) { json(res, 405, { error: "Método no permitido" }); }
function html(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://*.cloud.appwrite.io; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.cloud.appwrite.io",
  });
  res.end(body);
}
function origin(req) {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = typeof forwardedHost === "string" ? forwardedHost : (req.headers.host || "localhost");
  return (req.headers["x-forwarded-proto"] === "https" ? "https://" : "http://") + host;
}
function sameOrigin(req) {
  const referer = req.headers.origin;
  if (!referer) return true;
  try { return new URL(referer).host === new URL(origin(req)).host; } catch { return false; }
}
async function readJSON(req, limit = 16000) {
  let content = "";
  for await (const chunk of req) {
    content += chunk.toString("utf8");
    if (Buffer.byteLength(content) > limit) abort(413, "Solicitud demasiado grande");
  }
  try { return JSON.parse(content); }
  catch { abort(400, "Datos JSON incorrectos"); }
}
async function fetchRemote(path, options = {}, asBytes = false) {
  if (!APP_READY) abort(503, "Faltan variables APPWRITE_* en Render");
  const h = {
    "X-Appwrite-Project": PROJECT,
    "X-Appwrite-Key": KEY,
    ...options.headers,
  };
  const response = await fetch(ENDPOINT + path, { ...options, headers: h, signal: AbortSignal.timeout(25000) });
  if (asBytes) return response;
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { body = { message: raw.slice(0, 250) }; }
  if (!response.ok) {
    console.error("Appwrite", response.status, path.split("?")[0], body?.message || "");
    abort(response.status >= 500 ? 502 : 400, "Servicio de datos: " + (body.message || "Error"));
  }
  return body;
}
async function appJSON(path, method, data) {
  return fetchRemote(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
function rowsPath(table, id) {
  return `/tablesdb/${encodeURIComponent(DB)}/tables/${encodeURIComponent(table)}/rows` + (id ? "/" + encodeURIComponent(id) : "");
}
async function listRows(table, maximum = 400) {
  const results = [];
  let offset = 0;
  const size = 100;
  while (offset < maximum) {
    const qs = new URLSearchParams();
    qs.append("queries[]", JSON.stringify({ method: "limit", values: [size] }));
    qs.append("queries[]", JSON.stringify({ method: "offset", values: [offset] }));
    const page = await fetchRemote(rowsPath(table) + "?" + qs);
    const current = Array.isArray(page.rows) ? page.rows : [];
    results.push(...current);
    if (current.length < size) break;
    offset += size;
  }
  return results;
}
async function getRow(table, id) {
  try { return await fetchRemote(rowsPath(table, id)); }
  catch (err) { if (err.status === 400) abort(404, "Elemento no encontrado"); throw err; }
}
async function addRow(table, data, rowId = crypto.randomUUID()) {
  return appJSON(rowsPath(table), "POST", { rowId, data, permissions: [] });
}
async function updateRow(table, id, data) {
  return appJSON(rowsPath(table, id), "PATCH", { data });
}
async function deleteRow(table, id) {
  return fetchRemote(rowsPath(table, id), { method: "DELETE" });
}
async function sendFile(buffer, type) {
  const fileId = crypto.randomUUID().replaceAll("-", "");
  const path = `/storage/buckets/${encodeURIComponent(BUCKET)}/files`;
  const CHUNK = 5 * 1024 * 1024;
  let confirmedId = null;
  try {
    for (let start = 0; start < buffer.length; start += CHUNK) {
      const end = Math.min(buffer.length, start + CHUNK);
      const chunk = buffer.subarray(start, end);
      const form = new FormData();
      form.append("fileId", fileId);
      form.append("file", new Blob([chunk], { type }), `nico.${ALLOWED.get(type)}`);
      // El archivo se crea SIN permisos públicos ni acceso directo de usuarios.
      // Para archivos de más de 5 MB, Appwrite exige subir bloques separados.
      const headers = {
        "Content-Range": `bytes ${start}-${end - 1}/${buffer.length}`,
      };
      if (confirmedId) headers["X-Appwrite-ID"] = confirmedId;
      const uploaded = await fetchRemote(path, { method: "POST", body: form, headers });
      confirmedId = uploaded.$id || fileId;
    }
    return confirmedId || fileId;
  } catch (err) {
    if (confirmedId) await eraseFile(confirmedId);
    throw err;
  }
}
async function eraseFile(fileId) {
  if (!fileId) return;
  try { await fetchRemote(`/storage/buckets/${encodeURIComponent(BUCKET)}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }); }
  catch (e) { console.warn("No se pudo eliminar archivo", e.message); }
}
function fileReference(row) {
  const raw = row.video_url || "";
  const match = /^(image|video):([a-zA-Z0-9_-]{1,80})$/.exec(raw);
  return match ? { kind: match[1], id: match[2] } : null;
}
function publicPost(row) {
  const f = fileReference(row);
  return {
    id: row.$id,
    nombre: row.nombra || row.nombre || "Creador",
    titulo: row.titulo || "Sin título",
    descripcion: row.descripcion || "",
    estado: row.estado || "pendiente",
    usuario_id: row.usuario_id || "",
    tipo: f ? f.kind : "video",
    media: f ? `/media/${encodeURIComponent(row.$id)}` : "",
    fecha: row.$createdAt || null,
  };
}
function publicMessage(row) {
  return {
    id: row.$id,
    nombre: row.nombre || "Usuario",
    contenido: row.contenido || "",
    usuario_id: row.usuario_id || "",
    fecha: row.$createdAt || null,
    eliminado: row.eliminado === "si",
  };
}
function getAdmin(req) {
  const raw = String(req.headers.authorization || "");
  const token = raw.startsWith("Admin ") ? raw.slice(6) : "";
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) { if (exp) adminSessions.delete(token); return false; }
  return true;
}
function requireAdmin(req) { if (!getAdmin(req)) abort(401, "Inicia sesión como administrador"); }
async function who(req) {
  const jwt = String(req.headers["x-nico-jwt"] || "");
  if (!jwt || jwt.length > 5000) abort(401, "Inicia sesión con Google para continuar");
  if (!ENDPOINT || !PROJECT) abort(503, "Appwrite no configurado");
  const response = await fetch(ENDPOINT + "/account", {
    headers: { "X-Appwrite-Project": PROJECT, "X-Appwrite-JWT": jwt },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) abort(401, "Tu sesión terminó. Vuelve a iniciar sesión");
  const account = await response.json();
  if (!account.$id) abort(401, "Usuario no válido");
  return { id: account.$id, nombre: text(account.name || "Usuario", 60) || "Usuario" };
}
/** Los avisos de moderación se guardan en la tabla existente mensajes.
 * Son filas reservadas: eliminado = nota/suspension/levantado. Jamás se envían al chat.
 * Fila determinista de suspensión: su estado persiste incluso si Render reinicia.
 */
function privateRecordId(prefix,id) {
  return prefix + '_' + crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,28);
}
async function maybeUser(req) {
  if (!req.headers['x-nico-jwt']) return null;
  return who(req);
}
async function optionalChatRecord(id) {
  try { return await getRow(TABLE_CHAT,id); }
  catch(e) { if(e.status===404)return null;throw e; }
}
function suspensionFromRow(row) {
  if(!row || row.eliminado!=='suspension')return null;
  try {
    const { hasta,motivo }=JSON.parse(row.contenido);
    const timestamp=Date.parse(hasta);
    return Number.isFinite(timestamp)&&timestamp>Date.now()?{hasta,motivo}:null;
  } catch{return null;}
}
async function userSuspension(usuario_id) {
  const row=await optionalChatRecord(privateRecordId('susp',usuario_id));
  return suspensionFromRow(row);
}
async function getPrivateNote(postId) {
  const row=await optionalChatRecord(privateRecordId('nota',postId));
  return row?.eliminado==='nota'?row.contenido:'';
}
async function setUserSuspension(usuario_id,nombre,motivo,dias,lift=false) {
  const id=privateRecordId('susp',usuario_id);
  const existing=await optionalChatRecord(id);
  const until=new Date(Date.now()+Number(dias)*86400000).toISOString();
  const data={ usuario_id,nombre,contenido:lift?'{}':JSON.stringify({hasta:until,motivo}),eliminado:lift?'levantado':'suspension' };
  if(existing) await updateRow(TABLE_CHAT,id,data);
  else await addRow(TABLE_CHAT,data,id);
}
function minInterval(map, id, seconds) {
  const now = Date.now();
  if (now - (map.get(id) || 0) < seconds * 1000) abort(429, `Espera ${seconds} segundos antes de repetir`);
  map.set(id, now);
  if (map.size > 8000) for (const key of [...map.keys()].slice(0, 3000)) map.delete(key);
}
function safeCompare(a,b) {
  if (!a || !b) return false;
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah,bh);
}
function clientAddress(req) { return String(req.socket.remoteAddress || "unknown"); }
function checkCSRF(req) {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) abort(403, "Origen no permitido");
}
async function getForm(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (length > MAX_BODY) abort(413, `Archivo demasiado grande. Máximo ${MAX_FILE_MB} MB`);
  // Request.formData() requiere un cuerpo tipo Web Stream, disponible en Node 20.
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) abort(413, `Archivo demasiado grande. Máximo ${MAX_FILE_MB} MB`);
    chunks.push(chunk);
  }
  const request = new Request("http://localhost/upload", {
    method: "POST", headers: { "content-type": req.headers["content-type"] || "" },
    body: Buffer.concat(chunks),
  });
  const form = await request.formData();
  const file = form.get("archivo");
  if (!file || typeof file.arrayBuffer !== "function") abort(400, "Selecciona un archivo");
  if (!ALLOWED.has(file.type)) abort(400, "Usa MP4, WebM, PNG, JPG, WebP o GIF");
  if (file.size <= 0 || file.size > MAX_UPLOAD) abort(413, `Máximo ${MAX_FILE_MB} MB`);
  return { form, file };
}
async function getFile(res, req, row) {
  const ref = fileReference(row);
  if (!ref) abort(404, "Archivo no disponible");
  const path = `/storage/buckets/${encodeURIComponent(BUCKET)}/files/${encodeURIComponent(ref.id)}/download`;
  const upstream = await fetchRemote(path, {
    headers: req.headers.range ? { Range: req.headers.range } : {},
  }, true);
  if (!upstream.ok) abort(502, "No se pudo cargar el archivo");
  const headers = {
    "Content-Type": upstream.headers.get("content-type") || (ref.kind === "image" ? "image/jpeg" : "video/mp4"),
    "Cache-Control": "private, max-age=90",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "none",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  for (const [from,to] of [["content-length","Content-Length"],["content-range","Content-Range"]]) {
    const value = upstream.headers.get(from);
    if (value) headers[to] = value;
  }
  res.writeHead(upstream.status === 206 ? 206 : 200, headers);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
}
function requireReady() { if (!APP_READY) abort(503, "Configura las variables de Appwrite en Render"); }
function startupMessage() {
  console.log("Animaciones Nico V6, puerto", PORT);
  console.log("Appwrite:", APP_READY ? "variables completas" : "faltan variables");
  console.log("Google OAuth: requiere habilitar el proveedor y dominio en Appwrite");
}

// El HTML, los estilos y el JavaScript del cliente se integran más abajo.
const CLIENT_CONFIG = JSON.stringify({ endpoint: ENDPOINT, project: PROJECT, googleReady: Boolean(ENDPOINT && PROJECT) });
const PAGE = [
  "<!doctype html>",
  "<html lang=\"es\">",
  "<head>",
  "  <meta charset=\"utf-8\">",
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
  "  <meta name=\"theme-color\" content=\"#141419\">",
  "  <meta name=\"description\" content=\"Animaciones Nico: tus historias en movimiento. Comparte videos e imágenes y descubre artistas.\">",
  "  <title>Animaciones Nico</title>",
  "  <link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">",
  "  <style>",
  "    :root {",
  "      color-scheme:dark;",
  "      --ink:#f9faff;",
  "      --muted:#9ca7bc;",
  "      --soft:#cbd3e6;",
  "      --bg:#090b15;",
  "      --panel:#111525;",
  "      --panel-2:#171b30;",
  "      --panel-3:#1d2139;",
  "      --edge:#2c324b;",
  "      --orange:#ff9c4b;",
  "      --pink:#ff5379;",
  "      --purple:#8269ff;",
  "      --blue:#4cb7ff;",
  "      --green:#40dcb1;",
  "      --radius:22px;",
  "      --shadow:0 24px 80px rgba(0,0,0,.25);",
  "      --font:Inter,ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",sans-serif;",
  "    }",
  "    *{",
  "      box-sizing:border-box",
  "    }",
  "    html{",
  "      scroll-behavior:smooth",
  "    }",
  "    body{",
  "      margin:0;",
  "      font:15px/1.58 var(--font);",
  "      color:var(--ink);",
  "      background:var(--bg);",
  "      min-height:100vh",
  "    }",
  "    body::before{",
  "      content:\"\";",
  "      position:fixed;",
  "      inset:-20%;",
  "      pointer-events:none;",
  "      z-index:-1;",
  "      background:radial-gradient(ellipse 33% 28% at 17% 4%,#56357544,transparent 72%),radial-gradient(ellipse 36% 28% at 92% 21%,#28438735,transparent 76%)",
  "    }",
  "    button,input,textarea,select{",
  "      font:inherit",
  "    }",
  "    button{",
  "      cursor:pointer",
  "    }",
  "    a{",
  "      color:inherit;",
  "      text-decoration:none",
  "    }",
  "    a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{",
  "      outline:3px solid var(--blue);",
  "      outline-offset:2px",
  "    }",
  "    button:disabled{",
  "      opacity:.5;",
  "      cursor:not-allowed",
  "    }",
  "    ::selection{",
  "      background:#7255dd;",
  "      color:white",
  "    }",
  "    .shell{",
  "      width:min(1220px,calc(100% - 40px));",
  "      margin:auto",
  "    }",
  "    .skip{",
  "      position:absolute;",
  "      left:-1000px;",
  "      top:5px;",
  "      background:#fff;",
  "      color:#111;",
  "      padding:12px;",
  "      z-index:20",
  "    }",
  "    .skip:focus{",
  "      left:5px",
  "    }",
  "    .topbar{",
  "      border-bottom:1px solid var(--edge);",
  "      background:#0b0d19dc;",
  "      backdrop-filter:blur(22px);",
  "      position:sticky;",
  "      top:0;",
  "      z-index:10",
  "    }",
  "    .top-inner{",
  "      min-height:86px;",
  "      display:flex;",
  "      align-items:center;",
  "      gap:16px;",
  "      justify-content:space-between",
  "    }",
  "    .logo{",
  "      display:flex;",
  "      align-items:center;",
  "      gap:13px;",
  "      min-width:0",
  "    }",
  "    .logo-icon{",
  "      height:48px;",
  "      width:48px;",
  "      border-radius:17px;",
  "      display:grid;",
  "      place-items:center;",
  "      color:#fff;",
  "      background:linear-gradient(145deg,var(--pink),#ff9551 58%,#f0c06a);",
  "      box-shadow:0 10px 29px #ff58683b",
  "    }",
  "    .logo-icon svg{",
  "      width:27px;",
  "      height:27px",
  "    }",
  "    .logo-type{",
  "      display:flex;",
  "      flex-direction:column;",
  "      line-height:1.2;",
  "      gap:4px",
  "    }",
  "    .logo-type b{",
  "      font-size:17px;",
  "      letter-spacing:.13em",
  "    }",
  "    .logo-type small{",
  "      font-size:11px;",
  "      color:var(--muted);",
  "      letter-spacing:.08em",
  "    }",
  "    .beta{",
  "      padding:3px 8px;",
  "      border-radius:20px;",
  "      background:#7964df20;",
  "      border:1px solid #756adf60;",
  "      color:#cfc5ff;",
  "      font-size:10px;",
  "      letter-spacing:.06em;",
  "      font-weight:800",
  "    }",
  "    .account{",
  "      display:flex;",
  "      align-items:center;",
  "      gap:10px",
  "    }",
  "    .avatar{",
  "      width:36px;",
  "      height:36px;",
  "      border-radius:50%;",
  "      display:grid;",
  "      place-items:center;",
  "      font-size:15px;",
  "      font-weight:800;",
  "      background:linear-gradient(145deg,#7264dd,#ff7b9b);",
  "      color:white;",
  "      flex-shrink:0",
  "    }",
  "    .signed{",
  "      max-width:150px;",
  "      overflow:hidden;",
  "      text-overflow:ellipsis;",
  "      white-space:nowrap;",
  "      color:var(--soft);",
  "      font-size:13px;",
  "      font-weight:600",
  "    }",
  "    .btn{",
  "      display:inline-flex;",
  "      justify-content:center;",
  "      align-items:center;",
  "      gap:8px;",
  "      padding:12px 18px;",
  "      color:#f9f9ff;",
  "      border:1px solid #444862;",
  "      background:var(--panel-2);",
  "      border-radius:13px;",
  "      font-weight:700;",
  "      line-height:1.2;",
  "      transition:transform .17s,background .17s,border-color .17s",
  "    }",
  "    .btn:hover{",
  "      background:#282e49;",
  "      border-color:#6a708f;",
  "      transform:translateY(-1px)",
  "    }",
  "    .btn.primary{",
  "      background:linear-gradient(115deg,#fb567b,#fa8459);",
  "      color:#fff;",
  "      border-color:transparent;",
  "      box-shadow:0 10px 26px #e75b702e",
  "    }",
  "    .btn.primary:hover{",
  "      filter:brightness(1.12)",
  "    }",
  "    .btn.alt{",
  "      background:#2a2350;",
  "      border-color:#6154a2",
  "    }",
  "    .btn.ghost{",
  "      background:transparent;",
  "      border-color:transparent;",
  "      color:var(--muted)",
  "    }",
  "    .btn.ghost:hover{",
  "      color:white;",
  "      background:#23263b",
  "    }",
  "    .btn.danger{",
  "      background:#542839;",
  "      border-color:#9a3d51;",
  "      color:#ffc4d2",
  "    }",
  "    .btn.mini{",
  "      padding:9px 12px;",
  "      font-size:12px;",
  "      border-radius:10px",
  "    }",
  "    .btn.icon-btn{",
  "      height:39px;",
  "      width:39px;",
  "      padding:0",
  "    }",
  "    .google-g{",
  "      display:inline-grid;",
  "      place-items:center;",
  "      background:white;",
  "      border-radius:50%;",
  "      height:21px;",
  "      width:21px;",
  "      color:#4285f4;",
  "      font-weight:900",
  "    }",
  "    .hero{",
  "      padding:64px 0 30px",
  "    }",
  "    .hero-layout{",
  "      display:grid;",
  "      grid-template-columns:minmax(0,1.5fr) minmax(260px,.7fr);",
  "      gap:26px;",
  "      align-items:stretch",
  "    }",
  "    .hero-left{",
  "      padding:16px 0",
  "    }",
  "    .eyebrow{",
  "      display:inline-flex;",
  "      align-items:center;",
  "      gap:8px;",
  "      font-size:12px;",
  "      font-weight:800;",
  "      letter-spacing:.14em;",
  "      text-transform:uppercase;",
  "      color:#ffb4c3",
  "    }",
  "    .dot{",
  "      height:7px;",
  "      width:7px;",
  "      border-radius:50%;",
  "      background:var(--orange);",
  "      box-shadow:0 0 18px var(--orange)",
  "    }",
  "    .hero h1{",
  "      font-size:clamp(38px,5.2vw,67px);",
  "      letter-spacing:-.065em;",
  "      line-height:1.08;",
  "      margin:20px 0 16px;",
  "      max-width:800px",
  "    }",
  "    .gradient{",
  "      background:linear-gradient(110deg,#ffb763,#ff6489 45%,#a393ff);",
  "      -webkit-background-clip:text;",
  "      background-clip:text;",
  "      color:transparent",
  "    }",
  "    .hero-lead{",
  "      font-size:17px;",
  "      line-height:1.8;",
  "      color:var(--muted);",
  "      max-width:600px;",
  "      margin:0 0 25px",
  "    }",
  "    .hero-buttons{",
  "      display:flex;",
  "      flex-wrap:wrap;",
  "      gap:11px",
  "    }",
  "    .hero-card{",
  "      border:1px solid #4a3a6566;",
  "      border-radius:29px;",
  "      background:linear-gradient(140deg,#241a3e 0%,#15172b 70%);",
  "      box-shadow:var(--shadow);",
  "      padding:28px;",
  "      min-height:270px;",
  "      position:relative;",
  "      overflow:hidden;",
  "      display:flex;",
  "      flex-direction:column;",
  "      justify-content:space-between",
  "    }",
  "    .hero-card::after{",
  "      content:\"\";",
  "      position:absolute;",
  "      width:200px;",
  "      height:200px;",
  "      border-radius:40px;",
  "      background:linear-gradient(120deg,#f4637d,#886eff);",
  "      transform:rotate(28deg);",
  "      right:-90px;",
  "      top:-74px;",
  "      opacity:.28;",
  "      filter:blur(8px)",
  "    }",
  "    .hero-card .film{",
  "      font-size:66px;",
  "      line-height:1",
  "    }",
  "    .hero-card .headline{",
  "      font-weight:900;",
  "      font-size:22px;",
  "      line-height:1.25;",
  "      max-width:240px;",
  "      letter-spacing:-.04em",
  "    }",
  "    .hero-card p{",
  "      font-size:13px;",
  "      color:#beb5d9;",
  "      margin:7px 0 0",
  "    }",
  "    .hero-strip{",
  "      display:flex;",
  "      flex-wrap:wrap;",
  "      gap:11px;",
  "      margin:27px 0 0",
  "    }",
  "    .pill{",
  "      display:flex;",
  "      align-items:center;",
  "      gap:8px;",
  "      padding:8px 11px;",
  "      border:1px solid #3a3853;",
  "      background:#1b1a2ac4;",
  "      border-radius:12px;",
  "      color:#c5bedb;",
  "      font-size:12px",
  "    }",
  "    .pill strong{",
  "      color:white",
  "    }",
  "    .tabs-wrap{",
  "      position:sticky;",
  "      top:86px;",
  "      z-index:9;",
  "      background:#0c0e1bc9;",
  "      backdrop-filter:blur(19px);",
  "      border-block:1px solid #282d44;",
  "      margin-top:14px",
  "    }",
  "    .tabs{",
  "      display:flex;",
  "      align-items:center;",
  "      gap:5px;",
  "      overflow-x:auto;",
  "      scrollbar-width:thin;",
  "      padding:11px 0",
  "    }",
  "    .tab{",
  "      white-space:nowrap;",
  "      padding:12px 18px;",
  "      background:transparent;",
  "      border:0;",
  "      color:var(--muted);",
  "      font-weight:750;",
  "      border-radius:13px",
  "    }",
  "    .tab:hover{",
  "      background:#272a42;",
  "      color:#fff",
  "    }",
  "    .tab.active{",
  "      color:#fff;",
  "      background:linear-gradient(110deg,#302541,#2b2448);",
  "      box-shadow:inset 0 0 0 1px #72588d",
  "    }",
  "    .tab svg{",
  "      width:17px;",
  "      height:17px;",
  "      vertical-align:-3px;",
  "      margin-right:6px",
  "    }",
  "    main{",
  "      padding:38px 0 90px;",
  "      min-height:440px",
  "    }",
  "    section[hidden]{",
  "      display:none!important",
  "    }",
  "    .section-head{",
  "      display:flex;",
  "      justify-content:space-between;",
  "      align-items:center;",
  "      gap:16px;",
  "      margin:0 0 24px;",
  "      flex-wrap:wrap",
  "    }",
  "    .section-head h2{",
  "      font-size:clamp(24px,2.7vw,35px);",
  "      letter-spacing:-.04em;",
  "      line-height:1.2;",
  "      margin:0",
  "    }",
  "    .section-head p{",
  "      margin:7px 0 0;",
  "      color:var(--muted)",
  "    }",
  "    .section-note{",
  "      padding:11px 14px;",
  "      border:1px solid #454362;",
  "      border-radius:12px;",
  "      background:#24233c;",
  "      color:#d6caea;",
  "      font-size:12px",
  "    }",
  "    .filters{",
  "      display:flex;",
  "      gap:10px;",
  "      flex-wrap:wrap;",
  "      margin-bottom:20px",
  "    }",
  "    .search{",
  "      flex:1;",
  "      max-width:530px;",
  "      min-width:190px;",
  "      position:relative",
  "    }",
  "    .search input{",
  "      padding-left:42px",
  "    }",
  "    .search svg{",
  "      position:absolute;",
  "      top:15px;",
  "      left:14px;",
  "      width:17px;",
  "      height:17px;",
  "      color:var(--muted);",
  "      pointer-events:none",
  "    }",
  "    .input{",
  "      width:100%;",
  "      padding:13px 14px;",
  "      border:1px solid var(--edge);",
  "      border-radius:13px;",
  "      background:#141827;",
  "      color:var(--ink);",
  "      outline:none",
  "    }",
  "    .input:hover{",
  "      border-color:#5a6080",
  "    }",
  "    .input:focus{",
  "      border-color:#a185ff;",
  "      box-shadow:0 0 0 3px #7d6dff27",
  "    }",
  "    .input::placeholder{",
  "      color:#7f8aa4",
  "    }",
  "    textarea.input{",
  "      min-height:120px;",
  "      resize:vertical",
  "    }",
  "    select.input{",
  "      cursor:pointer",
  "    }",
  "    .cards{",
  "      display:grid;",
  "      grid-template-columns:repeat(3,minmax(0,1fr));",
  "      gap:18px;",
  "      align-items:start",
  "    }",
  "    .media-card{",
  "      border:1px solid var(--edge);",
  "      background:linear-gradient(160deg,#191c2f,#101321);",
  "      border-radius:21px;",
  "      overflow:hidden;",
  "      box-shadow:0 12px 40px #00000018;",
  "      transition:border-color .2s,transform .2s",
  "    }",
  "    .media-card:hover{",
  "      border-color:#766b92;",
  "      transform:translateY(-2px)",
  "    }",
  "    .media-frame{",
  "      width:100%;",
  "      aspect-ratio:16/10;",
  "      background:linear-gradient(140deg,#33223c,#161d39);",
  "      position:relative;",
  "      display:grid;",
  "      place-items:center;",
  "      overflow:hidden",
  "    }",
  "    .media-frame img,.media-frame video{",
  "      width:100%;",
  "      height:100%;",
  "      object-fit:contain;",
  "      display:block;",
  "      background:#090c16",
  "    }",
  "    .media-frame video{",
  "      object-fit:contain",
  "    }",
  "    .kind-label{",
  "      position:absolute;",
  "      top:12px;",
  "      left:12px;",
  "      background:#13131cbb;",
  "      color:#fff;",
  "      border:1px solid #ded4f155;",
  "      padding:4px 10px;",
  "      border-radius:99px;",
  "      font-size:11px;",
  "      font-weight:700;",
  "      backdrop-filter:blur(6px)",
  "    }",
  "    .media-fallback{",
  "      font-size:55px;",
  "      opacity:.75",
  "    }",
  "    .media-info{",
  "      padding:18px",
  "    }",
  "    .media-info h3{",
  "      margin:0 0 5px;",
  "      font-size:19px;",
  "      letter-spacing:-.035em;",
  "      overflow-wrap:anywhere",
  "    }",
  "    .byline{",
  "      font-size:12px;",
  "      color:var(--muted)",
  "    }",
  "    .media-description{",
  "      color:#bcc5d7;",
  "      font-size:13px;",
  "      min-height:22px;",
  "      white-space:pre-wrap;",
  "      overflow-wrap:anywhere",
  "    }",
  "    .stats{",
  "      display:flex;",
  "      align-items:center;",
  "      gap:8px;",
  "      margin-top:17px;",
  "      flex-wrap:wrap",
  "    }",
  "    .stats .btn{",
  "      margin-right:auto",
  "    }",
  "    .count{",
  "      color:#d9dbed;",
  "      font-weight:800;",
  "      font-size:13px",
  "    }",
  "    .liked{",
  "      color:#ffb7c8!important;",
  "      background:#4c263f!important;",
  "      border-color:#ac536c!important",
  "    }",
  "    .names{",
  "      color:#8d99b6;",
  "      font-size:11px;",
  "      line-height:1.7;",
  "      margin-top:10px;",
  "      overflow-wrap:anywhere",
  "    }",
  "    .empty{",
  "      padding:52px 24px;",
  "      border:1px dashed #41445e;",
  "      border-radius:25px;",
  "      background:#131626a3;",
  "      text-align:center;",
  "      color:var(--muted)",
  "    }",
  "    .empty .emoj{",
  "      font-size:48px;",
  "      margin-bottom:10px",
  "    }",
  "    .empty h3{",
  "      font-size:21px;",
  "      color:var(--ink);",
  "      margin:0 0 6px",
  "    }",
  "    .empty p{",
  "      margin:0 auto 15px;",
  "      max-width:540px",
  "    }",
  "    .empty.compact{",
  "      padding:28px",
  "    }",
  "    .chat-layout{",
  "      display:grid;",
  "      grid-template-columns:minmax(0,1fr) 270px;",
  "      gap:18px",
  "    }",
  "    .chatbox{",
  "      border:1px solid var(--edge);",
  "      border-radius:23px;",
  "      background:#121626;",
  "      overflow:hidden;",
  "      display:flex;",
  "      flex-direction:column;",
  "      min-height:550px",
  "    }",
  "    .chat-head{",
  "      display:flex;",
  "      align-items:center;",
  "      gap:12px;",
  "      padding:17px 20px;",
  "      border-bottom:1px solid var(--edge);",
  "      background:#1b1e30",
  "    }",
  "    .chat-head strong{",
  "      font-size:16px",
  "    }",
  "    .online{",
  "      height:9px;",
  "      width:9px;",
  "      background:var(--green);",
  "      border-radius:50%;",
  "      box-shadow:0 0 12px #40dcb177",
  "    }",
  "    .chat-messages{",
  "      flex:1;",
  "      padding:20px;",
  "      display:flex;",
  "      flex-direction:column;",
  "      gap:14px;",
  "      overflow-y:auto;",
  "      max-height:490px;",
  "      min-height:300px",
  "    }",
  "    .message{",
  "      display:flex;",
  "      gap:10px;",
  "      align-items:flex-start",
  "    }",
  "    .message .avatar{",
  "      width:33px;",
  "      height:33px;",
  "      font-size:12px",
  "    }",
  "    .bubble{",
  "      background:#23283d;",
  "      border:1px solid #333a54;",
  "      border-radius:4px 15px 15px 15px;",
  "      padding:10px 15px;",
  "      max-width:min(85%,640px);",
  "      min-width:110px",
  "    }",
  "    .bubble strong{",
  "      font-size:12px;",
  "      color:#e1c9ff",
  "    }",
  "    .bubble time{",
  "      font-size:10px;",
  "      color:#8d98b2;",
  "      margin-left:8px",
  "    }",
  "    .bubble p{",
  "      white-space:pre-wrap;",
  "      overflow-wrap:anywhere;",
  "      margin:6px 0 0;",
  "      font-size:13px;",
  "      color:#f1f3fc",
  "    }",
  "    .chat-input-wrap{",
  "      padding:15px 18px;",
  "      border-top:1px solid var(--edge);",
  "      background:#1a1d2e",
  "    }",
  "    .chat-input{",
  "      display:flex;",
  "      gap:8px",
  "    }",
  "    .chat-input .input{",
  "      flex:1",
  "    }",
  "    .chat-tips,.info-card{",
  "      border:1px solid var(--edge);",
  "      border-radius:20px;",
  "      background:#161a2b;",
  "      padding:24px",
  "    }",
  "    .chat-tips h3,.info-card h3{",
  "      margin:0 0 11px;",
  "      font-size:17px",
  "    }",
  "    .chat-tips p,.info-card p{",
  "      color:var(--muted);",
  "      font-size:13px;",
  "      line-height:1.7",
  "    }",
  "    .chat-tips ul{",
  "      padding-left:18px;",
  "      color:#bbc3d6;",
  "      font-size:13px;",
  "      line-height:2",
  "    }",
  "    .form-layout{",
  "      display:grid;",
  "      grid-template-columns:minmax(0,1.3fr) minmax(250px,.8fr);",
  "      gap:23px;",
  "      align-items:start",
  "    }",
  "    .form-card{",
  "      background:#161a2b;",
  "      border:1px solid var(--edge);",
  "      border-radius:24px;",
  "      padding:27px",
  "    }",
  "    .form-card h3{",
  "      margin:0 0 7px;",
  "      font-size:21px",
  "    }",
  "    .form-card>p{",
  "      margin:0 0 16px;",
  "      color:var(--muted);",
  "      font-size:13px",
  "    }",
  "    .field{",
  "      display:block;",
  "      margin-bottom:18px;",
  "      font-size:13px;",
  "      font-weight:800;",
  "      color:#dae0f1",
  "    }",
  "    .field .input{",
  "      display:block;",
  "      margin-top:8px;",
  "      font-weight:450",
  "    }",
  "    .field small{",
  "      display:block;",
  "      color:var(--muted);",
  "      font-weight:400;",
  "      margin-top:7px",
  "    }",
  "    .dropzone{",
  "      position:relative;",
  "      padding:35px 15px;",
  "      text-align:center;",
  "      border:2px dashed #655381;",
  "      border-radius:18px;",
  "      background:linear-gradient(160deg,#1f2039,#161a2a);",
  "      margin-top:8px",
  "    }",
  "    .dropzone:hover,.dropzone.over{",
  "      border-color:#ff7992;",
  "      background:#2e2542",
  "    }",
  "    .dropzone .cloud{",
  "      font-size:39px;",
  "      display:block;",
  "      margin-bottom:8px",
  "    }",
  "    .dropzone strong{",
  "      display:block;",
  "      font-size:15px",
  "    }",
  "    .dropzone small{",
  "      color:#a9a7c7;",
  "      display:block;",
  "      font-weight:500;",
  "      margin-top:6px",
  "    }",
  "    .dropzone input{",
  "      position:absolute;",
  "      inset:0;",
  "      width:100%;",
  "      height:100%;",
  "      opacity:0;",
  "      cursor:pointer",
  "    }",
  "    .file-preview{",
  "      background:#0e1222;",
  "      border:1px solid #343956;",
  "      padding:10px;",
  "      border-radius:15px;",
  "      margin:12px 0;",
  "      display:none",
  "    }",
  "    .file-preview img,.file-preview video{",
  "      width:100%;",
  "      height:250px;",
  "      object-fit:contain;",
  "      background:#080912;",
  "      border-radius:10px",
  "    }",
  "    .file-preview p{",
  "      font-size:12px;",
  "      color:var(--muted);",
  "      margin:8px",
  "    }",
  "    .help-list{",
  "      display:grid;",
  "      gap:12px",
  "    }",
  "    .help-step{",
  "      display:flex;",
  "      gap:13px;",
  "      align-items:flex-start;",
  "      padding:13px;",
  "      border:1px solid #343852;",
  "      background:#1c2034;",
  "      border-radius:16px",
  "    }",
  "    .help-step .num{",
  "      height:30px;",
  "      width:30px;",
  "      border-radius:10px;",
  "      display:grid;",
  "      place-items:center;",
  "      background:#49365c;",
  "      color:#ffc1cd;",
  "      font-weight:900;",
  "      flex-shrink:0",
  "    }",
  "    .help-step h4{",
  "      font-size:13px;",
  "      margin:0 0 3px",
  "    }",
  "    .help-step p{",
  "      font-size:12px;",
  "      margin:0;",
  "      color:var(--muted)",
  "    }",
  "    .status{",
  "      min-height:20px;",
  "      color:var(--soft);",
  "      font-size:13px;",
  "      margin:11px 0",
  "    }",
  "    .status.error{",
  "      color:#ff9dac",
  "    }",
  "    .status.ok{",
  "      color:var(--green)",
  "    }",
  "    .admin-layout{",
  "      display:grid;",
  "      grid-template-columns:1fr;",
  "      gap:16px",
  "    }",
  "    .admin-auth{",
  "      max-width:550px",
  "    }",
  "    .admin-tools{",
  "      display:flex;",
  "      gap:9px;",
  "      flex-wrap:wrap;",
  "      margin:18px 0",
  "    }",
  "    .chip{",
  "      padding:8px 14px;",
  "      border-radius:99px;",
  "      border:1px solid #383f5a;",
  "      background:#1d2238;",
  "      color:#bfc7df;",
  "      font-size:12px;",
  "      font-weight:800",
  "    }",
  "    .chip.active{",
  "      background:#45325d;",
  "      border-color:#a46dce;",
  "      color:#fff",
  "    }",
  "    .admin-post,.admin-message{",
  "      padding:19px;",
  "      border:1px solid #38405a;",
  "      border-radius:17px;",
  "      background:#191d2f;",
  "      margin-bottom:13px",
  "    }",
  "    .admin-post h4{",
  "      margin:0;",
  "      font-size:17px;",
  "      overflow-wrap:anywhere",
  "    }",
  "    .admin-post p{",
  "      margin:6px 0;",
  "      color:#adb9d1;",
  "      font-size:13px;",
  "      white-space:pre-wrap;",
  "      overflow-wrap:anywhere",
  "    }",
  "    .admin-status{",
  "      font-size:11px;",
  "      color:#ffd1a2;",
  "      padding:4px 9px;",
  "      background:#9d652c30;",
  "      border:1px solid #aa713654;",
  "      border-radius:99px",
  "    }",
  "    .admin-post .row,.admin-message .row{",
  "      display:flex;",
  "      gap:8px;",
  "      align-items:center;",
  "      flex-wrap:wrap;",
  "      margin-top:13px",
  "    }",
  "    .admin-post .admin-media{",
  "      display:block;",
  "      width:100%;",
  "      max-width:440px;",
  "      max-height:240px;",
  "      object-fit:contain;",
  "      background:#080b18;",
  "      border-radius:12px;",
  "      margin:14px 0",
  "    }",
  "    .admin-message strong{",
  "      color:#d4c6fa",
  "    }",
  "    .admin-message p{",
  "      white-space:pre-wrap;",
  "      overflow-wrap:anywhere",
  "    }",
  "    .admin-message small{",
  "      color:var(--muted)",
  "    }",
  "    .modal-backdrop{",
  "      position:fixed;",
  "      inset:0;",
  "      z-index:50;",
  "      background:#050710c9;",
  "      backdrop-filter:blur(8px);",
  "      display:none;",
  "      align-items:center;",
  "      justify-content:center;",
  "      padding:20px",
  "    }",
  "    .modal-backdrop.open{",
  "      display:flex",
  "    }",
  "    .modal-dialog{",
  "      width:min(540px,100%);",
  "      max-height:90vh;",
  "      overflow:auto;",
  "      background:#20243a;",
  "      border:1px solid #555b7a;",
  "      border-radius:23px;",
  "      padding:26px;",
  "      box-shadow:var(--shadow)",
  "    }",
  "    .modal-dialog h3{",
  "      margin:0 0 9px;",
  "      font-size:22px",
  "    }",
  "    .modal-dialog p{",
  "      color:#b7c2d7;",
  "      font-size:13px",
  "    }",
  "    .modal-actions{",
  "      display:flex;",
  "      justify-content:flex-end;",
  "      gap:9px;",
  "      flex-wrap:wrap;",
  "      margin-top:17px",
  "    }",
  "    .toast-stack{",
  "      position:fixed;",
  "      right:16px;",
  "      bottom:24px;",
  "      z-index:100;",
  "      display:grid;",
  "      gap:8px;",
  "      width:min(350px,calc(100% - 32px))",
  "    }",
  "    .toast{",
  "      padding:13px 17px;",
  "      border-radius:13px;",
  "      border:1px solid #706184;",
  "      background:#242439;",
  "      box-shadow:0 20px 50px #0006;",
  "      color:#fff;",
  "      font-size:13px;",
  "      animation:toast-in .3s ease",
  "    }",
  "    .toast.error{",
  "      border-color:#b65b72",
  "    }",
  "    @keyframes toast-in{",
  "      from{",
  "      opacity:0;",
  "      transform:translateY(10px)",
  "    }",
  "    to{",
  "      opacity:1;",
  "      transform:translateY(0)",
  "    }",
  "    }",
  "    .spinner{",
  "      width:17px;",
  "      height:17px;",
  "      border-radius:50%;",
  "      border:2px solid #fff6;",
  "      border-top-color:#fff;",
  "      animation:spin .7s linear infinite;",
  "      display:inline-block",
  "    }",
  "    @keyframes spin{",
  "      to{",
  "      transform:rotate(360deg)",
  "    }",
  "    }",
  "    footer{",
  "      padding:33px 0 40px;",
  "      border-top:1px solid #262d40;",
  "      color:var(--muted);",
  "      font-size:12px",
  "    }",
  "    .footer-content{",
  "      display:flex;",
  "      justify-content:space-between;",
  "      gap:12px;",
  "      align-items:center;",
  "      flex-wrap:wrap",
  "    }",
  "    .footer-content strong{",
  "      color:#ddd",
  "    }",
  "    .rainbow-line{",
  "      height:3px;",
  "      background:linear-gradient(90deg,var(--pink),var(--orange),var(--purple),var(--blue));",
  "      opacity:.8",
  "    }",
  "    [hidden]{",
  "      display:none!important",
  "    }",
  "    @media(max-width:1050px){",
  "      .cards{",
  "      grid-template-columns:repeat(2,minmax(0,1fr))",
  "    }",
  "    .hero-layout{",
  "      grid-template-columns:1.5fr 1fr",
  "    }",
  "    .chat-layout{",
  "      grid-template-columns:1fr 240px",
  "    }",
  "    }",
  "    @media(max-width:730px){",
  "      .shell{",
  "      width:min(100% - 24px,1220px)",
  "    }",
  "    .top-inner{",
  "      min-height:70px",
  "    }",
  "    .topbar .logo-type b{",
  "      font-size:13px",
  "    }",
  "    .logo-type small{",
  "      font-size:10px",
  "    }",
  "    .logo-icon{",
  "      height:39px;",
  "      width:39px;",
  "      border-radius:13px",
  "    }",
  "    .beta{",
  "      display:none",
  "    }",
  "    .signed{",
  "      display:none",
  "    }",
  "    .hero{",
  "      padding:35px 0 14px",
  "    }",
  "    .hero-layout,.form-layout,.chat-layout{",
  "      grid-template-columns:1fr",
  "    }",
  "    .hero-card{",
  "      min-height:190px",
  "    }",
  "    .hero h1{",
  "      font-size:42px",
  "    }",
  "    .tabs-wrap{",
  "      top:70px",
  "    }",
  "    .tabs{",
  "      padding:8px 0",
  "    }",
  "    .tab{",
  "      padding:10px 12px;",
  "      font-size:12px",
  "    }",
  "    main{",
  "      padding-top:26px",
  "    }",
  "    .chat-tips{",
  "      order:-1",
  "    }",
  "    .chatbox{",
  "      min-height:470px",
  "    }",
  "    }",
  "    @media(max-width:560px){",
  "      .cards{",
  "      grid-template-columns:1fr",
  "    }",
  "    .hero h1{",
  "      font-size:36px",
  "    }",
  "    .hero-lead{",
  "      font-size:14px",
  "    }",
  "    .form-card{",
  "      padding:18px",
  "    }",
  "    .section-head h2{",
  "      font-size:25px",
  "    }",
  "    .account .btn{",
  "      padding:10px;",
  "      font-size:11px",
  "    }",
  "    .hero-buttons .btn{",
  "      flex:1",
  "    }",
  "    .media-frame{",
  "      aspect-ratio:16/9",
  "    }",
  "    .modal-dialog{",
  "      padding:18px",
  "    }",
  "    }",
  "    @media(prefers-reduced-motion:reduce){",
  "      *,*::before,*::after{",
  "      scroll-behavior:auto!important;",
  "      animation:none!important;",
  "      transition:none!important",
  "    }",
  "    }",
  "",
  "    /* V6 sencilla: conservar la apariencia de Animaciones Nico original. */",
  "    :root {color-scheme:dark;--ink:#f3f3f6;--muted:#aaaab5;--soft:#d0d0d9;",
  "      --bg:#101014;--panel:#1d1d24;--panel-2:#22222b;--panel-3:#24242d;",
  "      --edge:#34343e;--orange:#d9364b;--pink:#d9364b;--purple:#d9364b;",
  "      --blue:#d9364b;--green:#55b18a;--radius:10px;",
  "      --shadow:none;--font:Arial,Helvetica,sans-serif;}",
  "    html{scroll-behavior:auto}",
  "    body{font:15px/1.55 Arial,Helvetica,sans-serif;background:#101014;color:#f3f3f6}",
  "    body::before,.rainbow-line,.hero,.beta,.hero-card,.hero-strip,.hero-buttons{display:none!important}",
  "    .shell{width:min(1150px,calc(100% - 40px))}",
  "    .topbar{background:#18181f;position:static;border-bottom:1px solid #35353d;backdrop-filter:none}",
  "    .top-inner{min-height:90px;padding-top:15px;align-items:center}",
  "    .logo{gap:0}.logo-type b{font:700 25px/1.3 Arial,sans-serif;letter-spacing:2px;color:#fff}",
  "    .logo-icon{display:grid!important;width:43px;height:43px;min-width:43px;border-radius:12px;background:linear-gradient(145deg,#ff5778 0%,#ff9853 70%,#f4b86d 100%);color:white;box-shadow:none}.logo{gap:12px}.logo-icon svg{height:25px;width:25px}@media(max-width:680px){.logo-icon{width:38px;height:38px;min-width:38px}}",
  "    .logo-type small{display:block;font:13px/1.6 Arial,sans-serif;color:#bfc0ca;letter-spacing:0;text-transform:none;margin-top:3px}",
  "    .site-intro{padding:0 0 18px}.site-intro p{font-size:15px;color:#c6c6d0;margin:0;max-width:760px}",
  "    .tabs-wrap{background:#141419;border-bottom:1px solid #333;position:static;box-shadow:none}",
  "    .tabs{display:flex;gap:9px;padding:15px 0;flex-wrap:wrap;overflow:visible}",
  "    .tab{background:#2a2a32;color:#fff;border:1px solid #41414a;border-radius:7px;padding:11px 16px;min-height:45px;font:15px Arial,sans-serif;box-shadow:none}",
  "    .tab.active,.tab[aria-selected=true]{background:#d9364b;color:#fff;border-color:#d9364b;box-shadow:none}",
  "    .btn.primary{background:#d9364b;color:#fff;border:1px solid #d9364b;box-shadow:none}",
  "    .btn,.chip{background:#2a2a32;color:#fff;border:1px solid #41414a;border-radius:7px;box-shadow:none}",
  "    .btn:hover,.tab:hover{background:#41414c;transform:none;box-shadow:none}",
  "    main.shell{padding:30px 0;min-height:63vh}",
  "    section{animation:none!important}.section-head{margin-bottom:22px}",
  "    .section-head h2{font:700 28px/1.3 Arial,sans-serif;color:#fff;letter-spacing:0}",
  "    .section-head p{font-size:15px;color:#aaaab5}",
  "    .section-note{background:transparent;border:0;color:#aaaab5}",
  "    .media-card,.chatbox,.form-card,.info-card,.chat-tips,.admin-post,.admin-auth,.empty,.modal-dialog{background:#1d1d24;border:1px solid #34343e;border-radius:10px;box-shadow:none}",
  "    .media-card:hover{transform:none;box-shadow:none}",
  "    .media-info{padding:17px}",
  "    .input{border-radius:7px;border:1px solid #454550;background:#22222b;color:#fff}",
  "    .dropzone{border-radius:8px;background:#22222b;border-color:#454550}",
  "    .chat-head{background:#22222b}",
  "    .message .bubble{background:#292933;border-radius:8px}",
  "    footer{background:#141419;border-top:1px solid #30303a;color:#aaaab5;padding:24px 0;text-align:center}",
  "    .footer-content{display:block;text-align:center}",
  "    #googleBtn{background:#2a2a32;border:1px solid #41414a;color:#fff}",
  "    @media(max-width:680px){.top-inner{flex-wrap:wrap;gap:10px;padding-bottom:10px}.logo-type b{font-size:21px}",
  "      .tabs{gap:7px}.tab{font-size:13px;flex:1 1 40%;padding:10px 6px;text-align:center}",
  "      .site-intro{padding-bottom:13px}.section-note{display:none}}",
  "    /* V6 solicitada: cada sección tiene contenido propio y no hay decoraciones extra. */",
  "    .form-layout{display:block;max-width:690px}",
  "    #uploadForm{max-width:690px;display:flex;flex-direction:column;gap:8px;padding:21px}",
  "    #uploadForm .field{margin:4px 0 8px}",
  "    #uploadForm .input{margin-top:7px;width:100%}",
  "    #uploadForm textarea{min-height:95px;resize:vertical}",
  "    #uploadForm small,.minor-note{font-size:13px;color:#b7b7c1}",
  "    .mute-notice{background:#3d2531;border:1px solid #bf697f;border-radius:8px;color:#ffe0e6;padding:14px;margin-bottom:15px;white-space:pre-wrap}",
  "    .suspend-form{padding:20px;max-width:690px;margin:18px 0}",
  "    .suspend-form .field{display:block;margin:12px 0}",
  "    .suspend-form select,.suspend-form input,.suspend-form textarea{width:100%;margin-top:7px}",
  "    .suspend-form textarea{min-height:80px;resize:vertical}",
  "    .moderation-status{color:#f4c2cf;font-size:13px;margin:10px 0}",
  "    #postGrid .stats{border-top:1px solid #34343e;padding-top:12px;margin-top:13px}",
  "    #postGrid .names{padding-top:8px;color:#bdbdc9;font-size:13px}",
  "    .media-fallback{border-radius:0}",
  "    .preview-only{font-size:12px;color:#bbb;border:1px solid #555;padding:6px 9px;border-radius:5px;margin-bottom:15px}",
  "    section[hidden],.suspend-form[hidden],.mute-notice[hidden]{display:none!important}",
  "    @media(max-width:680px){#uploadForm{padding:16px}.tab{flex:1 1 42%;font-size:12px}}",
  "    /* V6: imagen o video se abre en grande al pulsar la publicación. */",
  "    .publication-media-zoom{cursor:zoom-in;position:relative;}",
  "    .publication-media-zoom:focus-visible{outline:3px solid #ef98a7;outline-offset:3px;}",
  "    .publication-media-zoom img,.publication-media-zoom video{pointer-events:none;}",
  "    .publication-media-zoom::after{",
  "      content:'Pulsar para ampliar';position:absolute;right:10px;bottom:10px;",
  "      padding:5px 10px;border-radius:6px;background:#0c0c10d9;color:#fff;",
  "      font-size:12px;pointer-events:none;opacity:.92",
  "    }",
  "    .viewer-backdrop{position:fixed;inset:0;z-index:120;background:#050508f2;",
  "      display:flex;align-items:center;justify-content:center;padding:16px;}",
  "    .viewer-backdrop[hidden]{display:none!important;}",
  "    .viewer-panel{width:min(1200px,100%);max-height:95vh;display:flex;flex-direction:column;gap:10px;}",
  "    .viewer-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;}",
  "    .viewer-bar h3{color:#fff;font-size:17px;margin:0;overflow-wrap:anywhere;}",
  "    .viewer-media{background:#08080a;border:1px solid #373740;border-radius:8px;",
  "      min-height:180px;display:flex;align-items:center;justify-content:center;overflow:hidden;}",
  "    .viewer-media img,.viewer-media video{max-height:calc(95vh - 125px);max-width:100%;object-fit:contain;}",
  "    .viewer-media video{width:100%;}",
  "    .viewer-media .demo-note{padding:50px 20px;text-align:center;color:#c6c6cd;}",
  "    @media (max-width:600px){.viewer-backdrop{padding:9px}.viewer-bar h3{font-size:14px}}",
  "    /* V6: botón de pantalla completa REAL, como el reproductor de YouTube. */",
  "    .publication-media-zoom.has-fullscreen::after{left:10px;right:auto;bottom:10px;}",
  "    .publication-fullscreen-btn{position:absolute;right:10px;bottom:10px;z-index:3;",
  "      display:grid;place-items:center;width:43px;height:38px;color:#fff;",
  "      background:#09090dcf;border:1px solid #ffffff66;border-radius:5px;cursor:pointer;}",
  "    .publication-fullscreen-btn:hover,.publication-fullscreen-btn:focus-visible{background:#25252fd9;outline:2px solid #fff;}",
  "    .publication-fullscreen-btn svg{width:23px;height:23px;pointer-events:none;}",
  "    .viewer-fullscreen-action[hidden]{display:none!important;}",
  "    .viewer-fullscreen-action{white-space:nowrap;}",
  "    .viewer-media:fullscreen,.viewer-media:-webkit-full-screen{",
  "      width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;",
  "      border:0!important;border-radius:0!important;background:#000!important;",
  "      padding:0!important;margin:0!important;overflow:hidden!important;}",
  "    .viewer-media:fullscreen video,.viewer-media:-webkit-full-screen video,",
  "    .viewer-media video:fullscreen,.viewer-media video:-webkit-full-screen{",
  "      width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;",
  "      object-fit:contain;background:#000!important;display:block;}",
  "    .viewer-media:fullscreen .demo-note{font-size:22px;}",
  "    @media(max-width:600px){.viewer-fullscreen-action{font-size:12px;}}",
  "    /* Navegador: el video ocupa el monitor entero; pueden aparecer bandas negras si su proporción es distinta. */",
  "  </style>",
  "</head>",
  "<body>",
  "  <a class=\"skip\" href=\"#contenido\">Saltar al contenido</a>",
  "  <div class=\"rainbow-line\"></div>",
  "  <header class=\"topbar\">",
  "    <div class=\"shell top-inner\">",
  "      <div class=\"logo\" aria-label=\"Animaciones Nico\">",
  "        <div class=\"logo-icon\" aria-hidden=\"true\"><svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M8 5.8c0-1 1.05-1.6 1.9-1.1l9.3 5.7c.85.53.85 1.7 0 2.2l-9.3 5.7c-.85.5-1.9-.1-1.9-1.1V5.8Z\" fill=\"currentColor\"/><path d=\"M4 4v16\" stroke=\"currentColor\" stroke-width=\"2.3\" stroke-linecap=\"round\"/></svg></div>",
  "        <div class=\"logo-type\"><b>ANIMACIONES NICO</b><small>(para la comunidad escolar, y mis conocidos)</small></div>",
  "      </div>",
  "      <div class=\"account\">",
  "        <div id=\"userBox\" class=\"account\" hidden><span id=\"userAvatar\" class=\"avatar\">N</span><span id=\"userName\" class=\"signed\">Usuario</span><button id=\"logoutBtn\" class=\"btn ghost mini\" type=\"button\">Salir</button></div>",
  "        <button id=\"googleBtn\" class=\"btn mini\" type=\"button\">Entrar con Google</button>",
  "      </div>",
  "    </div>",
  "    <div class=\"shell site-intro\"><p>Espero que les guste mi sitio web. Me tomó mucho esfuerzo hacerlo. Por favor, nunca lo abandonen...</p></div>",
  "  </header>",
  "  <div class=\"tabs-wrap\"><nav class=\"shell tabs\" role=\"tablist\" aria-label=\"Secciones principales\">",
  "    <button id=\"tab-publicaciones\" type=\"button\" class=\"tab active\" data-tab=\"publicaciones\" role=\"tab\" aria-selected=\"true\">Publicaciones</button>",
  "    <button id=\"tab-subir\" type=\"button\" class=\"tab\" data-tab=\"subir\" role=\"tab\" aria-selected=\"false\">Subir animación</button>",
  "    <button id=\"tab-chat\" type=\"button\" class=\"tab\" data-tab=\"chat\" role=\"tab\" aria-selected=\"false\">Chat</button>",
  "    <button id=\"tab-admin\" type=\"button\" class=\"tab\" data-tab=\"admin\" role=\"tab\" aria-selected=\"false\">Administración</button>",
  "  </nav></div>",
  "  <main id=\"contenido\" class=\"shell\">",
  "    <section id=\"publicaciones\" role=\"tabpanel\" aria-labelledby=\"tab-publicaciones\">",
  "      <div class=\"section-head\"><div><h2>Publicaciones</h2><p>Aquí aparecen solamente las imágenes y animaciones que Nico ha aprobado.</p></div></div>",
  "      <div class=\"filters\"><label class=\"search\"><span class=\"sr-only\"></span><span style=\"position:absolute;left:15px;top:13px\"></span><input id=\"searchPosts\" class=\"input\" placeholder=\"Buscar título o creador…\" aria-label=\"Buscar publicaciones\" style=\"padding-left:39px\"></label><select id=\"typeFilter\" class=\"input\" style=\"width:auto;min-width:145px\"><option value=\"all\">Todo</option><option value=\"video\"> Videos</option><option value=\"image\"> Imágenes</option></select><button id=\"refreshPosts\" class=\"btn mini\">Actualizar</button></div>",
  "      <div id=\"postsStatus\" class=\"status\" aria-live=\"polite\"></div>",
  "      <div id=\"postGrid\" class=\"cards\"></div>",
  "    </section>",
  "    <section id=\"chat\" role=\"tabpanel\" aria-labelledby=\"tab-chat\" hidden>",
  "      <div class=\"section-head\"><div><h2>Chat</h2><p>Para escribir debes iniciar sesión con Google. Aquí se muestra tu nombre, nunca tu correo.</p></div><button id=\"refreshChat\" class=\"btn mini\">Actualizar</button></div>",
  "      <div id=\"muteNotice\" class=\"mute-notice\" role=\"alert\" hidden></div><div class=\"chat-layout\"><div class=\"chatbox\">",
  "        <div class=\"chat-head\"><div><strong>Comunidad Animaciones Nico</strong><div style=\"color:var(--muted);font-size:11px\">Mensajes moderados por Nico</div></div></div>",
  "        <div id=\"chatMessages\" class=\"chat-messages\" role=\"log\" aria-live=\"polite\" aria-relevant=\"additions\"></div>",
  "        <form id=\"chatForm\" class=\"chat-input-wrap\"><div class=\"chat-input\"><input id=\"chatText\" class=\"input\" placeholder=\"Inicia sesión con Google para escribir…\" maxlength=\"500\" autocomplete=\"off\"><button class=\"btn primary\" type=\"submit\" id=\"sendChat\">Enviar</button></div><div class=\"status\" id=\"chatStatus\"></div></form>",
  "      </div><aside class=\"chat-tips\"><h3>Normas del chat</h3><p>Un lugar seguro para compartir tu creatividad.</p><ul><li>Trata a todos con respeto.</li><li>No compartas datos personales.</li><li>No envíes enlaces sospechosos.</li><li>Nico puede ocultar mensajes.</li></ul><p>Solo las cuentas que inician sesión con Google pueden escribir.</p></aside></div>",
  "    </section>",
  "    <section id=\"subir\" role=\"tabpanel\" aria-labelledby=\"tab-subir\" hidden>",
  "      <div class=\"section-head\"><div><h2>Subir animación</h2><p>Solicita publicar tu video o imagen. Nico revisará la solicitud antes de aceptarla.</p></div></div>",
  "      <div class=\"form-layout\"><form id=\"uploadForm\" class=\"form-card\" novalidate>",
  "        <p class=\"minor-note\">Todos los campos son obligatorios. El creador inspeccionará tu contenido antes de publicarlo.</p>",
  "        <label class=\"field\">Título del video o imagen",
  "          <input id=\"uploadTitle\" class=\"input\" maxlength=\"120\" minlength=\"3\" placeholder=\"Escribe un título\" required>",
  "        </label>",
  "        <label class=\"field\">Descripción del video o imagen",
  "          <textarea id=\"uploadDescription\" class=\"input\" maxlength=\"600\" placeholder=\"Escribe de qué trata\" required></textarea>",
  "        </label>",
  "        <label class=\"field\">Subir imagen o animación",
  "          <input id=\"uploadFile\" class=\"input\" type=\"file\" accept=\"video/mp4,video/webm,image/jpeg,image/png,image/webp,image/gif\" required>",
  "          <small>(Esto será enviado al creador, quien lo inspeccionará antes de publicarlo).</small>",
  "        </label>",
  "        <div id=\"preview\" class=\"file-preview\"></div>",
  "        <label class=\"field\">Dile algo al creador para que publique tu imagen o animación",
  "          <textarea id=\"uploadNote\" class=\"input\" maxlength=\"300\" placeholder=\"Ejemplo: Yo soy... Me gustaría que publiques mi creación porque...\" required></textarea>",
  "          <small>Este mensaje solo lo verá el administrador. No compartas datos personales.</small>",
  "        </label>",
  "        <button id=\"uploadButton\" class=\"btn primary\" type=\"submit\">Enviar solicitud al creador</button>",
  "        <p id=\"uploadStatus\" class=\"status\" aria-live=\"polite\"></p>",
  "      </form></div>",
  "    </section>",
  "    <section id=\"admin\" role=\"tabpanel\" aria-labelledby=\"tab-admin\" hidden>",
  "      <div class=\"section-head\"><div><h2>Administración</h2><p>Zona exclusiva del creador: revisar solicitudes, editar publicaciones y moderar el chat.</p></div></div>",
  "      <div id=\"adminLogin\" class=\"form-card admin-auth\"><h3>Acceso exclusivo de Nico</h3><p>Introduce la contraseña de administrador configurada en Render.</p><form id=\"adminLoginForm\"><label class=\"field\">Contraseña<input type=\"password\" class=\"input\" id=\"adminPassword\" autocomplete=\"current-password\" required placeholder=\"Contraseña de administración\"></label><button class=\"btn primary\" type=\"submit\">Entrar al panel</button></form><p id=\"adminLoginStatus\" class=\"status\"></p><button id=\"demoAdmin\" class=\"btn mini\" type=\"button\" hidden>Ver panel de ejemplo (vista previa)</button></div>",
  "      <div id=\"adminPanel\" class=\"admin-layout\" hidden><div class=\"admin-tools\"><button class=\"btn mini\" id=\"adminRefresh\">Actualizar</button><button class=\"chip active\" id=\"adminPostsTab\" data-admin-view=\"posts\">Publicaciones</button><button class=\"chip\" id=\"adminChatTab\" data-admin-view=\"chat\">Moderar chat</button><button class=\"btn ghost mini\" id=\"adminLogout\" style=\"margin-left:auto\">Cerrar sesión</button></div><div id=\"adminStatus\" class=\"status\"></div>",
  "        <form id=\"suspendForm\" class=\"form-card suspend-form\" hidden novalidate>",
  "          <h3>Suspender a una persona del chat</h3>",
  "          <p>Selecciona a alguien que haya escrito en el chat, elige los días y explica el motivo. Esa persona verá el aviso cuando entre al chat.</p>",
  "          <label class=\"field\">Usuario del chat<select id=\"suspendUser\" class=\"input\" required><option value=\"\">Selecciona un usuario</option></select></label>",
  "          <label class=\"field\">Días de suspensión<input id=\"suspendDays\" class=\"input\" type=\"number\" min=\"1\" max=\"365\" value=\"3\" required></label>",
  "          <label class=\"field\">Motivo de la suspensión<textarea id=\"suspendReason\" class=\"input\" maxlength=\"150\" required placeholder=\"Explica el motivo\"></textarea></label>",
  "          <div class=\"row\"><button class=\"btn primary mini\" type=\"submit\">Suspender del chat</button>",
  "          <button class=\"btn mini\" type=\"button\" id=\"unsuspendUser\">Quitar suspensión</button></div>",
  "          <p id=\"suspendStatus\" class=\"status\" aria-live=\"polite\"></p>",
  "        </form><div id=\"adminList\"></div></div>",
  "    </section>",
  "  </main>",
  "  <footer><div class=\"shell footer-content\"><span>Autor: su conocido, estimado y amigo leal Nico.</span></div></footer>",
  "  <div id=\"modal\" class=\"modal-backdrop\" aria-hidden=\"true\"><div class=\"modal-dialog\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"modalTitle\"><h3 id=\"modalTitle\">Editar publicación</h3><p id=\"modalCaption\">Los cambios se guardarán en Appwrite.</p><form id=\"editForm\"><input type=\"hidden\" id=\"editId\"><label class=\"field\">Título<input id=\"editTitle\" class=\"input\" maxlength=\"120\" required></label><label class=\"field\">Descripción<textarea id=\"editDescription\" class=\"input\" maxlength=\"1000\"></textarea></label><div class=\"modal-actions\"><button class=\"btn ghost\" type=\"button\" id=\"cancelEdit\">Cancelar</button><button class=\"btn primary\" type=\"submit\">Guardar cambios</button></div></form></div></div>",
  "  <div id=\"mediaViewer\" class=\"viewer-backdrop\" hidden aria-hidden=\"true\">",
  "    <div class=\"viewer-panel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"viewerTitle\">",
  "      <div class=\"viewer-bar\">",
  "        <h3 id=\"viewerTitle\">Publicación</h3>",
  "        <div class=\"row\"><button type=\"button\" class=\"btn mini viewer-fullscreen-action\" id=\"viewerFullscreen\" aria-label=\"Ver video a pantalla completa\" title=\"Pantalla completa\" hidden>⛶ Pantalla completa</button><button type=\"button\" class=\"btn mini\" id=\"viewerClose\" aria-label=\"Cerrar imagen o video ampliado\">Cerrar ×</button></div>",
  "      </div>",
  "      <div id=\"viewerMedia\" class=\"viewer-media\"></div>",
  "    </div>",
  "  </div>",
  "  <div id=\"toastStack\" class=\"toast-stack\" aria-live=\"polite\"></div>",
  "  <script src=\"https://cdn.jsdelivr.net/npm/appwrite@29.3.1\"></script>",
  "  <script>",
  "    'use strict';",
  "    const APPWRITE_SETTINGS = __CLIENT_CONFIG__;",
  "    const DEMO = Boolean(APPWRITE_SETTINGS.demo) || location.protocol === 'file:';",
  "    const DEMO_VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAASibW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA810cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAeAAAAEOAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAIAAABAAAAAANFbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAA8AAAAeABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAC8G1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAArBzdGJsAAAAwHN0c2QAAAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAeABDgBIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAV/+EAGmdkABWs2UHgj+sBEAAAAwAQAAADAeDxYtlgAQAFaO+CnLD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAJNAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAB4AAAQAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAEAY3R0cwAAAAAAAAAeAAAAAQAACAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAeAAAAAQAAAIxzdHN6AAAAAAAAAAAAAAAeAAAHkQAAAA4AAAAOAAAADgAAAA4AAAAPAAAADwAAAA4AAAAOAAAADwAAAA8AAAAOAAAADgAAAA8AAAAPAAAADgAAAA4AAAAPAAAADwAAAA4AAAAOAAAADwAAAA8AAAAOAAAADgAAAA8AAAAPAAAADgAAAA4AAAAPAAAAFHN0Y28AAAAAAAAAAQAABNIAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAzAAAACGZyZWUAAAk8bWRhdAAAAq0GBf//qdxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0xIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTIgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9MCB0aHJlYWRzPTcgbG9va2FoZWFkX3RocmVhZHM9MiBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTEga2V5aW50PTI1MCBrZXlpbnRfbWluPTE1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9MTAgcmM9Y3JmIG1idHJlZT0xIGNyZj0zNi4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAE3GWIhADfdlhS/dKkrAerMD5zp2Aqrgcsz+beZq+20+qNh4AAAATZpAAZHW2nG5Xwdy+BgAAECMwYGzhJoAzgAR4qjuhY4x+eTMa/ynLYmoz+pKdVIrDXt1AdZJ0ibzHI/XXKLWHDOQE4UlmQDK2atvy+mXVEYQe7gvt+QpVmOdlcWxWN275mqyd/bZYM8nkQyrOtu7Q0vtciyVNNwBNSykBq1Yy3eDcrq1UTYHbG8hfSUItvQvcxmI28VJgD4tj5fdMp1QsOe8GKd0lBPNFJtTPfD6IrWGhMsN48VxZj4YACtx+MWecpM6QH/b1ByMYit/wTs7TFQOLlP9jRAtIorAx4z+8pF8Q+WMtsqEmpcGs8YXYG0eg0PDrR97NL8MV9+vhhdsATSZbdw2oFkMa/FarSaTGLWBn5zmJFVWUT0mWZcljYrstOa+opGzYg30MoREHnXz50RrBnR6gwZtuWRJCzk9BJD5iS5HkfjZIziQP/8pdVzzZAOOeVqTQTRwi5SjSzkZ9PyrSzfc1s2Ucl2pb9UGUaDMAB5KuEc1inmwdI5ZNM7NJZ+/8fL18qPtH39MmXFBjTqkCYbaO9CldnyvlBIPxPeDO4UDAImFKnB73doqpIGtvLlBQmSL7gYpcqnhcOQpq8oR0o0GuhCkZ2fhwfGyePyhuOfqhheIMoe4yz/lDAgYOUReAV0Yoth+lGoSXTQtfxgdNs05M/daA+IwbLKmGyJ7QfdEnPsrM/PDq+fdl/eViYnYx9NnW9kKc47HOGV3O84QUDHKfyuSsD51maBbCuRxWh8vwUve5d/ezo6JMJz2YktVILybjgcg671oJpNCOSii9NBC2ibi4eGT3U0Xo5itp6C1VYtH/gPOsid4RPuozBfCzJaOcdAoi/LpDYuVb6YIL9C+0aFP2hT12ax869mTp+S6LxK4OnRfIlhohhetQaxByi3CN9qD78VYBYgcI+munyLyc2iuWgo8jz7ZR4huYaBmjVVh9Mkihvk2SA34EeYc47wjPEk2KulVbkLtUaCIY8cDItbxHq4yScM6Qh2HCyomNjUsRupkYA5jg2rB3KWjL+6yQU8hdk6Byweg3c/+2Ibh1KZ4zWaI8Lsfre+zpKfu+0jW3ZsUaum6QAFxR8s7me8B7GdT4uPYYl+Dqo7ejSQqNlrO4J94m6rmFlDCXgolxQbKs1D8RJzazZiP/fr1+7wWl0I7KuNRRNlw1VrIp/oIgzU69dXm/9OwuZqanvsvDaQ5AqmpVj1xMmQlocuV2yvau1w5rW+sasqX6J2xGYOt94P9+RzRTMDvao6JLqqV17LfjkGmZUF0GLrvOZrSxEb5QHQlHepjaSFvmftHCotQDW5OwHaBkeI85Kihc58phHJtWMu/7bUaX7j0dKCsV35cWoL4R1H7sB4QhmvSKtVZrrD3ahVjjyx/5fm/cadF+RClZYzpyqCdGv5FryRUG1CtUP7mtgNBgPAPwcLrjlWNNoZClKEJJrDjMUmmhDlIot0gnKltz5VTOYCXwRr/S/UNN2OPrH0QAyxmsj8jPbSjQwIPG5OJieCEylsEeWlQWPWcNhPVpN6sZvavNmv2odThRRoCysgUOtcAnxyHGPLvc8vAgAPgixD70YEGuOZ7gcl8vvNz/tygAC3KgAAAMAADihAAAACkGaJBiI/wAAB3QAAAAKQZ5CQjP/AAAdMQAAAAoBnmFEIf8AAB6QAAAACgGeY0Qh/wAAHpEAAAALQZpoNExEfwAAB3UAAAALQZ6GRREsZwAAHTEAAAAKAZ6lRCH/AAAekQAAAAoBnqdEIf8AAB6QAAAAC0GarDRMRH8AAAd0AAAAC0GeykUVLGcAAB0xAAAACgGe6UQh/wAAHpAAAAAKAZ7rRCH/AAAekAAAAAtBmvA0TER/AAAHdQAAAAtBnw5FFSxnAAAdMQAAAAoBny1EIf8AAB6RAAAACgGfL0Qh/wAAHpAAAAALQZs0NExEfwAAB3QAAAALQZ9SRRUsZwAAHTEAAAAKAZ9xRCH/AAAekAAAAAoBn3NEIf8AAB6QAAAAC0GbeDRMRH8AAAd1AAAAC0GflkUVLGcAAB0wAAAACgGftUQh/wAAHpEAAAAKAZ+3RCH/AAAekQAAAAtBm7w0TEZ/AAAKmAAAAAtBn9pFFSxnAAAdMQAAAAoBn/lEIf8AAB6QAAAACgGf+0Qh/wAAHpEAAAALQZv9NExCHwAADek=';",
  "    const qs = sel => document.querySelector(sel);",
  "    const qsa = sel => [...document.querySelectorAll(sel)];",
  "    const state = {",
  "      activeTab: 'publicaciones',",
  "      posts: [],",
  "      chat: [],",
  "      user: null,",
  "      auth: null,",
  "      adminToken: '',",
  "      adminPosts: [],",
  "      adminChat: [],",
  "      adminView: 'posts',",
  "      loading: false,",
  "      lastChatId: '',",
  "      lastPreview: null,",
  "      activeMedia: [],",
  "      suspension: null,",
  "      adminUsers: [],",
  "    };",
  "    const demoPosts = [",
  "      {id:'demo1',titulo:'Un viaje entre estrellas',nombre:'Nico',descripcion:'Mi primer cortometraje de aventuras: un universo lleno de imaginación.',tipo:'video',estado:'aprobado',likes:[{nombre:'Sofía',usuario_id:'demo-a'},{nombre:'Leo',usuario_id:'demo-b'}],fecha:new Date().toISOString()},",
  "      {id:'demo2',titulo:'Mundo jurásico',nombre:'Alex',descripcion:'Una ilustración de criaturas prehistóricas.',tipo:'image',estado:'aprobado',likes:[{nombre:'Mia',usuario_id:'demo-c'}],fecha:new Date().toISOString()},",
  "      {id:'demo3',titulo:'El bosque de los sueños',nombre:'Valentina',descripcion:'Cada rincón esconde una pequeña historia.',tipo:'image',estado:'aprobado',likes:[],fecha:new Date().toISOString()},",
  "    ];",
  "    const demoChat = [",
  "      {id:'m1',nombre:'Nico',contenido:'¡Bienvenidos a nuestra comunidad de animación! ',fecha:new Date(Date.now()-5000000).toISOString()},",
  "      {id:'m2',nombre:'Sofía',contenido:'Me gusta cómo está quedando la nueva página ',fecha:new Date(Date.now()-2000000).toISOString()},",
  "      {id:'m3',nombre:'Alex',contenido:'¿Alguien más está haciendo un dibujo?',fecha:new Date(Date.now()-800000).toISOString()},",
  "    ];",
  "    function elt(tag, cls='', content='') {",
  "      const node = document.createElement(tag);",
  "      if (cls) node.className = cls;",
  "      if (content) node.textContent = content;",
  "      return node;",
  "    }",
  "    function button(label, klass='btn mini', click=null) {",
  "      const node = elt('button', klass, label);",
  "      node.type = 'button';",
  "      if (click) node.addEventListener('click', click);",
  "      return node;",
  "    }",
  "    function status(selector,message,kind='') {",
  "      const node = qs(selector);",
  "      if (!node) return;",
  "      node.textContent = message;",
  "      node.className = 'status '+kind;",
  "    }",
  "    function toast(message,error=false) {",
  "      const list = qs('#toastStack');",
  "      const item=elt('div','toast'+(error?' error':''),message);",
  "      list.append(item);",
  "      setTimeout(()=>item.remove(),4200);",
  "    }",
  "    function relativeDate(value) {",
  "      if (!value) return '';",
  "      try { return new Date(value).toLocaleDateString('es-PE',{day:'numeric',month:'short',year:'numeric'}); }",
  "      catch { return ''; }",
  "    }",
  "    function shortTime(value) {",
  "      if (!value) return '';",
  "      try { return new Date(value).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'}); }",
  "      catch { return ''; }",
  "    }",
  "    function initials(name) { return (name||'?').trim().slice(0,1).toLocaleUpperCase(); }",
  "    function cleanName(name) { return (name||'').trim().slice(0,60)||'Usuario'; }",
  "    function setLoading(node,value,label='Cargando…') {",
  "      if (!node) return;",
  "      if (value) { node.dataset.was = node.textContent; node.innerHTML='<span class=\"spinner\"></span> '+label; node.disabled=true; }",
  "      else { node.textContent=node.dataset.was||node.textContent; node.disabled=false; }",
  "    }",
  "    function safeMessage(e) { return e?.message || 'Algo salió mal. Inténtalo nuevamente.'; }",
  "    async function api(route,options={}) {",
  "      if (DEMO) throw new Error('Esta vista es una demostración. Para usar datos reales, hay que desplegar V6.');",
  "      const headers={...(options.headers||{})};",
  "      if (state.adminToken) headers.Authorization='Admin '+state.adminToken;",
  "      if (state.user && state.auth) {",
  "        try {",
  "          const jwt=await state.auth.createJWT();",
  "          if (jwt?.jwt) headers['X-Nico-JWT']=jwt.jwt;",
  "        } catch(e) {",
  "          if (options.requiresUser) throw new Error('Tu sesión de Google terminó. Vuelve a entrar.');",
  "        }",
  "      }",
  "      const response=await fetch(route,{...options,headers});",
  "      let data;",
  "      try { data=await response.json(); } catch { data={}; }",
  "      if (!response.ok) throw new Error(data.error||'Error '+response.status);",
  "      return data;",
  "    }",
  "    function selectTab(tab) {",
  "      state.activeTab=tab;",
  "      qsa('[role=\"tabpanel\"]').forEach(x=>{x.hidden=x.id!==tab;});",
  "      qsa('.tab').forEach(x=>{",
  "        const active=x.dataset.tab===tab;",
  "        x.classList.toggle('active',active);",
  "        x.setAttribute('aria-selected',String(active));",
  "      });",
  "      if (tab==='publicaciones') loadPosts();",
  "      if (tab==='chat') loadChat();",
  "      if (tab==='admin'&&state.adminToken) loadAdmin();",
  "      const top=qs('.tabs-wrap').getBoundingClientRect().top+window.scrollY-72;",
  "      window.scrollTo({top,behavior:'smooth'});",
  "      if (location.hash!==('#'+tab)) history.replaceState(null,'','#'+tab);",
  "    }",
  "    function setupTabs() {",
  "      qsa('[data-tab]').forEach(tab=>tab.addEventListener('click',()=>selectTab(tab.dataset.tab)));",
  "      qsa('[data-go]').forEach(tab=>tab.addEventListener('click',()=>selectTab(tab.dataset.go)));",
  "      const name=location.hash.slice(1);",
  "      if (['publicaciones','chat','subir','admin'].includes(name)) selectTab(name);",
  "    }",
  "    async function initGoogle() {",
  "      if (DEMO) { state.user=null;renderLogin();return; }",
  "      if (!window.Appwrite || !APPWRITE_SETTINGS.endpoint || !APPWRITE_SETTINGS.project) {",
  "        toast('Appwrite no cargó. Revisa la conexión.',true); renderLogin();return;",
  "      }",
  "      try {",
  "        const client=new window.Appwrite.Client();",
  "        client.setEndpoint(APPWRITE_SETTINGS.endpoint).setProject(APPWRITE_SETTINGS.project);",
  "        state.auth=new window.Appwrite.Account(client);",
  "        state.user=await state.auth.get();",
  "      } catch(e) { state.user=null; }",
  "      renderLogin();",
  "    }",
  "    function renderLogin() {",
  "      const logged=Boolean(state.user);",
  "      qs('#googleBtn').hidden=logged;",
  "      qs('#userBox').hidden=!logged;",
  "      if (logged) {",
  "        qs('#userName').textContent=cleanName(state.user.name);",
  "        qs('#userAvatar').textContent=initials(state.user.name);",
  "      }",
  "      qs('#chatText').placeholder=logged?'Escribe un mensaje para la comunidad…':'Inicia sesión con Google para enviar mensajes…';",
  "      renderSuspension();",
  "      qs('#sendChat').disabled=!logged;",
  "      qs('#chatText').disabled=!logged;",
  "      qs('#uploadButton').disabled=false;",
  "    }",
  "    async function googleLogin() {",
  "      if (DEMO) { toast('Vista previa: Google funcionará después de configurar OAuth.');return; }",
  "      if (!state.auth) { toast('Appwrite aún no está listo.',true);return; }",
  "      try {",
  "        // Es necesario habilitar Google en Appwrite y registrar el dominio web.",
  "        await state.auth.createOAuth2Session({provider:'google',success:location.origin+'/',failure:location.origin+'/#publicaciones'});",
  "      } catch(e) { toast('No se pudo abrir Google: '+safeMessage(e),true); }",
  "    }",
  "    async function googleLogout() {",
  "      if (!DEMO && state.auth) {",
  "        try { await state.auth.deleteSession({sessionId:'current'}); }",
  "        catch(e) { toast(safeMessage(e),true); }",
  "      }",
  "      state.user=null;",
  "      renderLogin();",
  "      loadPosts();",
  "      toast('Sesión cerrada');",
  "    }",
  "    function mediaElement(post, admin=false) {",
  "      const container=elt('div','media-frame');",
  "      const src=post.media || '';",
  "      if (DEMO && post.tipo==='video') {",
  "        // El clip solo se usa para probar los controles en la vista previa local.",
  "        const demoVideo=document.createElement('video');",
  "        demoVideo.src=DEMO_VIDEO;",
  "        demoVideo.muted=true;",
  "        demoVideo.preload='metadata';",
  "        demoVideo.playsInline=true;",
  "        demoVideo.setAttribute('aria-label','Video de demostración para comprobar pantalla completa');",
  "        container.append(demoVideo);",
  "      } else if (DEMO) {",
  "        const illustration=elt('div','media-fallback','');",
  "        const caption=elt('p','','Imagen de ejemplo');",
  "        caption.style.cssText='position:absolute;bottom:10px;color:#b9b5d0;font-size:12px';",
  "        container.append(illustration,caption);",
  "      } else if (post.tipo==='image') {",
  "        const picture=document.createElement('img');",
  "        picture.alt='Imagen: '+post.titulo;",
  "        picture.loading='lazy';",
  "        picture.src=src;",
  "        container.append(picture);",
  "      } else {",
  "        const video=document.createElement('video');",
  "        video.controls=true;",
  "        video.preload='metadata';",
  "        video.playsInline=true;",
  "        video.src=src;",
  "        container.append(video);",
  "      }",
  "      const label=elt('div','kind-label',post.tipo==='image'?' Imagen':' Video');",
  "      container.append(label);",
  "      return container;",
  "    }",
  "    // Vista ampliada de las publicaciones aprobadas; no cambia likes ni moderación.",
  "    let viewerPreviousFocus = null;",
  "    function openMediaViewer(post) {",
  "      const viewer=qs('#mediaViewer');",
  "      const mount=qs('#viewerMedia');",
  "      viewerPreviousFocus=document.activeElement;",
  "      mount.replaceChildren();",
  "      qs('#viewerTitle').textContent=post.titulo;",
  "      if (DEMO && post.tipo==='video') {",
  "        const demoVideo=document.createElement('video');",
  "        demoVideo.src=DEMO_VIDEO;",
  "        demoVideo.muted=true;",
  "        demoVideo.controls=true;",
  "        demoVideo.playsInline=true;",
  "        demoVideo.preload='metadata';",
  "        demoVideo.setAttribute('aria-label','Video de prueba de pantalla completa');",
  "        mount.append(demoVideo);",
  "      } else if (DEMO) {",
  "        const msg=elt('p','demo-note','Imagen de ejemplo. La imagen real aparecerá aquí ampliada.');",
  "        mount.append(msg);",
  "      } else if (post.tipo==='image') {",
  "        const img=document.createElement('img');",
  "        img.src=post.media || '';",
  "        img.alt=post.titulo;",
  "        mount.append(img);",
  "      } else {",
  "        const video=document.createElement('video');",
  "        video.src=post.media || '';",
  "        video.controls=true;",
  "        video.playsInline=true;",
  "        video.preload='metadata';",
  "        mount.append(video);",
  "      }",
  "      qs('#viewerFullscreen').hidden=post.tipo!=='video';",
  "      viewer.hidden=false;",
  "      viewer.setAttribute('aria-hidden','false');",
  "      qs('#viewerClose').focus();",
  "    }",
  "    async function requestViewerFullscreen() {",
  "      const mount=qs('#viewerMedia');",
  "      const video=mount.querySelector('video');",
  "      if(!video) return; // Las imágenes se amplían al pulsarlas, sin botón de pantalla completa.",
  "      // requestFullscreen sobre el VIDEO: ocupa todo el monitor, como YouTube.",
  "      try {",
  "        if (video.requestFullscreen) await video.requestFullscreen({navigationUI:'hide'});",
  "        else if (typeof video.webkitEnterFullscreen==='function') video.webkitEnterFullscreen();",
  "        else if (mount.requestFullscreen) await mount.requestFullscreen();",
  "        else toast('Este navegador no permite pantalla completa.',true);",
  "      } catch(e) {",
  "        try {",
  "          if (mount.requestFullscreen) await mount.requestFullscreen();",
  "          else toast('No se pudo activar la pantalla completa.',true);",
  "        } catch {",
  "          toast('No se pudo activar pantalla completa. Prueba el botón del reproductor.',true);",
  "        }",
  "      }",
  "    }",
  "    function openVideoFullscreen(post,event) {",
  "      if (event) { event.stopPropagation();event.preventDefault(); }",
  "      openMediaViewer(post);",
  "      // Esta llamada ocurre directamente en el clic del usuario.",
  "      void requestViewerFullscreen();",
  "    }",
  "    function closeMediaViewer() {",
  "      const viewer=qs('#mediaViewer');",
  "      if(viewer.hidden) return;",
  "      const mount=qs('#viewerMedia');",
  "      if(document.fullscreenElement && (document.fullscreenElement===mount || mount.contains(document.fullscreenElement))){",
  "        void document.exitFullscreen().catch(()=>{});",
  "      }",
  "      const video=mount.querySelector('video');",
  "      if(video) {video.pause();video.removeAttribute('src');video.load();}",
  "      mount.replaceChildren();",
  "      viewer.hidden=true;",
  "      viewer.setAttribute('aria-hidden','true');",
  "      if(viewerPreviousFocus && viewerPreviousFocus.isConnected) viewerPreviousFocus.focus();",
  "      viewerPreviousFocus=null;",
  "    }",
  "    function renderPosts() {",
  "      const grid=qs('#postGrid');",
  "      grid.replaceChildren();",
  "      const search=qs('#searchPosts').value.trim().toLowerCase();",
  "      const type=qs('#typeFilter').value;",
  "      const filtered=state.posts.filter(p=>{",
  "        const matchesType=type==='all'||p.tipo===type;",
  "        const matchesSearch=(`${p.titulo} ${p.nombre} ${p.descripcion}`).toLocaleLowerCase().includes(search);",
  "        return matchesType && matchesSearch;",
  "      });",
  "      if (!filtered.length) {",
  "        grid.append(empty('','Todavía no hay publicaciones para mostrar','Cuando Nico apruebe una creación, aparecerá aquí.'));",
  "        return;",
  "      }",
  "      for (const post of filtered) {",
  "        const card=elt('article','media-card');",
  "        const info=elt('div','media-info');",
  "        info.append(elt('h3','',post.titulo));",
  "        info.append(elt('div','byline','Por '+post.nombre+' · '+relativeDate(post.fecha)));",
  "        info.append(elt('p','media-description',post.descripcion||'Una creación compartida con la comunidad.'));",
  "        const row=elt('div','stats');",
  "        const likes=post.likes||[];",
  "        const liked=state.user && likes.some(l=>l.usuario_id===state.user.$id);",
  "        const likeBtn=button(liked?'Te gusta':'Me gusta','btn mini'+(liked?' liked':''),()=>toggleLike(post));",
  "        row.append(likeBtn,elt('span','count',String(likes.length)+' Me gusta'));",
  "        info.append(row);",
  "        info.append(elt('div','names',likes.length?'Les gusta a: '+likes.slice(0,12).map(l=>l.nombre).join(', '):'Todavía no hay Me gusta.'));",
  "        const cardMedia=mediaElement(post);",
  "        cardMedia.classList.add('publication-media-zoom');",
  "        cardMedia.setAttribute('role','button');",
  "        cardMedia.tabIndex=0;",
  "        cardMedia.setAttribute('aria-label','Ver en grande: '+post.titulo);",
  "        cardMedia.addEventListener('click',()=>openMediaViewer(post));",
  "        cardMedia.addEventListener('keydown',event=>{",
  "          if(event.key==='Enter'||event.key===' '){",
  "            event.preventDefault();",
  "            openMediaViewer(post);",
  "          }",
  "        });",
  "        // Evita reproducir el video pequeño: los controles están en la vista grande.",
  "        const smallVideo=cardMedia.querySelector('video');",
  "        if(smallVideo) smallVideo.controls=false;",
  "        if(post.tipo==='video') {",
  "          const fullscreenBtn=button('','publication-fullscreen-btn',event=>openVideoFullscreen(post,event));",
  "          fullscreenBtn.setAttribute('aria-label','Pantalla completa: '+post.titulo);",
  "          fullscreenBtn.title='Pantalla completa (como YouTube)';",
  "          fullscreenBtn.innerHTML='<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.6\" stroke-linecap=\"square\"><path d=\"M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5\"/></svg>';",
  "          cardMedia.classList.add('has-fullscreen');",
  "          cardMedia.append(fullscreenBtn);",
  "        }",
  "        card.append(cardMedia,info);",
  "        grid.append(card);",
  "      }",
  "    }",
  "    async function loadPosts() {",
  "      status('#postsStatus',DEMO?'Demostración visual: aún no son publicaciones reales.':'Cargando creaciones…');",
  "      try {",
  "        state.posts=DEMO?demoPosts:(await api('/api/posts')).posts;",
  "        status('#postsStatus',state.posts.length?(DEMO?'Vista previa: publicaciones de ejemplo':`${state.posts.length} creación(es) aprobadas`):'');",
  "        renderPosts();",
  "      } catch(e) {",
  "        state.posts=[];",
  "        status('#postsStatus',safeMessage(e),'error');",
  "        renderPosts();",
  "      }",
  "    }",
  "    async function toggleLike(post) {",
  "      if (!state.user) { toast('Inicia sesión con Google para dar Me gusta.');return; }",
  "      if (DEMO) { toast('En la vista previa, los likes no se guardan.');return; }",
  "      try {",
  "        await api('/api/likes/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:post.id}),requiresUser:true});",
  "        await loadPosts();",
  "      } catch(e) { toast(safeMessage(e),true); }",
  "    }",
  "    function empty(icon,title,description) {",
  "      const box=elt('div','empty');",
  "      box.style.gridColumn='1/-1';",
  "      box.append(elt('div','emoj',icon),elt('h3','',title),elt('p','',description));",
  "      return box;",
  "    }",
  "    function renderChat() {",
  "      const box=qs('#chatMessages');",
  "      box.replaceChildren();",
  "      if (!state.chat.length) { box.append(empty('','Todavía no hay mensajes','Sé la primera persona en iniciar una conversación.'));return; }",
  "      for (const item of state.chat) {",
  "        const message=elt('div','message');",
  "        const av=elt('span','avatar',initials(item.nombre));",
  "        const bubble=elt('div','bubble');",
  "        const title=elt('div');",
  "        const name=elt('strong','',item.nombre);",
  "        const time=elt('time','',shortTime(item.fecha));",
  "        title.append(name,time);",
  "        bubble.append(title,elt('p','',item.contenido));",
  "        message.append(av,bubble);",
  "        box.append(message);",
  "      }",
  "      box.scrollTop=box.scrollHeight;",
  "    }",
  "    function renderSuspension() {",
  "      const box=qs('#muteNotice');",
  "      const s=state.suspension;",
  "      box.hidden=!s;",
  "      box.textContent=s?('Tu acceso al chat está suspendido hasta el '+new Date(s.hasta).toLocaleString('es-PE')+'.\\nMotivo: '+s.motivo):'';",
  "      const canWrite=Boolean(state.user) && !s;",
  "      qs('#chatText').disabled=!canWrite;",
  "      qs('#sendChat').disabled=!canWrite;",
  "      if(s) qs('#chatText').placeholder='No puedes enviar mensajes durante la suspensión.';",
  "    }",
  "    async function checkSuspension() {",
  "      if(!state.user || DEMO){state.suspension=null;renderSuspension();return;}",
  "      try {state.suspension=(await api('/api/chat/status')).suspension;}",
  "      catch(e){state.suspension=null;status('#chatStatus',safeMessage(e),'error');}",
  "      renderSuspension();",
  "    }",
  "    async function loadChat() {",
  "      status('#chatStatus','');",
  "      try {",
  "        await checkSuspension();",
  "        state.chat=DEMO?demoChat:(await api('/api/chat')).messages;",
  "        renderChat();",
  "      } catch(e) {status('#chatStatus',safeMessage(e),'error');}",
  "    }",
  "    async function submitChat(event) {",
  "      event.preventDefault();",
  "      if(state.suspension){renderSuspension();return;}",
  "      const input=qs('#chatText');",
  "      const content=input.value.trim();",
  "      if (!state.user) { toast('Primero entra con Google',true);return; }",
  "      if (!content) return;",
  "      if (DEMO) { toast('Vista previa: el chat será real al publicarlo.');return; }",
  "      const btn=qs('#sendChat');",
  "      try {",
  "        setLoading(btn,true,'Enviando');",
  "        await api('/api/chat',{method:'POST',requiresUser:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({contenido:content})});",
  "        input.value='';",
  "        await loadChat();",
  "      } catch(e) { status('#chatStatus',safeMessage(e),'error'); }",
  "      finally { setLoading(btn,false); }",
  "    }",
  "    function fileChosen() {",
  "      const file=qs('#uploadFile').files[0];",
  "      const box=qs('#preview');",
  "      box.replaceChildren();",
  "      if (state.lastPreview) URL.revokeObjectURL(state.lastPreview);",
  "      state.lastPreview=null;",
  "      if (!file) {box.style.display='none';return;}",
  "      box.style.display='block';",
  "      const bytes=(file.size/1024/1024).toFixed(1);",
  "      box.append(elt('p','',`${file.name} · ${bytes} MB`));",
  "      if (file.size>100*1024*1024) {box.append(elt('p','status error','Este archivo supera el límite de 100 MB.'));return;}",
  "      state.lastPreview=URL.createObjectURL(file);",
  "      const node=document.createElement(file.type.startsWith('image/')?'img':'video');",
  "      node.src=state.lastPreview;",
  "      if (node.tagName==='VIDEO') { node.controls=true;node.preload='metadata'; }",
  "      else node.alt='Vista previa de la imagen';",
  "      box.append(node);",
  "    }",
  "    async function submitUpload(event) {",
  "      event.preventDefault();",
  "      const titulo=qs('#uploadTitle').value.trim();",
  "      const descripcion=qs('#uploadDescription').value.trim();",
  "      const file=qs('#uploadFile').files[0];",
  "      const nota=qs('#uploadNote').value.trim();",
  "      if (!titulo || !descripcion || !file || !nota) {",
  "        status('#uploadStatus','Completa todo antes de enviar.','error');return;",
  "      }",
  "      if (titulo.length < 3) {status('#uploadStatus','El título debe tener al menos 3 caracteres.','error');return;}",
  "      if (file.size > 100*1024*1024) {status('#uploadStatus','El archivo supera los 100 MB.','error');return;}",
  "      if (!['video/mp4','video/webm','image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) {",
  "        status('#uploadStatus','Solo se permiten imágenes JPG, PNG, WebP, GIF o videos MP4, WebM.','error');return;",
  "      }",
  "      if (DEMO) {",
  "        status('#uploadStatus','Vista previa: formulario completo. Se enviará al administrador cuando publiquemos la V6.','ok');",
  "        return;",
  "      }",
  "      const btn=qs('#uploadButton');setLoading(btn,true,'Enviando solicitud...');",
  "      const form=new FormData();",
  "      form.set('titulo',titulo);form.set('descripcion',descripcion);",
  "      form.set('archivo',file);form.set('nota',nota);",
  "      try {",
  "        const data=await api('/api/posts/upload',{method:'POST',body:form});",
  "        qs('#uploadForm').reset();fileChosen();",
  "        status('#uploadStatus',data.message,'ok');",
  "      } catch(e) {status('#uploadStatus',safeMessage(e),'error');}",
  "      finally {setLoading(btn,false);}",
  "    }",
  "    function revealAdmin(value) {",
  "      qs('#adminLogin').hidden=value;",
  "      qs('#adminPanel').hidden=!value;",
  "    }",
  "    async function loginAdmin(event) {",
  "      event.preventDefault();",
  "      if (DEMO) { toast('La administración se activa con el servidor real.');return; }",
  "      try {",
  "        const data=await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:qs('#adminPassword').value})});",
  "        state.adminToken=data.token;",
  "        qs('#adminPassword').value='';",
  "        revealAdmin(true);",
  "        await loadAdmin();",
  "      } catch(e) {status('#adminLoginStatus',safeMessage(e),'error');}",
  "    }",
  "    function logoutAdmin() { state.adminToken=''; revealAdmin(false);status('#adminLoginStatus','Sesión de administrador cerrada.','ok'); }",
  "    async function loadAdmin() {",
  "      if (!state.adminToken) return;",
  "      if (DEMO) {",
  "        state.adminPosts=[{id:'ejemplo1',titulo:'Mi primera animación',descripcion:'Una aventura de ejemplo.',nota:'Hola Nico, hice esta animación. ¿Puedes revisarla?',nombre:'Creador de ejemplo',tipo:'video',estado:'pendiente',fecha:new Date().toISOString()}];",
  "        state.adminChat=[{id:'m1',usuario_id:'demo-alumno',nombre:'Estudiante de ejemplo',contenido:'Hola, ¿cómo van las animaciones?',eliminado:false,fecha:new Date().toISOString()}];",
  "        state.adminUsers=[{usuario_id:'demo-alumno',nombre:'Estudiante de ejemplo',suspension:null}];",
  "        renderSuspendUsers();renderAdmin();status('#adminStatus','Vista previa: los cambios aquí no se guardan.');return;",
  "      }",
  "      status('#adminStatus','Cargando panel…');",
  "      try {",
  "        if (state.adminView==='posts') state.adminPosts=(await api('/api/admin/posts')).posts;",
  "        else {const result=await api('/api/admin/chat');state.adminChat=result.messages;state.adminUsers=result.usuarios||[];renderSuspendUsers();}",
  "        renderAdmin();",
  "        status('#adminStatus','');",
  "      } catch(e) {",
  "        status('#adminStatus',safeMessage(e),'error');",
  "        if (/sesión|administrador/i.test(safeMessage(e))) logoutAdmin();",
  "      }",
  "    }",
  "    function switchAdminTab(name) {",
  "      state.adminView=name;",
  "      qsa('[data-admin-view]').forEach(x=>x.classList.toggle('active',x.dataset.adminView===name));",
  "      loadAdmin();",
  "    }",
  "    function renderSuspendUsers() {",
  "      const form=qs('#suspendForm');",
  "      form.hidden=state.adminView!=='chat';",
  "      if(form.hidden)return;",
  "      const select=qs('#suspendUser');const chosen=select.value;",
  "      select.replaceChildren(new Option('Selecciona un usuario',''));",
  "      for(const u of state.adminUsers){",
  "        const label=u.nombre+(u.suspension?' (suspendido hasta '+new Date(u.suspension.hasta).toLocaleDateString('es-PE')+')':'');",
  "        select.add(new Option(label,u.usuario_id));",
  "      }",
  "      if(state.adminUsers.some(x=>x.usuario_id===chosen))select.value=chosen;",
  "    }",
  "    async function suspendUser(event) {",
  "      event.preventDefault();",
  "      const usuario_id=qs('#suspendUser').value;",
  "      const dias=Number(qs('#suspendDays').value);",
  "      const motivo=qs('#suspendReason').value.trim();",
  "      if(!usuario_id||!Number.isInteger(dias)||dias<1||dias>365||!motivo){",
  "        status('#suspendStatus','Selecciona un usuario, los días y escribe un motivo.','error');return;",
  "      }",
  "      if(DEMO){status('#suspendStatus','Vista previa: la suspensión se guardará en Appwrite al publicar.','ok');return;}",
  "      if(!confirm('¿Suspender a este usuario durante '+dias+' día(s)?'))return;",
  "      try {",
  "        await api('/api/admin/chat/suspend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario_id,dias,motivo})});",
  "        status('#suspendStatus','Suspensión guardada. El usuario verá los días y el motivo.','ok');",
  "        qs('#suspendReason').value='';await loadAdmin();",
  "      } catch(e){status('#suspendStatus',safeMessage(e),'error');}",
  "    }",
  "    async function unsuspendUser() {",
  "      const usuario_id=qs('#suspendUser').value;",
  "      if(!usuario_id){status('#suspendStatus','Selecciona primero a un usuario.','error');return;}",
  "      if(DEMO){status('#suspendStatus','Vista previa: se quitará al publicar.','ok');return;}",
  "      if(!confirm('¿Quitar la suspensión del chat a este usuario?'))return;",
  "      try {",
  "        await api('/api/admin/chat/suspend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario_id,action:'lift'})});",
  "        status('#suspendStatus','La suspensión fue retirada.','ok');await loadAdmin();",
  "      } catch(e){status('#suspendStatus',safeMessage(e),'error');}",
  "    }",
  "    function renderAdmin() {",
  "      const box=qs('#adminList');",
  "      for(const url of state.activeMedia) URL.revokeObjectURL(url);",
  "      state.activeMedia=[];",
  "      box.replaceChildren();",
  "      qs('#suspendForm').hidden=state.adminView!=='chat';",
  "      if (state.adminView==='chat') return renderAdminChat(box);",
  "      if (!state.adminPosts.length) {box.append(empty('','Sin solicitudes','Todavía no se han recibido publicaciones.'));return;}",
  "      const grouped=state.adminPosts.slice().sort((a,b)=>{",
  "        const priority={pendiente:0,aprobado:1,rechazado:2};",
  "        return (priority[a.estado]??3)-(priority[b.estado]??3);",
  "      });",
  "      for (const p of grouped) {",
  "        const card=elt('article','admin-post');",
  "        const head=elt('div','row');",
  "        head.append(elt('h4','',p.titulo),elt('span','admin-status',p.estado.toUpperCase()));",
  "        card.append(head,elt('p','','Por '+p.nombre+' · '+relativeDate(p.fecha)),elt('p','',p.descripcion||'Sin descripción'));",
  "        if(p.nota) card.append(elt('p','moderation-status','Mensaje privado para el creador: '+p.nota));",
  "        const media=mediaElement(p,true);",
  "        media.classList.add('admin-media');",
  "        if (!DEMO && state.adminToken) {",
  "          const playable=media.querySelector('img,video');",
  "          if (playable) {",
  "            playable.removeAttribute('src');",
  "            fetch(p.media,{headers:{Authorization:'Admin '+state.adminToken}})",
  "              .then(r=>{if(!r.ok)throw Error('No se pudo cargar la vista privada');return r.blob();})",
  "              .then(blob=>{",
  "                const objectURL=URL.createObjectURL(blob);",
  "                state.activeMedia.push(objectURL);",
  "                playable.src=objectURL;",
  "              })",
  "              .catch(()=>{});",
  "          }",
  "        }",
  "        card.append(media);",
  "        const buttons=elt('div','row');",
  "        if (p.estado!=='aprobado') buttons.append(button('Aprobar','btn primary mini',()=>adminDecision(p,'approve')));",
  "        if (p.estado!=='rechazado') buttons.append(button('Rechazar','btn mini',()=>adminDecision(p,'reject')));",
  "        buttons.append(button('Editar','btn mini',()=>editPost(p)));",
  "        buttons.append(button('Eliminar','btn danger mini',()=>adminDecision(p,'delete')));",
  "        card.append(buttons);box.append(card);",
  "      }",
  "    }",
  "    async function adminDecision(post,action) {",
  "      const names={approve:'aprobar',reject:'rechazar',delete:'ELIMINAR PERMANENTEMENTE'};",
  "      if (!confirm(`¿Quieres ${names[action]} la publicación \"${post.titulo}\"?`))return;",
  "      try {",
  "        await api('/api/admin/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:post.id,action})});",
  "        toast('Cambio guardado');",
  "        await loadAdmin();",
  "        if (action!=='reject') await loadPosts();",
  "      } catch(e) {toast(safeMessage(e),true);}",
  "    }",
  "    function editPost(p) {",
  "      qs('#editId').value=p.id;",
  "      qs('#editTitle').value=p.titulo;",
  "      qs('#editDescription').value=p.descripcion;",
  "      qs('#modal').classList.add('open');",
  "      qs('#modal').setAttribute('aria-hidden','false');",
  "      qs('#editTitle').focus();",
  "    }",
  "    function closeModal() {",
  "      qs('#modal').classList.remove('open');",
  "      qs('#modal').setAttribute('aria-hidden','true');",
  "    }",
  "    async function saveEdit(event) {",
  "      event.preventDefault();",
  "      const data={id:qs('#editId').value,titulo:qs('#editTitle').value.trim(),descripcion:qs('#editDescription').value};",
  "      try {",
  "        await api('/api/admin/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});",
  "        closeModal();",
  "        toast('Publicación actualizada');",
  "        await loadAdmin();await loadPosts();",
  "      } catch(e) {toast(safeMessage(e),true);}",
  "    }",
  "    function renderAdminChat(box) {",
  "      if (!state.adminChat.length) {box.append(empty('','No hay mensajes','Cuando alguien escriba, podrás moderar sus mensajes aquí.'));return;}",
  "      for (const m of state.adminChat) {",
  "        const card=elt('article','admin-message');",
  "        const header=elt('div');",
  "        header.append(elt('strong','',m.nombre));",
  "        header.append(elt('small','',` · ${relativeDate(m.fecha)} ${shortTime(m.fecha)} · ${m.eliminado?'OCULTO':'VISIBLE'}`));",
  "        card.append(header,elt('p','',m.contenido));",
  "        const row=elt('div','row');",
  "        if (!m.eliminado) row.append(button('Ocultar','btn mini',()=>moderateChat(m,'hide')));",
  "        else row.append(button('Restaurar','btn mini',()=>moderateChat(m,'restore')));",
  "        row.append(button('Eliminar para siempre','btn danger mini',()=>moderateChat(m,'delete')));",
  "        card.append(row);box.append(card);",
  "      }",
  "    }",
  "    async function moderateChat(m,action) {",
  "      if (!confirm('¿Confirmas que quieres '+(action==='delete'?'eliminar definitivamente':action==='hide'?'ocultar':'restaurar')+' este mensaje?'))return;",
  "      try {",
  "        await api('/api/admin/chat/moderate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:m.id,action})});",
  "        toast('Mensaje moderado');",
  "        await loadAdmin();await loadChat();",
  "      } catch(e) {toast(safeMessage(e),true);}",
  "    }",
  "    function setupEvents() {",
  "      qs('#googleBtn').addEventListener('click',googleLogin);",
  "      qs('#logoutBtn').addEventListener('click',googleLogout);",
  "      qs('#searchPosts').addEventListener('input',renderPosts);",
  "      qs('#typeFilter').addEventListener('change',renderPosts);",
  "      qs('#refreshPosts').addEventListener('click',loadPosts);",
  "      qs('#refreshChat').addEventListener('click',loadChat);",
  "      qs('#chatForm').addEventListener('submit',submitChat);",
  "      qs('#uploadFile').addEventListener('change',fileChosen);",
  "      qs('#uploadForm').addEventListener('submit',submitUpload);",
  "      qs('#adminLoginForm').addEventListener('submit',loginAdmin);",
  "      qs('#demoAdmin').addEventListener('click',()=>{if(!DEMO)return;state.adminToken='solo-vista-previa';revealAdmin(true);loadAdmin();});",
  "      qs('#adminRefresh').addEventListener('click',loadAdmin);",
  "      qs('#adminLogout').addEventListener('click',logoutAdmin);",
  "      qs('#adminPostsTab').addEventListener('click',()=>switchAdminTab('posts'));",
  "      qs('#adminChatTab').addEventListener('click',()=>switchAdminTab('chat'));",
  "      qs('#suspendForm').addEventListener('submit',suspendUser);",
  "      qs('#unsuspendUser').addEventListener('click',unsuspendUser);",
  "      qs('#cancelEdit').addEventListener('click',closeModal);",
  "      qs('#editForm').addEventListener('submit',saveEdit);",
  "      qs('#modal').addEventListener('click',e=>{if(e.target===qs('#modal'))closeModal();});",
  "      qs('#viewerClose').addEventListener('click',closeMediaViewer);",
  "      qs('#viewerFullscreen').addEventListener('click',()=>{void requestViewerFullscreen();});",
  "      qs('#mediaViewer').addEventListener('click',e=>{if(e.target===qs('#mediaViewer'))closeMediaViewer();});",
  "      window.addEventListener('keydown',e=>{",
  "        if(e.key==='Escape') {closeMediaViewer();closeModal();}",
  "      });",
  "      window.addEventListener('hashchange',()=>{",
  "        const tab=location.hash.slice(1);",
  "        if(['publicaciones','chat','subir','admin'].includes(tab)) selectTab(tab);",
  "      });",
  "    }",
  "    async function start() {",
  "      setupEvents();",
  "      qs('#demoAdmin').hidden=!DEMO;",
  "      setupTabs();",
  "      await initGoogle();",
  "      await loadPosts();",
  "",
  "      // Actualización moderada del chat: no se mantienen conexiones abiertas.",
  "      setInterval(()=>{",
  "        if (state.activeTab==='chat' && !document.hidden) loadChat();",
  "      },16000);",
  "    }",
  "    start().catch(e=>toast(safeMessage(e),true));",
  "  </script>",
  "</body>",
  "</html>"
].join("\n");

async function router(req, res) {
  checkCSRF(req);
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const isGET = req.method === "GET";
  const isPOST = req.method === "POST";
  if (isGET && path === "/") return html(res, PAGE.replace("__CLIENT_CONFIG__", CLIENT_CONFIG.replace(/</g, "\\u003c")));
  if (isGET && path === "/privacidad") {
  return html(res, require("node:fs").readFileSync(__dirname + "/privacidad.html", "utf8"));
}
if (isGET && path === "/condiciones") {
  return html(res, require("node:fs").readFileSync(__dirname + "/condiciones.html", "utf8"));
}
  if (isGET && path === "/health") return json(res, 200, { ok: true, version: "6", appwriteConfigured: APP_READY });
  if (path === "/favicon.ico" || path === "/favicon.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }); return res.end("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><defs><linearGradient id=\"g\" x1=\"0\" x2=\"1\" y1=\"0\" y2=\"1\"><stop stop-color=\"#ff5778\"/><stop offset=\"1\" stop-color=\"#ffad56\"/></linearGradient></defs><rect width=\"64\" height=\"64\" rx=\"16\" fill=\"url(#g)\"/><path d=\"M22 16v32\" fill=\"none\" stroke=\"#fff\" stroke-width=\"5\" stroke-linecap=\"round\"/><path d=\"M29 16.5Q29 13 32 15L50 29Q54 32 50 35L32 49Q29 51 29 47.5Z\" fill=\"#fff\"/></svg>"); }
  if (!path.startsWith("/api/") && !path.startsWith("/media/") && !path.startsWith("/private-media/")) abort(404, "Ruta no encontrada");
  requireReady();

  // Sesión administrador heredada, con comparación resistente a temporización.
  if (isPOST && path === "/api/admin/login") {
    const body = await readJSON(req, 2000);
    const ip = clientAddress(req);
    const record = loginAttempts.get(ip) || { count: 0, until: Date.now() + 600000 };
    if (Date.now() > record.until) { record.count = 0; record.until = Date.now() + 600000; }
    if (record.count >= 10) abort(429, "Demasiados intentos. Intenta después");
    if (!ADMIN_PASSWORD) abort(503, "ADMIN_PASSWORD no configurado");
    if (!safeCompare(String(body.password || ""), ADMIN_PASSWORD)) {
      record.count++;
      loginAttempts.set(ip, record);
      abort(401, "Contraseña incorrecta");
    }
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    return json(res, 200, { token });
  }
  if (isGET && path === "/api/config") {
    return json(res,200,{ endpoint: ENDPOINT, project: PROJECT, version: 6, maxMB: MAX_FILE_MB });
  }
  if (isGET && path === "/api/posts") {
    const posts = (await listRows(TABLE_POSTS))
      .filter(p => p.estado === "aprobado")
      .map(publicPost)
      .sort((a,b) => (b.fecha || "").localeCompare(a.fecha || ""));
    const likes = await listRows(TABLE_LIKES, 1000);
    const counts = new Map();
    for (const item of likes) {
      const id = item.publicacion_id;
      if (!counts.has(id)) counts.set(id, []);
      counts.get(id).push({ usuario_id: item.usuario_id, nombre: item.nombre });
    }
    for (const post of posts) post.likes = (counts.get(post.id) || []).map(x => ({ nombre: x.nombre, usuario_id: x.usuario_id }));
    return json(res, 200, { posts });
  }
  if (isGET && path.startsWith("/media/")) {
    const id = path.slice("/media/".length);
    const row = await getRow(TABLE_POSTS, id);
    if (row.estado !== "aprobado") abort(404, "Archivo no publicado");
    return getFile(res, req, row);
  }
  if (isGET && path.startsWith("/private-media/")) {
    requireAdmin(req);
    const row = await getRow(TABLE_POSTS, path.slice("/private-media/".length));
    return getFile(res, req, row);
  }
  if (isGET && path === "/api/admin/posts") {
    requireAdmin(req);
    const posts = (await listRows(TABLE_POSTS)).map(publicPost)
      .sort((a,b) => (b.fecha || "").localeCompare(a.fecha || ""));
    for (const p of posts) {p.media = "/private-media/" + encodeURIComponent(p.id);p.nota = await getPrivateNote(p.id);}
    return json(res,200,{ posts });
  }
  if (isPOST && path === "/api/posts/upload") {
    // A diferencia del chat, pedir una publicación no requiere una cuenta Google.
    const user = await maybeUser(req);
    const sender = user?.id || clientAddress(req);
    minInterval(lastUpload, sender, 45);
    if (pendingUploads.has(sender)) abort(429,"Espera a que termine tu subida anterior");
    pendingUploads.add(sender);
    let fileId = null;
    let postId = null;
    try {
      const { form, file } = await getForm(req);
      const titulo = text(form.get("titulo"),120);
      const descripcion = text(form.get("descripcion"),600);
      const nota = text(form.get("nota"),300);
      if (!titulo || !descripcion || !nota || !file) abort(400,"Completa todo antes de enviar.");
      if (titulo.length < 3) abort(400,"El título necesita al menos 3 caracteres");
      const kind = file.type.startsWith("image/") ? "image" : "video";
      fileId = await sendFile(Buffer.from(await file.arrayBuffer()),file.type);
      const post = await addRow(TABLE_POSTS, {
        titulo,descripcion,nombra:user?.nombre||"Visitante",usuario_id:user?.id||"",
        video_url:`${kind}:${fileId}`,estado:"pendiente",
      });
      postId=post.$id;
      // Nota privada: se almacena con estado "nota", invisible en chat y publicaciones.
      await addRow(TABLE_CHAT,{
        usuario_id:postId,nombre:"Nota privada para Nico",contenido:nota,eliminado:"nota"
      },privateRecordId('nota',postId));
      fileId=null;
      return json(res,201,{id:postId,message:"Solicitud enviada al creador. Se revisará antes de publicar."});
    } catch(e) {
      if(postId) {try{await deleteRow(TABLE_POSTS,postId);}catch{}}
      throw e;
    } finally {
      if(fileId)await eraseFile(fileId);
      pendingUploads.delete(sender);
    }
  }
  if (isPOST && path === "/api/admin/decision") {
    requireAdmin(req);
    const { id, action } = await readJSON(req);
    if (!["approve", "reject", "delete"].includes(action)) abort(400, "Acción desconocida");
    const row = await getRow(TABLE_POSTS, text(id, 100));
    if (action === "approve") {
      if (row.estado === "aprobado") abort(409, "Ya está aprobada");
      await updateRow(TABLE_POSTS, row.$id, { estado: "aprobado" });
    } else if (action === "reject") {
      await updateRow(TABLE_POSTS, row.$id, { estado: "rechazado" });
    } else {
      await deleteRow(TABLE_POSTS, row.$id);
      const nota = await optionalChatRecord(privateRecordId("nota",row.$id));
      if(nota)try{await deleteRow(TABLE_CHAT,nota.$id);}catch{}
      // Dejar las operaciones de likes y medios sin bloquear el borrado de publicación.
      try {
        const likes = await listRows(TABLE_LIKES, 1000);
        for (const l of likes.filter(x => x.publicacion_id === row.$id)) await deleteRow(TABLE_LIKES,l.$id);
      } catch (err) { console.warn("Limpieza de likes:",err.message); }
      const ref = fileReference(row);
      if (ref) await eraseFile(ref.id);
    }
    return json(res,200,{ok:true});
  }
  if (isPOST && path === "/api/admin/edit") {
    requireAdmin(req);
    const body = await readJSON(req);
    const id = text(body.id,100);
    const titulo = text(body.titulo,120);
    const descripcion = text(body.descripcion,1000);
    if (titulo.length < 3) abort(400, "Título demasiado corto");
    await getRow(TABLE_POSTS,id);
    await updateRow(TABLE_POSTS,id,{ titulo, descripcion });
    return json(res,200,{ok:true});
  }
  if (isPOST && path === "/api/likes/toggle") {
    const user = await who(req);
    minInterval(lastLike,user.id,1);
    const body = await readJSON(req);
    const post = await getRow(TABLE_POSTS,text(body.id,100));
    if (post.estado !== "aprobado") abort(404,"No publicado");
    const likes = await listRows(TABLE_LIKES,1000);
    const found = likes.find(l => l.usuario_id === user.id && l.publicacion_id === post.$id);
    if (found) {
      await deleteRow(TABLE_LIKES,found.$id);
      return json(res,200,{ok:true,liked:false});
    }
    await addRow(TABLE_LIKES,{ usuario_id:user.id, publicacion_id:post.$id, nombre:user.nombre });
    return json(res,200,{ok:true,liked:true});
  }
  if (isGET && path === "/api/chat") {
    const messages = (await listRows(TABLE_CHAT, 300))
      .filter(m => !m.eliminado || m.eliminado === "no")
      .map(publicMessage)
      .sort((a,b) => (a.fecha || "").localeCompare(b.fecha || ""))
      .slice(-100);
    return json(res,200,{ messages });
  }
  if (isGET && path === "/api/chat/status") {
    const user=await who(req);
    return json(res,200,{suspension:await userSuspension(user.id)});
  }
  if (isPOST && path === "/api/chat") {
    const user = await who(req);
    const ban=await userSuspension(user.id);
    if(ban)abort(403,"Tu acceso al chat está suspendido hasta "+new Date(ban.hasta).toLocaleString("es-PE")+". Motivo: "+ban.motivo);
    minInterval(lastMessage,user.id,3);
    const body = await readJSON(req);
    const content = text(body.contenido,500);
    if (content.length < 1) abort(400, "Escribe un mensaje");
    await addRow(TABLE_CHAT, { usuario_id:user.id, nombre:user.nombre, contenido:content, eliminado:"no" });
    return json(res,201,{ok:true});
  }
  if (isGET && path === "/api/admin/chat") {
    requireAdmin(req);
    const messages = (await listRows(TABLE_CHAT,600))
      .filter(m=>!m.eliminado || ["no","si"].includes(m.eliminado))
      .map(publicMessage)
      .sort((a,b) => (b.fecha || "").localeCompare(a.fecha || ""));
    const unique=new Map();
    for(const m of messages){if(m.usuario_id&&!unique.has(m.usuario_id))unique.set(m.usuario_id,{usuario_id:m.usuario_id,nombre:m.nombre});}
    const usuarios=await Promise.all([...unique.values()].map(async u=>({...u,suspension:await userSuspension(u.usuario_id)})));
    return json(res,200,{messages,usuarios});
  }
  if (isPOST && path === "/api/admin/chat/moderate") {
    requireAdmin(req);
    const body = await readJSON(req);
    const row = await getRow(TABLE_CHAT,text(body.id,100));
    if(row.eliminado && !["no","si"].includes(row.eliminado))abort(403,"Este registro no es un mensaje de chat");
    if (body.action === "hide") await updateRow(TABLE_CHAT,row.$id,{ eliminado:"si" });
    else if (body.action === "restore") await updateRow(TABLE_CHAT,row.$id,{ eliminado:"no" });
    else if (body.action === "delete") await deleteRow(TABLE_CHAT,row.$id);
    else abort(400,"Acción desconocida");
    return json(res,200,{ok:true});
  }
  if (isPOST && path === "/api/admin/chat/suspend") {
    requireAdmin(req);
    const body=await readJSON(req,3000);
    const usuario_id=text(body.usuario_id,100);
    if(!usuario_id)abort(400,"Selecciona un usuario");
    const known=(await listRows(TABLE_CHAT,600)).filter(m=>
      (!m.eliminado || ["no","si"].includes(m.eliminado)) && m.usuario_id===usuario_id);
    if(!known.length)abort(404,"No se encontró al usuario entre los mensajes del chat");
    const nombre=known[0].nombre||"Usuario";
    if(body.action==='lift') {
      await setUserSuspension(usuario_id,nombre,'',1,true);
      return json(res,200,{ok:true,levantada:true});
    }
    const dias=Number(body.dias);
    const motivo=text(body.motivo,150);
    if(!Number.isInteger(dias)||dias<1||dias>365||!motivo)abort(400,"Indica entre 1 y 365 días y escribe un motivo");
    await setUserSuspension(usuario_id,nombre,motivo,dias);
    return json(res,200,{ok:true});
  }
  abort(404,"Ruta desconocida");
}

const server = http.createServer(async (req,res) => {
  try { await router(req,res); }
  catch(err) {
    if (err instanceof HttpError) { if (!res.headersSent) json(res,err.status,{error:err.message}); }
    else {
      console.error("V6 error:",err);
      if (!res.headersSent) json(res,500,{error:"Error inesperado. Reintenta más tarde."});
      else res.destroy();
    }
  }
});
server.listen(PORT,"0.0.0.0",startupMessage);
