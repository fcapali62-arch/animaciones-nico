'use strict';
// NEON STUDIO — membership prototype. Persistent SQL storage required for production.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const port = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PAYMENT_INSTRUCTIONS = (process.env.PAYMENT_INSTRUCTIONS || '').trim();
const DATA_FILE = process.env.DATA_FILE || '/tmp/neon-studio-demo.json';
const isDev = process.env.NODE_ENV !== 'production';
if (!SECRET || SECRET.length < 32 || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 14) {
  console.error('Missing SESSION_SECRET (min 32), ADMIN_EMAIL, or ADMIN_PASSWORD (min 14).');
  process.exit(1);
}
let db = {users: [], requests: []};
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { if (e.code !== 'ENOENT') console.error('Could not read data', e); }
if (!Array.isArray(db.users) || !Array.isArray(db.requests)) db = { users: [], requests: [] };
function persist() { const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db), {mode:0o600}); fs.renameSync(tmp, DATA_FILE); }
function hash(pw, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; }
function verify(pw, stored) { try { const [s,k]=stored.split(':'); const actual=crypto.scryptSync(pw,s,64); const prev=Buffer.from(k,'hex'); return actual.length===prev.length && crypto.timingSafeEqual(actual,prev); } catch {return false;} }
let administrator=db.users.find(u=>u.role==='admin');
if (!administrator) { administrator={id:crypto.randomUUID(),email:ADMIN_EMAIL,pw:hash(ADMIN_PASSWORD),role:'admin',free:true,expiresAt:null,createdAt:new Date().toISOString()};db.users.push(administrator);persist(); }
function token(user) { const body=Buffer.from(JSON.stringify({id:user.id,exp:Date.now()+7*86400e3})).toString('base64url');const sig=crypto.createHmac('sha256',SECRET).update(body).digest('base64url');return body+'.'+sig; }
function userFrom(req) { const cookie = (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ns_session=')); if (!cookie) return null; const [b,s]=cookie.slice(11).split('.'); if(!b||!s)return null;const expected=crypto.createHmac('sha256',SECRET).update(b).digest();const actual=Buffer.from(s,'base64url');if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;try{const p=JSON.parse(Buffer.from(b,'base64url').toString()); if(p.exp<Date.now())return null;return db.users.find(u=>u.id===p.id)||null;}catch{return null;} }
function active(u){return !!(u && (u.role==='admin' || u.free || (u.expiresAt && Date.parse(u.expiresAt)>Date.now())));}
function publicUser(u){return {id:u.id,email:u.email,role:u.role,free:!!u.free,expiresAt:u.expiresAt,active:active(u),createdAt:u.createdAt};}
function json(res,code,data,headers={}){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));}
function page(res,html){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'none'",'Referrer-Policy':'strict-origin-when-cross-origin'});res.end(fs.readFileSync(path.join(root,html),'utf8'));}
function cookie(value){return `ns_session=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`;}
function body(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>16384){reject(Error('Solicitud demasiado grande'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(Error('JSON incorrecto'));}});req.on('error',reject);});}
function fail(res,code,msg){json(res,code,{error:msg});}
const loginAttempts=new Map();
function tooMany(ip){const now=Date.now();let arr=loginAttempts.get(ip)||[];arr=arr.filter(n=>n>now-900000);loginAttempts.set(ip,arr);return arr.length>=20;}
function failed(ip){const a=loginAttempts.get(ip)||[];a.push(Date.now());loginAttempts.set(ip,a);}
function addMonth(d){const x=new Date(d),day=x.getUTCDate();x.setUTCDate(1);x.setUTCMonth(x.getUTCMonth()+1);const y=new Date(Date.UTC(x.getUTCFullYear(),x.getUTCMonth()+1,0)).getUTCDate();x.setUTCDate(Math.min(day,y));return x.toISOString();}
function originOk(req){ const origin=req.headers.origin;if(!origin)return true; const host=req.headers.host;try{return new URL(origin).host===host;}catch{return false;} }
http.createServer(async(req,res)=>{
  const route=new URL(req.url,'https://example.test').pathname;
  const user=userFrom(req);
  if(req.method==='GET' && route==='/'){return page(res,'index.html');}
  if(req.method==='GET' && route==='/health'){return json(res,200,{status:'ok',preview:true,storage:'ephemeral',payments:!!PAYMENT_INSTRUCTIONS});}
  if(req.method==='GET' && route==='/jugar'){if(!active(user)){res.writeHead(302,{Location:'/'});return res.end();}return page(res,'play.html');}
  if(req.method==='GET' && route==='/api/me')return json(res,200,{user:user?publicUser(user):null,paymentReady:!!PAYMENT_INSTRUCTIONS,price:10,currency:'PEN',term:'1 mes',aiVideoReady:false});
  if(!route.startsWith('/api/')){res.writeHead(404);return res.end('No encontrado');}
  if(req.method!=='POST')return fail(res,405,'Método no permitido');
  if(!originOk(req))return fail(res,403,'Origen no autorizado');
  let data;try{data=await body(req);}catch(e){return fail(res,400,e.message);}
  if(route==='/api/register'){
    const email=String(data.email||'').trim().toLowerCase(),pw=String(data.password||'');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>150||pw.length<10||pw.length>200)return fail(res,400,'Correo válido y clave de 10 a 200 caracteres.');
    if(db.users.some(u=>u.email===email))return fail(res,409,'Ese correo ya está registrado.');
    const u={id:crypto.randomUUID(),email,pw:hash(pw),role:'user',free:false,expiresAt:null,createdAt:new Date().toISOString()};db.users.push(u);persist();return json(res,201,{user:publicUser(u)},{'Set-Cookie':cookie(token(u))});
  }
  if(route==='/api/login'){
    const ip=req.socket.remoteAddress||'unknown';if(tooMany(ip))return fail(res,429,'Demasiados intentos.');
    const email=String(data.email||'').trim().toLowerCase(),pw=String(data.password||'');const u=db.users.find(x=>x.email===email);
    if(!u||!verify(pw,u.pw)){failed(ip);return fail(res,401,'Correo o contraseña incorrectos.');}
    return json(res,200,{user:publicUser(u)},{'Set-Cookie':cookie(token(u))});
  }
  if(route==='/api/logout')return json(res,200,{ok:true},{'Set-Cookie':'ns_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'});
  if(!user)return fail(res,401,'Inicia sesión.');
  if(route==='/api/payment-request'){
    if(!PAYMENT_INSTRUCTIONS)return fail(res,503,'Aún no está configurado el destino de los pagos. No hagas transferencias.');
    const ref=String(data.reference||'').trim().slice(0,120),method=String(data.method||'').trim().slice(0,30);
    if(ref.length<5||!['Yape','Plin','Transferencia'].includes(method))return fail(res,400,'Indica método y código de operación.');
    if(db.requests.some(p=>p.userId===user.id&&p.reference===ref))return fail(res,409,'Ya registraste ese código.');
    const p={id:crypto.randomUUID(),userId:user.id,method,reference:ref,status:'pendiente',createdAt:new Date().toISOString()};db.requests.push(p);persist();return json(res,201,{ok:true,message:'Solicitud pendiente de verificación. No implica pago aprobado.'});
  }
  if(route==='/api/admin/list'){
    if(user.role!=='admin')return fail(res,403,'Solo administrador.');
    return json(res,200,{users:db.users.map(publicUser),requests:db.requests.map(p=>({...p,email:db.users.find(u=>u.id===p.userId)?.email||''})),paymentInstructions:PAYMENT_INSTRUCTIONS});
  }
  if(route==='/api/admin/grant'){
    if(user.role!=='admin')return fail(res,403,'Solo administrador.');
    const u=db.users.find(x=>x.id===data.userId);if(!u||u.role==='admin')return fail(res,404,'Usuario inválido.');
    u.free=data.free===true;persist();return json(res,200,{user:publicUser(u)});
  }
  if(route==='/api/admin/payment'){
    if(user.role!=='admin')return fail(res,403,'Solo administrador.');
    const p=db.requests.find(x=>x.id===data.requestId),u=p&&db.users.find(x=>x.id===p.userId);
    if(!p||!u||p.status!=='pendiente')return fail(res,404,'Solicitud no encontrada o ya revisada.');
    if(!['aprobar','rechazar'].includes(data.action))return fail(res,400,'Acción inválida.');
    p.status=data.action==='aprobar'?'aprobado':'rechazado';p.reviewedAt=new Date().toISOString();p.reviewedBy=user.id;
    if(p.status==='aprobado')u.expiresAt=addMonth(u.expiresAt&&Date.parse(u.expiresAt)>Date.now()?u.expiresAt:new Date());
    persist();return json(res,200,{ok:true,user:publicUser(u)});
  }
  return fail(res,404,'No encontrado');
}).listen(port,'0.0.0.0',()=>console.log(`NEON STUDIO demo on port ${port}`));