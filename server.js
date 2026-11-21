
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { Readable } = require("stream");

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.ADMIN_PASSWORD || "";
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || "";
const PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || "";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const MAX_LOCAL = 30 * 1024 * 1024;
const DATA_FILE = "./videos.json";
const VIDEO_DIR = "./videos";
const sessions = new Map();
const loginAttempts = new Map();

if (!fs.existsSync(VIDEO_DIR)) {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]");
}

const persistent = Boolean(REDIS_URL && REDIS_TOKEN);
let queue = Promise.resolve();

function serialize(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function redis(command) {
  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const output = await response.json();
  if (!response.ok || output.error) {
    throw Error(output.error || "Fallo en base de datos");
  }
  return output.result;
}

async function load() {
  if (persistent) {
    const value = await redis(["GET", "animaciones-nico:v5:videos"]);
    return value ? JSON.parse(value) : [];
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

async function store(data) {
  if (persistent) {
    await redis([
      "SET",
      "animaciones-nico:v5:videos",
      JSON.stringify(data)
    ]);
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
}

function reply(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

async function bodyJSON(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 12000) {
      throw Error("Solicitud muy grande");
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    throw Error("Datos JSON incorrectos");
  }
}

function authorized(req) {
  const token = (req.headers.authorization || "")
    .replace(/^Bearer\s+/, "");
  const expires = sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function safe(v) {
  return {
    id: v.id,
    nombre: v.nombre,
    titulo: v.titulo,
    descripcion: v.descripcion || "",
    fecha: v.fecha || null,
    likes: Array.isArray(v.likes) ? v.likes : [],
    cloudUrl: v.cloudUrl || null,
    hasLocal: !v.cloudUrl
  };
}

function localVideo(req, res, item) {
  const ext = item.ext;
  if (!["mp4", "webm", "ogg"].includes(ext)) {
    return reply(res, 404, { error: "Video no disponible" });
  }

  const path = VIDEO_DIR + "/" + item.id + "." + ext;
  if (!fs.existsSync(path)) {
    return reply(res, 404, {
      error: "Archivo local no disponible"
    });
  }

  const size = fs.statSync(path).size;
  const types = {
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg"
  };

  const range = req.headers.range;
  let start = 0;
  let end = size - 1;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, {
        "Content-Range": "bytes */" + size
      });
      return res.end();
    }

    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);

    if (!match[1] && match[2]) {
      const n = Number(match[2]);
      start = Math.max(0, size - n);
      end = size - 1;
    }

    if (start > end || start >= size || end >= size) {
      res.writeHead(416, {
        "Content-Range": "bytes */" + size
      });
      return res.end();
    }
  }

  res.writeHead(range ? 206 : 200, {
    "Content-Type": types[ext],
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "X-Content-Type-Options": "nosniff",
    ...(range ? {
      "Content-Range": `bytes ${start}-${end}/${size}`
    } : {})
  });

  fs.createReadStream(path, { start, end }).pipe(res);
}

const page = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Animaciones Nico</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#101014;
  color:#f3f3f6;
  font:15px/1.55 Arial,sans-serif
}
header{
  padding:25px 6%;
  background:#18181f;
  border-bottom:1px solid #35353d
}
header strong{
  letter-spacing:2px;
  font-size:25px
}
header small{
  display:block;
  color:#abaaba;
  margin-top:4px
}
nav{
  display:flex;
  gap:9px;
  flex-wrap:wrap;
  border-bottom:1px solid #333;
  padding:15px 6%;
  background:#141419
}
button{
  padding:11px 16px;
  border:1px solid #41414a;
  border-radius:7px;
  background:#2a2a32;
  color:white;
  cursor:pointer;
  font:inherit
}
button:hover{background:#41414c}
button.current,.primary{
  background:#d9364b;
  border-color:#d9364b
}
main{
  max-width:1150px;
  min-height:65vh;
  margin:auto;
  padding:30px 20px
}
section{display:none}
section.active{display:block}
h1{font-size:28px;margin-top:0}
h2{font-size:20px}
p,.muted{color:#aaaab5}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
  gap:20px;
  margin-top:24px
}
.card,.request{
  border:1px solid #34343e;
  background:#1d1d24;
  border-radius:10px;
  overflow:hidden
}
.card video{
  display:block;
  width:100%;
  aspect-ratio:16/9;
  background:#050505
}
.details{padding:17px}
.details h3{
  margin:0 0 7px;
  font-size:19px
}
.details p{
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  font-size:14px
}
.row{
  display:flex;
  gap:10px;
  align-items:center;
  flex-wrap:wrap;
  margin-top:12px
}
.names{
  color:#b3b3c0;
  font-size:13px;
  margin-top:12px;
  overflow-wrap:anywhere
}
.liked{
  border-color:#d9364b!important;
  background:#5a2631!important
}
.form{max-width:540px}
input,textarea{
  display:block;
  width:100%;
  padding:13px;
  margin:10px 0 17px;
  border:1px solid #454550;
  border-radius:7px;
  background:#22222b;
  color:white;
  font:inherit
}
textarea{
  min-height:100px;
  resize:vertical
}
label{display:block;margin-top:12px}
input[type=file]{font-size:13px}
.request{
  padding:18px;
  margin:16px 0
}
.request video{
  width:440px;
  max-width:100%;
  margin:12px 0;
  background:#000
}
.notice{
  margin-top:12px;
  white-space:pre-wrap
}
.modal{
  display:none;
  position:fixed;
  inset:0;
  z-index:10;
  background:#000b;
  align-items:center;
  justify-content:center;
  padding:20px
}
.modal>div{
  border:1px solid #565660;
  border-radius:10px;
  background:#24242d;
  max-width:430px;
  width:100%;
  padding:24px
}
footer{
  text-align:center;
  color:#92929e;
  border-top:1px solid #30303a;
  padding:24px
}
@media(max-width:600px){
  nav{padding:10px}
  nav button{
    flex:1;
    padding:10px 6px;
    font-size:12px
  }
  .grid{grid-template-columns:1fr}
  header strong{font-size:21px}
}
</style>
</head>
<body>
<header>
<strong>ANIMACIONES NICO</strong>
<small>Historias en movimiento</small>
</header>
<nav>
<button id="tab-publicaciones" class="current"
onclick="openTab('publicaciones')">Publicaciones</button>
<button id="tab-subir"
onclick="openTab('subir')">Subir animación</button>
<button id="tab-admin"
onclick="openTab('admin')">Administración</button>
</nav>

<main>
<section id="publicaciones" class="active">
<h1>Publicaciones</h1>
<p>Descubre las animaciones aprobadas por Animaciones Nico.</p>
<div id="galeria" class="grid"></div>
</section>

<section id="subir">
<h1>Enviar una animación</h1>
<p>Todos pueden solicitar publicar, pero solo el administrador puede autorizar.</p>
<div class="form">
<label>Nombre del creador
<input id="nombre" maxlength="80" placeholder="Tu nombre de usuario">
</label>
<label>Título
<input id="titulo" maxlength="120" placeholder="Título de la animación">
</label>
<label>Descripción
<textarea id="descripcion" maxlength="1000"
placeholder="Cuéntanos sobre tu animación"></textarea>
</label>
<label>Video desde tu equipo
<input id="archivo" type="file"
accept="video/mp4,video/webm,video/ogg,video/quicktime">
</label>
<button id="send" class="primary"
onclick="submitVideo()">Solicitar publicación</button>
<p id="uploadMsg" class="notice"></p>
</div>
</section>

<section id="admin">
<h1>Administración</h1>
<div id="login" class="form">
<p>Solo el administrador puede entrar.</p>
<input id="clave" type="password" placeholder="Contraseña">
<button class="primary" onclick="login()">Entrar</button>
</div>
<div id="panel" style="display:none">
<h2>Solicitudes pendientes</h2>
<div id="pendientes"></div>
<button onclick="logout()">Cerrar sesión</button>
</div>
<p id="adminMsg" class="notice"></p>
</section>
</main>

<div id="modal" class="modal">
<div role="dialog" aria-modal="true" aria-labelledby="modalTitle">
<h2 id="modalTitle">Ingrese su nombre de usuario</h2>
<p>Tu nombre aparecerá entre las personas que dieron Me gusta.</p>
<input id="likeName" maxlength="40" placeholder="Nombre de usuario">
<p id="likeMsg" class="notice"></p>
<div class="row">
<button class="primary" onclick="giveLike()">Dar Me gusta</button>
<button onclick="closeLike()">Cancelar</button>
</div>
</div>
</div>

<footer>Animaciones Nico</footer>

<script src="https://upload-widget.cloudinary.com/latest/global/all.js"></script>
<script>
const CLOUD = ${JSON.stringify(CLOUD)};
const PRESET = ${JSON.stringify(PRESET)};
let token = "";
let selected = null;
let storedName = localStorage.getItem("nico_usuario") || "";

function el(tag,txt,cls) {
  const e=document.createElement(tag);
  if(txt!==undefined)e.textContent=txt;
  if(cls)e.className=cls;
  return e;
}

async function request(url,opts={}) {
  opts.headers={
    ...(opts.headers||{}),
    Authorization:"Bearer "+token
  };
  const response=await fetch(url,opts);
  const result=await response.json();
  if(!response.ok) {
    throw Error(result.error||"Error de servidor");
  }
  return result;
}

function openTab(id) {
  document.querySelectorAll("section").forEach(s=>
    s.classList.remove("active")
  );
  document.querySelectorAll("nav button").forEach(b=>
    b.classList.remove("current")
  );
  document.getElementById(id).classList.add("active");
  document.getElementById("tab-"+id).classList.add("current");
  if(id==="publicaciones")showVideos();
  if(id==="admin"&&token)showPending();
}

async function showVideos() {
  const grid=document.getElementById("galeria");
  grid.replaceChildren();

  try {
    const videos=await request("/api/videos");
    if(!videos.length) {
      grid.textContent="Todavía no hay publicaciones autorizadas.";
      return;
    }

    videos.slice().reverse().forEach(v=>{
      const card=el("article",undefined,"card");
      const video=el("video");
      const details=el("div",undefined,"details");

      video.controls=true;
      video.preload="metadata";
      video.src=v.cloudUrl||"/video/"+encodeURIComponent(v.id);

      details.append(
        el("h3",v.titulo),
        el("p","Por "+v.nombre),
        el("p",v.descripcion||"")
      );

      if(v.fecha) {
        details.append(el(
          "p",
          "Publicado: "+new Date(v.fecha).toLocaleDateString("es-PE")
        ));
      }

      const row=el("div",undefined,"row");
      const like=el("button","Me gusta");
      const count=el("strong",v.likes.length+" Me gusta");

      if(storedName&&v.likes.some(n=>
        n.toLowerCase()===storedName.toLowerCase()
      )) {
        like.classList.add("liked");
        like.textContent="Te gusta";
      }

      like.onclick=()=>startLike(v.id);
      row.append(like,count);

      details.append(
        row,
        el("div",
          v.likes.length
            ?"Les gusta a: "+v.likes.join(", ")
            :"Todavía no hay likes",
          "names"
        )
      );

      card.append(video,details);
      grid.append(card);
    });
  }catch(e) {
    grid.textContent="No se pudieron cargar las publicaciones: "+e.message;
  }
}

function startLike(id) {
  selected=id;
  document.getElementById("likeName").value=storedName;
  document.getElementById("likeMsg").textContent="";
  document.getElementById("modal").style.display="flex";
  document.getElementById("likeName").focus();
}

function closeLike() {
  selected=null;
  document.getElementById("modal").style.display="none";
}

async function giveLike() {
  const name=document.getElementById("likeName").value.trim();

  if(name.length<2) {
    document.getElementById("likeMsg").textContent=
      "Escribe un nombre de al menos dos letras.";
    return;
  }

  try {
    await request("/api/like",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({id:selected,nombre:name})
    });

    storedName=name;
    localStorage.setItem("nico_usuario",name);
    closeLike();
    showVideos();
  }catch(e) {
    document.getElementById("likeMsg").textContent=e.message;
  }
}

async function submitVideo() {
  const nombre=document.getElementById("nombre").value.trim();
  const titulo=document.getElementById("titulo").value.trim();
  const descripcion=document.getElementById("descripcion").value;
  const video=document.getElementById("archivo").files[0];
  const msg=document.getElementById("uploadMsg");
  const btn=document.getElementById("send");

  if(!nombre||!titulo||!video) {
    msg.textContent="Completa nombre, título y selecciona un video.";
    return;
  }

  btn.disabled=true;
  msg.textContent="Preparando subida...";

  try {
    if(CLOUD&&PRESET) {
      if(!window.cloudinary) {
        throw Error("No cargó el sistema de videos.");
      }

      const widget=cloudinary.createUploadWidget({
        cloudName:CLOUD,
        uploadPreset:PRESET,
        resourceType:"video",
        sources:["local"],
        multiple:false,
        maxFiles:1,
        clientAllowedFormats:["mp4","webm","mov","m4v","ogg"]
      },async(error,result)=>{
        if(error) {
          msg.textContent="Falló la subida a la nube.";
          btn.disabled=false;
          return;
        }

        if(result&&result.event==="success") {
          try {
            msg.textContent="Registrando la solicitud...";
            const data=await request("/api/cloud-request",{
              method:"POST",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({
                nombre,titulo,descripcion,
                cloudUrl:result.info.secure_url,
                publicId:result.info.public_id
              })
            });

            msg.textContent=data.message;
            document.getElementById("archivo").value="";
            document.getElementById("titulo").value="";
          }catch(e) {
            msg.textContent=e.message;
          }finally {
            btn.disabled=false;
          }
        }

        if(result&&result.event==="close")btn.disabled=false;
      });

      widget.open();
    }else {
      if(video.size>30*1024*1024) {
        throw Error(
          "Para videos mayores de 30 MB primero hay que configurar Cloudinary en Render."
        );
      }

      const form=new FormData();
      form.append("nombre",nombre);
      form.append("titulo",titulo);
      form.append("descripcion",descripcion);
      form.append("video",video);

      msg.textContent="Subiendo...";
      const response=await fetch("/api/local-request",{
        method:"POST",
        body:form
      });
      const data=await response.json();

      if(!response.ok) {
        throw Error(data.error||"Error de subida");
      }

      msg.textContent=data.message;
      document.getElementById("archivo").value="";
      document.getElementById("titulo").value="";
      btn.disabled=false;
    }
  }catch(e) {
    msg.textContent=e.message;
    btn.disabled=false;
  }
}

async function login() {
  try {
    const data=await request("/api/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        password:document.getElementById("clave").value
      })
    });

    token=data.token;
    document.getElementById("clave").value="";
    document.getElementById("login").style.display="none";
    document.getElementById("panel").style.display="block";
    document.getElementById("adminMsg").textContent="";
    showPending();
  }catch(e) {
    document.getElementById("adminMsg").textContent=e.message;
  }
}

function logout() {
  token="";
  document.getElementById("panel").style.display="none";
  document.getElementById("login").style.display="block";
}

async function showPending() {
  const box=document.getElementById("pendientes");
  box.replaceChildren();

  try {
    const list=await request("/api/pending");

    if(!list.length) {
      box.textContent="No hay solicitudes pendientes.";
      return;
    }

    for(const v of list) {
      const card=el("div",undefined,"request");
      card.append(
        el("h3",v.nombre+" solicita subir un video"),
        el("p","Título: "+v.titulo),
        el("p",v.descripcion||"")
      );

      const preview=el("video");
      preview.controls=true;
      preview.preload="metadata";

      if(v.cloudUrl) {
        preview.src=v.cloudUrl;
      }else {
        try {
          const r=await fetch(
            "/api/preview/"+encodeURIComponent(v.id),
            {headers:{Authorization:"Bearer "+token}}
          );
          if(r.ok) {
            preview.src=URL.createObjectURL(await r.blob());
          }
        }catch {}
      }

      card.append(preview);
      const row=el("div",undefined,"row");
      const yes=el("button","Autorizar","primary");
      const no=el("button","Rechazar");

      yes.onclick=()=>decide(v.id,"approve");
      no.onclick=()=>decide(v.id,"reject");

      row.append(yes,no);
      card.append(row);
      box.append(card);
    }
  }catch(e) {
    box.textContent=e.message;
  }
}

async function decide(id,action) {
  try {
    await request("/api/decide",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({id,action})
    });
    showPending();
  }catch(e) {
    alert(e.message);
  }
}

showVideos();
</script>
</body>
</html>`;

const server = http.createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,"http://localhost").pathname;

    if(req.method==="GET"&&path==="/") {
      res.writeHead(200,{
        "Content-Type":"text/html; charset=utf-8",
        "X-Content-Type-Options":"nosniff"
      });
      return res.end(page);
    }

    if(req.method==="GET"&&path==="/api/videos") {
      return reply(res,200,
        (await load())
          .filter(v=>v.estado==="aprobado")
          .map(safe)
      );
    }

    if(req.method==="GET"&&path==="/api/pending") {
      if(!authorized(req)) {
        return reply(res,401,{error:"No autorizado"});
      }
      return reply(res,200,
        (await load())
          .filter(v=>v.estado==="pendiente")
          .map(safe)
      );
    }

    if(req.method==="GET"&&path.startsWith("/video/")) {
      const id=path.split("/").pop();
      const item=(await load()).find(v=>
        v.id===id&&v.estado==="aprobado"&&!v.cloudUrl
      );
      if(!item) {
        return reply(res,404,{error:"Video no encontrado"});
      }
      return localVideo(req,res,item);
    }

    if(req.method==="GET"&&path.startsWith("/api/preview/")) {
      if(!authorized(req)) {
        return reply(res,401,{error:"No autorizado"});
      }
      const id=path.split("/").pop();
      const item=(await load()).find(v=>
        v.id===id&&!v.cloudUrl
      );
      if(!item) {
        return reply(res,404,{error:"No encontrado"});
      }
      return localVideo(req,res,item);
    }

    if(req.method==="POST"&&path==="/api/local-request") {
      if(Number(req.headers["content-length"]||0)>MAX_LOCAL+100000) {
        return reply(res,413,{
          error:"Máximo 30 MB para subida directa"
        });
      }

      const request=new Request("http://localhost/upload",{
        method:"POST",
        headers:req.headers,
        body:Readable.toWeb(req),
        duplex:"half"
      });

      const form=await request.formData();
      const file=form.get("video");
      const nombre=String(form.get("nombre")||"").trim().slice(0,80);
      const titulo=String(form.get("titulo")||"").trim().slice(0,120);
      const descripcion=String(form.get("descripcion")||"").slice(0,1000);

      if(!nombre||!titulo||!file||typeof file.arrayBuffer!=="function") {
        return reply(res,400,{
          error:"Completa los datos y video"
        });
      }

      const ext={
        "video/mp4":"mp4",
        "video/webm":"webm",
        "video/ogg":"ogg"
      }[file.type];

      if(!ext||!file.size||file.size>MAX_LOCAL) {
        return reply(res,400,{
          error:"Usa MP4, WebM u OGG de hasta 30 MB"
        });
      }

      const id=crypto.randomUUID();
      fs.writeFileSync(
        VIDEO_DIR+"/"+id+"."+ext,
        Buffer.from(await file.arrayBuffer())
      );

      await serialize(async()=>{
        const list=await load();
        list.push({
          id,nombre,titulo,descripcion,ext,
          estado:"pendiente",
          fecha:new Date().toISOString(),
          likes:[]
        });
        await store(list);
      });

      return reply(res,200,{
        message:"Solicitud enviada. El administrador decidirá si se publica."
      });
    }

    if(req.method!=="POST") {
      return reply(res,404,{error:"No encontrado"});
    }

    const data=await bodyJSON(req);

    if(path==="/api/login") {
      if(!PASSWORD) {
        return reply(res,503,{
          error:"Falta ADMIN_PASSWORD en Render"
        });
      }

      const address=req.socket.remoteAddress||"unknown";
      const attempts=loginAttempts.get(address)||{
        count:0,
        reset:Date.now()+600000
      };

      if(Date.now()>attempts.reset) {
        attempts.count=0;
        attempts.reset=Date.now()+600000;
      }

      if(attempts.count>=10) {
        return reply(res,429,{
          error:"Demasiados intentos. Intenta luego."
        });
      }

      if(data.password!==PASSWORD) {
        attempts.count++;
        loginAttempts.set(address,attempts);
        return reply(res,401,{
          error:"Contraseña incorrecta"
        });
      }

      loginAttempts.delete(address);
      const token=crypto.randomBytes(32).toString("hex");
      sessions.set(token,Date.now()+12*60*60*1000);
      return reply(res,200,{token});
    }

    if(path==="/api/cloud-request") {
      const nombre=String(data.nombre||"").trim().slice(0,80);
      const titulo=String(data.titulo||"").trim().slice(0,120);
      const descripcion=String(data.descripcion||"").slice(0,1000);
      const cloudUrl=String(data.cloudUrl||"");
      const publicId=String(data.publicId||"");

      if(!CLOUD||!PRESET||!nombre||!titulo||!publicId) {
        return reply(res,400,{error:"Datos incompletos"});
      }

      let link;
      try {
        link=new URL(cloudUrl);
      }catch {}

      if(
        !link||
        link.protocol!=="https:"||
        link.hostname!=="res.cloudinary.com"||
        !link.pathname.startsWith("/"+CLOUD+"/video/upload/")
      ) {
        return reply(res,400,{error:"Enlace de video inválido"});
      }

      await serialize(async()=>{
        const list=await load();
        list.push({
          id:crypto.randomUUID(),
          nombre,titulo,descripcion,
          cloudUrl,publicId,
          estado:"pendiente",
          fecha:new Date().toISOString(),
          likes:[]
        });
        await store(list);
      });

      return reply(res,200,{
        message:"Solicitud enviada. Debe ser autorizada antes de publicarse."
      });
    }

    if(path==="/api/decide") {
      if(!authorized(req)) {
        return reply(res,401,{error:"No autorizado"});
      }
      if(!["approve","reject"].includes(data.action)) {
        return reply(res,400,{error:"Acción no válida"});
      }

      const found=await serialize(async()=>{
        const list=await load();
        const item=list.find(v=>
          v.id===data.id&&v.estado==="pendiente"
        );
        if(!item)return false;

        item.estado=data.action==="approve"?"aprobado":"rechazado";
        await store(list);
        return true;
      });

      return reply(
        res,found?200:404,
        found?{ok:true}:{error:"Solicitud no encontrada"}
      );
    }

    if(path==="/api/like") {
      const nombre=String(data.nombre||"").trim();
      const id=String(data.id||"");

      if(nombre.length<2||nombre.length>40) {
        return reply(res,400,{
          error:"Nombre entre 2 y 40 caracteres"
        });
      }

      const result=await serialize(async()=>{
        const list=await load();
        const item=list.find(v=>
          v.id===id&&v.estado==="aprobado"
        );
        if(!item)return "missing";

        if(!Array.isArray(item.likes))item.likes=[];
        if(item.likes.some(n=>
          n.toLowerCase()===nombre.toLowerCase()
        )) {
          return "duplicate";
        }

        item.likes.push(nombre);
        await store(list);
        return "ok";
      });

      if(result==="missing") {
        return reply(res,404,{
          error:"Publicación no encontrada"
        });
      }
      if(result==="duplicate") {
        return reply(res,409,{
          error:"Ese nombre ya dio Me gusta a este video"
        });
      }

      return reply(res,200,{ok:true});
    }

    return reply(res,404,{error:"No encontrado"});

  }catch(err) {
    console.error(err);
    if(!res.headersSent) {
      reply(res,500,{
        error:"Error del servidor: "+err.message
      });
    }else {
      res.end();
    }
  }
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log(
    "Animaciones Nico V5 en puerto "+PORT+
    (persistent?" con base permanente":" con almacenamiento temporal")
  );
});
