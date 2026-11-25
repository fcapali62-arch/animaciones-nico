'use strict';
/**
 * NEON STUDIO 5.0 — Studio with licensed, separately configured image/video APIs.
 * Yape payments are manual, off until a real video engine is enabled. Requires persistent
 * storage path, a secret, a configured AI provider and budgets. No secret in browser.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const PORT = Number(process.env.PORT || 3000);
const PRODUCTION = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const STATE_PATH = process.env.STATE_PATH || path.join(root, 'data', 'state.json');
const MEDIA_PATH = process.env.MEDIA_PATH || path.join(root, 'data', 'media');
const PERSISTENT_STORE = process.env.PERSISTENT_STORE === 'true';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash-image';
const HF_KEY = process.env.HF_API_KEY || process.env.HF_CREDENTIALS || '';
const VIDEO_MODEL = 'bytedance/seedance-2.5';
const DOWNLOAD_MAX_BYTES = 450 * 1024 * 1024;
const IMAGE_BUDGET = Math.max(0, Number(process.env.IMAGE_DAILY_BUDGET || 0));
const VIDEO_SECONDS_BUDGET = Math.max(0, Number(process.env.VIDEO_DAILY_SECONDS_BUDGET || 0));
const USER_IMAGE_DAILY_LIMIT = Math.max(1, Number(process.env.USER_IMAGE_DAILY_LIMIT || 4));
const USER_VIDEO_DAILY_LIMIT = Math.max(1, Number(process.env.USER_VIDEO_DAILY_LIMIT || 1));
const imageReady = () => !!GEMINI_KEY && IMAGE_BUDGET > 0 && (PERSISTENT_STORE || !PRODUCTION);
const videoReady = () => !!HF_KEY && VIDEO_SECONDS_BUDGET > 0 && (PERSISTENT_STORE || !PRODUCTION);
const isReady = () => imageReady() || videoReady();
const DAILY = 86400000;
const STYLES = Object.freeze({
  cinematic: 'Photorealistic cinematic film shot, excellent production design, beautiful realistic lighting, refined shadows, natural perspective, coherent motion, filmic color grading. No captions or text.',
  anime: 'Original high quality Japanese animation feature-film art style, painterly backgrounds, clean expressive silhouettes, fluid animation, cinematic framing. No text.',
  realistic: 'High fidelity photographic realism, lifelike detail, convincing textures, stable anatomy, natural light, beautifully rendered. No text.',
  fantasy: 'Ethereal fantasy concept art, epic composition, magical lighting, atmospheric depth, enchanting detailed environment, high artistic quality. No text.',
  clay: 'Beautifully crafted 3D animated film, fluid expressive motion, tactile materials, polished cinematic lighting. No text.',
  mono: 'Elegant black and white film, dramatic chiaroscuro, textured monochrome, precise visual storytelling, fine-art cinematography. No captions.'
});
if (SECRET.length < 32) throw Error('SESSION_SECRET must be 32+ characters');
if ((ADMIN_EMAIL && ADMIN_PASSWORD.length < 14) || (ADMIN_PASSWORD && !ADMIN_EMAIL)) throw Error('ADMIN_EMAIL and ADMIN_PASSWORD (14+ chars) must be set together');
if (PRODUCTION && isReady() && (!process.env.SESSION_SECRET || !PERSISTENT_STORE)) throw Error('Paid AI API use in production requires SESSION_SECRET and PERSISTENT_STORE');
fs.mkdirSync(path.dirname(STATE_PATH), {recursive: true});
fs.mkdirSync(MEDIA_PATH, {recursive: true});
let db = {users:[],images:[],videos:[],audit:[],threads:[],payments:[],config:{yapePhone:'',yapeHolder:'',billingEnabled:false,priceSoles:10}};
try {db = JSON.parse(fs.readFileSync(STATE_PATH,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e;}
for(const field of ['users','images','videos','audit','threads','payments']) if (!Array.isArray(db[field])) db[field]=[];
if(!db.config||typeof db.config!=='object')db.config={yapePhone:'',yapeHolder:'',billingEnabled:false,priceSoles:10};
db.config={yapePhone:String(db.config.yapePhone||''),yapeHolder:String(db.config.yapeHolder||''),billingEnabled:db.config.billingEnabled===true,priceSoles:10};
function save(){const tmp=STATE_PATH+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db),{mode:0o600});fs.renameSync(tmp,STATE_PATH);}
function hashPassword(p,salt=crypto.randomBytes(16).toString('hex')){return salt+':'+crypto.scryptSync(p,salt,64).toString('hex');}
function checkPassword(p,h){try{const [salt,bytes]=h.split(':');const b=Buffer.from(bytes,'hex');return crypto.timingSafeEqual(b,crypto.scryptSync(p,salt,b.length));}catch{return false;}}
if(ADMIN_EMAIL && ADMIN_PASSWORD && !db.users.some(u=>u.role==='admin')){
  db.users.push({id:crypto.randomUUID(),email:ADMIN_EMAIL,password:hashPassword(ADMIN_PASSWORD),role:'admin',blocked:false,createdAt:new Date().toISOString()});save();
}
const active = u => !!u && !u.blocked;
// Checkout de comercio no conectado: acceso temporal sin cobrar a visitantes.
const member = u => !!u;
const safeUser = u => u ? {id:u.id,email:u.email,role:u.role,active:active(u),member:member(u),paidUntil:u.paidUntil||null,grantUntil:u.grantUntil||null,createdAt:u.createdAt}:null;
const safePayment=p=>({id:p.id,userId:p.userId,email:db.users.find(x=>x.id===p.userId)?.email||'Usuario',reference:p.reference,status:p.status,createdAt:p.createdAt,reviewedAt:p.reviewedAt||null,amount:10});
function threadFor(user,id){return db.threads.find(t=>t.id===id&&t.userId===user?.id);}
function addThreadMessage(user,threadId,message){const t=threadFor(user,threadId);if(!t)return; t.messages.push({...message,id:crypto.randomUUID(),createdAt:new Date().toISOString()});t.messages=t.messages.slice(-100);t.updatedAt=new Date().toISOString();save();}
function accessGuard(res,u){if(!member(u)){fail(res,402,'Se requiere una membresía de 30 días o acceso gratuito concedido por el administrador.');return false;}return true;}
function cookie(u){const content=Buffer.from(JSON.stringify({id:u.id,exp:Date.now()+7*DAILY})).toString('base64url');return content+'.'+crypto.createHmac('sha256',SECRET).update(content).digest('base64url');}
function userFrom(req){try{const val=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ns3_session='))?.slice(12);if(!val)return null;const [raw,signature]=val.split('.');if(!raw||!signature)return null;const calculated=crypto.createHmac('sha256',SECRET).update(raw).digest();const provided=Buffer.from(signature,'base64url');if(provided.length!==calculated.length||!crypto.timingSafeEqual(provided,calculated))return null;const payload=JSON.parse(Buffer.from(raw,'base64url').toString());if(payload.exp<Date.now())return null;return db.users.find(u=>u.id===payload.id)||null;}catch{return null;}}
function setSession(u){return `ns3_session=${cookie(u)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${PRODUCTION?'; Secure':''}`;}
function reply(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',...headers});res.end(JSON.stringify(data));}
function fail(res,status,msg){reply(res,status,{error:msg});}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
function staticFile(res,urlPath){const normalized=urlPath==='/'?'index.html':urlPath.slice(1);if(!['index.html','style.css','app.js','assets/cinema.svg','assets/anime.svg','assets/fantasy.svg','assets/favicon.svg'].includes(normalized)){res.writeHead(404);res.end('No encontrado');return;}
 const file=path.join(root,normalized);res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'none'"});fs.createReadStream(file).pipe(res);
}
function readBody(req,limit=24576){return new Promise((resolve,reject)=>{let bytes=0;const chunks=[];req.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit){reject(Error('Solicitud muy grande')); req.destroy();return;}chunks.push(chunk);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(Error('JSON inválido'));}});req.on('error',reject);});}
function sameOrigin(req){if(!req.headers.origin)return true;try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
const limiter=new Map();
function rateLimit(key,max,windowMs){const now=Date.now();const a=(limiter.get(key)||[]).filter(x=>x>now-windowMs);if(a.length>=max)return false;a.push(now);limiter.set(key,a);if(limiter.size>5000)limiter.clear();return true;}
function utcDay(){return new Date().toISOString().slice(0,10);}
function countToday(collection,pred=()=>true){const day=utcDay();return collection.filter(x=>x.createdAt?.startsWith(day)&&pred(x)).length;}
const makeBrief=(prompt,style)=>`${prompt}\nArt direction: ${STYLES[style]}\nPreserve intended appearance and spatial continuity; do not add captions, logos, or letters.`;
function safeImage(image){return {id:image.id,type:'image',style:image.style,createdAt:image.createdAt,status:image.status==='processing'?'processing':'completed',url:image.status==='completed'?'/api/images/'+image.id:null,aspect:image.aspect,threadId:image.threadId||null,prompt:image.prompt||''};}
function safeVideo(video){return {id:video.id,type:'video',style:video.style,duration:video.duration,createdAt:video.createdAt,status:video.status,url:video.status==='completed'?video.url:null,downloadUrl:video.status==='completed'?'/api/video/download/'+video.id:null,progress:Number.isFinite(video.progress)?video.progress:null,error:video.error||null,threadId:video.threadId||null,prompt:video.prompt||'',generationMode:video.generationMode||'text'};}
async function sendGemini(prompt){const url='https://generativelanguage.googleapis.com/v1beta/models/'+GEMINI_MODEL+':generateContent';const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':GEMINI_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:['TEXT','IMAGE']}}),signal:AbortSignal.timeout(105000)});const data=await response.json();if(!response.ok)throw Error(`API de imágenes: HTTP ${response.status}. Comprueba acceso y saldo de la API.`);const candidates=data.candidates||[];const parts=candidates.flatMap(c=>c.content?.parts||[]);const item=parts.find(p=>p.inlineData?.data&&/^image\/(png|jpeg|webp)$/.test(p.inlineData?.mimeType||''));if(!item)throw Error('La IA no devolvió una imagen válida.');const bytes=Buffer.from(item.inlineData.data,'base64');if(bytes.length<1000||bytes.length>17_000_000)throw Error('La imagen recibida tiene un tamaño no admitido.');return {buffer:bytes,mime:item.inlineData.mimeType};}
async function higgsfield(endpoint,method,body){const res=await fetch('https://api.higgsfield.ai/'+endpoint,{method,headers:{'Authorization':'Key '+HF_KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});let data={};try{data=await res.json();}catch{}if(!res.ok)throw Error(`API de video: HTTP ${res.status}; revisa credenciales, saldo y parámetros.`);return data;}
function validateMediaUrl(raw, kind='download'){
  const u = new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.port) throw Error('El proveedor no entregó un enlace multimedia seguro.');
  const host=u.hostname.toLowerCase();
  const suffixes = kind==='upload'
    ? ['.amazonaws.com','.cloudflarestorage.com','.higgsfield.ai','.higgs.ai','.r2.dev']
    : ['.cloudfront.net','.amazonaws.com','.higgsfield.ai','.higgs.ai','.googleapis.com','.googleusercontent.com','.r2.dev'];
  if(!(suffixes.some(s => host.endsWith(s)) || ['higgsfield.ai','higgs.ai','storage.googleapis.com'].includes(host)) || host==='localhost') throw Error('Dominio multimedia no autorizado: verifica el proveedor.');
  return u.toString();
}
async function uploadReferenceToHiggsfield(ref){
  const signed=await higgsfield('files/generate-upload-url','POST',{content_type:ref.mime});
  if(typeof signed.upload_url!=='string'||typeof signed.public_url!=='string')throw Error('Higgsfield no devolvió los enlaces de carga de referencia.');
  const target=validateMediaUrl(signed.upload_url,'upload');
  const publicUrl=validateMediaUrl(signed.public_url,'download');
  const headers={'Content-Type':ref.mime};
  if(signed.upload_headers&&typeof signed.upload_headers==='object'&&!Array.isArray(signed.upload_headers)){
    for (const [key,value] of Object.entries(signed.upload_headers)){
      if(typeof value==='string'&&/^[a-zA-Z0-9-]+$/.test(key)&&!/authorization|cookie|host/i.test(key))headers[key]=value;
    }
  }
  const done=await fetch(target,{method:'PUT',headers,body:ref.bytes,redirect:'error',signal:AbortSignal.timeout(90000)});
  if(!done.ok)throw Error('No se pudo subir la imagen de referencia al motor de IA (HTTP '+done.status+').');
  return publicUrl;
}
async function downloadVideo(res, video){
  if(video.status!=='completed'||!video.url)return fail(res,404,'El video aún no está terminado.');
  let url;try{url=validateMediaUrl(video.url);}catch{return fail(res,502,'El enlace del proveedor no está permitido para descarga directa.');}
  try{
    const remote=await fetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(180000)});
    if(remote.status>=300&&remote.status<400)return fail(res,502,'El proveedor redirige el archivo; abre el video en una pestaña nueva.');
    if(!remote.ok||!remote.body)return fail(res,502,'No se pudo descargar el archivo del proveedor.');
    const len=Number(remote.headers.get('content-length')||0);
    if(len>DOWNLOAD_MAX_BYTES){await remote.body.cancel();return fail(res,413,'Video demasiado grande para descarga directa.');}
    const {Readable}=require('node:stream');let size=0;
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="neon-studio-'+video.id+'.mp4"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    const stream=Readable.fromWeb(remote.body);
    stream.on('data',chunk=>{size+=chunk.length;if(size>DOWNLOAD_MAX_BYTES)stream.destroy(Error('Archivo demasiado grande'));});
    stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch{if(!res.headersSent)fail(res,502,'Fallo la descarga desde el proveedor.');else res.destroy();}
}

async function serveImage(res,id,u){const found=db.images.find(x=>x.id===id);if(!found||found.userId!==u?.id&&! (u?.role==='admin'))return fail(res,404,'Imagen no encontrada');const file=path.join(MEDIA_PATH,id+'.'+found.ext);if(!fs.existsSync(file))return fail(res,410,'La imagen ya no está guardada en el servidor.');res.writeHead(200,{'Content-Type':found.mime,'Content-Disposition':'inline; filename="neon-'+id+'.'+found.ext+'"','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});fs.createReadStream(file).pipe(res);}

function parseReferenceData(raw){
 if(typeof raw!=='string'||raw.length>6_000_000)return null;
 const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
 if(!m)return null;
 const bytes=Buffer.from(m[2],'base64');if(bytes.length<1024||bytes.length>4_500_000)return null;
 const isPng=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const isJpg=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
 const isWebp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
 if(!((m[1]==='image/png'&&isPng)||(m[1]==='image/jpeg'&&isJpg)||(m[1]==='image/webp'&&isWebp)))return null;
 const ext=m[1]==='image/jpeg'?'jpg':m[1].split('/')[1];return {bytes,mime:m[1],ext};
}

const server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://local').pathname;
  const u=userFrom(req);
  if(req.method==='GET'&&!route.startsWith('/api/'))return staticFile(res,route);
  if(req.method==='GET'&&route==='/api/status')return reply(res,200,{ok:true,freeForVisitors:true,configured:imageReady()||videoReady(),imageReady:imageReady(),videoReady:videoReady(),storagePersistent:PERSISTENT_STORE,mode:PRODUCTION?'production':'development'});
  if(req.method==='GET'&&route==='/api/me')return reply(res,200,{user:safeUser(u),imageReady:imageReady(),videoReady:videoReady(),freeForVisitors:true});
  if(req.method==='GET'&&route.startsWith('/api/images/'))return serveImage(res,route.slice('/api/images/'.length),u);
  // Las imágenes privadas se suben directamente al almacenamiento firmado de Higgsfield; no hay ruta pública de referencias.
  if(req.method==='GET'&&route==='/api/public')return reply(res,200,{priceSoles:10,billingEnabled:false,checkoutReady:false,paymentMethod:'yape_checkout_pending',imageReady:imageReady(),videoReady:videoReady(),maxSingleClip:30,requestedMaxDuration:120,storagePersistent:PERSISTENT_STORE});
  if(req.method==='GET'&&route==='/api/threads'){if(!active(u))return fail(res,401,'Inicia sesión.');return reply(res,200,{items:db.threads.filter(t=>t.userId===u.id).map(t=>({id:t.id,title:t.title,updatedAt:t.updatedAt,createdAt:t.createdAt})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100)});}
  if(req.method==='GET'&&route.startsWith('/api/threads/')){if(!active(u))return fail(res,401,'Inicia sesión.');const t=threadFor(u,route.slice('/api/threads/'.length));if(!t)return fail(res,404,'Conversación no encontrada.');return reply(res,200,{thread:t});}
  if(req.method==='GET'&&route==='/api/payments'){if(!active(u))return fail(res,401,'Inicia sesión.');return reply(res,200,{payments:db.payments.filter(p=>p.userId===u.id).map(safePayment)});}
  if(req.method==='GET'&&route==='/api/library'){
    if(!active(u))return fail(res,401,'Inicia sesión para ver tus creaciones.');
    return reply(res,200,{items:[...db.images.filter(x=>x.userId===u.id).map(safeImage),...db.videos.filter(x=>x.userId===u.id).map(safeVideo)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,80)});
  }
  if(req.method==='GET'&&route.startsWith('/api/video/download/')){
    if(!active(u))return fail(res,401,'Inicia sesión para descargar tu archivo.');
    const video=db.videos.find(x=>x.id===route.slice('/api/video/download/'.length)&&(x.userId===u.id||u.role==='admin'));
    if(!video)return fail(res,404,'No encontramos este archivo.');
    return downloadVideo(res,video);
  }
  if(req.method==='GET'&&route.startsWith('/api/video/status/')){
    if(!active(u))return fail(res,401,'Sesión requerida.');const video=db.videos.find(x=>x.id===route.slice(18)&&x.userId===u.id);if(!video)return fail(res,404,'No encontramos el video.');
    if(!['completed','failed','canceled','nsfw'].includes(video.status)&&video.remoteId){
      try{const data=await higgsfield('requests/'+encodeURIComponent(video.remoteId)+'/status','GET');const state=String(data.status||'').toLowerCase();if(['queued','in_progress','completed','failed','canceled','nsfw'].includes(state))video.status=state;
        const rawProgress=typeof data.progress==='number'?data.progress:typeof data.progress?.percent==='number'?data.progress.percent:null;
        if(Number.isFinite(rawProgress)&&rawProgress>=0&&rawProgress<=100&&rawProgress!==1)video.progress=Math.round(rawProgress<1?rawProgress*100:rawProgress);
        if(video.status==='completed'){const link=data?.video?.url||data?.output?.video?.url||data?.output?.url;if(typeof link!=='string'||!link.startsWith('https://')){video.status='failed';video.error='El proveedor no entregó un video reproducible.';}else video.url=link;}
        if(['failed','canceled','nsfw'].includes(video.status))video.error='La IA no pudo completar la generación.';
        save();
      }catch{ /* Keep last known state and allow retry. */ }
    }
    return reply(res,200,{item:safeVideo(video)});
  }
  if(req.method==='GET'&&route==='/api/admin'){
    if(u?.role!=='admin')return fail(res,403,'Acceso exclusivo de administración.');
    return reply(res,200,{users:db.users.map(safeUser),payments:db.payments.map(safePayment).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),paymentSettings:db.config,stats:{users:db.users.filter(x=>x.role!=='admin').length,totalImages:db.images.length,totalVideos:db.videos.filter(v=>v.status==='completed').length,videosInProgress:db.videos.filter(v=>['queued','submitting','in_progress'].includes(v.status)).length,totalThreads:db.threads.length,imagesToday:countToday(db.images),videoSecondsToday:db.videos.filter(x=>x.createdAt?.startsWith(utcDay())&&x.status!=='failed').reduce((n,j)=>n+j.duration,0),approvedRevenue:db.payments.filter(p=>p.status==='approved').length*10},engine:{imageReady:imageReady(),videoReady:videoReady(),imageDailyBudget:IMAGE_BUDGET,videoSecondsDailyBudget:VIDEO_SECONDS_BUDGET,storagePersistent:PERSISTENT_STORE}});
  }
  if(req.method!=='POST'||!route.startsWith('/api/'))return fail(res,404,'Ruta no disponible');
  if(!sameOrigin(req))return fail(res,403,'Origen no autorizado');
  let body;try{body=await readBody(req,(route==='/api/video/generate'&&u)?6_500_000:24576);}catch(e){return fail(res,400,e.message);}
  if(route==='/api/register'){
    const ip=req.socket.remoteAddress||'?';if(!rateLimit('register:'+ip,4,3600000))return fail(res,429,'Demasiados registros desde esta conexión.');
    const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');if(email.length>150||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<10||password.length>200)return fail(res,400,'Usa un correo válido y una contraseña de al menos 10 caracteres.');
    if(db.users.some(x=>x.email===email))return fail(res,409,'Este correo ya existe.');const user={id:crypto.randomUUID(),email,password:hashPassword(password),role:'user',blocked:false,createdAt:new Date().toISOString()};db.users.push(user);save();return reply(res,201,{user:safeUser(user)},{'Set-Cookie':setSession(user)});
  }
  if(route==='/api/login'){
    const ip=req.socket.remoteAddress||'?';if(!rateLimit('login:'+ip,16,900000))return fail(res,429,'Demasiados intentos de inicio de sesión.');const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');const target=db.users.find(x=>x.email===email);
    if(!target||!checkPassword(password,target.password))return fail(res,401,'Correo o contraseña incorrectos.');if(target.blocked)return fail(res,403,'Esta cuenta está suspendida.');return reply(res,200,{user:safeUser(target)},{'Set-Cookie':setSession(target)});
  }
  if(route==='/api/logout')return reply(res,200,{ok:true},{'Set-Cookie':'ns3_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'+(PRODUCTION?'; Secure':'')});
  if(!active(u))return fail(res,401,'Inicia sesión con una cuenta activa.');
  if(route==='/api/threads/new'){
    const title=String(body.title||'Nueva creación').replace(/[\n\r]/g,' ').trim().slice(0,90)||'Nueva creación';
    if(db.threads.filter(t=>t.userId===u.id).length>=100)return fail(res,429,'Has alcanzado el máximo de conversaciones guardadas.');
    const t={id:crypto.randomUUID(),userId:u.id,title,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[]};db.threads.push(t);save();return reply(res,201,{thread:t});
  }
  if(route==='/api/threads/add'){
    const t=threadFor(u,String(body.threadId||''));if(!t)return fail(res,404,'Conversación no encontrada.');
    const text=String(body.text||'').trim().slice(0,1700);if(text.length<2)return fail(res,400,'Escribe una idea.');
    if(!rateLimit('message:'+u.id,25,3600000))return fail(res,429,'Demasiados mensajes seguidos.');
    addThreadMessage(u,t.id,{kind:'prompt',text,style:String(body.style||'cinematic'),duration:Number(body.duration||10),mode:String(body.mode||'text'),hasImage:body.hasImage===true});return reply(res,200,{ok:true});
  }
  if(route==='/api/threads/delete'){
    const t=threadFor(u,String(body.threadId||''));if(!t)return fail(res,404,'Conversación no encontrada.');
    db.threads=db.threads.filter(x=>x.id!==t.id);save();return reply(res,200,{ok:true});
  }
  if(route==='/api/payments/request')return fail(res,503,'Aún no hay pasarela de pago segura. No realices transferencias ni ingreses códigos de operación.');
   if(route==='/api/admin/yape'){
    if(u.role!=='admin')return fail(res,403,'Solo el administrador.');
    const phone=String(body.phone||'').trim(),holder=String(body.holder||'').trim();const enabled=body.enabled===true;
    if((phone&&!/^9\d{8}$/.test(phone))||holder.length>85||enabled&&(!phone||holder.length<3))return fail(res,400,'Indica un número Yape válido (9 dígitos) y el titular antes de activar cobros.');
    if(enabled)return fail(res,409,'Para proteger tu número personal, se necesita integrar una pasarela de comercio como Culqi o Mercado Pago. No se pueden activar transferencias manuales.');
    db.config={yapePhone:phone,yapeHolder:holder,billingEnabled:false,priceSoles:10};save();return reply(res,200,{settings:db.config});
  }
  if(route==='/api/admin/grant'){
    if(u.role!=='admin')return fail(res,403,'Solo el administrador.');
    const t=db.users.find(x=>x.id===body.userId&&x.role!=='admin');if(!t)return fail(res,404,'Usuario no encontrado.');
    if(body.revoke===true){t.grantUntil=null;} else{t.grantUntil=new Date(Math.max(Date.now(),Date.parse(t.grantUntil||'')||0)+30*DAILY).toISOString();}
    db.audit.push({time:new Date().toISOString(),actor:u.id,target:t.id,action:body.revoke?'revoke_grant':'grant_30_days'});save();return reply(res,200,{user:safeUser(t)});
  }
  if(route==='/api/admin/payment'){
    if(u.role!=='admin')return fail(res,403,'Solo el administrador.');
    const p=db.payments.find(x=>x.id===body.paymentId);if(!p||p.status!=='pending'||!['approved','rejected'].includes(body.action))return fail(res,400,'La solicitud ya fue revisada o no existe.');
    p.status=body.action;p.reviewedAt=new Date().toISOString();if(p.status==='approved'){const t=db.users.find(x=>x.id===p.userId);if(t){t.paidUntil=new Date(Math.max(Date.now(),Date.parse(t.paidUntil||'')||0)+30*DAILY).toISOString();}}
    db.audit.push({time:new Date().toISOString(),actor:u.id,target:p.userId,action:'payment_'+p.status,reference:p.reference});save();return reply(res,200,{payment:safePayment(p)});
  }
  if(route==='/api/image/generate'&&!accessGuard(res,u))return;
  if(route==='/api/video/generate'&&!accessGuard(res,u))return;

  if(route==='/api/image/generate'){
    if(!imageReady())return fail(res,503,'Nano Banana no está conectado. El administrador debe configurar la API de Google y un presupuesto.');
    const prompt=String(body.prompt||'').trim(),style=String(body.style||''),aspect=String(body.aspect||'16:9');if(prompt.length<8||prompt.length>1700||!Object.hasOwn(STYLES,style)||!['16:9','9:16','1:1'].includes(aspect))return fail(res,400,'Revisa el texto, el estilo o el formato.');
    if(countToday(db.images)>=IMAGE_BUDGET)return fail(res,429,'Se agotó la capacidad de imágenes del estudio por hoy.');
    if(countToday(db.images,x=>x.userId===u.id)>=USER_IMAGE_DAILY_LIMIT)return fail(res,429,'Alcanzaste el límite de uso responsable de imágenes por hoy.');
    if(!rateLimit('image:'+u.id,3,900000))return fail(res,429,'Espera un poco antes de enviar más solicitudes.');
    const id=crypto.randomUUID();const createdAt=new Date().toISOString();const threadId=threadFor(u,body.threadId)?.id||null;
    // Reserve before external paid request to prevent concurrent overspending.
    db.images.push({id,userId:u.id,createdAt,style,aspect,threadId,prompt,mime:'',ext:'',status:'processing'});save();
    try{const result=await sendGemini(makeBrief(prompt,style)+'\nComposition/aspect ratio requested: '+aspect);const ext=result.mime==='image/png'?'png':result.mime==='image/webp'?'webp':'jpg';fs.writeFileSync(path.join(MEDIA_PATH,id+'.'+ext),result.buffer,{mode:0o600});const record=db.images.find(x=>x.id===id);Object.assign(record,{mime:result.mime,ext,status:'completed'});save();if(threadId)addThreadMessage(u,threadId,{kind:'creation',mediaType:'image',creationId:id});return reply(res,201,{item:safeImage(record)});}catch(e){db.images=db.images.filter(x=>x.id!==id);save();return fail(res,502,'No se creó la imagen: '+e.message);}
  }
  if(route==='/api/video/generate'){
    if(!videoReady())return fail(res,503,'El motor de video todavía no está conectado. Hay que configurar la API y el presupuesto del propietario.');
    const prompt=String(body.prompt||'').trim(),style=String(body.style||''),duration=Number(body.duration),aspect=String(body.aspect||'16:9');
    if(prompt.length<10||prompt.length>1700||!Object.hasOwn(STYLES,style)||!Number.isInteger(duration)||duration<4||duration>30||!['16:9','9:16','1:1'].includes(aspect))return fail(res,400,'El motor Seedance admite clips de 4 a 30 segundos. La edición de 1 a 3 s y 31 a 120 s aún no está disponible.');
    const generationMode=body.generationMode==='image'?'image':'text';
    const reference=generationMode==='image'?parseReferenceData(body.imageData):null;
    if(generationMode==='image'&&!reference)return fail(res,400,'Debes adjuntar una imagen JPG, PNG o WebP de hasta 4,5 MB.');
    const todayVideos=db.videos.filter(v=>v.createdAt.startsWith(utcDay())&&v.status!=='failed'&&v.status!=='canceled');
    if(todayVideos.reduce((n,j)=>n+j.duration,0)+duration>VIDEO_SECONDS_BUDGET)return fail(res,429,'Se agotó el presupuesto de videos de hoy.');
    if(todayVideos.filter(v=>v.userId===u.id).length>=USER_VIDEO_DAILY_LIMIT)return fail(res,429,'Alcanzaste el límite de uso responsable de videos por hoy.');
    if(db.videos.some(v=>v.userId===u.id&&['queued','submitting','in_progress'].includes(v.status)))return fail(res,409,'Ya tienes un video en generación.');
    if(!rateLimit('video:'+u.id,3,3600000))return fail(res,429,'Demasiadas generaciones consecutivas.');
    const threadId=threadFor(u,body.threadId)?.id||null;
    const video={id:crypto.randomUUID(),userId:u.id,createdAt:new Date().toISOString(),style,duration,aspect,threadId,prompt,generationMode,status:'submitting',remoteId:null,url:null,error:null};
    // Las referencias no se exponen mediante URL pública ni se almacenan localmente.
    db.videos.push(video);save();
    try{const endpoint=generationMode==='image'?VIDEO_MODEL+'/image-to-video':VIDEO_MODEL+'/text-to-video';
      const payload={prompt:makeBrief(prompt,style),duration,resolution:'720p',aspect_ratio:aspect,output_format:'mp4',generate_audio:body.sound===true};
      if(reference)payload.image_url=await uploadReferenceToHiggsfield(reference);
      const data=await higgsfield(endpoint,'POST',payload);const rid=data.request_id;if(typeof rid!=='string'||rid.length<5)throw Error('El proveedor no confirmó el trabajo.');video.remoteId=rid;video.status='queued';save();if(threadId)addThreadMessage(u,threadId,{kind:'creation',mediaType:'video',creationId:video.id});return reply(res,202,{item:safeVideo(video)});}catch(e){video.status='failed';video.error=e.message;save();return fail(res,502,'No se pudo confirmar la generación: '+e.message);}
  }
  if(route==='/api/video/cancel'){
    const v=db.videos.find(x=>x.id===String(body.videoId||'')&&x.userId===u.id);
    if(!v)return fail(res,404,'No encontramos este video.');
    if(!v.remoteId||!['queued','in_progress','canceling'].includes(v.status))return fail(res,409,'Este video ya no puede cancelarse.');
    if(!rateLimit('cancel:'+u.id,10,3600000))return fail(res,429,'Demasiados intentos de cancelación.');
    try{await higgsfield('requests/'+encodeURIComponent(v.remoteId)+'/cancel','POST',{});v.status='canceling';save();return reply(res,202,{item:safeVideo(v),message:'Cancelación solicitada al proveedor; pendiente de confirmación.'});}
    catch(e){return fail(res,502,'No se pudo confirmar la cancelación: '+e.message);}
  }
  if(route==='/api/admin/block'){
    if(u.role!=='admin')return fail(res,403,'Solo el administrador puede gestionar usuarios.');const target=db.users.find(x=>x.id===body.userId);if(!target||target.role==='admin'||typeof body.block!=='boolean')return fail(res,400,'Usuario o acción incorrecta.');target.blocked=body.block;db.audit.push({time:new Date().toISOString(),actor:u.id,target:target.id,action:body.block?'block':'unblock'});if(db.audit.length>800)db.audit.shift();save();return reply(res,200,{user:safeUser(target)});
  }
  return fail(res,404,'Ruta no disponible');
});
server.on('clientError',(error,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');});
server.listen(PORT,'0.0.0.0',()=>console.log(`NEON STUDIO gratis escuchando en puerto ${PORT}`));