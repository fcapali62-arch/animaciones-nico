'use strict';
/**
 * NEON STUDIO 3.0 — Free-for-visitors studio, with licensed third-party image/video AI.
 * No billing or payments routes. Production operation requires HTTPS, a persistent
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
  clay: 'Beautifully crafted claymation stop-motion, tiny tactile handmade materials, polished studio lighting, charming film art direction. No text.'
});
if (SECRET.length < 32) throw Error('SESSION_SECRET must be 32+ characters');
if ((ADMIN_EMAIL && ADMIN_PASSWORD.length < 14) || (ADMIN_PASSWORD && !ADMIN_EMAIL)) throw Error('ADMIN_EMAIL and ADMIN_PASSWORD (14+ chars) must be set together');
if (PRODUCTION && isReady() && (!process.env.SESSION_SECRET || !PERSISTENT_STORE)) throw Error('Paid AI API use in production requires SESSION_SECRET and PERSISTENT_STORE');
fs.mkdirSync(path.dirname(STATE_PATH), {recursive: true});
fs.mkdirSync(MEDIA_PATH, {recursive: true});
let db = {users:[],images:[],videos:[],audit:[]};
try {db = JSON.parse(fs.readFileSync(STATE_PATH,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e;}
for(const field of ['users','images','videos','audit']) if (!Array.isArray(db[field])) db[field]=[];
function save(){const tmp=STATE_PATH+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db),{mode:0o600});fs.renameSync(tmp,STATE_PATH);}
function hashPassword(p,salt=crypto.randomBytes(16).toString('hex')){return salt+':'+crypto.scryptSync(p,salt,64).toString('hex');}
function checkPassword(p,h){try{const [salt,bytes]=h.split(':');const b=Buffer.from(bytes,'hex');return crypto.timingSafeEqual(b,crypto.scryptSync(p,salt,b.length));}catch{return false;}}
if(ADMIN_EMAIL && ADMIN_PASSWORD && !db.users.some(u=>u.role==='admin')){
  db.users.push({id:crypto.randomUUID(),email:ADMIN_EMAIL,password:hashPassword(ADMIN_PASSWORD),role:'admin',blocked:false,createdAt:new Date().toISOString()});save();
}
const active = u => !!u && !u.blocked;
const safeUser = u => u ? {id:u.id,email:u.email,role:u.role,active:active(u),createdAt:u.createdAt}:null;
function cookie(u){const content=Buffer.from(JSON.stringify({id:u.id,exp:Date.now()+7*DAILY})).toString('base64url');return content+'.'+crypto.createHmac('sha256',SECRET).update(content).digest('base64url');}
function userFrom(req){try{const val=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ns3_session='))?.slice(12);if(!val)return null;const [raw,signature]=val.split('.');if(!raw||!signature)return null;const calculated=crypto.createHmac('sha256',SECRET).update(raw).digest();const provided=Buffer.from(signature,'base64url');if(provided.length!==calculated.length||!crypto.timingSafeEqual(provided,calculated))return null;const payload=JSON.parse(Buffer.from(raw,'base64url').toString());if(payload.exp<Date.now())return null;return db.users.find(u=>u.id===payload.id)||null;}catch{return null;}}
function setSession(u){return `ns3_session=${cookie(u)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${PRODUCTION?'; Secure':''}`;}
function reply(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',...headers});res.end(JSON.stringify(data));}
function fail(res,status,msg){reply(res,status,{error:msg});}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
function staticFile(res,urlPath){const normalized=urlPath==='/'?'index.html':urlPath.slice(1);if(!['index.html','style.css','app.js','assets/cinema.svg','assets/anime.svg','assets/fantasy.svg','assets/favicon.svg'].includes(normalized)){res.writeHead(404);res.end('No encontrado');return;}
 const file=path.join(root,normalized);res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'none'"});fs.createReadStream(file).pipe(res);
}
function readBody(req){return new Promise((resolve,reject)=>{let bytes=0;const chunks=[];req.on('data',chunk=>{bytes+=chunk.length;if(bytes>24576){reject(Error('Solicitud muy grande'));req.destroy();return;}chunks.push(chunk);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(Error('JSON inválido'));}});req.on('error',reject);});}
function sameOrigin(req){if(!req.headers.origin)return true;try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
const limiter=new Map();
function rateLimit(key,max,windowMs){const now=Date.now();const a=(limiter.get(key)||[]).filter(x=>x>now-windowMs);if(a.length>=max)return false;a.push(now);limiter.set(key,a);if(limiter.size>5000)limiter.clear();return true;}
function utcDay(){return new Date().toISOString().slice(0,10);}
function countToday(collection,pred=()=>true){const day=utcDay();return collection.filter(x=>x.createdAt?.startsWith(day)&&pred(x)).length;}
const makeBrief=(prompt,style)=>`${prompt}\nArt direction: ${STYLES[style]}\nPreserve intended appearance and spatial continuity; do not add captions, logos, or letters.`;
function safeImage(image){return {id:image.id,type:'image',style:image.style,createdAt:image.createdAt,status:'completed',url:'/api/images/'+image.id,aspect:image.aspect};}
function safeVideo(video){return {id:video.id,type:'video',style:video.style,duration:video.duration,createdAt:video.createdAt,status:video.status,url:video.status==='completed'?video.url:null,error:video.error||null};}
async function sendGemini(prompt){const url='https://generativelanguage.googleapis.com/v1beta/models/'+GEMINI_MODEL+':generateContent';const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':GEMINI_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:['TEXT','IMAGE']}}),signal:AbortSignal.timeout(105000)});const data=await response.json();if(!response.ok)throw Error(`API de imágenes: HTTP ${response.status}. Comprueba acceso y saldo de la API.`);const candidates=data.candidates||[];const parts=candidates.flatMap(c=>c.content?.parts||[]);const item=parts.find(p=>p.inlineData?.data&&/^image\/(png|jpeg|webp)$/.test(p.inlineData?.mimeType||''));if(!item)throw Error('La IA no devolvió una imagen válida.');const bytes=Buffer.from(item.inlineData.data,'base64');if(bytes.length<1000||bytes.length>17_000_000)throw Error('La imagen recibida tiene un tamaño no admitido.');return {buffer:bytes,mime:item.inlineData.mimeType};}
async function higgsfield(endpoint,method,body){const res=await fetch('https://api.higgsfield.ai/'+endpoint,{method,headers:{'Authorization':'Key '+HF_KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});let data={};try{data=await res.json();}catch{}if(!res.ok)throw Error(`API de video: HTTP ${res.status}; revisa credenciales, saldo y parámetros.`);return data;}
async function serveImage(res,id,u){const found=db.images.find(x=>x.id===id);if(!found||found.userId!==u?.id&&! (u?.role==='admin'))return fail(res,404,'Imagen no encontrada');const file=path.join(MEDIA_PATH,id+'.'+found.ext);if(!fs.existsSync(file))return fail(res,410,'La imagen ya no está guardada en el servidor.');res.writeHead(200,{'Content-Type':found.mime,'Content-Disposition':'inline; filename="neon-'+id+'.'+found.ext+'"','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});fs.createReadStream(file).pipe(res);}
const server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://local').pathname;
  const u=userFrom(req);
  if(req.method==='GET'&&!route.startsWith('/api/'))return staticFile(res,route);
  if(req.method==='GET'&&route==='/api/status')return reply(res,200,{ok:true,freeForVisitors:true,configured:imageReady()||videoReady(),imageReady:imageReady(),videoReady:videoReady(),storagePersistent:PERSISTENT_STORE,mode:PRODUCTION?'production':'development'});
  if(req.method==='GET'&&route==='/api/me')return reply(res,200,{user:safeUser(u),imageReady:imageReady(),videoReady:videoReady(),freeForVisitors:true});
  if(req.method==='GET'&&route.startsWith('/api/images/'))return serveImage(res,route.slice('/api/images/'.length),u);
  if(req.method==='GET'&&route==='/api/library'){
    if(!active(u))return fail(res,401,'Inicia sesión para ver tus creaciones.');
    return reply(res,200,{items:[...db.images.filter(x=>x.userId===u.id).map(safeImage),...db.videos.filter(x=>x.userId===u.id).map(safeVideo)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,80)});
  }
  if(req.method==='GET'&&route.startsWith('/api/video/status/')){
    if(!active(u))return fail(res,401,'Sesión requerida.');const video=db.videos.find(x=>x.id===route.slice(18)&&x.userId===u.id);if(!video)return fail(res,404,'No encontramos el video.');
    if(!['completed','failed','canceled','nsfw'].includes(video.status)&&video.remoteId){
      try{const data=await higgsfield('requests/'+encodeURIComponent(video.remoteId)+'/status','GET');const state=String(data.status||'').toLowerCase();if(['queued','in_progress','completed','failed','canceled','nsfw'].includes(state))video.status=state;
        if(video.status==='completed'){const link=data?.video?.url||data?.output?.video?.url||data?.output?.url;if(typeof link!=='string'||!link.startsWith('https://')){video.status='failed';video.error='El proveedor no entregó un video reproducible.';}else video.url=link;}
        if(['failed','canceled','nsfw'].includes(video.status))video.error='La IA no pudo completar la generación.';
        save();
      }catch{ /* Keep last known state and allow retry. */ }
    }
    return reply(res,200,{item:safeVideo(video)});
  }
  if(req.method==='GET'&&route==='/api/admin'){
    if(u?.role!=='admin')return fail(res,403,'Acceso exclusivo de administración.');
    return reply(res,200,{users:db.users.map(safeUser),stats:{users:db.users.length-1,totalImages:db.images.length,totalVideos:db.videos.length,imagesToday:countToday(db.images),videoSecondsToday:db.videos.filter(x=>x.createdAt?.startsWith(utcDay())&&x.status!=='failed').reduce((n,j)=>n+j.duration,0)},engine:{imageReady:imageReady(),videoReady:videoReady(),imageDailyBudget:IMAGE_BUDGET,videoSecondsDailyBudget:VIDEO_SECONDS_BUDGET,storagePersistent:PERSISTENT_STORE}});
  }
  if(req.method!=='POST'||!route.startsWith('/api/'))return fail(res,404,'Ruta no disponible');
  if(!sameOrigin(req))return fail(res,403,'Origen no autorizado');
  let body;try{body=await readBody(req);}catch(e){return fail(res,400,e.message);}
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
  if(!active(u))return fail(res,401,'Necesitas una cuenta activa para generar. El registro es gratuito.');
  if(route==='/api/image/generate'){
    if(!imageReady())return fail(res,503,'Nano Banana no está conectado. El administrador debe configurar la API de Google y un presupuesto.');
    const prompt=String(body.prompt||'').trim(),style=String(body.style||''),aspect=String(body.aspect||'16:9');if(prompt.length<8||prompt.length>1700||!Object.hasOwn(STYLES,style)||!['16:9','9:16','1:1'].includes(aspect))return fail(res,400,'Revisa el texto, el estilo o el formato.');
    if(countToday(db.images)>=IMAGE_BUDGET)return fail(res,429,'Se agotó la capacidad de imágenes del estudio por hoy.');
    if(countToday(db.images,x=>x.userId===u.id)>=USER_IMAGE_DAILY_LIMIT)return fail(res,429,'Alcanzaste el límite de uso responsable de imágenes por hoy.');
    if(!rateLimit('image:'+u.id,3,900000))return fail(res,429,'Espera un poco antes de enviar más solicitudes.');
    const id=crypto.randomUUID();const createdAt=new Date().toISOString();
    // Reserve before external paid request to prevent concurrent overspending.
    db.images.push({id,userId:u.id,createdAt,style,aspect,mime:'',ext:'',status:'processing'});save();
    try{const result=await sendGemini(makeBrief(prompt,style)+'\nComposition/aspect ratio requested: '+aspect);const ext=result.mime==='image/png'?'png':result.mime==='image/webp'?'webp':'jpg';fs.writeFileSync(path.join(MEDIA_PATH,id+'.'+ext),result.buffer,{mode:0o600});const record=db.images.find(x=>x.id===id);Object.assign(record,{mime:result.mime,ext,status:'completed'});save();return reply(res,201,{item:safeImage(record)});}catch(e){db.images=db.images.filter(x=>x.id!==id);save();return fail(res,502,'No se creó la imagen: '+e.message);}
  }
  if(route==='/api/video/generate'){
    if(!videoReady())return fail(res,503,'El motor de video todavía no está conectado. Hay que configurar la API y el presupuesto del propietario.');
    const prompt=String(body.prompt||'').trim(),style=String(body.style||''),duration=Number(body.duration),aspect=String(body.aspect||'16:9');
    if(prompt.length<10||prompt.length>1700||!Object.hasOwn(STYLES,style)||!Number.isInteger(duration)||duration<4||duration>30||!['16:9','9:16','1:1'].includes(aspect))return fail(res,400,'Verifica la descripción, el formato o la duración (4 a 30 segundos).');
    const todayVideos=db.videos.filter(v=>v.createdAt.startsWith(utcDay())&&v.status!=='failed'&&v.status!=='canceled');
    if(todayVideos.reduce((n,j)=>n+j.duration,0)+duration>VIDEO_SECONDS_BUDGET)return fail(res,429,'Se agotó el presupuesto de videos de hoy.');
    if(todayVideos.filter(v=>v.userId===u.id).length>=USER_VIDEO_DAILY_LIMIT)return fail(res,429,'Alcanzaste el límite de uso responsable de videos por hoy.');
    if(db.videos.some(v=>v.userId===u.id&&['queued','submitting','in_progress'].includes(v.status)))return fail(res,409,'Ya tienes un video en generación.');
    if(!rateLimit('video:'+u.id,3,3600000))return fail(res,429,'Demasiadas generaciones consecutivas.');
    const video={id:crypto.randomUUID(),userId:u.id,createdAt:new Date().toISOString(),style,duration,aspect,status:'submitting',remoteId:null,url:null,error:null};db.videos.push(video);save();
    try{const data=await higgsfield('bytedance/seedance-2.5/text-to-video','POST',{prompt:makeBrief(prompt,style),duration,resolution:'720p',aspect_ratio:aspect,output_format:'mp4',generate_audio:body.sound===true});const rid=data.request_id;if(typeof rid!=='string'||rid.length<5)throw Error('El proveedor no confirmó el trabajo.');video.remoteId=rid;video.status='queued';save();return reply(res,202,{item:safeVideo(video)});}catch(e){video.status='failed';video.error=e.message;save();return fail(res,502,'No se pudo confirmar la generación: '+e.message);}
  }
  if(route==='/api/admin/block'){
    if(u.role!=='admin')return fail(res,403,'Solo el administrador puede gestionar usuarios.');const target=db.users.find(x=>x.id===body.userId);if(!target||target.role==='admin'||typeof body.block!=='boolean')return fail(res,400,'Usuario o acción incorrecta.');target.blocked=body.block;db.audit.push({time:new Date().toISOString(),actor:u.id,target:target.id,action:body.block?'block':'unblock'});if(db.audit.length>800)db.audit.shift();save();return reply(res,200,{user:safeUser(target)});
  }
  return fail(res,404,'Ruta no disponible');
});
server.on('clientError',(error,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');});
server.listen(PORT,'0.0.0.0',()=>console.log(`NEON STUDIO gratis escuchando en puerto ${PORT}`));