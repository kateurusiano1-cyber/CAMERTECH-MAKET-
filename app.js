// ===== CONFIG =====
const SUPABASE_URL = "https://czrxdtacgbaccdsctle.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6cnhkdGFjZ2JhY2Nkc2N0bHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MDcyNzEsImV4cCI6MjA5NzE4MzI3MX0.0pXS9iPbRqN9_7bqKogEZLgHlaLHcA-d1MuX-FTyXCU";
const BUCKET = "images";
const WA1 = "237699781160";
const ADMINS = [
  {id:"EVAR_ADMIN_1",mdp:"Ev@r2025#Cm1",wa:"237699781160"},
  {id:"EVAR_ADMIN_2",mdp:"C@mTech#753!",wa:"237653756167"},
  {id:"EVAR_ADMIN_3",mdp:"M@rket#670Xt",wa:"237670554637"}
];
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== ÉTAT =====
let user=null, isAdmin=false, currentAdmin=null;
let allProds=[], panier=[], curProd=null;
let cat="tous", zone="", frais=0;
let selFile=null, editId=null, selNote=0, avisFile=null;
let slideIdx=0, slideTimer=null, payMethod="mtn";
let slides=[];

// ===== UTILITAIRES =====
const $=id=>document.getElementById(id);
const fmt=n=>parseInt(n).toLocaleString('fr-FR');
const isNew=d=>(new Date()-new Date(d))<7*24*60*60*1000;
const getPrix=p=>p.promo_active&&p.promo_prix?p.promo_prix:p.resale_price;
const stars=n=>'★'.repeat(Math.round(n))+'☆'.repeat(5-Math.round(n));

function showModal(id){$(id).style.display='flex'; document.body.style.overflow='hidden';}
function hideModal(id){$(id).style.display='none'; document.body.style.overflow='';}
window.showModal=showModal; window.hideModal=hideModal;

// ===== INIT =====
document.addEventListener('DOMContentLoaded',()=>{
  // Sidebar
  $('hamburger-btn').addEventListener('click', openSidebar);
  $('sidebar-close-btn').addEventListener('click', closeSidebar);
  $('sidebar-overlay').addEventListener('click', closeSidebar);

  // Auth
  $('btn-connexion').addEventListener('click',()=>showModal('auth-overlay'));

  // Slider
  $('slide-prev').addEventListener('click', prevSlide);
  $('slide-next').addEventListener('click', nextSlide);

  // Search
  $('search-input').addEventListener('input', e=>{
    const q=e.target.value.toLowerCase().trim();
    renderProds(q?allProds.filter(p=>p.name.toLowerCase().includes(q)||(p.description||'').toLowerCase().includes(q)):allProds);
  });

  // Theme
  const t=localStorage.getItem('cmkt_theme')||'light';
  document.documentElement.setAttribute('data-theme',t);
  $('theme-chk').checked=t==='dark';

  // Session
  try{const s=localStorage.getItem('cmkt_user'); if(s){user=JSON.parse(s); showUserUI();}}catch(e){localStorage.removeItem('cmkt_user');}

  // Admin check
  const path=window.location.pathname.split('/').pop().replace('.html','');
  if(path==='admin-cmr2025'){showAdminLogin(); return;}

  // Fermer modals sur overlay click
  document.querySelectorAll('.overlay').forEach(o=>{
    o.addEventListener('click',e=>{if(e.target===o){o.style.display='none'; document.body.style.overflow='';}});
  });

  // Escape key
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape') document.querySelectorAll('.overlay').forEach(o=>{o.style.display='none'; document.body.style.overflow='';});
  });

  fetchProds();
  loadBanniere();
  if(!sessionStorage.getItem('popup_done')){setTimeout(loadPopup,1800); sessionStorage.setItem('popup_done','1');}
});

// ===== SIDEBAR =====
function openSidebar(){$('sidebar').classList.add('open'); $('sidebar-overlay').classList.add('show');}
function closeSidebar(){$('sidebar').classList.remove('open'); $('sidebar-overlay').classList.remove('show');}
window.closeSidebar=closeSidebar;
window.scrollTo2=id=>{$(id)&&$(id).scrollIntoView({behavior:'smooth'});};
window.scrollTo=id=>{$(id)&&$(id).scrollIntoView({behavior:'smooth'});};

// ===== THEME & LANGUE =====
window.toggleTheme=()=>{
  const t=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('cmkt_theme',t);
};
window.setLang=(lang)=>{
  $('btn-fr').classList.toggle('active',lang==='fr');
  $('btn-en').classList.toggle('active',lang==='en');
  localStorage.setItem('cmkt_lang',lang);
};

// ===== BANNIÈRE =====
async function loadBanniere(){
  const{data}=await db.from('bannières').select('*').eq('actif',true).eq('type','banniere');
  if(!data?.length)return;
  const txt=data.map(b=>'📢 '+b.message).join('   •   ');
  $('banniere-txt').textContent=txt+'   •   '+txt;
  $('banniere-bar').style.display='block';
}

// ===== POPUP =====
async function loadPopup(){
  const{data:msgs}=await db.from('bannières').select('*').eq('actif',true).eq('type','popup');
  const{data:flash}=await db.from('products').select('*').eq('flash_active',true).limit(4);
  if(!msgs?.length&&!flash?.length)return;
  const msg=msgs?.[0]?.message||'🎉 Bienvenue sur CAMERTECH MARKET !';
  const pHtml=flash?.length?`<p style="font-weight:700;color:var(--or);margin:12px 0 8px">⚡ Ventes Flash</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
    ${flash.map(p=>`<div onclick="document.querySelector('.overlay').style.display='none';openProd('${p.id}')" style="background:var(--bg);border:1px solid var(--bdr);border-radius:8px;padding:9px;cursor:pointer;text-align:center">
      ${p.image_url?`<img src="${p.image_url}" style="width:100%;height:55px;object-fit:cover;border-radius:6px;margin-bottom:5px">`:'📦<br>'}
      <div style="font-size:.72rem;font-weight:600">${p.name}</div>
      <div style="font-size:.75rem;color:var(--or);font-weight:700">${fmt(getPrix(p))} F</div>
    </div>`).join('')}
    </div>`:'';
  const el=document.createElement('div');
  el.className='overlay'; el.style.cssText='display:flex';
  el.innerHTML=`<div class="modal" style="padding:26px;text-align:center;max-width:400px">
    <img src="logo.png" style="height:55px;width:55px;border-radius:50%;margin-bottom:10px">
    <h2 style="font-family:Poppins,sans-serif;color:var(--g);margin-bottom:8px">CAMERTECH MARKET</h2>
    <p style="color:var(--txt2);line-height:1.6;margin-bottom:12px">${msg}</p>
    ${pHtml}
    <button class="btn-green" onclick="this.closest('.overlay').remove()">Explorer →</button>
  </div>`;
  document.body.appendChild(el);
  el.addEventListener('click',e=>{if(e.target===el)el.remove();});
}

// ===== SLIDER =====
async function initSlider(){
  const{data}=await db.from('bannières').select('*').eq('type','slider').eq('actif',true);
  slides=data&&data.length>0?data:[];
  const track=$('slider-track');
  const dots=$('slide-dots');
  track.innerHTML=''; dots.innerHTML='';

  if(!slides.length){
    track.innerHTML=`<div class="slide slide-default" style="min-width:100%"><div class="slide-inner">
      <span class="slide-tag">🔥 OFFRE SPÉCIALE</span>
      <h2>Les meilleurs produits<br><em>Tech au Cameroun</em></h2>
      <p>Livraison rapide à Douala • Qualité garantie</p>
      <button class="slide-cta" onclick="document.getElementById('produits').scrollIntoView({behavior:'smooth'})">Découvrir →</button>
    </div></div>`;
    return;
  }

  slides.forEach((s,i)=>{
    const div=document.createElement('div');
    div.className='slide'; div.style.minWidth='100%';
    if(s.image_url){
      div.style.backgroundImage=`url(${s.image_url})`;
      div.style.backgroundSize='cover';
      div.style.backgroundPosition='center';
      div.innerHTML=`<div class="slide-inner" style="background:linear-gradient(90deg,rgba(0,0,0,.6),transparent)">
        <span class="slide-tag">${s.tag||'🔥 PROMOTION'}</span>
        <h2>${s.titre||'Offre Spéciale'}<br><em>${s.sous_titre||''}</em></h2>
        <p>${s.message||''}</p>
        ${s.btn_texte?`<button class="slide-cta">${s.btn_texte}</button>`:''}
      </div>`;
    } else {
      div.className='slide slide-default'; div.style.minWidth='100%';
      div.innerHTML=`<div class="slide-inner">
        <span class="slide-tag">${s.tag||'🔥 PROMOTION'}</span>
        <h2>${s.titre||'Offre Spéciale'}<br><em>${s.sous_titre||''}</em></h2>
        <p>${s.message||''}</p>
      </div>`;
    }
    track.appendChild(div);
    const dot=document.createElement('button');
    dot.className='slide-dot'+(i===0?' active':'');
    dot.onclick=()=>goSlide(i);
    dots.appendChild(dot);
  });

  if(slideTimer)clearInterval(slideTimer);
  if(slides.length>1)slideTimer=setInterval(()=>goSlide((slideIdx+1)%slides.length),4500);
}

function goSlide(i){
  slideIdx=i;
  $('slider-track').style.transform=`translateX(-${i*100}%)`;
  document.querySelectorAll('.slide-dot').forEach((d,j)=>d.classList.toggle('active',j===i));
}
window.prevSlide=()=>goSlide((slideIdx-1+Math.max(slides.length,1))%Math.max(slides.length,1));
window.nextSlide=()=>goSlide((slideIdx+1)%Math.max(slides.length,1));

// ===== AUTH =====
window.switchAuthTab=(tab)=>{
  $('atab-login').classList.toggle('active',tab==='login');
  $('atab-reg').classList.toggle('active',tab==='register');
  $('auth-login').style.display=tab==='login'?'block':'none';
  $('auth-register').style.display=tab==='register'?'block':'none';
};

window.login=async()=>{
  const tel=$('l-tel').value.trim(), mdp=$('l-mdp').value.trim(), err=$('l-err');
  if(tel.length!==9){err.textContent='❌ Numéro invalide (9 chiffres)';return;}
  if(!mdp){err.textContent='❌ Mot de passe requis';return;}
  err.textContent='';
  const{data,error}=await db.from('utilisateurs').select('*').eq('telephone',tel).eq('mot_de_passe',mdp).single();
  if(error||!data){err.textContent='❌ Numéro ou mot de passe incorrect';return;}
  user=data; localStorage.setItem('cmkt_user',JSON.stringify(data));
  showUserUI(); hideModal('auth-overlay');
};

window.register=async()=>{
  const nom=$('r-nom').value.trim(), tel=$('r-tel').value.trim();
  const email=$('r-email').value.trim(), mdp=$('r-mdp').value.trim();
  const mdp2=$('r-mdp2').value.trim(), err=$('r-err');
  if(!nom){err.textContent='❌ Nom obligatoire';return;}
  if(tel.length!==9){err.textContent='❌ Numéro invalide (9 chiffres)';return;}
  if(mdp.length<6){err.textContent='❌ Mot de passe trop court (6 min)';return;}
  if(mdp!==mdp2){err.textContent='❌ Mots de passe différents';return;}
  err.textContent='';
  const{data,error}=await db.from('utilisateurs').insert([{nom,telephone:tel,email:email||null,mot_de_passe:mdp}]).select().single();
  if(error){err.textContent=error.message.includes('unique')?'❌ Ce numéro existe déjà':'❌ '+error.message;return;}
  user=data; localStorage.setItem('cmkt_user',JSON.stringify(data));
  showUserUI(); hideModal('auth-overlay');
};

function showUserUI(){
  $('user-name-display').textContent='👤 '+user.nom.split(' ')[0];
  $('user-info').style.display='flex';
  $('btn-connexion').style.display='none';
  renderProds(allProds);
}

window.deconnecter=()=>{
  user=null; localStorage.removeItem('cmkt_user');
  $('user-info').style.display='none';
  $('btn-connexion').style.display='block';
  panier=[]; updatePanierBtn();
  renderProds(allProds);
};

// ===== PRODUITS =====
async function fetchProds(){
  try{
    const{data,error}=await db.from('products').select('*').order('created_at',{ascending:false});
    if(error)throw error;
    allProds=data||[];
    renderProds(allProds);
    loadFlash(allProds);
    initSlider();
  }catch(e){console.error(e); renderProds([]);}
  finally{$('loader').style.display='none';}
}

function renderProds(prods){
  const grid=$('prod-grid');
  const filtered=cat==='tous'?prods:prods.filter(p=>p.category===cat);
  $('prod-count').textContent=filtered.length+' produit(s)';
  grid.innerHTML='';
  if(!filtered.length){grid.innerHTML='<div class="empty">Aucun produit disponible.</div>';return;}
  filtered.forEach(p=>{
    const prix=getPrix(p);
    const barre=(p.promo_active||p.flash_active)&&p.promo_prix?`<div class="card-barre">${fmt(p.resale_price)} FCFA</div>`:'';
    const pct=p.promo_prix?`-${Math.round((1-p.promo_prix/p.resale_price)*100)}%`:'';
    const imgEl=p.image_url?`<img src="${p.image_url}" alt="${p.name}" class="card-img" loading="lazy" onerror="this.outerHTML='<div class=\\'card-img-ph\\'>📦</div>'">`:'<div class="card-img-ph">📦</div>';
    const badges=[
      p.quantity<5&&p.quantity>0?'<span class="badge badge-low">Stock faible</span>':'',
      p.flash_active?'<span class="badge badge-flash">⚡ FLASH</span>':(isNew(p.created_at)?'<span class="badge badge-new">🆕</span>':''),
      p.promo_active&&!p.flash_active?'<span class="badge badge-promo">🔥 PROMO</span>':'',
      pct?`<span class="badge badge-pct">${pct}</span>`:''
    ].join('');
    let admin='';
    if(isAdmin) admin=`<div class="card-admin">
      <button class="btn-edit" onclick="event.stopPropagation();editProd('${p.id}')">✏️</button>
      <button class="btn-del" onclick="event.stopPropagation();delProd('${p.id}')">🗑️</button>
      <button class="btn-flash" onclick="event.stopPropagation();toggleFlash('${p.id}',${p.flash_active})">${p.flash_active?'❌⚡':'⚡'}</button>
    </div>`;
    const card=document.createElement('div');
    card.className='card';
    card.innerHTML=`<div class="card-img-wrap">${imgEl}${badges}</div>
      <div class="card-body">
        <div class="card-cat">${p.category}</div>
        <div class="card-name">${p.name}</div>
        <div class="card-qty">Qté : ${p.quantity}</div>
        ${barre}
        <div class="card-prix${(p.promo_active||p.flash_active)?' promo':''}">${fmt(prix)} FCFA</div>
        <button class="card-btn" onclick="event.stopPropagation();openProd('${p.id}')">Voir détails</button>
        ${admin}
      </div>`;
    card.addEventListener('click',()=>openProd(p.id));
    grid.appendChild(card);
  });
}

// ===== FLASH =====
let flashInt=null;
function loadFlash(prods){
  const flash=prods.filter(p=>p.flash_active&&p.flash_fin&&new Date(p.flash_fin)>new Date());
  const sec=$('flash-section');
  if(!flash.length){sec.style.display='none';return;}
  sec.style.display='block';
  const grid=$('flash-grid');
  grid.innerHTML='';
  flash.forEach(p=>{
    const c=document.createElement('div'); c.className='card';
    const imgEl=p.image_url?`<img src="${p.image_url}" class="card-img" loading="lazy">`:'<div class="card-img-ph">📦</div>';
    c.innerHTML=`<div class="card-img-wrap">${imgEl}<span class="badge badge-flash">⚡ FLASH</span></div>
      <div class="card-body">
        <div class="card-name">${p.name}</div>
        <div class="card-barre">${fmt(p.resale_price)} FCFA</div>
        <div class="card-prix promo">${fmt(getPrix(p))} FCFA</div>
        <button class="card-btn" onclick="openProd('${p.id}')">Voir détails</button>
      </div>`;
    grid.appendChild(c);
  });
  if(flashInt)clearInterval(flashInt);
  const tick=()=>{
    const fin=flash.reduce((m,p)=>{const d=new Date(p.flash_fin);return d<m?d:m;},new Date(flash[0].flash_fin));
    const diff=fin-new Date();
    if(diff<=0){clearInterval(flashInt);sec.style.display='none';return;}
    const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);
    $('flash-timer').textContent=`⏱ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };
  tick(); flashInt=setInterval(tick,1000);
}

// ===== FILTRES =====
window.setCat=c=>{cat=c; renderProds(allProds); $('produits').scrollIntoView({behavior:'smooth'});};
window.setCatPill=(btn,c)=>{
  document.querySelectorAll('.cat-pill').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); cat=c; renderProds(allProds);
};
window.filtrerFlash=()=>{renderProds(allProds.filter(p=>p.flash_active)); $('produits').scrollIntoView({behavior:'smooth'});};
window.filtrerPromo=()=>{renderProds(allProds.filter(p=>p.promo_active)); $('produits').scrollIntoView({behavior:'smooth'});};
window.filtrerNouveautes=()=>{renderProds(allProds.filter(p=>isNew(p.created_at))); $('produits').scrollIntoView({behavior:'smooth'});};
window.filtrerMeilleures=async()=>{
  const{data}=await db.from('reservations').select('items');
  const counts={};
  (data||[]).forEach(r=>(r.items||[]).forEach(i=>{counts[i.name]=(counts[i.name]||0)+i.qty;}));
  renderProds([...allProds].sort((a,b)=>(counts[b.name]||0)-(counts[a.name]||0)));
  $('produits').scrollIntoView({behavior:'smooth'});
};

// ===== MODAL PRODUIT =====
window.openProd=async(id)=>{
  const p=allProds.find(x=>x.id===id); if(!p)return;
  curProd=p;
  $('qty-num').textContent='1';
  $('prod-name').textContent=p.name;
  $('prod-desc').textContent=p.description||'';
  $('prod-cat-tag').textContent=p.category;
  $('prod-new-tag').style.display=isNew(p.created_at)?'inline-block':'none';
  $('prod-low').style.display=p.quantity<5?'block':'none';
  $('prod-flash-tag').style.display=p.flash_active?'block':'none';
  $('prod-stock').textContent=`Quantité disponible : ${p.quantity}`;
  const prix=getPrix(p);
  $('prod-prix').textContent=fmt(prix)+' FCFA';
  if((p.promo_active||p.flash_active)&&p.promo_prix){
    $('prod-prix-barre').textContent=fmt(p.resale_price)+' FCFA';
    $('prod-prix-barre').style.display='block';
  } else {$('prod-prix-barre').style.display='none';}
  const img=$('prod-img');
  if(p.image_url){img.src=p.image_url;img.style.display='block';}else{img.style.display='none';}
  const waMsg=encodeURIComponent(`Bonjour CAMERTECH MARKET, intéressé par : ${p.name} (${fmt(prix)} FCFA)`);
  $('prod-wa').href=`https://wa.me/${WA1}?text=${waMsg}`;
  if(user){$('prod-actions').style.display='flex';$('prod-login-msg').style.display='none';}
  else{$('prod-actions').style.display='none';$('prod-login-msg').style.display='block';}
  showModal('prod-overlay');
  loadCross(p);
  loadAvis(p.id);
};

window.qtyMinus=()=>{const v=parseInt($('qty-num').textContent);if(v>1)$('qty-num').textContent=v-1;};
window.qtyPlus=()=>{const v=parseInt($('qty-num').textContent);if(v<curProd.quantity)$('qty-num').textContent=v+1;};

window.addToCart=()=>{
  const qty=parseInt($('qty-num').textContent);
  const prix=getPrix(curProd);
  const ex=panier.find(x=>x.id===curProd.id);
  if(ex)ex.qty=Math.min(ex.qty+qty,curProd.quantity);
  else panier.push({id:curProd.id,name:curProd.name,prix,qty,image_url:curProd.image_url});
  updatePanierBtn();
  hideModal('prod-overlay');
  const btn=$('btn-panier');
  btn.style.transform='scale(1.2)';
  setTimeout(()=>btn.style.transform='',200);
};

// ===== CROSS-SELLING =====
async function loadCross(p){
  $('cross-zone').innerHTML='';
  const{data}=await db.from('products').select('*').eq('category',p.category).neq('id',p.id).limit(4);
  if(!data?.length)return;
  $('cross-zone').innerHTML=`<p class="cross-title">💡 Souvent achetés ensemble</p>
    <div class="cross-list">
      ${data.map(cs=>`<div class="cs-card" onclick="openProd('${cs.id}')">
        ${cs.image_url?`<img src="${cs.image_url}">`:'<div style="height:55px;display:flex;align-items:center;justify-content:center;font-size:1.3rem">📦</div>'}
        <div class="cs-name">${cs.name}</div>
        <div class="cs-price">${fmt(getPrix(cs))} F</div>
        <button class="btn-cs" onclick="event.stopPropagation();quickAdd('${cs.id}')">+ Ajouter</button>
      </div>`).join('')}
    </div>`;
}

window.quickAdd=(id)=>{
  const p=allProds.find(x=>x.id===id); if(!p||!user)return;
  const ex=panier.find(x=>x.id===id);
  if(ex)ex.qty++;
  else panier.push({id:p.id,name:p.name,prix:getPrix(p),qty:1});
  updatePanierBtn();
};

// ===== AVIS =====
async function loadAvis(productId){
  const el=$('avis-zone'); el.innerHTML='';
  const{data}=await db.from('avis').select('*').eq('product_id',productId).eq('valide',true).order('created_at',{ascending:false});
  const moy=data?.length?(data.reduce((s,a)=>s+a.note,0)/data.length).toFixed(1):0;
  el.innerHTML=`<p class="avis-title">⭐ Avis clients</p>
    ${data?.length?`<div class="avis-moy"><span class="avis-note">${moy}</span><div><div class="stars">${stars(moy)}</div><div class="avis-nb">${data.length} avis</div></div></div>`:''}
    ${user?`<button class="btn-avis" onclick="toggleAvisForm('${productId}')">✏️ Laisser un avis</button>`:''}
    <div id="avis-form-${productId}" style="display:none">
      <div class="avis-form">
        <h4>Votre avis</h4>
        <div class="stars-inp" id="stars-${productId}">
          ${[1,2,3,4,5].map(i=>`<button class="star-btn" onclick="setNote(${i},'${productId}')">★</button>`).join('')}
        </div>
        <textarea id="avis-txt-${productId}" placeholder="Votre commentaire..." rows="3"></textarea>
        <label class="lbl-photo">📷 Ajouter une photo
          <input type="file" id="avis-file-${productId}" accept="image/*" style="display:none" onchange="previewAvis(this,'${productId}')">
        </label>
        <img id="avis-prev-${productId}" src="" style="display:none;width:60px;height:60px;object-fit:cover;border-radius:6px;margin-left:8px;vertical-align:middle">
        <button class="btn-green" style="margin-top:10px" onclick="submitAvis('${productId}')">Publier</button>
        <p id="avis-msg-${productId}" style="min-height:16px;font-size:.8rem;margin-top:5px"></p>
      </div>
    </div>
    ${data?.length?data.map(a=>`<div class="avis-card">
      <div class="avis-top"><span class="avis-auteur">${a.nom_client}</span><span class="avis-date">${new Date(a.created_at).toLocaleDateString('fr-FR')}</span></div>
      <div class="stars" style="font-size:.85rem">${stars(a.note)}</div>
      ${a.commentaire?`<div class="avis-txt">${a.commentaire}</div>`:''}
      ${a.photo_url?`<img src="${a.photo_url}" class="avis-photo" onclick="window.open('${a.photo_url}','_blank')">`:''}
    </div>`).join(''):'<p style="color:var(--txt3);font-size:.82rem">Aucun avis pour le moment.</p>'}`;
}

window.toggleAvisForm=(id)=>{const f=$(`avis-form-${id}`);f.style.display=f.style.display==='none'?'block':'none';};
window.setNote=(n,id)=>{selNote=n; document.querySelectorAll(`#stars-${id} .star-btn`).forEach((b,i)=>b.classList.toggle('lit',i<n));};
window.previewAvis=(input,id)=>{
  avisFile=input.files[0]; if(!avisFile)return;
  const r=new FileReader(); r.onload=e=>{const img=$(`avis-prev-${id}`);img.src=e.target.result;img.style.display='inline-block';}; r.readAsDataURL(avisFile);
};
window.submitAvis=async(productId)=>{
  const msg=$(`avis-msg-${productId}`);
  if(!selNote){msg.style.color='var(--red)';msg.textContent='❌ Choisissez une note';return;}
  let photoUrl=null;
  if(avisFile){try{photoUrl=await uploadImg(avisFile);}catch(e){}}
  const{error}=await db.from('avis').insert([{product_id:productId,utilisateur_id:user.id,nom_client:user.nom,note:selNote,commentaire:$(`avis-txt-${productId}`).value.trim()||null,photo_url:photoUrl,valide:false}]);
  if(error){msg.style.color='var(--red)';msg.textContent='❌ '+error.message;return;}
  msg.style.color='var(--ok)';msg.textContent='✅ Avis soumis ! En attente de validation.';
  selNote=0;avisFile=null;
};

// ===== PANIER =====
function updatePanierBtn(){
  const n=panier.reduce((s,p)=>s+p.qty,0);
  $('panier-nb').textContent=n;
  $('btn-panier').style.display=n===0?'none':'block';
}

window.ouvrirPanier=()=>{
  const items=$('panier-items');
  if(!panier.length){items.innerHTML='<div class="panier-vide">Votre panier est vide 🛒</div>';$('panier-totaux').innerHTML='';$('.btn-payer').style.display='none';$('.btn-reserver').style.display='none';}
  else{
    document.querySelector('.btn-payer').style.display='block';
    document.querySelector('.btn-reserver').style.display='block';
    renderPanierItems();
  }
  showModal('panier-overlay');
};

function renderPanierItems(){
  const items=$('panier-items'); items.innerHTML=''; let sT=0;
  panier.forEach((item,i)=>{
    const st=item.prix*item.qty; sT+=st;
    const d=document.createElement('div'); d.className='panier-item';
    d.innerHTML=`<div class="pi-info"><strong>${item.name}</strong><span>${fmt(item.prix)} FCFA × ${item.qty}</span></div>
      <div class="pi-price">${fmt(st)} FCFA</div>
      <button class="btn-rm" onclick="rmPanier(${i})">✕</button>`;
    items.appendChild(d);
  });
  updateTotaux(sT);
}

function updateTotaux(sT){
  const tot=sT+frais;
  $('panier-totaux').innerHTML=`<div class="tot-ligne"><span>Sous-total</span><span>${fmt(sT)} FCFA</span></div>
    <div class="tot-ligne"><span>Livraison</span><span>${frais>0?fmt(frais)+' FCFA':'—'}</span></div>
    <div class="tot-final"><span>Total</span><span>${fmt(tot)} FCFA</span></div>`;
}

window.rmPanier=(i)=>{panier.splice(i,1);updatePanierBtn();ouvrirPanier();};

window.updateLivraison=()=>{
  zone=$('zone-sel').value;
  frais=zone==='retrait'?0:zone?1000:0;
  const info=$('livraison-info');
  if(zone){
    info.style.display='block';
    info.className='livraison-info '+(frais===0?'liv-ok':'liv-pay');
    info.textContent=frais===0?'🏪 Retrait gratuit en boutique':'🚚 Livraison : 1 000 FCFA';
  }else{info.style.display='none';}
  if(panier.length)renderPanierItems();
};

// ===== PAIEMENT =====
window.selectMeth=(btn,m)=>{
  payMethod=m;
  document.querySelectorAll('.pay-meth').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
};

window.initierPaiement=()=>{
  if(!user){alert('Connectez-vous pour payer.');return;}
  if(!zone){alert('Choisissez votre zone de livraison.');return;}
  const tot=panier.reduce((s,p)=>s+p.prix*p.qty,0)+frais;
  $('pay-montant').textContent=fmt(tot)+' FCFA';
  $('pay-tel').value=user.telephone||'';
  $('pay-status').textContent='';
  $('btn-pay').disabled=false; $('btn-pay').textContent='Payer maintenant';
  hideModal('panier-overlay');
  showModal('pay-overlay');
};

window.confirmerPaiement=async()=>{
  const tel=$('pay-tel').value.trim();
  const status=$('pay-status');
  const btn=$('btn-pay');
  if(!/^\d{9}$/.test(tel)){status.style.color='var(--red)';status.textContent='❌ Numéro invalide (9 chiffres)';return;}
  btn.disabled=true; btn.textContent='Traitement...';
  status.style.color='var(--txt3)'; status.textContent='📲 Envoi de la demande...';
  const tot=panier.reduce((s,p)=>s+p.prix*p.qty,0)+frais;
  const code='CMT-'+Math.random().toString(36).substring(2,5).toUpperCase()+'-'+Date.now().toString().slice(-4);
  try{
    await db.from('reservations').insert([{utilisateur_id:user.id,nom_client:user.nom,telephone:user.telephone,code,items:panier.map(p=>({name:p.name,qty:p.qty,prix:p.prix})),total:tot,zone_livraison:zone,frais_livraison:frais,statut:'paiement_en_cours',note:$('note-cmd').value||null}]);
    const resp=await fetch('/.netlify/functions/initier-paiement',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telephone:tel,montant:Math.round(tot),operateur:payMethod,reference:code,nom_client:user.nom.split(' ')[0]})});
    const result=await resp.json();
    if(result.success){
      status.style.color='var(--ok)'; status.textContent='✅ Demande envoyée ! Confirmez sur votre téléphone.';
      let tries=0;
      const poll=setInterval(async()=>{
        tries++;
        if(tries>24){clearInterval(poll);return;}
        try{
          const cr=await fetch('/.netlify/functions/verifier-paiement',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_id:result.transaction_id})});
          const c=await cr.json();
          if(c.transaction_status==='SUCCESSFUL'||c.status==='success'){
            clearInterval(poll);
            hideModal('pay-overlay');
            afficherCode(code,tot);
            panier=[]; updatePanierBtn();
          }else if(c.transaction_status==='FAILED'){
            clearInterval(poll);
            status.style.color='var(--red)'; status.textContent='❌ Paiement refusé. Réessayez.';
            btn.disabled=false; btn.textContent='Payer maintenant';
          }
        }catch(e){}
      },5000);
    }else{throw new Error(result.error||result.message||'Échec');}
  }catch(e){
    status.style.color='var(--red)'; status.textContent='❌ '+(e.message||'Erreur. Réessayez.');
    btn.disabled=false; btn.textContent='Payer maintenant';
  }
};

window.reserverSansPaiement=async()=>{
  if(!user){alert('Connectez-vous pour réserver.');return;}
  if(!zone){alert('Choisissez votre zone de livraison.');return;}
  const tot=panier.reduce((s,p)=>s+p.prix*p.qty,0)+frais;
  const code='CMT-'+Math.random().toString(36).substring(2,5).toUpperCase()+'-'+Date.now().toString().slice(-4);
  await db.from('reservations').insert([{utilisateur_id:user.id,nom_client:user.nom,telephone:user.telephone,code,items:panier.map(p=>({name:p.name,qty:p.qty,prix:p.prix})),total:tot,zone_livraison:zone,frais_livraison:frais,statut:'en attente',note:$('note-cmd').value||null}]);
  hideModal('panier-overlay');
  afficherCode(code,tot);
  const waMsg=encodeURIComponent(`🛒 CAMERTECH MARKET\n👤 ${user.nom}\n📞 ${user.telephone}\n📍 ${zone}\n🔑 ${code}\n${panier.map(p=>`• ${p.name} ×${p.qty} = ${fmt(p.prix*p.qty)} F`).join('\n')}\n💰 TOTAL: ${fmt(tot)} FCFA`);
  setTimeout(()=>window.open(`https://wa.me/${WA1}?text=${waMsg}`,'_blank'),500);
};

function afficherCode(code,tot){
  $('code-val').textContent=code;
  let html=panier.map(p=>`<div class="recap-l"><span>${p.name} ×${p.qty}</span><span>${fmt(p.prix*p.qty)} F</span></div>`).join('');
  if(frais>0)html+=`<div class="recap-l"><span>🚚 Livraison (${zone})</span><span>${fmt(frais)} F</span></div>`;
  html+=`<div class="recap-tot"><span>Total</span><span>${fmt(tot)} FCFA</span></div>`;
  $('code-recap').innerHTML=html;
  showModal('code-overlay');
}

window.copierCode=()=>{
  navigator.clipboard.writeText($('code-val').textContent).then(()=>{
    const btn=document.querySelector('#code-overlay .btn-green');
    btn.textContent='✅ Copié !'; setTimeout(()=>btn.textContent='📋 Copier le code',2000);
  });
};
window.fermerCode=()=>{hideModal('code-overlay'); panier=[]; updatePanierBtn();};

// ===== COMMANDES =====
window.chargerCommandes=async()=>{
  if(!user)return;
  const{data}=await db.from('reservations').select('*').eq('utilisateur_id',user.id).order('created_at',{ascending:false});
  const list=$('cmds-list');
  list.innerHTML=!data?.length?'<p style="color:var(--txt3);text-align:center;padding:20px">Aucune commande.</p>'
    :data.map(r=>`<div class="cmd-card">
      <div class="cmd-code">${r.code}</div>
      <div class="cmd-date">📅 ${new Date(r.created_at).toLocaleString('fr-FR')} • 📍 ${r.zone_livraison||'—'}</div>
      <span class="cmd-st st-${r.statut==='en attente'?'att':r.statut==='valide'?'val':r.statut==='livre'?'liv':'ann'}">${r.statut}</span>
      <div style="color:var(--txt2);font-size:.8rem;margin-top:5px">${r.items.map(i=>`${i.name} ×${i.qty}`).join(', ')}</div>
      <div style="color:var(--g);font-weight:700;margin-top:3px">${fmt(r.total)} FCFA</div>
    </div>`).join('');
  showModal('cmds-overlay');
};

// ===== SUIVI =====
window.suivreCommande=async()=>{
  const code=$('suivi-code').value.trim().toUpperCase();
  const res=$('suivi-res'); if(!code)return;
  const{data}=await db.from('reservations').select('*').eq('code',code).single();
  if(!data){res.innerHTML='<p style="color:var(--red)">❌ Code introuvable : '+code+'</p>';return;}
  const sts={'en attente':'⏳ En attente','valide':'✅ Validée','livre':'🚚 Livrée','annule':'❌ Annulée','paiement_en_cours':'💳 Paiement en cours'};
  res.innerHTML=`<div style="background:var(--bg);border-radius:10px;padding:14px;border:1px solid var(--bdr)">
    <div style="font-family:monospace;color:var(--g);font-weight:700;margin-bottom:7px">${data.code}</div>
    <div style="font-size:1rem;margin-bottom:6px">${sts[data.statut]||data.statut}</div>
    <div style="color:var(--txt3);font-size:.8rem">📅 ${new Date(data.created_at).toLocaleString('fr-FR')}</div>
    <div style="color:var(--txt3);font-size:.8rem">📍 ${data.zone_livraison||'—'}</div>
    <div style="color:var(--g);font-weight:700;margin-top:7px">${fmt(data.total)} FCFA</div>
  </div>`;
};

// ===== IMAGE UPLOAD =====
async function compressImg(file,maxW=800,maxH=800,q=.75){
  return new Promise(res=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
      img.onload=()=>{
        const canvas=document.createElement('canvas');
        let{width:w,height:h}=img;
        if(w>maxW||h>maxH){const r=Math.min(maxW/w,maxH/h);w=Math.round(w*r);h=Math.round(h*r);}
        canvas.width=w;canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        canvas.toBlob(b=>res(b),'image/webp',q);
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
async function uploadImg(file){
  const blob=await compressImg(file);
  const name=`${Date.now()}-${Math.random().toString(36).substring(2)}.webp`;
  const{data,error}=await db.storage.from(BUCKET).upload(name,blob,{contentType:'image/webp',cacheControl:'3600'});
  if(error)throw error;
  return db.storage.from(BUCKET).getPublicUrl(data.path).data.publicUrl;
}

// ===== ADMIN LOGIN =====
function showAdminLogin(){
  document.body.innerHTML=`
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f4;padding:20px;font-family:Inter,sans-serif">
    <div style="background:#fff;border-radius:18px;padding:34px;max-width:360px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.1)">
      <img src="logo.png" style="height:65px;width:65px;border-radius:50%;margin-bottom:12px;border:3px solid #1a5c2a">
      <h1 style="color:#1a5c2a;font-family:Poppins,sans-serif;font-size:1.3rem;margin-bottom:4px">CAMERTECH MARKET</h1>
      <p style="color:#999;font-size:.82rem;margin-bottom:22px">Espace Administrateur</p>
      <div id="step1">
        <input type="text" id="adm-id" placeholder="Identifiant admin" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:10px;font-size:.9rem;font-family:Inter,sans-serif">
        <input type="password" id="adm-mdp" placeholder="Mot de passe" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:14px;font-size:.9rem;font-family:Inter,sans-serif">
        <button onclick="admStep1()" style="width:100%;background:#1a5c2a;color:#fff;border:none;padding:13px;border-radius:10px;font-weight:700;font-size:.95rem;cursor:pointer;font-family:Poppins,sans-serif">Continuer →</button>
      </div>
      <div id="step2" style="display:none">
        <p style="color:#2dc653;font-size:.85rem;margin-bottom:14px">✅ Code envoyé sur WhatsApp !</p>
        <input type="text" id="adm-code" placeholder="Code WhatsApp" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:14px;font-size:1.1rem;text-align:center;letter-spacing:5px;font-family:monospace">
        <button onclick="admStep2()" style="width:100%;background:#1a5c2a;color:#fff;border:none;padding:13px;border-radius:10px;font-weight:700;font-size:.95rem;cursor:pointer">Confirmer →</button>
      </div>
      <p id="adm-err" style="color:#e63946;font-size:.82rem;min-height:18px;margin-top:10px"></p>
    </div>
  </div>`;
}

let admCode=null, admTemp=null, admTries=0;

window.admStep1=()=>{
  const id=$('adm-id').value.trim(), mdp=$('adm-mdp').value.trim(), err=$('adm-err');
  const adm=ADMINS.find(a=>a.id===id&&a.mdp===mdp);
  if(!adm){admTries++;err.textContent=`❌ Identifiant ou mot de passe incorrect (${admTries}/3)`;if(admTries>=3){$('step1').style.opacity='.3';$('step1').style.pointerEvents='none';err.textContent='🚫 Trop de tentatives.';}return;}
  admTemp=adm; admCode=Math.floor(1000+Math.random()*9000).toString();
  window.open(`https://wa.me/${adm.wa}?text=${encodeURIComponent(`🔐 CAMERTECH MARKET\nCode admin : ${admCode}\nValide 5 minutes.`)}`,'_blank');
  $('step1').style.display='none'; $('step2').style.display='block';
  setTimeout(()=>{admCode=null;},5*60*1000);
};

window.admStep2=()=>{
  const code=$('adm-code').value.trim(), err=$('adm-err');
  if(!admCode){err.textContent='❌ Code expiré. Recommencez.';return;}
  if(code!==admCode){err.textContent='❌ Code incorrect';return;}
  isAdmin=true; currentAdmin=admTemp;
  showAdminPanel();
};

// ===== PANNEAU ADMIN =====
async function showAdminPanel(){
  const[{data:prods},{data:users},{data:reserv},{data:avisList},{data:banns}]=await Promise.all([
    db.from('products').select('*').order('created_at',{ascending:false}),
    db.from('utilisateurs').select('*').order('created_at',{ascending:false}),
    db.from('reservations').select('*').order('created_at',{ascending:false}),
    db.from('avis').select('*').eq('valide',false).order('created_at',{ascending:false}),
    db.from('bannières').select('*').eq('actif',true).order('created_at',{ascending:false})
  ]);
  window._prods=prods||[]; window._res=reserv||[]; window._users=users||[];
  const totV=(reserv||[]).reduce((s,r)=>s+parseFloat(r.total),0);
  const today=new Date().toDateString();
  const todayV=(reserv||[]).filter(r=>new Date(r.created_at).toDateString()===today).reduce((s,r)=>s+parseFloat(r.total),0);
  const att=(reserv||[]).filter(r=>r.statut==='en attente').length;
  const sFaible=(prods||[]).filter(p=>p.quantity<5&&p.quantity>0);
  const sZero=(prods||[]).filter(p=>p.quantity===0);
  const valStock=(prods||[]).reduce((s,p)=>s+p.purchase_price*p.quantity,0);
  const valVente=(prods||[]).reduce((s,p)=>s+p.resale_price*p.quantity,0);
  const counts={},zones={};
  (reserv||[]).forEach(r=>{(r.items||[]).forEach(i=>{counts[i.name]=(counts[i.name]||0)+i.qty;});if(r.zone_livraison)zones[r.zone_livraison]=(zones[r.zone_livraison]||0)+1;});
  const topP=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topZ=Object.entries(zones).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxP=topP[0]?.[1]||1, maxZ=topZ[0]?.[1]||1;
  const j7=[]; for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const ds=d.toDateString();const lbl=d.toLocaleDateString('fr-FR',{weekday:'short',day:'numeric'});const t=(reserv||[]).filter(r=>new Date(r.created_at).toDateString()===ds).reduce((s,r)=>s+parseFloat(r.total),0);j7.push({lbl,t});}
  const maxJ=Math.max(...j7.map(j=>j.t),1);
  const page=$('admin-page'); page.style.display='block';
  page.innerHTML=`<div class="adm-top">
    <h1>⚙️ CAMERTECH MARKET — ${currentAdmin.id}</h1>
    <div class="adm-tabs">
      <button class="adm-tab active" onclick="admTab(this,'a-dash')">📊 Dashboard</button>
      <button class="adm-tab" onclick="admTab(this,'a-prods')">📦 Produits</button>
      <button class="adm-tab" onclick="admTab(this,'a-cmds')">🧾 Commandes</button>
      <button class="adm-tab" onclick="admTab(this,'a-users')">👥 Clients</button>
      <button class="adm-tab" onclick="admTab(this,'a-avis')">⭐ Avis (${(avisList||[]).length})</button>
      <button class="adm-tab" onclick="admTab(this,'a-mktg')">📢 Marketing</button>
      <button class="adm-tab" onclick="admTab(this,'a-analytics')">📈 Analytics</button>
      <button class="adm-tab" onclick="$('admin-page').style.display='none';isAdmin=true;renderProds(allProds)">🏪 Site</button>
    </div>
  </div>
  <div class="adm-body">

  <div id="a-dash">
    <div class="stats-row">
      <div class="stat-box"><div class="stat-ico">💰</div><div class="stat-num">${fmt(todayV)}</div><div class="stat-lbl">Ventes aujourd'hui (F)</div></div>
      <div class="stat-box"><div class="stat-ico">📦</div><div class="stat-num">${fmt(totV)}</div><div class="stat-lbl">Total ventes (F)</div></div>
      <div class="stat-box"><div class="stat-ico">⏳</div><div class="stat-num" style="color:var(--or)">${att}</div><div class="stat-lbl">En attente</div></div>
      <div class="stat-box"><div class="stat-ico">📱</div><div class="stat-num">${(prods||[]).length}</div><div class="stat-lbl">Produits</div></div>
      <div class="stat-box"><div class="stat-ico">👥</div><div class="stat-num">${(users||[]).length}</div><div class="stat-lbl">Clients</div></div>
      <div class="stat-box"><div class="stat-ico">💎</div><div class="stat-num" style="color:var(--ok)">${fmt(valVente-valStock)}</div><div class="stat-lbl">Bénéfice estimé (F)</div></div>
      <div class="stat-box"><div class="stat-ico">⚠️</div><div class="stat-num" style="color:var(--red)">${sFaible.length+sZero.length}</div><div class="stat-lbl">Alertes stock</div></div>
    </div>
    <div class="adm-sec">
      <h2>📈 Ventes 7 jours</h2>
      <div style="display:flex;align-items:flex-end;gap:7px;height:90px">
        ${j7.map(j=>`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
          <span style="color:var(--txt3);font-size:.58rem">${j.t>0?Math.round(j.t/1000)+'k':''}</span>
          <div style="background:var(--g);border-radius:4px 4px 0 0;width:100%;height:${Math.max((j.t/maxJ)*80,j.t>0?4:2)}px;opacity:.85"></div>
          <span style="color:var(--txt3);font-size:.58rem;text-align:center">${j.lbl}</span>
        </div>`).join('')}
      </div>
    </div>
    ${(sFaible.length+sZero.length)>0?`<div class="adm-sec"><h2>⚠️ Alertes Stock</h2>
      ${sZero.map(p=>`<div class="alerte-row zero"><span>🔴 <strong>${p.name}</strong></span><span style="color:var(--red)">ÉPUISÉ</span></div>`).join('')}
      ${sFaible.map(p=>`<div class="alerte-row"><span>🟡 <strong>${p.name}</strong></span><span style="color:var(--or)">${p.quantity} restant(s)</span></div>`).join('')}
    </div>`:''}
  </div>

  <div id="a-prods" style="display:none">
    <div class="adm-sec">
      <h2 id="prod-form-h">➕ Ajouter un Produit</h2>
      <div class="adm-form">
        <input type="text" id="p-name" placeholder="Nom *" class="field">
        <textarea id="p-desc" placeholder="Description" rows="2" class="field"></textarea>
        <div class="row2">
          <select id="p-cat" class="field"><option value="Téléphonie">📱 Téléphonie</option><option value="Accessoires">🎧 Accessoires</option><option value="Électronique">💻 Électronique</option><option value="Réseau">📡 Réseau</option><option value="Gaming">🎮 Gaming</option><option value="Autre">📦 Autre</option></select>
          <input type="number" id="p-qty" placeholder="Quantité *" class="field">
        </div>
        <div class="row2">
          <input type="number" id="p-achat" placeholder="Prix achat (F) *" class="field">
          <input type="number" id="p-vente" placeholder="Prix vente (F) *" class="field">
        </div>
        <div class="row2">
          <input type="number" id="p-promo-px" placeholder="Prix promo (F)" class="field">
          <div class="chk-row"><input type="checkbox" id="p-promo-chk"><label for="p-promo-chk">🔥 Activer promo</label></div>
        </div>
        <div class="row2">
          <input type="datetime-local" id="p-flash-fin" class="field">
          <div class="chk-row"><input type="checkbox" id="p-flash-chk"><label for="p-flash-chk">⚡ Vente Flash</label></div>
        </div>
        <div class="photo-zone">
          <p style="font-size:.8rem;color:var(--txt3);margin-bottom:7px">📷 Photo (compression auto -90%)</p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <label class="upload-lbl" for="p-img-file">⬆️ Uploader<input type="file" id="p-img-file" accept="image/*" style="display:none" onchange="prevImg(this)"></label>
            <input type="url" id="p-img-url" placeholder="ou URL image" class="field" style="flex:1;min-width:140px">
          </div>
          <div id="img-prev-wrap" style="display:none;margin-top:9px;position:relative;display:none;display:inline-block">
            <img id="img-prev" src="" style="max-height:130px;border-radius:8px;max-width:100%">
            <button class="btn-rm-img" onclick="resetImg()">✕</button>
          </div>
        </div>
        <div style="display:flex;gap:9px">
          <button class="btn-adm" onclick="saveProd()" style="flex:1">Enregistrer</button>
          <button class="btn-adm-red" id="btn-cancel-edit" style="display:none" onclick="cancelEdit()">Annuler</button>
        </div>
        <p id="prod-msg" style="min-height:16px;font-size:.8rem"></p>
      </div>
    </div>
    <div class="adm-sec">
      <h2>📦 Produits (${(prods||[]).length})</h2>
      <div style="overflow-x:auto"><table class="adm-table">
        <thead><tr><th>Nom</th><th>Catégorie</th><th>Stock</th><th>Prix</th><th>Statut</th><th>Actions</th></tr></thead>
        <tbody>${(prods||[]).map(p=>`<tr>
          <td><strong>${p.name}</strong></td><td style="color:var(--txt3)">${p.category}</td>
          <td style="color:${p.quantity===0?'var(--red)':p.quantity<5?'var(--or)':'var(--ok)'};font-weight:600">${p.quantity}</td>
          <td style="color:var(--g);font-weight:600">${fmt(p.resale_price)} F</td>
          <td>${p.flash_active?'<span style="color:var(--red);font-weight:600">⚡Flash</span>':p.promo_active?'<span style="color:var(--or);font-weight:600">🔥Promo</span>':'Normal'}</td>
          <td><div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="btn-adm" style="padding:4px 9px;font-size:.72rem" onclick="loadEditProd('${p.id}')">✏️</button>
            <button class="btn-adm-red" onclick="delProd('${p.id}')">🗑️</button>
            <button class="btn-adm-or" onclick="toggleFlash('${p.id}',${p.flash_active})">${p.flash_active?'❌⚡':'⚡'}</button>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
  </div>

  <div id="a-cmds" style="display:none">
    <div class="adm-sec">
      <h2>🧾 Commandes</h2>
      <input type="text" placeholder="🔎 Rechercher..." oninput="searchCmd(this.value)" class="field" style="margin-bottom:10px">
      <div class="filtre-row">
        <button class="fpill active" onclick="filterCmd(this,'tous')">Toutes (${(reserv||[]).length})</button>
        <button class="fpill" onclick="filterCmd(this,'en attente')">⏳ En attente (${att})</button>
        <button class="fpill" onclick="filterCmd(this,'valide')">✅ Validées</button>
        <button class="fpill" onclick="filterCmd(this,'livre')">🚚 Livrées</button>
      </div>
      <div id="cmds-adm">${renderCmdsAdm(reserv||[])}</div>
    </div>
  </div>

  <div id="a-users" style="display:none">
    <div class="adm-sec">
      <h2>👥 Clients (${(users||[]).length})</h2>
      <div style="overflow-x:auto"><table class="adm-table">
        <thead><tr><th>Nom</th><th>Téléphone</th><th>Email</th><th>Inscrit le</th></tr></thead>
        <tbody>${(users||[]).map(u=>`<tr>
          <td><strong>${u.nom}</strong></td>
          <td>📞 ${u.telephone}</td>
          <td style="color:var(--txt3)">${u.email||'—'}</td>
          <td style="color:var(--txt3);font-size:.78rem">${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
  </div>

  <div id="a-avis" style="display:none">
    <div class="adm-sec">
      <h2>⭐ Avis en attente (${(avisList||[]).length})</h2>
      ${!(avisList||[]).length?'<p style="color:var(--txt3)">Aucun avis en attente.</p>'
      :(avisList||[]).map(a=>`<div class="avis-card">
        <div class="avis-top"><span class="avis-auteur">${a.nom_client} — ${'★'.repeat(a.note)+'☆'.repeat(5-a.note)}</span>
          <div style="display:flex;gap:6px">
            <button class="btn-adm" style="padding:5px 10px;font-size:.78rem" onclick="validerAvis('${a.id}')">✅ Valider</button>
            <button class="btn-adm-red" onclick="delAvis('${a.id}')">🗑️</button>
          </div>
        </div>
        ${a.commentaire?`<div class="avis-txt">${a.commentaire}</div>`:''}
        ${a.photo_url?`<img src="${a.photo_url}" class="avis-photo">`:''}
      </div>`).join('')}
    </div>
  </div>

  <div id="a-mktg" style="display:none">
    <div class="adm-sec">
      <h2>📢 Publier un message</h2>
      <div class="adm-form">
        <input type="text" id="mktg-msg" placeholder="Message..." class="field">
        <select id="mktg-type" class="field">
          <option value="banniere">📌 Bannière défilante</option>
          <option value="popup">🔔 Popup à l'arrivée</option>
          <option value="slider">🖼️ Slide pub</option>
        </select>
        <div id="mktg-slider-x" style="display:none">
          <input type="text" id="mktg-titre" placeholder="Titre du slide" class="field">
          <input type="text" id="mktg-stitle" placeholder="Sous-titre" class="field">
          <input type="text" id="mktg-tag" placeholder="Tag (ex: 🔥 PROMO)" class="field">
          <input type="url" id="mktg-img" placeholder="URL image fond" class="field">
          <input type="text" id="mktg-btn" placeholder="Texte bouton" class="field">
        </div>
        <button class="btn-adm" onclick="publishMsg()">Publier</button>
        <p id="mktg-res" style="min-height:16px;font-size:.8rem"></p>
      </div>
    </div>
    <div class="adm-sec">
      <h2>Messages actifs</h2>
      <div id="mktg-liste">${renderBanns(banns||[])}</div>
    </div>
  </div>

  <div id="a-analytics" style="display:none">
    <div class="adm-sec">
      <h2>🏆 Produits les plus vendus</h2>
      <div class="bar-wrap">
        ${topP.length?topP.map(([n,q])=>`<div class="bar-row"><span class="bar-lbl">${n}</span><div class="bar-fill" style="width:${Math.round((q/maxP)*200)}px"></div><span class="bar-val">${q} vendu(s)</span></div>`).join(''):'<p style="color:var(--txt3)">Pas encore de données.</p>'}
      </div>
    </div>
    <div class="adm-sec">
      <h2>📍 Zones qui commandent le plus</h2>
      <div class="bar-wrap">
        ${topZ.length?topZ.map(([z,n])=>`<div class="bar-row"><span class="bar-lbl">📍 ${z}</span><div class="bar-fill bar-or" style="width:${Math.round((n/maxZ)*200)}px"></div><span class="bar-val">${n} cmd(s)</span></div>`).join(''):'<p style="color:var(--txt3)">Pas encore de données.</p>'}
      </div>
    </div>
    <div class="adm-sec">
      <h2>💰 Rapport financier</h2>
      <div style="overflow-x:auto"><table class="adm-table">
        <thead><tr><th>Produit</th><th>Stock</th><th>Achat</th><th>Vente</th><th>Marge</th><th>Valeur stock</th></tr></thead>
        <tbody>${(prods||[]).sort((a,b)=>(b.resale_price-b.purchase_price)-(a.resale_price-a.purchase_price)).map(p=>{
          const marge=((p.resale_price-p.purchase_price)/p.purchase_price*100).toFixed(0);
          return `<tr>
            <td><strong>${p.name}</strong></td>
            <td style="color:${p.quantity===0?'var(--red)':p.quantity<5?'var(--or)':'var(--ok)'};font-weight:600">${p.quantity}</td>
            <td>${fmt(p.purchase_price)}</td>
            <td style="color:var(--g);font-weight:600">${fmt(p.resale_price)}</td>
            <td style="color:var(--ok);font-weight:600">+${marge}%</td>
            <td>${fmt(p.purchase_price*p.quantity)} F</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>
  </div>

  </div>`;

  $('mktg-type').addEventListener('change',function(){$('mktg-slider-x').style.display=this.value==='slider'?'block':'none';});
  document.addEventListener('change',e=>{if(e.target.id==='p-img-file')prevImg(e.target);});
}

function renderCmdsAdm(data){
  if(!data.length)return'<p style="color:var(--txt3);text-align:center;padding:18px">Aucune commande.</p>';
  return`<div style="overflow-x:auto"><table class="adm-table">
    <thead><tr><th>Code</th><th>Client</th><th>Zone</th><th>Total</th><th>Date</th><th>Statut</th><th>Action</th></tr></thead>
    <tbody>${data.map(r=>`<tr>
      <td style="font-family:monospace;color:var(--g);font-weight:700">${r.code}</td>
      <td>${r.nom_client}<br><span style="color:var(--txt3);font-size:.72rem">${r.telephone}</span></td>
      <td style="font-size:.78rem">📍${r.zone_livraison||'—'}</td>
      <td style="font-weight:600">${fmt(r.total)} F</td>
      <td style="color:var(--txt3);font-size:.75rem">${new Date(r.created_at).toLocaleDateString('fr-FR')}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:8px;font-size:.7rem;font-weight:700;background:${r.statut==='en attente'?'#fff8f0':r.statut==='valide'?'#f0fff4':r.statut==='livre'?'#f0f8ff':'#fff0f0'};color:${r.statut==='en attente'?'var(--or)':r.statut==='valide'?'var(--ok)':r.statut==='livre'?'var(--blue)':'var(--red)'}">${r.statut}</span></td>
      <td><select onchange="changeStatut('${r.id}',this.value)" style="background:var(--bg);color:var(--txt);border:1px solid var(--bdr);border-radius:5px;padding:4px;font-size:.72rem">
        <option value="">Changer...</option>
        <option value="en attente">⏳ En attente</option>
        <option value="valide">✅ Validée</option>
        <option value="livre">🚚 Livrée</option>
        <option value="annule">❌ Annulée</option>
      </select></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderBanns(data){
  if(!data.length)return'<p style="color:var(--txt3)">Aucun message actif.</p>';
  return data.map(b=>`<div class="mktg-item">
    <div><span style="background:${b.type==='popup'?'var(--blue)':b.type==='slider'?'var(--or)':'var(--g)'};color:#fff;padding:2px 7px;border-radius:4px;font-size:.7rem;font-weight:700">${b.type.toUpperCase()}</span><span style="margin-left:8px;font-size:.85rem">${b.message}</span></div>
    <button class="btn-adm-red" onclick="deactivBann('${b.id}')">Désactiver</button>
  </div>`).join('');
}

// ===== ADMIN ACTIONS =====
window.admTab=(btn,id)=>{
  document.querySelectorAll('.adm-tab').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
  document.querySelectorAll('[id^="a-"]').forEach(t=>t.style.display='none');
  $(id).style.display='block';
};

window.prevImg=(input)=>{
  selFile=input.files[0]; if(!selFile)return;
  const r=new FileReader(); r.onload=e=>{$('img-prev').src=e.target.result;$('img-prev-wrap').style.display='inline-block';}; r.readAsDataURL(selFile);
};
window.resetImg=()=>{selFile=null; const f=$('p-img-file');if(f)f.value=''; $('p-img-url').value=''; $('img-prev-wrap').style.display='none';};

window.saveProd=async()=>{
  const msg=$('prod-msg');
  const name=$('p-name').value.trim(), qty=parseInt($('p-qty').value);
  const achat=parseFloat($('p-achat').value), vente=parseFloat($('p-vente').value);
  if(!name||!qty||!achat||!vente){msg.style.color='var(--red)';msg.textContent='❌ Remplissez les champs obligatoires';return;}
  msg.style.color='var(--txt3)';msg.textContent='Enregistrement...';
  let imgUrl=$('p-img-url').value.trim();
  if(selFile){try{imgUrl=await uploadImg(selFile);}catch(e){msg.style.color='var(--red)';msg.textContent='❌ Upload: '+e.message;return;}}
  const promoChk=$('p-promo-chk').checked, promoPx=parseFloat($('p-promo-px').value)||null;
  const flashChk=$('p-flash-chk').checked, flashFin=$('p-flash-fin').value||null;
  const prod={name,description:$('p-desc').value.trim()||null,category:$('p-cat').value,quantity:qty,purchase_price:achat,resale_price:vente,image_url:imgUrl||null,promo_active:promoChk,promo_prix:promoChk&&promoPx?promoPx:null,flash_active:flashChk,flash_fin:flashChk&&flashFin?new Date(flashFin).toISOString():null};
  const{error}=editId?await db.from('products').update(prod).eq('id',editId):await db.from('products').insert([prod]);
  if(error){msg.style.color='var(--red)';msg.textContent='❌ '+error.message;return;}
  msg.style.color='var(--ok)';msg.textContent='✅ Enregistré !';
  cancelEdit(); setTimeout(()=>showAdminPanel(),600);
};

window.loadEditProd=(id)=>{
  const p=window._prods.find(x=>x.id===id); if(!p)return;
  editId=id;
  $('prod-form-h').textContent='✏️ Modifier le produit';
  $('p-name').value=p.name; $('p-desc').value=p.description||'';
  $('p-cat').value=p.category; $('p-qty').value=p.quantity;
  $('p-achat').value=p.purchase_price; $('p-vente').value=p.resale_price;
  $('p-promo-px').value=p.promo_prix||''; $('p-promo-chk').checked=p.promo_active||false;
  $('p-flash-chk').checked=p.flash_active||false;
  if(p.image_url){$('p-img-url').value=p.image_url;$('img-prev').src=p.image_url;$('img-prev-wrap').style.display='inline-block';}
  $('btn-cancel-edit').style.display='block';
  admTab(document.querySelectorAll('.adm-tab')[1],'a-prods');
  window.scrollTo({top:0,behavior:'smooth'});
};

window.cancelEdit=()=>{
  editId=null; selFile=null;
  ['p-name','p-desc','p-qty','p-achat','p-vente','p-promo-px','p-img-url'].forEach(id=>{const e=$(id);if(e)e.value='';});
  const a=$('p-promo-chk');if(a)a.checked=false;
  const b=$('p-flash-chk');if(b)b.checked=false;
  const w=$('img-prev-wrap');if(w)w.style.display='none';
  const h=$('prod-form-h');if(h)h.textContent='➕ Ajouter un Produit';
  const c=$('btn-cancel-edit');if(c)c.style.display='none';
};

window.delProd=async(id)=>{if(!confirm('Supprimer ?'))return; await db.from('products').delete().eq('id',id); showAdminPanel();};
window.editProd=window.loadEditProd;
window.toggleFlash=async(id,actif)=>{await db.from('products').update({flash_active:!actif}).eq('id',id); showAdminPanel();};
window.changeStatut=async(id,s)=>{if(!s)return; await db.from('reservations').update({statut:s}).eq('id',id); showAdminPanel();};
window.filterCmd=(btn,f)=>{document.querySelectorAll('.fpill').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const d=f==='tous'?window._res:window._res.filter(r=>r.statut===f);$('cmds-adm').innerHTML=renderCmdsAdm(d);};
window.searchCmd=(q)=>{const d=window._res.filter(r=>r.code.toLowerCase().includes(q.toLowerCase())||r.nom_client.toLowerCase().includes(q.toLowerCase()));$('cmds-adm').innerHTML=renderCmdsAdm(d);};
window.validerAvis=async(id)=>{await db.from('avis').update({valide:true}).eq('id',id); showAdminPanel();};
window.delAvis=async(id)=>{if(!confirm('Supprimer ?'))return; await db.from('avis').delete().eq('id',id); showAdminPanel();};
window.publishMsg=async()=>{
  const msg=$('mktg-msg').value.trim(), type=$('mktg-type').value, res=$('mktg-res');
  if(!msg){res.style.color='var(--red)';res.textContent='❌ Message vide';return;}
  const payload={message:msg,type,actif:true};
  if(type==='slider'){payload.titre=$('mktg-titre').value;payload.sous_titre=$('mktg-stitle').value;payload.tag=$('mktg-tag').value;payload.btn_texte=$('mktg-btn').value;payload.image_url=$('mktg-img').value;}
  const{error}=await db.from('bannières').insert([payload]);
  if(error){res.style.color='var(--red)';res.textContent='❌ '+error.message;return;}
  res.style.color='var(--ok)';res.textContent='✅ Publié !';
  $('mktg-msg').value=''; setTimeout(()=>showAdminPanel(),600);
};
window.deactivBann=async(id)=>{await db.from('bannières').update({actif:false}).eq('id',id); showAdminPanel();};
