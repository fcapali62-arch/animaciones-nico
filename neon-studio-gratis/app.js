'use strict';
(()=>{
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const state={user:null,me:null,page:'create',mode:'video',authMode:'register',currentJob:null,jobTimer:null,busy:false,adminData:null};
  const tabs={create:'Crear con IA',library:'Mis creaciones',ideas:'Explorar ideas',admin:'Administración'};
  const examples={
    elephant:{style:'cinematic',prompt:'Un elefante gigantesco y majestuoso vuela entre las nubes usando sus enormes orejas como alas. Al fondo se levantan montañas flotantes y un sol naranja sobre el horizonte. La cámara asciende lentamente alrededor del elefante, mostrando su vuelo con gran realismo cinematográfico; viento, luz dorada y nubes volumétricas.'},
    dino:{style:'realistic',prompt:'Un explorador corre desesperadamente por una selva tropical bajo una intensa lluvia, mientras un enorme tiranosaurio lo persigue entre árboles y lianas. Plano cinematográfico con cámara en movimiento, reflejos realistas en el suelo y un ambiente de aventura espectacular.'},
    anime:{style:'anime',prompt:'Una joven aventurera con abrigo rojo salta entre los tejados de una ciudad japonesa futurista al atardecer. Las luces de neón se reflejan en la lluvia, el cabello se mueve con el viento, y una cámara fluida sigue su recorrido en un estilo de anime de alta calidad.'}
  };
  let toastTimer=0;
  function status(text,kind=''){
    const node=$('#generateStatus');node.textContent=text;node.className='notice '+kind;
  }
  function htmlEscape(t){return String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function when(x){if(!x)return '—';try{return new Date(x).toLocaleString('es-PE',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return '—';}}
  async function api(path,body=undefined){
    const r=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    let v;try{v=await r.json()}catch{throw Error('No se obtuvo una respuesta válida del servidor.');}
    if(!r.ok)throw Error(v.error||'No fue posible completar esta operación.');return v;
  }
  function switchPage(page){
    if(!Object.hasOwn(tabs,page))page='create';state.page=page;
    $$('.page').forEach(x=>x.classList.toggle('hidden',x.id!=='page-'+page));
    $$('[data-nav]').forEach(x=>x.classList.toggle('selected',x.dataset.nav===page));
    $('#crumb').textContent=tabs[page];$('#sidebar').classList.remove('open');
    if(page==='library')loadLibrary(); if(page==='admin')loadAdmin();
    window.scrollTo({top:0,behavior:'instant'});
  }
  $$('[data-nav]').forEach(x=>x.addEventListener('click',()=>switchPage(x.dataset.nav)));
  $('#toggleMenu').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
  $('#seeLibrary').addEventListener('click',()=>switchPage('library'));
  function switchMode(mode){
    state.mode=mode;$$('[data-mode]').forEach(x=>{const on=x.dataset.mode===mode;x.classList.toggle('current',on);x.setAttribute('aria-selected',on?'true':'false');});
    $('#videoOptions').classList.toggle('hidden',mode==='image');
    $('#engineDetail').textContent=mode==='video'?'Motor de video: Seedance 2.5, mediante API autorizada':'Motor de imagen: Nano Banana de Google, mediante API autorizada';
    $('#generateLabel').textContent=mode==='video'?'Crear video con IA':'Crear imagen con IA';
    $('#previewLabel').textContent=mode==='video'?'Aquí aparecerá el video real cuando el motor de IA termine.':'Aquí aparecerá la imagen real cuando el motor de IA termine.';
    $('#resultIllustration').src=mode==='video'?'/assets/cinema.svg':'/assets/fantasy.svg';
    status('El resultado se obtendrá de un modelo real. Las ilustraciones son solo referencias.');
  }
  $$('[data-mode]').forEach(x=>x.addEventListener('click',()=>switchMode(x.dataset.mode)));
  $('#duration').addEventListener('input',()=>{$('#durationLabel').textContent=$('#duration').value+' segundos'});
  $('#prompt').addEventListener('input',()=>{$('#charCount').textContent=$('#prompt').value.length+' / 1700'});
  function useExample(key){const x=examples[key];if(!x)return;$('#prompt').value=x.prompt;$('#style').value=x.style;$('#charCount').textContent=x.prompt.length+' / 1700';switchPage('create');$('#prompt').focus();status('Idea de ejemplo cargada. El resultado aún no ha sido generado.');}
  $('#examplePrompt').addEventListener('click',()=>useExample('elephant'));
  $$('[data-example]').forEach(x=>x.addEventListener('click',()=>useExample(x.dataset.example)));
  function updateIdentity(){
    const u=state.user;const initials=u?.email?.slice(0,1).toUpperCase()||'N';
    $('#profileInitial').textContent=initials;$('#profileName').textContent=u?.email?.split('@')[0]||'Invitado';
    $('#profileSub').textContent=u?.role==='admin'?'Administrador':u?'Cuenta gratuita':'Iniciar sesión';
    $('#topAccount').textContent=initials;$('#adminTiny').textContent=u?.role==='admin'?'Activo':'Privado';
    const on=!!(state.me?.imageReady||state.me?.videoReady);$('#serverStatus').classList.toggle('ready',on);
    $('#serverText').textContent=on?'Motor IA disponible':'Motor IA por conectar';
    $('#adminGateNote').textContent=u?.role==='admin'?'Acceso habilitado':u?'Tu cuenta no tiene permisos de administración.':'Para entrar se requiere la cuenta del propietario.';
  }
  async function refreshSession(){try{state.me=await api('/api/me');state.user=state.me.user;updateIdentity();return true}catch(e){status('No se pudo consultar el servidor: '+e.message,'error');return false;}}
  function openAuth(mode){state.authMode=mode||(state.user?'login':'register');const signed=!!state.user;
    $('#authOverlay').classList.remove('hidden');$('#authForm').classList.toggle('hidden',signed);$('#logout').classList.toggle('hidden',!signed);
    $('#authTitle').textContent=signed?'Tu cuenta':state.authMode==='register'?'Crea tu cuenta gratuita':'Iniciar sesión';
    $('#authSubtitle').textContent=signed?(state.user.email+' · acceso gratuito'):state.authMode==='register'?'Registro de prueba. Usa una contraseña exclusiva para NEON STUDIO. No debes pagar.':'Accede a tus creaciones o a tu administración.';
    $('#authButton').textContent=state.authMode==='register'?'Crear cuenta gratis':'Iniciar sesión';
    $('#switchAuth').classList.toggle('hidden',signed);$('#switchAuth').textContent=state.authMode==='register'?'¿Ya tienes una cuenta? Inicia sesión':'¿No tienes cuenta? Regístrate gratis';
    $('#authPassword').autocomplete=state.authMode==='register'?'new-password':'current-password';
    $('#authStatus').textContent='';
  }
  ['sidebarAccount','topAccount','mobileAccount','adminLogin'].forEach(id=>$('#'+id)?.addEventListener('click',()=>openAuth(id==='adminLogin'?'login':undefined)));
  $('#closeAuth').addEventListener('click',()=>$('#authOverlay').classList.add('hidden'));
  $('#authOverlay').addEventListener('click',e=>{if(e.target.id==='authOverlay')$('#authOverlay').classList.add('hidden')});
  $('#switchAuth').addEventListener('click',()=>openAuth(state.authMode==='register'?'login':'register'));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('#authOverlay').classList.add('hidden');$('#sidebar').classList.remove('open');}});
  $('#authForm').addEventListener('submit',async e=>{e.preventDefault();const btn=$('#authButton');btn.disabled=true;$('#authStatus').textContent='Procesando...';
    try{const result=await api(state.authMode==='register'?'/api/register':'/api/login',{email:$('#authEmail').value.trim(),password:$('#authPassword').value});
      state.user=result.user;await refreshSession();$('#authOverlay').classList.add('hidden');$('#authPassword').value='';
      status('Sesión iniciada. No se requiere pago.','success');if(state.page==='admin')loadAdmin();
    }catch(err){$('#authStatus').textContent=err.message;$('#authStatus').className='notice error';}finally{btn.disabled=false;}
  });
  $('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{})}catch{}$('#authOverlay').classList.add('hidden');state.user=null;await refreshSession();switchPage('create');status('Sesión cerrada.');});
  $('#serverStatus').addEventListener('click',async()=>{try{const s=await api('/api/status');status(s.configured?'El motor de IA está disponible según la configuración del servidor.':'Versión de prueba: falta configurar una clave API, presupuesto y almacenamiento permanente. Ninguna solicitud consumirá créditos.',''+(s.configured?'success':'waiting'));}catch(e){status(e.message,'error');}switchPage('create');});
  const terminal=new Set(['completed','failed','canceled','nsfw']);
  function stopPolling(){if(state.jobTimer){clearTimeout(state.jobTimer);state.jobTimer=null;}}
  function clearResult(){
    $('#resultVideo').pause();$('#resultVideo').removeAttribute('src');$('#resultVideo').load();
    $('#resultVideo').classList.add('hidden');$('#resultImage').removeAttribute('src');$('#resultImage').classList.add('hidden');
    $('#download').classList.add('hidden');$('#resultIllustration').classList.remove('hidden');$('#resultEmpty').classList.remove('hidden');
  }
  function showResult(item){
    if(!item)return;state.currentJob=item;
    const labels={completed:'Terminado',queued:'En cola',submitting:'Enviando',in_progress:'Generando',failed:'Error',canceled:'Cancelado',nsfw:'No disponible'};
    $('#resultBadge').textContent=labels[item.status]||'Pendiente';
    clearResult();
    if(item.status==='completed' && item.url){
      if(item.type==='image'){$('#resultImage').src=item.url;$('#resultImage').classList.remove('hidden');}
      else if(/^https:\/\//.test(item.url)){$('#resultVideo').src=item.url;$('#resultVideo').classList.remove('hidden');}
      $('#resultIllustration').classList.add('hidden');$('#resultEmpty').classList.add('hidden');
      $('#download').href=item.url;$('#download').download=item.type==='image'?'imagen-neon-studio.png':'video-neon-studio.mp4';$('#download').classList.remove('hidden');
      $('#resultDescription').textContent=(item.type==='video'?'Video':'Imagen')+' recibido del modelo de inteligencia artificial. '+(item.duration?item.duration+' segundos solicitados.':'');
      status('Tu creación está lista. Puedes reproducirla o descargarla.','success');
    }else if(['queued','submitting','in_progress'].includes(item.status)){
      $('#resultDescription').textContent='El motor externo está procesando tu solicitud. Esta imagen es solo una referencia visual.';
      status('Tu video está en proceso. El estudio consultará automáticamente el resultado.','waiting');
    }else{
      $('#resultDescription').textContent='No se obtuvo un video. Esta ilustración no representa una generación.';
      status(item.error||'La solicitud no se completó.','error');
    }
  }
  async function poll(){stopPolling();const item=state.currentJob;if(!item||item.type!=='video'||terminal.has(item.status))return;
    try{const data=await api('/api/video/status/'+encodeURIComponent(item.id));showResult(data.item);if(!terminal.has(data.item.status))state.jobTimer=setTimeout(poll,6500);else loadLibrary();}
    catch(err){status('La generación puede seguir en proceso; no se pudo consultar su estado: '+err.message,'error');state.jobTimer=setTimeout(poll,14000);}
  }
  $('#generate').addEventListener('click',async()=>{
    if(state.busy)return;
    const prompt=$('#prompt').value.trim(),style=$('#style').value,aspect=$('#aspect').value,duration=Number($('#duration').value);
    if(prompt.length<10){status('Describe tu escena con al menos 10 caracteres.','error');$('#prompt').focus();return;}
    if(!state.user){openAuth('register');status('Crea una cuenta gratuita para guardar tus resultados.','waiting');return;}
    if(!state.user.active){status('Esta cuenta no tiene acceso. Solicita revisión al administrador.','error');return;}
    const ready=state.mode==='video'?state.me?.videoReady:state.me?.imageReady;
    if(!ready){status('Motor '+(state.mode==='video'?'de videos Seedance':'de imágenes Nano Banana')+' pendiente de activación. Esta versión de prueba no enviará peticiones falsas.','error');return;}
    state.busy=true;const btn=$('#generate');btn.disabled=true;$('#generateLabel').textContent='Enviando solicitud...';
    try{const endpoint=state.mode==='video'?'/api/video/generate':'/api/image/generate';
      const data=await api(endpoint,{prompt,style,aspect,duration,sound:$('#sound').checked});
      showResult(data.item);if(data.item.type==='video'&&!terminal.has(data.item.status))state.jobTimer=setTimeout(poll,3000);
    }catch(err){status(err.message,'error');}finally{state.busy=false;btn.disabled=false;$('#generateLabel').textContent=state.mode==='video'?'Crear video con IA':'Crear imagen con IA';}
  });
  function card(item){const node=document.createElement('article');node.className='library-card';
    if(item.type==='image'&&item.status==='completed'&&item.url){const im=document.createElement('img');im.src=item.url;im.alt='Imagen real generada';node.append(im);}
    else {const im=document.createElement('img');im.src=item.type==='video'?'/assets/cinema.svg':'/assets/fantasy.svg';im.alt='Imagen de referencia, no generación real';node.append(im);}
    const title=document.createElement('strong');title.textContent=(item.type==='video'?'Video · ':'Imagen · ')+(item.style||'');node.append(title);
    const details=document.createElement('small');details.textContent=(item.duration?item.duration+' segundos · ':'')+when(item.createdAt)+' · '+item.status;node.append(details);
    const btn=document.createElement('button');btn.className='outline-action';btn.type='button';btn.textContent=item.status==='completed'?'Ver resultado':'Consultar estado';btn.onclick=()=>{switchMode(item.type);switchPage('create');showResult(item);if(item.type==='video'&&!terminal.has(item.status))poll();};node.append(btn);return node;
  }
  async function loadLibrary(){const el=$('#libraryList');el.innerHTML='';
    if(!state.user){el.innerHTML='<div class="empty-card">Inicia sesión para consultar tus creaciones.</div>';return;}
    el.innerHTML='<div class="empty-card">Consultando historial...</div>';
    try{const data=await api('/api/library');el.innerHTML='';if(!data.items.length){el.innerHTML='<div class="empty-card">Todavía no hay resultados. Cuando conectemos los motores, tus creaciones aparecerán aquí.</div>';return;}
      data.items.forEach(x=>el.append(card(x)));
    }catch(e){el.textContent=e.message;}
  }
  $('#refreshLibrary').addEventListener('click',loadLibrary);
  function tech(title,value){const c=document.createElement('div');c.className='tech';const a=document.createElement('strong');a.textContent=title;const b=document.createElement('span');b.textContent=value;c.append(a,b);return c;}
  function renderAdminUsers(){const tbody=$('#adminUsers');tbody.innerHTML='';const all=state.adminData?.users||[];const q=$('#userSearch').value.trim().toLowerCase();const users=all.filter(x=>x.email.toLowerCase().includes(q));
    if(!users.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=4;td.textContent='No se encontraron usuarios.';tr.append(td);tbody.append(tr);return;}
    for(const u of users){const tr=document.createElement('tr');
      for (const t of [u.email,u.role==='admin'?'Administrador':'Gratis',u.blocked?'Suspendido':'Activo']){const td=document.createElement('td');td.textContent=t;tr.append(td);}
      const action=document.createElement('td');if(u.role!=='admin'){const btn=document.createElement('button');btn.className='outline-action';btn.textContent=u.blocked?'Rehabilitar':'Suspender';btn.addEventListener('click',async()=>{if(!confirm('¿'+(u.blocked?'Rehabilitar':'Suspender')+' la cuenta '+u.email+'?'))return;btn.disabled=true;try{await api('/api/admin/block',{userId:u.id,block:!u.blocked});$('#adminMessage').textContent='Permiso actualizado.';loadAdmin();}catch(e){$('#adminMessage').textContent=e.message;btn.disabled=false;}});action.append(btn);}else action.textContent='Propietario';tr.append(action);tbody.append(tr);
    }
  }
  async function loadAdmin(){const isAdmin=state.user?.role==='admin';$('#adminGate').classList.toggle('hidden',isAdmin);$('#adminContent').classList.toggle('hidden',!isAdmin);if(!isAdmin)return;
    try{const d=await api('/api/admin');state.adminData=d;$('#metricUsers').textContent=d.stats.users;$('#metricImages').textContent=d.stats.totalImages;$('#metricVideos').textContent=d.stats.totalVideos;$('#metricSeconds').textContent=d.stats.videoSecondsToday+' s';
      const grid=$('#engineSettings');grid.innerHTML='';grid.append(tech('Motor de imágenes',d.engine.imageReady?'Conectado':'Falta API'),tech('Motor de videos',d.engine.videoReady?'Conectado':'Falta API'),tech('Presupuesto imágenes/día',String(d.engine.imageDailyBudget)),tech('Presupuesto video/día',d.engine.videoSecondsDailyBudget+' s'),tech('Base de datos duradera',d.engine.storagePersistent?'Configurada':'Temporal de prueba'));
      $('#adminMessage').textContent='Administración privada activa. No existen pagos ni suscripciones.';renderAdminUsers();
    }catch(e){$('#adminMessage').textContent='Error de administración: '+e.message;}
  }
  $('#userSearch').addEventListener('input',renderAdminUsers);$('#refreshAdmin').addEventListener('click',loadAdmin);
  async function init(){switchPage('create');switchMode('video');await refreshSession();try{const s=await api('/api/status');if(!s.configured){status('Estudio de prueba publicado. El motor real se activará cuando el propietario configure las claves API y el presupuesto. No se generan videos falsos.','waiting');}}
    catch(err){status('El servidor no responde: '+err.message,'error');}
  }
  init();
})();