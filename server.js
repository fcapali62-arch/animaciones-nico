
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { Readable } = require("stream");

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD;
const DIR = "./videos";
const DB = "./videos.json";
const MAX_SIZE = 30 * 1024 * 1024;
const tokens = new Set();

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);
if (!fs.existsSync(DB)) fs.writeFileSync(DB, "[]");

function read() {
  return JSON.parse(fs.readFileSync(DB, "utf8"));
}

function save(data) {
  fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

function admin(req) {
  const token = (req.headers.authorization || "")
    .replace("Bearer ", "");
  return tokens.has(token);
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

function publicVideo(v) {
  return {
    id: v.id,
    nombre: v.nombre,
    titulo: v.titulo,
    descripcion: v.descripcion,
    fecha: v.fecha,
    likes: Array.isArray(v.likes) ? v.likes : []
  };
}

const page = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Animaciones Nico</title>
<style>
*{box-sizing:border-box}
:root{
--bg:#0c0c10;
--panel:#19191f;
--line:#303039;
--text:#f4f4f6;
--muted:#a5a5b3;
--accent:#dd3548;
}
body{
margin:0;
background:var(--bg);
color:var(--text);
font-family:Arial,Helvetica,sans-serif;
}
header{
background:#15151b;
border-bottom:1px solid var(--line);
padding:26px 6%;
}
.logo{
font-size:25px;
font-weight:800;
letter-spacing:2px;
}
.subtitle{
color:var(--muted);
font-size:13px;
margin-top:8px;
}
nav{
display:flex;
gap:10px;
padding:16px 6%;
border-bottom:1px solid var(--line);
flex-wrap:wrap;
}
button{
background:#292931;
border:1px solid #41414c;
border-radius:6px;
color:white;
padding:11px 17px;
font-size:14px;
cursor:pointer;
}
button:hover{background:#41414c}
button.active,.primary{
background:var(--accent);
border-color:var(--accent);
}
main{
max-width:1180px;
margin:auto;
padding:34px 20px;
min-height:55vh;
}
h1{font-size:29px;margin-top:0}
h2{font-size:21px}
p{color:var(--muted);line-height:1.5}
section{display:none}
section.active{display:block}
.grid{
display:grid;
grid-template-columns:repeat(auto-fill,minmax(290px,1fr));
gap:23px;
margin-top:28px;
}
.card{
background:var(--panel);
border:1px solid var(--line);
border-radius:10px;
overflow:hidden;
}
.card video{
width:100%;
aspect-ratio:16/9;
background:black;
display:block;
}
.card-content{padding:17px}
.card h3{
font-size:19px;
margin:0 0 8px;
}
.card .author{
font-size:13px;
color:#c6c6d0;
}
.card .description{
font-size:14px;
overflow-wrap:anywhere;
white-space:pre-wrap;
}
.like-row{
display:flex;
gap:10px;
align-items:center;
flex-wrap:wrap;
margin-top:18px;
}
.like-count{font-weight:bold;font-size:14px}
.like-button.liked{
background:#4a2430;
border-color:var(--accent);
}
.likes-list{
margin-top:12px;
font-size:13px;
color:var(--muted);
overflow-wrap:anywhere;
}
.form{max-width:560px}
input,textarea{
display:block;
width:100%;
padding:14px;
margin:12px 0;
background:#202027;
border:1px solid #474752;
border-radius:6px;
color:white;
font:inherit;
}
textarea{min-height:95px;resize:vertical}
input[type=file]{font-size:13px}
.message{margin-top:15px;white-space:pre-wrap}
.request{
padding:20px;
background:var(--panel);
border:1px solid var(--line);
border-radius:8px;
margin:15px 0;
}
.request h3{margin-top:0}
.request button{margin:6px 8px 0 0}
.request video{
max-width:100%;
width:440px;
display:block;
margin:15px 0;
background:black;
}
.badge{
display:inline-block;
background:#33333d;
border-radius:4px;
padding:6px 9px;
font-size:12px;
}
footer{
text-align:center;
padding:30px 12px;
border-top:1px solid var(--line);
color:#8e8e9b;
font-size:13px;
}
.dialog-backdrop{
position:fixed;
inset:0;
background:#000b;
display:none;
align-items:center;
justify-content:center;
padding:20px;
z-index:20;
}
.dialog{
background:#202027;
border:1px solid #50505a;
border-radius:12px;
padding:25px;
max-width:430px;
width:100%;
}
.dialog h2{margin-top:0}
.dialog-actions{
display:flex;
gap:10px;
flex-wrap:wrap;
}
@media(max-width:600px){
.logo{font-size:21px}
nav{padding:12px}
nav button{flex:1;padding:11px 7px;font-size:12px}
main{padding:24px 15px}
.grid{grid-template-columns:1fr}
h1{font-size:25px}
}
</style>
</head>
<body>
<header>
<div class="logo">ANIMACIONES NICO</div>
<div class="subtitle">Un espacio para compartir historias animadas</div>
</header>

<nav>
<button id="nav-publicaciones" class="active"
onclick="tab('publicaciones')">Publicaciones</button>
<button id="nav-subir"
onclick="tab('subir')">Subir animación</button>
<button id="nav-administracion"
onclick="tab('administracion')">Administración</button>
</nav>

<main>
<section id="publicaciones" class="active">
<h1>Publicaciones</h1>
<p>Descubre las animaciones de nuestra comunidad.</p>
<div id="galeria" class="grid"></div>
</section>

<section id="subir">
<h1>Enviar una animación</h1>
<p>
Comparte tu trabajo con la comunidad.
Todas las solicitudes deben ser autorizadas
antes de aparecer en Publicaciones.
</p>
<div class="form">
<label>Nombre del creador</label>
<input id="nombre" maxlength="80"
placeholder="Tu nombre de usuario">

<label>Título de la animación</label>
<input id="titulo" maxlength="120"
placeholder="Título del video">

<label>Descripción</label>
<textarea id="descripcion" maxlength="1000"
placeholder="Cuéntanos sobre tu animación"></textarea>

<label>Selecciona tu video</label>
<input type="file" id="archivo"
accept="video/mp4,video/webm,video/ogg">

<p>Formatos MP4, WebM u OGG. Máximo 30 MB.</p>
<button class="primary" id="btnEnviar"
onclick="enviar()">Solicitar publicación</button>

<p class="message" id="mensaje"></p>
</div>
</section>

<section id="administracion">
<h1>Administración</h1>
<div id="login" class="form">
<p>Acceso exclusivo del administrador.</p>
<input id="clave" type="password"
placeholder="Contraseña de administrador">
<button class="primary" onclick="entrar()">Entrar</button>
</div>
<div id="panel" style="display:none">
<h2>Solicitudes pendientes</h2>
<div id="solicitudes"></div>
<button onclick="salir()">Cerrar sesión</button>
</div>
<p id="estado" class="message"></p>
</section>
</main>

<div id="likeDialog" class="dialog-backdrop">
<div class="dialog" role="dialog" aria-modal="true"
aria-labelledby="dialogTitle">
<h2 id="dialogTitle">Dar Me gusta</h2>
<p>Ingrese su nombre de usuario para dar like.</p>
<input id="usuarioLike" maxlength="40"
placeholder="Nombre de usuario">
<div class="dialog-actions">
<button class="primary" onclick="confirmarLike()">
Confirmar Me gusta
</button>
<button onclick="cerrarLike()">Cancelar</button>
</div>
<p id="likeMensaje" class="message"></p>
</div>
</div>

<footer>
Animaciones Nico. Plataforma de publicaciones animadas.
</footer>

<script>
let token = "";
let videoSeleccionado = null;
let usuarioActual = localStorage.getItem("nico_usuario") || "";

function tab(id) {
  document.querySelectorAll("section").forEach(s=>{
    s.classList.remove("active");
  });
  document.querySelectorAll("nav button").forEach(b=>{
    b.classList.remove("active");
  });
  document.getElementById(id).classList.add("active");
  document.getElementById("nav-"+id).classList.add("active");
  if(id==="publicaciones") cargar();
  if(id==="administracion" && token) pendientes();
}

async function api(url, options={}) {
  options.headers = {
    ...(options.headers||{}),
    Authorization:"Bearer "+token
  };
  const r = await fetch(url,options);
  const data = await r.json();
  if(!r.ok) throw Error(data.error || "Error de solicitud");
  return data;
}

function elemento(tag, clase, contenido) {
  const e=document.createElement(tag);
  if(clase)e.className=clase;
  if(contenido!==undefined)e.textContent=contenido;
  return e;
}

async function cargar() {
  const galeria=document.getElementById("galeria");
  galeria.replaceChildren();
  try {
    const videos=await api("/api/videos");
    if(!videos.length) {
      galeria.textContent="Todavía no hay animaciones publicadas.";
      return;
    }

    videos.slice().reverse().forEach(v=>{
      const card=elemento("article","card");
      const video=document.createElement("video");
      video.controls=true;
      video.preload="metadata";
      video.src="/video/"+encodeURIComponent(v.id);

      const content=elemento("div","card-content");
      const titulo=elemento("h3","",v.titulo);
      const autor=elemento("div","author","Por "+v.nombre);
      const descripcion=elemento("p","description",v.descripcion||"");

      const row=elemento("div","like-row");
      const boton=elemento("button","like-button","Me gusta");
      const cantidad=elemento(
        "span","like-count",
        v.likes.length+" Me gusta"
      );

      if(usuarioActual && v.likes.some(n=>
        n.toLowerCase()===usuarioActual.toLowerCase()
      )){
        boton.classList.add("liked");
        boton.textContent="Te gusta";
      }

      boton.onclick=()=>abrirLike(v.id);
      row.append(boton,cantidad);

      const nombres=elemento(
        "div","likes-list",
        v.likes.length
        ? "Les gusta a: "+v.likes.join(", ")
        : "Sé el primero en dar Me gusta"
      );

      content.append(titulo,autor,descripcion,row,nombres);
      card.append(video,content);
      galeria.append(card);
    });
  }catch(e){
    galeria.textContent="No se pudieron cargar las publicaciones.";
  }
}

function abrirLike(id) {
  videoSeleccionado=id;
  document.getElementById("usuarioLike").value=usuarioActual;
  document.getElementById("likeMensaje").textContent="";
  document.getElementById("likeDialog").style.display="flex";
  document.getElementById("usuarioLike").focus();
}

function cerrarLike() {
  document.getElementById("likeDialog").style.display="none";
  videoSeleccionado=null;
}

async function confirmarLike() {
  const nombre=document.getElementById("usuarioLike").value.trim();
  const msg=document.getElementById("likeMensaje");

  if(!nombre) {
    msg.textContent="Ingresa tu nombre de usuario.";
    return;
  }

  try {
    await api("/api/like",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        id:videoSeleccionado,
        nombre:nombre
      })
    });

    usuarioActual=nombre;
    localStorage.setItem("nico_usuario",nombre);
    cerrarLike();
    await cargar();
  }catch(e){
    msg.textContent=e.message;
  }
}

async function enviar() {
  const archivo=document.getElementById("archivo").files[0];
  const nombre=document.getElementById("nombre").value.trim();
  const titulo=document.getElementById("titulo").value.trim();
  const descripcion=document.getElementById("descripcion").value;
  const msg=document.getElementById("mensaje");
  const boton=document.getElementById("btnEnviar");

  if(!nombre||!titulo||!archivo){
    msg.textContent="Completa el nombre, el título y selecciona un video.";
    return;
  }
  if(archivo.size>30*1024*1024){
    msg.textContent="El video supera los 30 MB.";
    return;
  }

  const form=new FormData();
  form.append("nombre",nombre);
  form.append("titulo",titulo);
  form.append("descripcion",descripcion);
  form.append("video",archivo);

  boton.disabled=true;
  msg.textContent="Enviando animación...";

  try {
    const r=await fetch("/api/subir",{
      method:"POST",
      body:form
    });
    const data=await r.json();
    if(!r.ok)throw Error(data.error||"Error de subida");

    msg.textContent=data.message;
    document.getElementById("titulo").value="";
    document.getElementById("descripcion").value="";
    document.getElementById("archivo").value="";
  }catch(e){
    msg.textContent=e.message;
  }finally{
    boton.disabled=false;
  }
}

async function entrar() {
  const clave=document.getElementById("clave").value;
  const estado=document.getElementById("estado");

  try {
    const r=await api("/api/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:clave})
    });

    token=r.token;
    document.getElementById("clave").value="";
    document.getElementById("login").style.display="none";
    document.getElementById("panel").style.display="block";
    estado.textContent="";
    pendientes();
  }catch(e){
    estado.textContent=e.message;
  }
}

function salir() {
  token="";
  document.getElementById("panel").style.display="none";
  document.getElementById("login").style.display="block";
  document.getElementById("solicitudes").replaceChildren();
}

async function pendientes() {
  const cont=document.getElementById("solicitudes");
  cont.replaceChildren();

  try {
    const solicitudes=await api("/api/pendientes");
    if(!solicitudes.length){
      cont.textContent="No hay solicitudes pendientes.";
      return;
    }

    solicitudes.forEach(v=>{
      const box=elemento("div","request");
      const h=elemento(
        "h3","",v.nombre+" solicita subir un video"
      );
      const titulo=elemento("p","","Título: "+v.titulo);
      const desc=elemento("p","",v.descripcion||"");
      const etiqueta=elemento("span","badge","Pendiente");

      const autorizar=elemento("button","primary","Autorizar");
      autorizar.onclick=()=>resolver(v.id,"aprobar");

      const rechazar=elemento("button","","Rechazar");
      rechazar.onclick=()=>resolver(v.id,"rechazar");

      const preview=document.createElement("video");
      preview.controls=true;
      preview.preload="metadata";
      preview.src="/api/revisar/"+encodeURIComponent(v.id);

      box.append(
        h,titulo,desc,etiqueta,preview,
        autorizar,rechazar
      );
      cont.append(box);
    });
  }catch(e){
    cont.textContent=e.message;
  }
}

async function resolver(id,accion) {
  try {
    await api("/api/resolver",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({id,accion})
    });
    pendientes();
  }catch(e){
    alert(e.message);
  }
}

cargar();
</script>
</body>
</html>`;

function serveVideo(req,res,v) {
  const file=DIR+"/"+v.id+"."+v.ext;
  if(!fs.existsSync(file)){
    return json(res,404,{error:"Archivo no disponible"});
  }

  const size=fs.statSync(file).size;
  const types={
    mp4:"video/mp4",
    webm:"video/webm",
    ogg:"video/ogg"
  };
  const type=types[v.ext]||"application/octet-stream";

  let start=0;
  let end=size-1;
  const range=req.headers.range;

  if(range){
    const match=/bytes=(\\d*)-(\\d*)/.exec(range);
    if(!match){
      res.writeHead(416,{"Content-Range":"bytes */"+size});
      return res.end();
    }
    start=match[1]?Number(match[1]):0;
    end=match[2]?Number(match[2]):size-1;
    if(start>end||start>=size||end>=size){
      res.writeHead(416,{"Content-Range":"bytes */"+size});
      return res.end();
    }
    res.writeHead(206,{
      "Content-Type":type,
      "Accept-Ranges":"bytes",
      "Content-Range":"bytes "+start+"-"+end+"/"+size,
      "Content-Length":end-start+1,
      "X-Content-Type-Options":"nosniff"
    });
  }else{
    res.writeHead(200,{
      "Content-Type":type,
      "Content-Length":size,
      "Accept-Ranges":"bytes",
      "X-Content-Type-Options":"nosniff"
    });
  }

  fs.createReadStream(file,{start,end}).pipe(res);
}

async function getBody(req) {
  let body="";
  for await(const chunk of req){
    body+=chunk.toString();
    if(body.length>10000)throw Error("Datos demasiado grandes");
  }
  return JSON.parse(body);
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,"http://localhost");
    const path=url.pathname;

    if(req.method==="GET"&&path==="/"){
      res.writeHead(200,{
        "Content-Type":"text/html; charset=utf-8",
        "X-Content-Type-Options":"nosniff"
      });
      return res.end(page);
    }

    if(req.method==="GET"&&path==="/api/videos"){
      return json(res,200,
        read().filter(v=>v.estado==="aprobado")
          .map(publicVideo)
      );
    }

    if(req.method==="GET"&&path==="/api/pendientes"){
      if(!admin(req))return json(res,401,{error:"No autorizado"});
      return json(res,200,
        read().filter(v=>v.estado==="pendiente")
          .map(publicVideo)
      );
    }

    if(req.method==="GET"&&path.startsWith("/video/")){
      const id=path.split("/").pop();
      const v=read().find(x=>
        x.id===id&&x.estado==="aprobado"
      );
      if(!v)return json(res,404,{error:"Video no encontrado"});
      return serveVideo(req,res,v);
    }

    if(req.method==="GET"&&path.startsWith("/api/revisar/")){
      if(!admin(req)){
        // Los videos pendientes no son públicos.
        return json(res,401,{error:"No autorizado"});
      }
      const id=path.split("/").pop();
      const v=read().find(x=>x.id===id);
      if(!v)return json(res,404,{error:"Video no encontrado"});
      return serveVideo(req,res,v);
    }

    if(req.method==="POST"&&path==="/api/subir"){
      const declared=Number(req.headers["content-length"]||0);
      if(declared>MAX_SIZE+100000){
        return json(res,413,{error:"El video supera el límite"});
      }

      const request=new Request("http://localhost/subir",{
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

      if(!nombre||!titulo||!file||typeof file.arrayBuffer!=="function"){
        return json(res,400,{error:"Faltan datos"});
      }

      const formats={
        "video/mp4":"mp4",
        "video/webm":"webm",
        "video/ogg":"ogg"
      };
      const ext=formats[file.type];

      if(!ext){
        return json(res,400,{error:"Formato no permitido"});
      }
      if(file.size>MAX_SIZE||file.size===0){
        return json(res,413,{error:"El video debe pesar máximo 30 MB"});
      }

      const id=crypto.randomUUID();
      fs.writeFileSync(
        DIR+"/"+id+"."+ext,
        Buffer.from(await file.arrayBuffer())
      );

      const list=read();
      list.push({
        id,nombre,titulo,descripcion,ext,
        estado:"pendiente",
        fecha:new Date().toISOString(),
        likes:[]
      });
      save(list);

      return json(res,200,{
        message:"Solicitud enviada. El administrador revisará tu animación."
      });
    }

    if(req.method==="POST"&&path==="/api/login"){
      const data=await getBody(req);
      if(!PASSWORD){
        return json(res,503,{
          error:"El administrador debe configurar ADMIN_PASSWORD"
        });
      }
      if(data.password!==PASSWORD){
        return json(res,401,{error:"Contraseña incorrecta"});
      }
      const token=crypto.randomBytes(32).toString("hex");
      tokens.add(token);
      return json(res,200,{token});
    }

    if(req.method==="POST"&&path==="/api/resolver"){
      if(!admin(req)){
        return json(res,401,{error:"No autorizado"});
      }

      const data=await getBody(req);
      if(!["aprobar","rechazar"].includes(data.accion)){
        return json(res,400,{error:"Acción inválida"});
      }

      const list=read();
      const v=list.find(x=>
        x.id===data.id&&x.estado==="pendiente"
      );
      if(!v){
        return json(res,404,{error:"Solicitud no encontrada"});
      }

      v.estado=data.accion==="aprobar"
        ?"aprobado":"rechazado";
      if(!Array.isArray(v.likes))v.likes=[];
      save(list);

      return json(res,200,{ok:true});
    }

    if(req.method==="POST"&&path==="/api/like"){
      const data=await getBody(req);
      const id=String(data.id||"");
      const nombre=String(data.nombre||"").trim();

      if(nombre.length<2||nombre.length>40){
        return json(res,400,{
          error:"El nombre debe tener entre 2 y 40 caracteres."
        });
      }

      const list=read();
      const v=list.find(x=>
        x.id===id&&x.estado==="aprobado"
      );

      if(!v){
        return json(res,404,{
          error:"La publicación no existe."
        });
      }

      if(!Array.isArray(v.likes))v.likes=[];

      const existe=v.likes.some(n=>
        n.toLowerCase()===nombre.toLowerCase()
      );

      if(existe){
        return json(res,409,{
          error:"Este nombre de usuario ya dio Me gusta a este video."
        });
      }

      v.likes.push(nombre);
      save(list);

      return json(res,200,{
        ok:true,
        total:v.likes.length,
        usuarios:v.likes
      });
    }

    return json(res,404,{error:"Página no encontrada"});

  }catch(e){
    console.error(e);
    return json(res,500,{
      error:"Ocurrió un error en el servidor"
    });
  }
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log("Animaciones Nico V3 funcionando en puerto "+PORT);
});
