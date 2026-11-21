
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { Readable } = require("stream");

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD;
const DIR = "./videos";
const DB = "./videos.json";

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);
if (!fs.existsSync(DB)) fs.writeFileSync(DB, "[]");

const read = () => JSON.parse(fs.readFileSync(DB, "utf8"));
const save = data => fs.writeFileSync(DB, JSON.stringify(data));
const tokens = new Set();

function admin(req) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  return tokens.has(token);
}

function json(res, status, data) {
  res.writeHead(status, {"Content-Type":"application/json"});
  res.end(JSON.stringify(data));
}

const page = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Animaciones Nico</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#101014;color:#f3f3f5;font-family:Arial,sans-serif}
header{background:#18181e;border-bottom:1px solid #333;padding:22px 6%}
.logo{font-size:24px;font-weight:800;letter-spacing:2px}
nav{display:flex;gap:12px;padding:18px 6%;border-bottom:1px solid #333}
button{background:#292932;border:1px solid #444;color:white;padding:12px 19px;border-radius:6px;cursor:pointer;font-size:14px}
button:hover{background:#41414e}
.primary{background:#e03445;border:0}
main{max-width:1100px;margin:auto;padding:30px 20px}
h1{font-size:28px}
p{color:#aaa}
input,textarea{display:block;width:100%;padding:14px;background:#202027;border:1px solid #45454d;border-radius:6px;color:white;margin:12px 0;font:inherit}
section{display:none}
section.active{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:22px;margin-top:25px}
.card{background:#1d1d24;border:1px solid #303039;border-radius:8px;overflow:hidden;padding-bottom:14px}
.card video{width:100%;aspect-ratio:16/9;background:black}
.card h3,.card p{margin:12px 15px}
.form{max-width:540px}
.request{padding:20px;background:#202027;border:1px solid #444;border-radius:8px;margin-bottom:15px}
.request button{margin:7px 7px 0 0}
footer{text-align:center;border-top:1px solid #303039;padding:30px;color:#888;margin-top:50px}
</style>
</head>
<body>
<header><div class="logo">ANIMACIONES NICO</div></header>
<nav>
<button onclick="tab('publicaciones')">Publicaciones</button>
<button onclick="tab('subir')">Subir animación</button>
<button onclick="tab('administracion')">Administración</button>
</nav>
<main>
<section id="publicaciones" class="active">
<h1>Publicaciones</h1>
<p>Descubre las últimas animaciones de la comunidad.</p>
<div class="grid" id="galeria"></div>
</section>

<section id="subir">
<h1>Enviar una animación</h1>
<p>Tu video será revisado antes de publicarse.</p>
<div class="form">
<input id="nombre" placeholder="Nombre del creador" maxlength="80">
<input id="titulo" placeholder="Título de la animación" maxlength="120">
<textarea id="descripcion" placeholder="Descripción" maxlength="1000"></textarea>
<input type="file" id="archivo" accept="video/mp4,video/webm,video/ogg">
<button class="primary" onclick="enviar()">Solicitar publicación</button>
<p id="mensaje"></p>
</div>
</section>

<section id="administracion">
<h1>Administración</h1>
<div id="login" class="form">
<p>Acceso exclusivo del administrador.</p>
<input type="password" id="clave" placeholder="Contraseña">
<button onclick="entrar()">Entrar</button>
</div>
<div id="panel" style="display:none">
<h2>Solicitudes pendientes</h2>
<div id="solicitudes"></div>
<button onclick="salir()">Cerrar sesión</button>
</div>
<p id="estado"></p>
</section>
</main>
<footer>Animaciones Nico. Todos los derechos reservados.</footer>
<script>
let token = "";

function tab(id){
document.querySelectorAll("section").forEach(x=>x.classList.remove("active"));
document.getElementById(id).classList.add("active");
if(id==="publicaciones") cargar();
if(id==="administracion" && token) pendientes();
}

async function api(url,options={}){
options.headers={...(options.headers||{}),Authorization:"Bearer "+token};
const r=await fetch(url,options);
return r.json();
}

async function cargar(){
const videos=await api("/api/videos");
const g=document.getElementById("galeria");
g.replaceChildren();
if(!videos.length){g.textContent="Todavía no hay animaciones publicadas.";return;}
videos.forEach(v=>{
const c=document.createElement("div");c.className="card";
const video=document.createElement("video");
video.controls=true;video.preload="metadata";
video.src="/video/"+encodeURIComponent(v.id);
const h=document.createElement("h3");h.textContent=v.titulo;
const p=document.createElement("p");p.textContent="Por "+v.nombre;
const d=document.createElement("p");d.textContent=v.descripcion||"";
c.append(video,h,p,d);g.append(c);
});
}

async function enviar(){
const f=document.getElementById("archivo").files[0];
const nombre=document.getElementById("nombre").value.trim();
const titulo=document.getElementById("titulo").value.trim();
const msg=document.getElementById("mensaje");
if(!nombre||!titulo||!f){msg.textContent="Completa el nombre, título y video.";return;}
const form=new FormData();
form.append("nombre",nombre);
form.append("titulo",titulo);
form.append("descripcion",document.getElementById("descripcion").value);
form.append("video",f);
msg.textContent="Enviando...";
try{
const r=await fetch("/api/subir",{method:"POST",body:form});
const result=await r.json();
msg.textContent=result.message||result.error;
}catch(e){msg.textContent="No se pudo enviar el video.";}
}

async function entrar(){
const r=await fetch("/api/login",{
method:"POST",headers:{"Content-Type":"application/json"},
body:JSON.stringify({password:document.getElementById("clave").value})
});
const data=await r.json();
if(!r.ok){document.getElementById("estado").textContent=data.error;return;}
token=data.token;
document.getElementById("clave").value="";
document.getElementById("login").style.display="none";
document.getElementById("panel").style.display="block";
pendientes();
}

function salir(){
token="";
document.getElementById("panel").style.display="none";
document.getElementById("login").style.display="block";
}

async function pendientes(){
const list=await api("/api/pendientes");
const cont=document.getElementById("solicitudes");
cont.replaceChildren();
if(!list.length){cont.textContent="No tienes solicitudes pendientes.";return;}
list.forEach(v=>{
const box=document.createElement("div");box.className="request";
const h=document.createElement("h3");h.textContent=v.nombre+" solicita subir un video";
const p=document.createElement("p");p.textContent="Título: "+v.titulo;
const a=document.createElement("button");a.textContent="Autorizar";
a.onclick=()=>resolver(v.id,"aprobar");
const b=document.createElement("button");b.textContent="Rechazar";
b.onclick=()=>resolver(v.id,"rechazar");
box.append(h,p,a,b);cont.append(box);
});
}

async function resolver(id,accion){
const result=await api("/api/resolver",{
method:"POST",headers:{"Content-Type":"application/json"},
body:JSON.stringify({id,accion})
});
if(result.ok) pendientes();
else alert(result.error);
}
cargar();
</script>
</body></html>`;

const server = http.createServer(async(req,res)=>{
try{
const url=new URL(req.url,"http://localhost");
const method=req.method;

if(method==="GET"&&url.pathname==="/"){
res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
return res.end(page);
}

if(method==="GET"&&url.pathname==="/api/videos")
return json(res,200,read().filter(v=>v.estado==="aprobado"));

if(method==="GET"&&url.pathname==="/api/pendientes"){
if(!admin(req))return json(res,401,{error:"No autorizado"});
return json(res,200,read().filter(v=>v.estado==="pendiente"));
}

if(method==="GET"&&url.pathname.startsWith("/video/")){
const id=url.pathname.split("/").pop();
const item=read().find(v=>v.id===id&&v.estado==="aprobado");
if(!item)return json(res,404,{error:"No encontrado"});
const file=DIR+"/"+item.id+"."+item.ext;
if(!fs.existsSync(file))return json(res,404,{error:"Archivo no disponible"});
const size=fs.statSync(file).size;
const type=item.ext==="mp4"?"video/mp4":item.ext==="webm"?"video/webm":"video/ogg";
let start=0,end=size-1;
const range=req.headers.range;
if(range){
const match=/bytes=(\\d*)-(\\d*)/.exec(range);
if(match){
start=match[1]?Number(match[1]):0;
end=match[2]?Number(match[2]):size-1;
}
if(start>end||start>=size)return res.writeHead(416,{"Content-Range":"bytes */"+size}).end();
res.writeHead(206,{"Content-Type":type,"Accept-Ranges":"bytes","Content-Range":"bytes "+start+"-"+end+"/"+size,"Content-Length":end-start+1});
}else res.writeHead(200,{"Content-Type":type,"Accept-Ranges":"bytes","Content-Length":size});
return fs.createReadStream(file,{start,end}).pipe(res);
}

if(method==="POST"){
if(Number(req.headers["content-length"]||0)>32*1024*1024)
return json(res,413,{error:"El video supera el límite de 30 MB"});

if(url.pathname==="/api/subir"){
const request=new Request("http://localhost/subir",{
method:"POST",headers:req.headers,body:Readable.toWeb(req),duplex:"half"
});
const form=await request.formData();
const file=form.get("video");
const nombre=String(form.get("nombre")||"").trim().slice(0,80);
const titulo=String(form.get("titulo")||"").trim().slice(0,120);
const descripcion=String(form.get("descripcion")||"").slice(0,1000);
if(!nombre||!titulo||!file||typeof file.arrayBuffer!=="function")
return json(res,400,{error:"Faltan datos"});
const ext=file.type==="video/mp4"?"mp4":file.type==="video/webm"?"webm":file.type==="video/ogg"?"ogg":null;
if(!ext)return json(res,400,{error:"Usa MP4, WebM u OGG"});
if(file.size>30*1024*1024)return json(res,413,{error:"Máximo 30 MB"});
const id=crypto.randomUUID();
fs.writeFileSync(DIR+"/"+id+"."+ext,Buffer.from(await file.arrayBuffer()));
const data=read();
data.push({id,nombre,titulo,descripcion,ext,estado:"pendiente"});
save(data);
return json(res,200,{message:"Solicitud enviada. Espera la autorización del administrador."});
}

let body="";
for await(const chunk of req){
body+=chunk;
if(body.length>10000)return json(res,413,{error:"Solicitud demasiado grande"});
}
let data;
try{data=JSON.parse(body);}catch{return json(res,400,{error:"Datos inválidos"});}

if(url.pathname==="/api/login"){
if(!PASSWORD)return json(res,503,{error:"Configura ADMIN_PASSWORD en Render"});
if(data.password!==PASSWORD)return json(res,401,{error:"Contraseña incorrecta"});
const token=crypto.randomBytes(32).toString("hex");
tokens.add(token);
return json(res,200,{token});
}

if(url.pathname==="/api/resolver"){
if(!admin(req))return json(res,401,{error:"No autorizado"});
const list=read();
const v=list.find(x=>x.id===data.id&&x.estado==="pendiente");
if(!v)return json(res,404,{error:"Solicitud no encontrada"});
if(!["aprobar","rechazar"].includes(data.accion))
return json(res,400,{error:"Acción inválida"});
v.estado=data.accion==="aprobar"?"aprobado":"rechazado";
save(list);
return json(res,200,{ok:true});
}
}

json(res,404,{error:"Página no encontrada"});
}catch(e){
console.error(e);
json(res,500,{error:"Error del servidor"});
}
});

server.listen(PORT,"0.0.0.0",()=>console.log("Animaciones Nico funcionando en puerto "+PORT));
