// ===== INIT SUPABASE =====
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ===== ÉTAT =====
let currentUser = null, isAdmin = false, currentAdmin = null;
let allProducts = [], panier = [], modalProduct = null;
let selectedFile = null, editingId = null, currentCat = "tous";
let userZone = "", fraisLivraison = 0;
let slideIndex = 0, slideTimer = null, totalSlides = 1;
let selectedOp = "mtn";
let selectedNote = 0, avisFile = null;

// ===== COMPRESSION IMAGE =====
async function compresserImage(file) {
    return new Promise(res => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                const max = 800;
                if (w > max || h > max) {
                    const r = Math.min(max/w, max/h);
                    w = Math.round(w*r); h = Math.round(h*r);
                }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                canvas.toBlob(b => res(b), 'image/webp', 0.75);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function uploadImage(file) {
    const blob = await compresserImage(file);
    const name = Date.now() + '-' + Math.random().toString(36).substring(2) + '.webp';
    const { data, error } = await db.storage.from(CONFIG.BUCKET).upload(name, blob, { contentType: 'image/webp' });
    if (error) throw error;
    return db.storage.from(CONFIG.BUCKET).getPublicUrl(data.path).data.publicUrl;
}

// ===== UTILITAIRES =====
const isNew = d => (new Date() - new Date(d)) < 7*24*60*60*1000;
const getPrix = p => (p.promo_active || p.flash_active) && p.promo_prix ? p.promo_prix : p.resale_price;
const fmt = n => parseInt(n).toLocaleString('fr-FR');
const $ = id => document.getElementById(id);
const show = id => { const el=$(id); if(el) el.style.display=''; };
const hide = id => { const el=$(id); if(el) el.style.display='none'; };
const showFlex = id => { const el=$(id); if(el) el.style.display='flex'; };

function openOverlay(id) { const el=$(id); if(el){el.style.display='flex'; document.body.style.overflow='hidden';} }
function closeOverlay(id) { const el=$(id); if(el){el.style.display='none'; document.body.style.overflow='';} }

// ===== DOM READY =====
document.addEventListener('DOMContentLoaded', () => {
    // Vérifier page admin
    const path = window.location.pathname.replace(/\//g,'').replace('.html','');
    if (path === CONFIG.ADMIN_PATH) { afficherLoginAdmin(); return; }

    // Session
    try {
        const saved = localStorage.getItem('cmkt_user');
        if (saved) { currentUser = JSON.parse(saved); showUserUI(); }
    } catch(e) { localStorage.removeItem('cmkt_user'); }

    // Thème
    const theme = localStorage.getItem('cmkt_theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    if ($('theme-toggle')) $('theme-toggle').checked = theme === 'dark';

    setupSidebar();
    setupAuth();
    setupCategories();
    setupSearch();
    setupPanier();
    setupPaiement();
    setupModals();
    fetchProducts();
    chargerBanniere();

    // Popup unique par session
    if (!sessionStorage.getItem('popup_ok')) {
        setTimeout(afficherPopup, 2000);
        sessionStorage.setItem('popup_ok', '1');
    }
});

// ===== SIDEBAR =====
function setupSidebar() {
    $('hamburger').onclick = () => { $('sidebar').classList.add('open'); $('sidebar-overlay').classList.add('active'); };
    $('sidebar-close').onclick = closeSidebar;
    $('sidebar-overlay').onclick = closeSidebar;

    function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.remove('active'); }

    $('sl-accueil').onclick = () => { closeSidebar(); window.scrollTo({top:0,behavior:'smooth'}); };
    $('sl-flash').onclick = () => { closeSidebar(); filtrerFlash(); };
    $('sl-promo').onclick = () => { closeSidebar(); renderProducts(allProducts.filter(p=>p.promo_active)); };
    $('sl-nouveautes').onclick = () => { closeSidebar(); renderProducts(allProducts.filter(p=>isNew(p.created_at))); };
    $('sl-meilleures').onclick = () => { closeSidebar(); afficherMeilleuresVentes(); };
    $('sl-tel').onclick = () => { closeSidebar(); filtrerCat('Téléphonie'); };
    $('sl-acc').onclick = () => { closeSidebar(); filtrerCat('Accessoires'); };
    $('sl-elec').onclick = () => { closeSidebar(); filtrerCat('Électronique'); };
    $('sl-res').onclick = () => { closeSidebar(); filtrerCat('Réseau'); };
    $('sl-gam').onclick = () => { closeSidebar(); filtrerCat('Gaming'); };
    $('sl-suivi').onclick = () => { closeSidebar(); openOverlay('suivi-overlay'); };
    $('sl-loc').onclick = () => { closeSidebar(); openOverlay('loc-overlay'); };

    $('theme-toggle').onchange = () => {
        const t = $('theme-toggle').checked ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('cmkt_theme', t);
    };

    $('btn-fr').onclick = () => { $('btn-fr').classList.add('active'); $('btn-en').classList.remove('active'); };
    $('btn-en').onclick = () => { $('btn-en').classList.add('active'); $('btn-fr').classList.remove('active'); };

    $('sidebar-zone').onchange = () => { userZone = $('sidebar-zone').value; $('zone-select').value = userZone; updateLivraison(); };
    $('prix-max-filter').onchange = () => {
        const max = parseFloat($('prix-max-filter').value);
        renderProducts(max ? allProducts.filter(p=>getPrix(p)<=max) : allProducts);
    };
}

// ===== AUTH =====
function setupAuth() {
    $('btn-auth-show').onclick = () => openOverlay('auth-overlay');
    $('auth-close').onclick = () => closeOverlay('auth-overlay');
    $('auth-overlay').onclick = e => { if(e.target===$('auth-overlay')) closeOverlay('auth-overlay'); };

    $('atab-login').onclick = () => {
        $('atab-login').classList.add('active'); $('atab-reg').classList.remove('active');
        show('form-login'); hide('form-reg');
    };
    $('atab-reg').onclick = () => {
        $('atab-reg').classList.add('active'); $('atab-login').classList.remove('active');
        hide('form-login'); show('form-reg');
    };

    $('btn-login').onclick = async () => {
        const tel = $('login-tel').value.trim();
        const mdp = $('login-mdp').value.trim();
        const err = $('login-err');
        err.textContent = '';
        if (tel.length !== 9) { err.textContent = '❌ Numéro invalide (9 chiffres)'; return; }
        if (!mdp) { err.textContent = '❌ Mot de passe requis'; return; }
        $('btn-login').textContent = 'Connexion...';
        const { data, error } = await db.from('utilisateurs').select('*').eq('telephone', tel).eq('mot_de_passe', mdp).single();
        $('btn-login').textContent = 'Se connecter';
        if (error || !data) { err.textContent = '❌ Numéro ou mot de passe incorrect'; return; }
        currentUser = data;
        localStorage.setItem('cmkt_user', JSON.stringify(data));
        showUserUI();
        closeOverlay('auth-overlay');
        renderProducts(allProducts);
    };

    $('btn-register').onclick = async () => {
        const nom = $('reg-nom').value.trim();
        const tel = $('reg-tel').value.trim();
        const email = $('reg-email').value.trim();
        const mdp = $('reg-mdp').value.trim();
        const mdp2 = $('reg-mdp2').value.trim();
        const err = $('reg-err');
        err.textContent = '';
        if (!nom) { err.textContent = '❌ Nom obligatoire'; return; }
        if (tel.length !== 9) { err.textContent = '❌ Numéro invalide (9 chiffres)'; return; }
        if (mdp.length < 6) { err.textContent = '❌ Mot de passe trop court (6 min)'; return; }
        if (mdp !== mdp2) { err.textContent = '❌ Mots de passe différents'; return; }
        $('btn-register').textContent = 'Création...';
        const { data, error } = await db.from('utilisateurs').insert([{ nom, telephone: tel, email: email||null, mot_de_passe: mdp }]).select().single();
        $('btn-register').textContent = 'Créer mon compte';
        if (error) { err.textContent = error.message.includes('unique') ? '❌ Ce numéro existe déjà' : '❌ ' + error.message; return; }
        currentUser = data;
        localStorage.setItem('cmkt_user', JSON.stringify(data));
        showUserUI();
        closeOverlay('auth-overlay');
    };

    $('btn-logout').onclick = () => {
        currentUser = null;
        localStorage.removeItem('cmkt_user');
        $('user-zone').style.display = 'none';
        $('btn-auth-show').style.display = '';
        panier = []; updatePanierBtn();
        renderProducts(allProducts);
    };

    $('btn-commandes').onclick = chargerCommandes;
}

function showUserUI() {
    $('user-nom').textContent = '👤 ' + currentUser.nom.split(' ')[0];
    $('user-zone').style.display = 'flex';
    $('btn-auth-show').style.display = 'none';
}

// ===== BANNIÈRE =====
async function chargerBanniere() {
    const { data } = await db.from('bannières').select('*').eq('actif', true).eq('type', 'banniere');
    if (!data || !data.length) return;
    const txt = data.map(b => '📢 ' + b.message).join('   •   ');
    $('banniere-text').textContent = txt + '   •   ' + txt;
    $('banniere-top').style.display = 'block';
}

// ===== POPUP =====
async function afficherPopup() {
    const { data: msgs } = await db.from('bannières').select('*').eq('actif', true).eq('type', 'popup');
    const { data: flash } = await db.from('products').select('*').eq('flash_active', true).limit(4);
    if (!msgs?.length && !flash?.length) return;
    const msg = msgs?.[0]?.message || '🎉 Bienvenue sur CAMERTECH MARKET !';
    const prods = flash?.length ? `<p style="font-weight:700;color:var(--orange);margin:14px 0 8px">⚡ Ventes Flash</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
        ${flash.map(p=>`<div onclick="closePopup();openModal('${p.id}')" style="background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px;cursor:pointer;text-align:center">
            ${p.image_url?`<img src="${p.image_url}" style="width:100%;height:55px;object-fit:cover;border-radius:6px;margin-bottom:6px">`:''}
            <div style="font-size:0.75rem;font-weight:600">${p.name}</div>
            <div style="font-size:0.8rem;color:var(--orange);font-weight:700">${fmt(getPrix(p))} F</div>
        </div>`).join('')}</div>` : '';
    const el = document.createElement('div');
    el.id = 'popup-overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)';
    el.innerHTML = `<div style="background:var(--card);border-radius:18px;padding:28px;max-width:400px;width:100%;text-align:center;position:relative;max-height:90vh;overflow-y:auto">
        <button onclick="closePopup()" style="position:absolute;top:12px;right:12px;background:var(--bg);border:none;border-radius:50%;width:30px;height:30px;cursor:pointer;font-size:0.9rem;color:var(--text)">✕</button>
        <img src="logo.png" style="height:55px;width:55px;border-radius:50%;margin-bottom:12px">
        <h2 style="font-family:Poppins,sans-serif;color:var(--green);margin-bottom:8px">CAMERTECH MARKET</h2>
        <p style="color:var(--text2);line-height:1.6;margin-bottom:10px">${msg}</p>
        ${prods}
        <button onclick="closePopup()" style="background:var(--green);color:white;border:none;padding:12px 28px;border-radius:10px;font-weight:700;cursor:pointer;font-size:0.95rem;font-family:Inter,sans-serif">Explorer →</button>
    </div>`;
    document.body.appendChild(el);
}
window.closePopup = () => { const el = $('popup-overlay'); if(el) el.remove(); };

// ===== SLIDER =====
function initSlider(slidesData) {
    const track = $('slider-track');
    const dots = $('slider-dots');
    track.innerHTML = '';
    dots.innerHTML = '';
    totalSlides = slidesData && slidesData.length > 0 ? slidesData.length : 1;

    if (slidesData && slidesData.length > 0) {
        slidesData.forEach((s, i) => {
            const slide = document.createElement('div');
            slide.className = 'slide';
            if (s.image_url) {
                slide.style.cssText = `background-image:url(${s.image_url});background-size:cover;background-position:center`;
                slide.innerHTML = `<div class="slide-inner" style="background:linear-gradient(90deg,rgba(0,0,0,0.65),transparent)">
                    <div class="slide-tag">${s.tag||'🔥 PROMO'}</div>
                    <h2>${s.titre||''}<br><span>${s.sous_titre||''}</span></h2>
                    <p>${s.message||''}</p>
                    ${s.btn_texte?`<button class="slide-btn">${s.btn_texte}</button>`:''}
                </div>`;
            } else {
                slide.className = 'slide slide-default';
                slide.innerHTML = `<div class="slide-inner">
                    <div class="slide-tag">🔥 BIENVENUE</div>
                    <h2>Les meilleurs produits<br><span>Tech au Cameroun</span></h2>
                    <p>Livraison rapide à Douala • Qualité garantie</p>
                    <button class="slide-btn" onclick="$('produits').scrollIntoView({behavior:'smooth'})">Découvrir →</button>
                </div>`;
            }
            track.appendChild(slide);
            const dot = document.createElement('button');
            dot.className = 'slider-dot' + (i===0?' active':'');
            dot.onclick = () => goSlide(i);
            dots.appendChild(dot);
        });
    } else {
        const slide = document.createElement('div');
        slide.className = 'slide slide-default';
        slide.innerHTML = `<div class="slide-inner">
            <div class="slide-tag">🔥 BIENVENUE</div>
            <h2>Les meilleurs produits<br><span>Tech au Cameroun</span></h2>
            <p>Livraison rapide à Douala • Qualité garantie</p>
            <button class="slide-btn" id="slide-decouvrir">Découvrir →</button>
        </div>`;
        track.appendChild(slide);
        const dot = document.createElement('button');
        dot.className = 'slider-dot active';
        dots.appendChild(dot);
        const btn = document.getElementById('slide-decouvrir');
        if (btn) btn.onclick = () => $('produits').scrollIntoView({behavior:'smooth'});
    }

    if (slideTimer) clearInterval(slideTimer);
    if (totalSlides > 1) slideTimer = setInterval(() => goSlide((slideIndex+1) % totalSlides), 4500);

    $('slider-prev').onclick = () => goSlide((slideIndex - 1 + totalSlides) % totalSlides);
    $('slider-next').onclick = () => goSlide((slideIndex + 1) % totalSlides);
    $('slide-btn-decouvrir') && ($('slide-btn-decouvrir').onclick = () => $('produits').scrollIntoView({behavior:'smooth'}));
}

function goSlide(i) {
    slideIndex = i;
    $('slider-track').style.transform = `translateX(-${i * 100}%)`;
    document.querySelectorAll('.slider-dot').forEach((d, j) => d.classList.toggle('active', j === i));
}

// ===== CATÉGORIES =====
function setupCategories() {
    document.querySelectorAll('.cat-pill').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCat = btn.dataset.cat;
            renderProducts(allProducts);
            $('produits').scrollIntoView({behavior:'smooth'});
        };
    });

    document.querySelectorAll('.tuile').forEach(t => {
        t.onclick = () => {
            if (t.dataset.action === 'flash') { filtrerFlash(); return; }
            filtrerCat(t.dataset.cat);
        };
    });
}

function filtrerCat(cat) {
    currentCat = cat;
    document.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    renderProducts(allProducts);
    $('produits').scrollIntoView({behavior:'smooth'});
}

// ===== RECHERCHE =====
function setupSearch() {
    $('search-bar').oninput = e => {
        const q = e.target.value.toLowerCase().trim();
        renderProducts(q ? allProducts.filter(p => p.name.toLowerCase().includes(q) || (p.description||'').toLowerCase().includes(q)) : allProducts);
    };
}

// ===== PRODUITS =====
async function fetchProducts() {
    try {
        const { data, error } = await db.from('products').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        allProducts = data || [];
        renderProducts(allProducts);
        chargerFlash(allProducts);
        const { data: slidesData } = await db.from('bannières').select('*').eq('type', 'slider').eq('actif', true);
        initSlider(slidesData);
    } catch(e) { console.error(e); renderProducts([]); initSlider([]); }
    finally { hide('loader'); }
}

function renderProducts(products) {
    const grid = $('product-grid');
    const filtered = currentCat === 'tous' ? products : products.filter(p => p.category === currentCat);
    $('prod-count').textContent = filtered.length + ' produit(s)';
    grid.innerHTML = '';
    if (!filtered.length) { grid.innerHTML = '<div class="empty-state">Aucun produit disponible.</div>'; return; }
    filtered.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card';
        const prix = getPrix(p);
        const hasPromo = (p.promo_active || p.flash_active) && p.promo_prix;
        const pct = hasPromo ? `-${Math.round((1-p.promo_prix/p.resale_price)*100)}%` : '';
        card.innerHTML = `
            <div class="card-img-wrap">
                ${p.image_url ? `<img src="${p.image_url}" alt="${p.name}" class="card-img" loading="lazy">` : '<div class="card-img-ph">📦</div>'}
                ${p.quantity < 5 && p.quantity > 0 ? '<span class="badge badge-low">Stock faible</span>' : ''}
                ${p.flash_active ? '<span class="badge badge-flash">⚡ FLASH</span>' : isNew(p.created_at) ? '<span class="badge badge-new">🆕</span>' : ''}
                ${p.promo_active && !p.flash_active ? '<span class="badge badge-promo">🔥 PROMO</span>' : ''}
                ${pct ? `<span class="badge badge-pct">${pct}</span>` : ''}
            </div>
            <div class="card-body">
                <div class="card-cat">${p.category}</div>
                <div class="card-name">${p.name}</div>
                <div class="card-qty">Qté : ${p.quantity}</div>
                ${hasPromo ? `<div class="prix-barre-sm">${fmt(p.resale_price)} FCFA</div>` : ''}
                <div class="card-price ${hasPromo?'promo':''}">${fmt(prix)} FCFA</div>
                <button class="btn-acheter">Voir détails</button>
                ${isAdmin ? `<div class="card-admin-btns">
                    <button class="btn-sm-edit" data-id="${p.id}">✏️</button>
                    <button class="btn-sm-del" data-id="${p.id}">🗑️</button>
                    <button class="btn-sm-flash" data-id="${p.id}" data-flash="${p.flash_active}">⚡</button>
                </div>` : ''}
            </div>`;
        card.querySelector('.btn-acheter').onclick = e => { e.stopPropagation(); openModal(p.id); };
        card.onclick = () => openModal(p.id);
        if (isAdmin) {
            card.querySelector('.btn-sm-edit').onclick = e => { e.stopPropagation(); chargerEditAdmin(p.id); };
            card.querySelector('.btn-sm-del').onclick = e => { e.stopPropagation(); supprimerProduit(p.id); };
            card.querySelector('.btn-sm-flash').onclick = e => { e.stopPropagation(); toggleFlash(p.id, p.flash_active); };
        }
        grid.appendChild(card);
    });
}

// ===== FLASH =====
let flashInterval = null;
function filtrerFlash() {
    renderProducts(allProducts.filter(p => p.flash_active));
    $('produits').scrollIntoView({behavior:'smooth'});
}

function chargerFlash(prods) {
    const flash = prods.filter(p => p.flash_active && p.flash_fin && new Date(p.flash_fin) > new Date());
    const sec = $('flash-section');
    if (!flash.length) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    const grid = $('flash-grid');
    grid.innerHTML = '';
    flash.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card';
        const prix = getPrix(p);
        card.innerHTML = `<div class="card-img-wrap">
            ${p.image_url ? `<img src="${p.image_url}" class="card-img">` : '<div class="card-img-ph">📦</div>'}
            <span class="badge badge-flash">⚡ FLASH</span>
        </div>
        <div class="card-body">
            <div class="card-name">${p.name}</div>
            <div class="prix-barre-sm">${fmt(p.resale_price)} FCFA</div>
            <div class="card-price promo">${fmt(prix)} FCFA</div>
            <button class="btn-acheter">Ajouter au panier</button>
        </div>`;
        card.querySelector('.btn-acheter').onclick = () => openModal(p.id);
        grid.appendChild(card);
    });
    if (flashInterval) clearInterval(flashInterval);
    const timer = $('flash-timer');
    const tick = () => {
        const fin = flash.reduce((m,p)=>{ const d=new Date(p.flash_fin); return d<m?d:m; }, new Date(flash[0].flash_fin));
        const diff = fin - new Date();
        if (diff <= 0) { clearInterval(flashInterval); sec.style.display='none'; return; }
        const h=Math.floor(diff/3600000), m=Math.floor((diff%3600000)/60000), s=Math.floor((diff%60000)/1000);
        timer.textContent = `⏱ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    tick(); flashInterval = setInterval(tick, 1000);
}

async function afficherMeilleuresVentes() {
    const { data } = await db.from('reservations').select('items');
    const counts = {};
    (data||[]).forEach(r => (r.items||[]).forEach(i => { counts[i.name]=(counts[i.name]||0)+i.qty; }));
    const sorted = [...allProducts].sort((a,b) => (counts[b.name]||0)-(counts[a.name]||0));
    renderProducts(sorted);
    $('produits').scrollIntoView({behavior:'smooth'});
}

// ===== MODAL PRODUIT =====
async function openModal(productId) {
    const p = allProducts.find(x => x.id === productId);
    if (!p) return;
    modalProduct = p;
    $('qty-val').textContent = '1';
    $('prod-name').textContent = p.name;
    $('prod-desc').textContent = p.description || '';
    $('prod-cat-tag').textContent = p.category;
    $('prod-new-tag').style.display = isNew(p.created_at) ? 'inline-block' : 'none';
    $('prod-low-tag').style.display = p.quantity < 5 ? 'inline-block' : 'none';
    $('prod-flash-tag').style.display = p.flash_active ? 'block' : 'none';
    $('prod-stock').textContent = `Quantité disponible : ${p.quantity}`;
    const prix = getPrix(p);
    $('prod-price').textContent = fmt(prix) + ' FCFA';
    if ((p.promo_active || p.flash_active) && p.promo_prix) {
        $('prod-prix-barre').textContent = fmt(p.resale_price) + ' FCFA';
        $('prod-prix-barre').style.display = 'block';
    } else { $('prod-prix-barre').style.display = 'none'; }
    const img = $('prod-img');
    if (p.image_url) { img.src = p.image_url; img.style.display = 'block'; } else img.style.display = 'none';
    const waMsg = encodeURIComponent(`Bonjour CAMERTECH MARKET, intéressé par : ${p.name} (${fmt(prix)} FCFA)`);
    $('prod-wa').href = `https://wa.me/${CONFIG.WA1}?text=${waMsg}`;
    if (currentUser) { $('prod-actions').style.display='flex'; $('prod-login-hint').style.display='none'; }
    else { $('prod-actions').style.display='none'; $('prod-login-hint').style.display='block'; }
    openOverlay('prod-overlay');
    chargerCrossSell(p);
    chargerAvis(p.id);
}

$('prod-close').onclick = () => closeOverlay('prod-overlay');
$('prod-overlay').onclick = e => { if(e.target===$('prod-overlay')) closeOverlay('prod-overlay'); };
$('qty-minus').onclick = () => { const v=parseInt($('qty-val').textContent); if(v>1) $('qty-val').textContent=v-1; };
$('qty-plus').onclick = () => { const v=parseInt($('qty-val').textContent); if(v<modalProduct.quantity) $('qty-val').textContent=v+1; };
$('btn-add-cart').onclick = () => {
    const qty = parseInt($('qty-val').textContent);
    const prix = getPrix(modalProduct);
    const ex = panier.find(x => x.id === modalProduct.id);
    if (ex) ex.qty = Math.min(ex.qty+qty, modalProduct.quantity);
    else panier.push({ id:modalProduct.id, name:modalProduct.name, prix, qty, image_url:modalProduct.image_url });
    updatePanierBtn();
    closeOverlay('prod-overlay');
    const btn = $('panier-btn');
    btn.style.transform = 'scale(1.2)';
    setTimeout(() => btn.style.transform='', 200);
};

// ===== CROSS-SELLING =====
async function chargerCrossSell(p) {
    const zone = $('cross-sell-zone');
    zone.innerHTML = '';
    const { data } = await db.from('products').select('*').eq('category', p.category).neq('id', p.id).limit(4);
    if (!data?.length) return;
    zone.innerHTML = `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <h4 style="font-size:0.88rem;color:var(--text2);margin-bottom:10px">💡 Souvent achetés ensemble</h4>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none">
            ${data.map(cs=>`<div onclick="closeOverlay('prod-overlay');setTimeout(()=>openModal('${cs.id}'),100)" style="min-width:110px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px;cursor:pointer;text-align:center;flex-shrink:0">
                ${cs.image_url?`<img src="${cs.image_url}" style="width:100%;height:55px;object-fit:cover;border-radius:6px;margin-bottom:6px">`:'<div style="height:55px;display:flex;align-items:center;justify-content:center;font-size:1.5rem">📦</div>'}
                <div style="font-size:0.72rem;font-weight:600;line-height:1.2;margin-bottom:4px">${cs.name}</div>
                <div style="font-size:0.8rem;color:var(--orange);font-weight:700">${fmt(getPrix(cs))} F</div>
                <button onclick="event.stopPropagation();addQuick('${cs.id}')" style="width:100%;background:var(--orange);color:white;border:none;padding:4px;border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;margin-top:4px">+ Ajouter</button>
            </div>`).join('')}
        </div>
    </div>`;
}

window.addQuick = id => {
    if (!currentUser) return;
    const p = allProducts.find(x=>x.id===id);
    if (!p) return;
    const ex = panier.find(x=>x.id===id);
    if (ex) ex.qty++;
    else panier.push({id:p.id, name:p.name, prix:getPrix(p), qty:1});
    updatePanierBtn();
};

// ===== AVIS =====
async function chargerAvis(productId) {
    const zone = $('avis-zone');
    const { data } = await db.from('avis').select('*').eq('product_id', productId).eq('valide', true).order('created_at', {ascending:false});
    const moy = data?.length ? (data.reduce((s,a)=>s+a.note,0)/data.length).toFixed(1) : 0;
    const stars = n => '★'.repeat(Math.round(n))+'☆'.repeat(5-Math.round(n));
    zone.innerHTML = `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <h3 style="font-size:1rem;font-weight:700;margin-bottom:12px">⭐ Avis clients</h3>
        ${data?.length?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <span style="font-size:2rem;font-weight:800;color:var(--orange);font-family:Poppins,sans-serif">${moy}</span>
            <div><div style="color:#f4c430;font-size:1.1rem">${stars(moy)}</div><div style="color:var(--text3);font-size:0.82rem">${data.length} avis</div></div>
        </div>`:''}
        ${currentUser?`<button onclick="toggleFormAvis('${productId}')" style="background:var(--bg);color:var(--text);border:1.5px solid var(--border);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:0.85rem;margin-bottom:12px">✏️ Laisser un avis</button>`:''}
        <div id="form-avis-${productId}" style="display:none;background:var(--bg);border-radius:10px;padding:14px;margin-bottom:14px;border:1px solid var(--border)">
            <h4 style="margin-bottom:10px;font-size:0.95rem">Votre avis</h4>
            <div id="stars-${productId}" style="display:flex;gap:4px;margin-bottom:10px">
                ${[1,2,3,4,5].map(i=>`<button onclick="setNote(${i},'${productId}')" style="font-size:1.5rem;cursor:pointer;filter:grayscale(1);background:none;border:none;padding:0" class="star-btn-${productId}">★</button>`).join('')}
            </div>
            <textarea id="avis-txt-${productId}" placeholder="Votre commentaire..." rows="3" style="width:100%;background:var(--card);border:1.5px solid var(--border);padding:10px;color:var(--text);border-radius:8px;font-size:0.88rem;resize:vertical;font-family:Inter,sans-serif;margin-bottom:10px"></textarea>
            <label style="display:inline-block;background:var(--card);color:var(--text);padding:7px 14px;border-radius:7px;cursor:pointer;border:1px solid var(--border);font-size:0.82rem;margin-bottom:10px">
                📷 Ajouter une photo<input type="file" id="avis-file-${productId}" accept="image/*" style="display:none" onchange="previewAvis(this,'${productId}')">
            </label>
            <img id="avis-preview-${productId}" src="" style="display:none;width:60px;height:60px;object-fit:cover;border-radius:6px;margin-left:8px;vertical-align:middle">
            <button onclick="soumettreAvis('${productId}')" style="width:100%;background:var(--green);color:white;border:none;padding:11px;border-radius:8px;font-weight:700;cursor:pointer;margin-top:6px">Publier</button>
            <p id="avis-msg-${productId}" style="min-height:18px;font-size:0.82rem;margin-top:6px"></p>
        </div>
        ${data?.length?data.map(a=>`<div style="background:var(--bg);border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <strong style="font-size:0.88rem">${a.nom_client}</strong>
                <span style="color:var(--text3);font-size:0.75rem">${new Date(a.created_at).toLocaleDateString('fr-FR')}</span>
            </div>
            <div style="color:#f4c430;font-size:0.9rem">${stars(a.note)}</div>
            ${a.commentaire?`<p style="color:var(--text2);font-size:0.85rem;margin-top:6px">${a.commentaire}</p>`:''}
            ${a.photo_url?`<img src="${a.photo_url}" style="width:75px;height:75px;object-fit:cover;border-radius:7px;margin-top:8px;cursor:pointer" onclick="window.open('${a.photo_url}','_blank')">`:''}
        </div>`).join(''):'<p style="color:var(--text3);font-size:0.85rem">Aucun avis pour le moment.</p>'}
    </div>`;
}

window.toggleFormAvis = id => { const el=$(`form-avis-${id}`); if(el) el.style.display=el.style.display==='none'?'block':'none'; };
window.setNote = (n, id) => {
    selectedNote = n;
    document.querySelectorAll(`.star-btn-${id}`).forEach((btn,i) => btn.style.filter=i<n?'grayscale(0)':'grayscale(1)');
};
window.previewAvis = (input, id) => {
    avisFile = input.files[0]; if(!avisFile)return;
    const reader = new FileReader();
    reader.onload = e => { const img=$(`avis-preview-${id}`); img.src=e.target.result; img.style.display='inline-block'; };
    reader.readAsDataURL(avisFile);
};
window.soumettreAvis = async pid => {
    const msg = $(`avis-msg-${pid}`);
    if (!selectedNote) { msg.style.color='var(--danger)'; msg.textContent='❌ Choisissez une note'; return; }
    let photoUrl = null;
    if (avisFile) { try { photoUrl = await uploadImage(avisFile); } catch(e){} }
    const { error } = await db.from('avis').insert([{
        product_id:pid, utilisateur_id:currentUser.id, nom_client:currentUser.nom,
        note:selectedNote, commentaire:$(`avis-txt-${pid}`).value.trim()||null, photo_url:photoUrl, valide:false
    }]);
    if (error) { msg.style.color='var(--danger)'; msg.textContent='❌ '+error.message; return; }
    msg.style.color='var(--success)'; msg.textContent='✅ Avis soumis ! En attente de validation.';
    selectedNote=0; avisFile=null;
};

// ===== PANIER =====
function updatePanierBtn() {
    const total = panier.reduce((s,p)=>s+p.qty,0);
    $('panier-count').textContent = total;
    $('panier-btn').style.display = total > 0 ? '' : 'none';
}

function setupPanier() {
    $('panier-btn').onclick = openPanier;
    $('panier-close').onclick = () => closeOverlay('panier-overlay');
    $('panier-overlay').onclick = e => { if(e.target===$('panier-overlay')) closeOverlay('panier-overlay'); };
    $('zone-select').onchange = updateLivraison;
    $('btn-payer').onclick = initierPaiement;
    $('btn-reserver').onclick = reserverSansPaiement;
    $('btn-copier').onclick = () => {
        navigator.clipboard.writeText($('code-display').textContent).then(() => {
            $('btn-copier').textContent='✅ Copié !';
            setTimeout(()=>$('btn-copier').textContent='📋 Copier le code',2000);
        });
    };
    $('btn-fermer-code').onclick = () => { closeOverlay('code-overlay'); panier=[]; updatePanierBtn(); };
}

function openPanier() {
    const items = $('panier-items');
    if (!panier.length) {
        items.innerHTML='<div class="panier-vide">Votre panier est vide. 🛒</div>';
        $('panier-totaux').innerHTML='';
        $('btn-payer').style.display='none';
        $('btn-reserver').style.display='none';
    } else {
        $('btn-payer').style.display='';
        $('btn-reserver').style.display='';
        renderPanier();
    }
    openOverlay('panier-overlay');
}

function renderPanier() {
    const items = $('panier-items');
    items.innerHTML='';
    let sousTotal=0;
    panier.forEach((item,i)=>{
        const st=item.prix*item.qty; sousTotal+=st;
        const d=document.createElement('div');
        d.className='panier-item';
        d.innerHTML=`<div class="panier-item-info"><strong>${item.name}</strong><span>${fmt(item.prix)} FCFA × ${item.qty}</span></div>
            <div class="panier-item-price">${fmt(st)} FCFA</div>
            <button class="btn-rm" data-idx="${i}">✕</button>`;
        d.querySelector('.btn-rm').onclick = e => { panier.splice(parseInt(e.target.dataset.idx),1); updatePanierBtn(); openPanier(); };
        items.appendChild(d);
    });
    updateTotaux(sousTotal);
}

function updateTotaux(sousTotal) {
    const total = sousTotal + fraisLivraison;
    $('panier-totaux').innerHTML=`<div class="totaux-box">
        <div class="total-ligne"><span>Sous-total</span><span>${fmt(sousTotal)} FCFA</span></div>
        <div class="total-ligne"><span>Livraison</span><span>${fraisLivraison>0?fmt(fraisLivraison)+' FCFA':'—'}</span></div>
        <div class="total-final"><span>Total</span><span>${fmt(total)} FCFA</span></div>
    </div>`;
}

function updateLivraison() {
    const zone=$('zone-select').value;
    userZone=zone;
    fraisLivraison=zone==='retrait'?0:zone?1000:0;
    const info=$('livraison-info');
    if(zone){
        info.style.display='block';
        info.className='livraison-info '+(fraisLivraison===0?'lv-ok':'lv-pay');
        info.textContent=fraisLivraison===0?'🏪 Retrait gratuit en boutique':`🚚 Livraison à ${zone} : 1 000 FCFA`;
    } else info.style.display='none';
    if(panier.length) renderPanier();
}

// ===== PAIEMENT =====
function setupPaiement() {
    $('pay-close').onclick = () => closeOverlay('pay-overlay');
    $('pay-mtn').onclick = () => { selectedOp='mtn'; $('pay-mtn').classList.add('active'); $('pay-orange').classList.remove('active'); };
    $('pay-orange').onclick = () => { selectedOp='orange'; $('pay-orange').classList.add('active'); $('pay-mtn').classList.remove('active'); };
    $('btn-pay-confirm').onclick = confirmerPaiement;
}

function initierPaiement() {
    if (!currentUser) { alert('Connectez-vous pour payer.'); return; }
    if (!userZone) { alert('Choisissez votre zone de livraison.'); return; }
    const total = panier.reduce((s,p)=>s+p.prix*p.qty,0) + fraisLivraison;
    $('pay-amount').textContent = fmt(total) + ' FCFA';
    $('pay-tel').value = currentUser.telephone || '';
    $('pay-status').textContent='';
    $('btn-pay-confirm').disabled=false;
    $('btn-pay-confirm').textContent='Payer maintenant';
    closeOverlay('panier-overlay');
    openOverlay('pay-overlay');
}

async function confirmerPaiement() {
    const tel = $('pay-tel').value.trim();
    const status = $('pay-status');
    const btn = $('btn-pay-confirm');
    if (tel.length!==9) { status.style.color='var(--danger)'; status.textContent='❌ Numéro invalide (9 chiffres)'; return; }
    btn.disabled=true; btn.textContent='Traitement...';
    status.style.color='var(--text3)'; status.textContent='📲 Envoi de la demande...';
    try {
        const total=panier.reduce((s,p)=>s+p.prix*p.qty,0)+fraisLivraison;
        const code='CMT-'+Math.random().toString(36).substring(2,5).toUpperCase()+'-'+Date.now().toString().slice(-4);
        await db.from('reservations').insert([{
            utilisateur_id:currentUser.id, nom_client:currentUser.nom, telephone:currentUser.telephone,
            code, items:panier.map(p=>({name:p.name,qty:p.qty,prix:p.prix})),
            total, zone_livraison:userZone, frais_livraison:fraisLivraison, statut:'paiement_en_cours',
            note:$('note-cmd').value||null
        }]);
        const resp = await fetch(CONFIG.API.INITIER_PAIEMENT, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ telephone:tel, montant:Math.round(total), operateur:selectedOp, reference:code, nom_client:currentUser.nom.split(' ')[0] })
        });
        const result = await resp.json();
        if (result.success) {
            status.style.color='var(--success)'; status.textContent='✅ Confirmez sur votre téléphone !';
            let tries=0;
            const poll=setInterval(async()=>{
                tries++;
                if(tries>24){clearInterval(poll);return;}
                try {
                    const cr=await fetch(CONFIG.API.VERIFIER_PAIEMENT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_id:result.transaction_id})});
                    const chk=await cr.json();
                    if(chk.transaction_status==='SUCCESSFUL'||chk.status==='success'){
                        clearInterval(poll); closeOverlay('pay-overlay');
                        afficherCode(code,total); panier=[]; updatePanierBtn();
                    } else if(chk.transaction_status==='FAILED'){
                        clearInterval(poll); status.style.color='var(--danger)'; status.textContent='❌ Paiement refusé.';
                        btn.disabled=false; btn.textContent='Réessayer';
                    }
                } catch(e){}
            },5000);
        } else throw new Error(result.error||'Échec paiement');
    } catch(e) {
        status.style.color='var(--danger)'; status.textContent='❌ '+(e.message||'Erreur. Réessayez.');
        btn.disabled=false; btn.textContent='Payer maintenant';
    }
}

async function reserverSansPaiement() {
    if (!currentUser) { alert('Connectez-vous pour réserver.'); return; }
    if (!userZone) { alert('Choisissez votre zone de livraison.'); return; }
    const total=panier.reduce((s,p)=>s+p.prix*p.qty,0)+fraisLivraison;
    const code='CMT-'+Math.random().toString(36).substring(2,5).toUpperCase()+'-'+Date.now().toString().slice(-4);
    await db.from('reservations').insert([{
        utilisateur_id:currentUser.id, nom_client:currentUser.nom, telephone:currentUser.telephone,
        code, items:panier.map(p=>({name:p.name,qty:p.qty,prix:p.prix})),
        total, zone_livraison:userZone, frais_livraison:fraisLivraison, statut:'en attente',
        note:$('note-cmd').value||null
    }]);
    closeOverlay('panier-overlay');
    afficherCode(code,total);
    const waMsg=encodeURIComponent(`🛒 CAMERTECH MARKET\n\n👤 ${currentUser.nom}\n📞 ${currentUser.telephone}\n📍 Zone: ${userZone}\n🔑 Code: ${code}\n\n${panier.map(p=>`• ${p.name} ×${p.qty} = ${fmt(p.prix*p.qty)} F`).join('\n')}\n\n💰 TOTAL: ${fmt(total)} FCFA`);
    setTimeout(()=>window.open(`https://wa.me/${CONFIG.WA1}?text=${waMsg}`,'_blank'),500);
    panier=[]; updatePanierBtn();
}

function afficherCode(code, total) {
    $('code-display').textContent = code;
    let html=panier.map(p=>`<div class="recap-ligne"><span>${p.name} ×${p.qty}</span><span>${fmt(p.prix*p.qty)} F</span></div>`).join('');
    if(fraisLivraison>0) html+=`<div class="recap-ligne"><span>🚚 Livraison (${userZone})</span><span>${fmt(fraisLivraison)} F</span></div>`;
    html+=`<div class="recap-total"><span>Total</span><span>${fmt(total)} FCFA</span></div>`;
    $('code-recap').innerHTML=html;
    closeOverlay('panier-overlay');
    openOverlay('code-overlay');
}

// ===== AUTRES MODALS =====
function setupModals() {
    $('suivi-close').onclick = () => closeOverlay('suivi-overlay');
    $('loc-close').onclick = () => closeOverlay('loc-overlay');
    $('cmds-close').onclick = () => closeOverlay('cmds-overlay');
    $('btn-suivi').onclick = suivreCommande;
    document.addEventListener('keydown', e => {
        if(e.key==='Escape') document.querySelectorAll('.modal-overlay').forEach(m=>m.style.display='none');
    });
}

async function suivreCommande() {
    const code=$('suivi-input').value.trim().toUpperCase();
    const res=$('suivi-result'); if(!code)return;
    const {data}=await db.from('reservations').select('*').eq('code',code).single();
    if(!data){res.innerHTML='<p style="color:var(--danger)">❌ Code introuvable : '+code+'</p>';return;}
    const statuts={'en attente':'⏳ En attente','valide':'✅ Validée','livre':'🚚 Livrée','annule':'❌ Annulée','paiement_en_cours':'💳 Paiement en cours'};
    res.innerHTML=`<div style="background:var(--bg);border-radius:10px;padding:14px;border:1px solid var(--border)">
        <div style="font-family:monospace;color:var(--green);font-weight:700;margin-bottom:6px">${data.code}</div>
        <div style="font-size:1.05rem;margin-bottom:6px">${statuts[data.statut]||data.statut}</div>
        <div style="color:var(--text3);font-size:0.82rem">📅 ${new Date(data.created_at).toLocaleString('fr-FR')}</div>
        <div style="color:var(--text3);font-size:0.82rem">📍 ${data.zone_livraison||'Non précisé'}</div>
        <div style="color:var(--green);font-weight:700;margin-top:8px">${fmt(data.total)} FCFA</div>
    </div>`;
}

async function chargerCommandes() {
    if(!currentUser)return;
    const {data}=await db.from('reservations').select('*').eq('utilisateur_id',currentUser.id).order('created_at',{ascending:false});
    const list=$('cmds-list');
    list.innerHTML=!data?.length?'<p style="color:var(--text3);text-align:center;padding:20px">Aucune commande.</p>'
        :data.map(r=>`<div style="background:var(--bg);border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid var(--border)">
            <div style="font-family:monospace;color:var(--green);font-weight:700">${r.code}</div>
            <div style="color:var(--text3);font-size:0.78rem;margin:4px 0">📅 ${new Date(r.created_at).toLocaleString('fr-FR')} • 📍 ${r.zone_livraison||'—'}</div>
            <span style="display:inline-block;padding:3px 12px;border-radius:10px;font-size:0.72rem;font-weight:700;background:${r.statut==='en attente'?'#fff8f0':r.statut==='valide'?'#f0fff4':'#fff0f0'};color:${r.statut==='en attente'?'var(--orange)':r.statut==='valide'?'var(--success)':'var(--danger)'}">${r.statut}</span>
            <div style="color:var(--text2);font-size:0.82rem;margin-top:6px">${r.items.map(i=>`${i.name} ×${i.qty}`).join(', ')}</div>
            <div style="color:var(--green);font-weight:700;margin-top:4px">${fmt(r.total)} FCFA</div>
        </div>`).join('');
    openOverlay('cmds-overlay');
}

// ===== LOGIN ADMIN =====
function afficherLoginAdmin() {
    document.body.innerHTML=`
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f4;padding:20px;font-family:Inter,sans-serif">
        <div style="background:white;border-radius:18px;padding:36px;max-width:380px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.1)">
            <img src="logo.png" style="height:70px;width:70px;border-radius:50%;margin-bottom:14px;border:3px solid #1a5c2a">
            <h1 style="color:#1a5c2a;font-family:Poppins,sans-serif;margin-bottom:4px;font-size:1.3rem">CAMERTECH MARKET</h1>
            <p style="color:#888;font-size:0.85rem;margin-bottom:24px">Espace Administrateur</p>
            <div id="step1">
                <input type="text" id="adm-id" placeholder="Identifiant admin" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:10px;font-size:0.95rem;font-family:Inter,sans-serif">
                <input type="password" id="adm-mdp" placeholder="Mot de passe" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:16px;font-size:0.95rem;font-family:Inter,sans-serif">
                <button onclick="adminStep1()" style="width:100%;background:#1a5c2a;color:white;border:none;padding:14px;border-radius:10px;font-weight:700;cursor:pointer;font-size:1rem;font-family:Poppins,sans-serif">Continuer →</button>
            </div>
            <div id="step2" style="display:none">
                <p style="color:#2dc653;font-size:0.88rem;margin-bottom:14px">✅ Code envoyé sur WhatsApp !</p>
                <input type="text" id="adm-code" placeholder="Code WhatsApp (4 chiffres)" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:16px;font-size:1.2rem;text-align:center;letter-spacing:6px;font-family:Inter,sans-serif">
                <button onclick="adminStep2()" style="width:100%;background:#1a5c2a;color:white;border:none;padding:14px;border-radius:10px;font-weight:700;cursor:pointer;font-size:1rem">Confirmer</button>
            </div>
            <p id="adm-err" style="color:#e63946;font-size:0.85rem;min-height:20px;margin-top:10px"></p>
        </div>
    </div>`;
}

let adminCodeTemp=null, adminTemp=null, adminTries=0;

window.adminStep1 = () => {
    const id=document.getElementById('adm-id').value.trim();
    const mdp=document.getElementById('adm-mdp').value.trim();
    const err=document.getElementById('adm-err');
    const admin=CONFIG.ADMINS.find(a=>a.id===id&&a.mdp===mdp);
    if(!admin){adminTries++;err.textContent=`❌ Identifiant ou mot de passe incorrect (${adminTries}/3)`;if(adminTries>=3){document.getElementById('step1').style.opacity='0.4';document.getElementById('step1').style.pointerEvents='none';err.textContent='🚫 Trop de tentatives.';}return;}
    adminTemp=admin;
    adminCodeTemp=Math.floor(1000+Math.random()*9000).toString();
    const msg=encodeURIComponent(`🔐 CAMERTECH MARKET\nCode admin : ${adminCodeTemp}\nValide 5 min.`);
    window.open(`https://wa.me/${admin.wa}?text=${msg}`,'_blank');
    document.getElementById('step1').style.display='none';
    document.getElementById('step2').style.display='block';
    setTimeout(()=>{adminCodeTemp=null;},5*60*1000);
};

window.adminStep2 = () => {
    const code=document.getElementById('adm-code').value.trim();
    const err=document.getElementById('adm-err');
    if(!adminCodeTemp){err.textContent='❌ Code expiré. Recommencez.';return;}
    if(code!==adminCodeTemp){err.textContent='❌ Code incorrect';return;}
    isAdmin=true; currentAdmin=adminTemp;
    afficherPanneauAdmin();
};

// ===== PANNEAU ADMIN (simplifié mais complet) =====
async function afficherPanneauAdmin() {
    const page=document.getElementById('admin-page');
    page.style.display='block';
    page.innerHTML='<div style="text-align:center;padding:60px;color:#888;font-family:Inter,sans-serif">Chargement du panneau...</div>';

    const [{data:prods},{data:users},{data:reservations},{data:avisListe},{data:bannieres}]=await Promise.all([
        db.from('products').select('*').order('created_at',{ascending:false}),
        db.from('utilisateurs').select('*').order('created_at',{ascending:false}),
        db.from('reservations').select('*').order('created_at',{ascending:false}),
        db.from('avis').select('*').eq('valide',false),
        db.from('bannières').select('*').eq('actif',true)
    ]);

    const totalV=(reservations||[]).reduce((s,r)=>s+parseFloat(r.total),0);
    const enAtt=(reservations||[]).filter(r=>r.statut==='en attente').length;
    const sfaible=(prods||[]).filter(p=>p.quantity<5&&p.quantity>0);
    const szero=(prods||[]).filter(p=>p.quantity===0);
    window._prods=prods||[]; window._res=reservations||[];

    page.innerHTML=`
    <div style="font-family:Inter,sans-serif">
        <div style="background:#1a5c2a;color:white;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;position:sticky;top:0;z-index:10">
            <h1 style="font-family:Poppins,sans-serif;font-size:1.1rem;margin:0">⚙️ CAMERTECH MARKET Admin</h1>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button onclick="showTab('tab-dash')" class="adm-tab active" id="tb-dash">📊 Dashboard</button>
                <button onclick="showTab('tab-prods')" class="adm-tab" id="tb-prods">📦 Produits</button>
                <button onclick="showTab('tab-cmds')" class="adm-tab" id="tb-cmds">🧾 Commandes</button>
                <button onclick="showTab('tab-users')" class="adm-tab" id="tb-users">👥 Clients</button>
                <button onclick="showTab('tab-avis')" class="adm-tab" id="tb-avis">⭐ Avis(${(avisListe||[]).length})</button>
                <button onclick="showTab('tab-mktg')" class="adm-tab" id="tb-mktg">📢 Marketing</button>
                <button onclick="document.getElementById('admin-page').style.display='none';isAdmin=true;renderProducts(allProducts)" class="adm-tab">🏪 Site</button>
            </div>
        </div>
        <div style="max-width:1200px;margin:0 auto;padding:20px 16px">

        <!-- DASHBOARD -->
        <div id="tab-dash">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px">
                ${[['💰','Total ventes',fmt(totalV)+' F'],['🧾','Réservations',(reservations||[]).length],['⏳','En attente',enAtt],['📦','Produits',(prods||[]).length],['👥','Clients',(users||[]).length],['⚠️','Alertes stock',sfaible.length+szero.length]].map(([ico,lbl,val])=>`
                <div style="background:white;border:1px solid #e8e8e8;border-radius:12px;padding:16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
                    <div style="font-size:1.7rem;margin-bottom:6px">${ico}</div>
                    <div style="font-size:1.2rem;font-weight:800;color:#1a5c2a;font-family:Poppins,sans-serif">${val}</div>
                    <div style="color:#888;font-size:0.75rem;margin-top:2px">${lbl}</div>
                </div>`).join('')}
            </div>
            ${(sfaible.length+szero.length)>0?`<div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:20px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:12px">⚠️ Alertes Stock</h2>
                ${szero.map(p=>`<div style="display:flex;justify-content:space-between;background:#fff0f0;border:1px solid #fcc;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span>🔴 <strong>${p.name}</strong></span><span style="color:#e63946">ÉPUISÉ</span></div>`).join('')}
                ${sfaible.map(p=>`<div style="display:flex;justify-content:space-between;background:#fff8f0;border:1px solid #fdd;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span>🟡 <strong>${p.name}</strong></span><span style="color:#ff6600">${p.quantity} restant(s)</span></div>`).join('')}
            </div>`:''}
        </div>

        <!-- PRODUITS -->
        <div id="tab-prods" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px;margin-bottom:16px">
                <h2 id="prod-form-title" style="font-size:1rem;margin-bottom:16px">➕ Ajouter un Produit</h2>
                <div style="display:flex;flex-direction:column;gap:10px">
                    <input type="text" id="p-name" placeholder="Nom du produit *" class="adm-input">
                    <textarea id="p-desc" placeholder="Description" rows="2" class="adm-input"></textarea>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <select id="p-cat" class="adm-input"><option value="Téléphonie">📱 Téléphonie</option><option value="Accessoires">🎧 Accessoires</option><option value="Électronique">💻 Électronique</option><option value="Réseau">📡 Réseau</option><option value="Gaming">🎮 Gaming</option><option value="Autre">📦 Autre</option></select>
                        <input type="number" id="p-qty" placeholder="Quantité *" class="adm-input">
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <input type="number" id="p-achat" placeholder="Prix achat (FCFA) *" class="adm-input">
                        <input type="number" id="p-vente" placeholder="Prix vente public (FCFA) *" class="adm-input">
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <input type="number" id="p-promo" placeholder="Prix promo (FCFA)" class="adm-input">
                        <label style="display:flex;align-items:center;gap:8px;color:#555;font-size:0.88rem"><input type="checkbox" id="p-promo-chk"> 🔥 Activer promo</label>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <input type="datetime-local" id="p-flash-fin" class="adm-input">
                        <label style="display:flex;align-items:center;gap:8px;color:#555;font-size:0.88rem"><input type="checkbox" id="p-flash-chk"> ⚡ Vente Flash</label>
                    </div>
                    <div style="background:#f4f6f4;border:1.5px dashed #ddd;border-radius:8px;padding:14px">
                        <p style="font-size:0.82rem;color:#888;margin-bottom:8px">📷 Photo (compression automatique -90%)</p>
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                            <label style="background:white;border:1px solid #ddd;padding:9px 14px;border-radius:7px;cursor:pointer;font-size:0.85rem">
                                ⬆️ Uploader<input type="file" id="p-img-file" accept="image/*" style="display:none" onchange="previewAdminImg(this)">
                            </label>
                            <input type="url" id="p-img-url" placeholder="ou URL image" class="adm-input" style="flex:1;min-width:150px">
                        </div>
                        <div id="adm-img-preview" style="display:none;margin-top:10px;position:relative;display:inline-block">
                            <img id="adm-img" src="" style="max-height:140px;border-radius:8px;max-width:100%">
                            <button onclick="resetAdminImg()" style="position:absolute;top:4px;right:4px;background:rgba(255,255,255,0.9);color:#e63946;border:none;border-radius:4px;padding:3px 7px;font-size:0.75rem;cursor:pointer">✕</button>
                        </div>
                    </div>
                    <div style="display:flex;gap:10px">
                        <button onclick="sauvegarderProduit()" style="flex:1;background:#1a5c2a;color:white;border:none;padding:12px;border-radius:9px;font-weight:700;cursor:pointer;font-size:0.95rem">Enregistrer</button>
                        <button id="btn-annuler-edit" onclick="annulerEdit()" style="display:none;background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:12px 16px;border-radius:9px;font-weight:600;cursor:pointer">Annuler</button>
                    </div>
                    <p id="prod-msg" style="min-height:18px;font-size:0.82rem"></p>
                </div>
            </div>
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">📦 Produits (${(prods||[]).length})</h2>
                <div style="overflow-x:auto">
                    <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                        <thead><tr>${['Nom','Catégorie','Stock','Prix','Statut','Actions'].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px">${h}</th>`).join('')}</tr></thead>
                        <tbody>${(prods||[]).map(p=>`<tr style="border-bottom:1px solid #f8f8f8">
                            <td style="padding:10px"><strong>${p.name}</strong></td>
                            <td style="padding:10px;color:#888">${p.category}</td>
                            <td style="padding:10px;font-weight:600;color:${p.quantity===0?'#e63946':p.quantity<5?'#ff6600':'#2dc653'}">${p.quantity}</td>
                            <td style="padding:10px;color:#1a5c2a;font-weight:600">${fmt(p.resale_price)} F</td>
                            <td style="padding:10px">${p.flash_active?'<span style="color:#e63946;font-weight:600">⚡Flash</span>':p.promo_active?'<span style="color:#ff6600;font-weight:600">🔥Promo</span>':'Normal'}</td>
                            <td style="padding:10px"><div style="display:flex;gap:5px">
                                <button onclick="chargerEditProduit('${p.id}')" style="background:#f0fff4;color:#1a5c2a;border:1px solid #b7f5c8;padding:5px 10px;border-radius:6px;font-size:0.78rem;cursor:pointer">✏️</button>
                                <button onclick="supprimerProduit('${p.id}')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:5px 10px;border-radius:6px;font-size:0.78rem;cursor:pointer">🗑️</button>
                                <button onclick="toggleFlash('${p.id}',${p.flash_active})" style="background:#fff8f0;color:#ff6600;border:1px solid #fdd;padding:5px 10px;border-radius:6px;font-size:0.78rem;cursor:pointer">${p.flash_active?'❌Flash':'⚡Flash'}</button>
                            </div></td>
                        </tr>`).join('')}</tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- COMMANDES -->
        <div id="tab-cmds" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">🧾 Commandes</h2>
                <input type="text" id="cmd-search" placeholder="🔎 Rechercher code ou client..." oninput="filtrerCmdsAdmin(this.value)" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:10px 14px;color:#1a1a1a;border-radius:9px;font-size:0.88rem;margin-bottom:14px;font-family:Inter,sans-serif">
                <div id="cmds-admin-table">${renderCmdsAdmin(reservations||[])}</div>
            </div>
        </div>

        <!-- CLIENTS -->
        <div id="tab-users" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">👥 Clients inscrits (${(users||[]).length})</h2>
                <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                    <thead><tr>${['Nom','Téléphone','Email','Inscrit le'].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.75rem">${h}</th>`).join('')}</tr></thead>
                    <tbody>${(users||[]).map(u=>`<tr style="border-bottom:1px solid #f8f8f8">
                        <td style="padding:10px"><strong>${u.nom}</strong></td>
                        <td style="padding:10px">📞 ${u.telephone}</td>
                        <td style="padding:10px;color:#888">${u.email||'—'}</td>
                        <td style="padding:10px;color:#888;font-size:0.78rem">${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                    </tr>`).join('')}</tbody>
                </table></div>
            </div>
        </div>

        <!-- AVIS -->
        <div id="tab-avis" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">⭐ Avis en attente</h2>
                ${!(avisListe||[]).length?'<p style="color:#888">Aucun avis en attente.</p>'
                :(avisListe||[]).map(a=>`<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                        <div><strong>${a.nom_client}</strong> — <span style="color:#f4c430">${'★'.repeat(a.note)}</span></div>
                        <div style="display:flex;gap:6px">
                            <button onclick="validerAvisAdmin('${a.id}')" style="background:#f0fff4;color:#2dc653;border:1px solid #b7f5c8;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">✅ Valider</button>
                            <button onclick="supprimerAvisAdmin('${a.id}')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">🗑️</button>
                        </div>
                    </div>
                    ${a.commentaire?`<p style="color:#555;font-size:0.85rem;margin-top:6px">${a.commentaire}</p>`:''}
                    ${a.photo_url?`<img src="${a.photo_url}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;margin-top:8px">`:''}
                </div>`).join('')}
            </div>
        </div>

        <!-- MARKETING -->
        <div id="tab-mktg" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:14px">📢 Publier un message</h2>
                <div style="display:flex;flex-direction:column;gap:10px">
                    <input type="text" id="mktg-msg" placeholder="Message..." class="adm-input">
                    <select id="mktg-type" class="adm-input">
                        <option value="banniere">📌 Bannière défilante</option>
                        <option value="popup">🔔 Popup à l'arrivée</option>
                        <option value="slider">🖼️ Slide pub (+ image URL)</option>
                    </select>
                    <div id="mktg-slider-extra" style="display:none;flex-direction:column;gap:8px">
                        <input type="text" id="mktg-titre" placeholder="Titre du slide" class="adm-input">
                        <input type="text" id="mktg-tag" placeholder="Tag (ex: 🔥 PROMO)" class="adm-input">
                        <input type="url" id="mktg-img-url" placeholder="URL image de fond" class="adm-input">
                        <input type="text" id="mktg-btn-txt" placeholder="Texte bouton" class="adm-input">
                    </div>
                    <button onclick="publierMessage()" style="background:#1a5c2a;color:white;border:none;padding:12px;border-radius:9px;font-weight:700;cursor:pointer">Publier</button>
                    <p id="mktg-res" style="min-height:18px;font-size:0.82rem"></p>
                </div>
            </div>
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">Messages actifs</h2>
                <div id="mktg-liste">${(bannieres||[]).length?
                    (bannieres||[]).map(b=>`<div style="background:#f8f8f8;border-radius:8px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                        <div><span style="background:${b.type==='popup'?'#0088ff':b.type==='slider'?'#ff6600':'#1a5c2a'};color:white;padding:2px 8px;border-radius:4px;font-size:0.72rem;font-weight:700">${b.type.toUpperCase()}</span><span style="margin-left:8px;font-size:0.88rem">${b.message}</span></div>
                        <button onclick="desactiverBanniere('${b.id}')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">Désactiver</button>
                    </div>`).join(''):'<p style="color:#888">Aucun message actif.</p>'}
                </div>
            </div>
        </div>

        </div>
    </div>
    <style>
        .adm-tab{background:rgba(255,255,255,0.15);color:white;border:none;padding:7px 12px;border-radius:7px;cursor:pointer;font-size:0.78rem;font-weight:600;font-family:Inter,sans-serif}
        .adm-tab:hover,.adm-tab.active{background:#ff6600}
        .adm-input{background:#f4f6f4;border:1.5px solid #e8e8e8;padding:12px;color:#1a1a1a;border-radius:9px;font-size:0.9rem;width:100%;font-family:Inter,sans-serif}
    </style>`;

    document.getElementById('mktg-type').onchange = function() {
        document.getElementById('mktg-slider-extra').style.display = this.value==='slider'?'flex':'none';
    };
}

function renderCmdsAdmin(data) {
    if (!data.length) return '<p style="color:#888;text-align:center;padding:20px">Aucune commande.</p>';
    return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.8rem">
        <thead><tr>${['Code','Client','Zone','Total','Date','Statut','Action'].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.72rem;text-transform:uppercase">${h}</th>`).join('')}</tr></thead>
        <tbody>${data.map(r=>`<tr style="border-bottom:1px solid #f8f8f8">
            <td style="padding:10px;font-family:monospace;color:#1a5c2a;font-weight:700">${r.code}</td>
            <td style="padding:10px">${r.nom_client}<br><span style="color:#888;font-size:0.72rem">${r.telephone}</span></td>
            <td style="padding:10px;color:#888;font-size:0.78rem">📍${r.zone_livraison||'—'}</td>
            <td style="padding:10px;font-weight:600">${fmt(r.total)} F</td>
            <td style="padding:10px;color:#888;font-size:0.75rem">${new Date(r.created_at).toLocaleDateString('fr-FR')}</td>
            <td style="padding:10px"><span style="padding:3px 10px;border-radius:8px;font-size:0.7rem;font-weight:700;background:${r.statut==='en attente'?'#fff8f0':r.statut==='valide'?'#f0fff4':'#fff0f0'};color:${r.statut==='en attente'?'#ff6600':r.statut==='valide'?'#2dc653':'#e63946'}">${r.statut}</span></td>
            <td style="padding:10px"><select onchange="changerStatutAdmin('${r.id}',this.value)" style="background:#f4f6f4;color:#1a1a1a;border:1px solid #e8e8e8;border-radius:6px;padding:5px;font-size:0.75rem">
                <option value="">Changer...</option>
                <option value="en attente">⏳ En attente</option>
                <option value="valide">✅ Validée</option>
                <option value="livre">🚚 Livrée</option>
                <option value="annule">❌ Annulée</option>
            </select></td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

window.showTab = id => {
    ['tab-dash','tab-prods','tab-cmds','tab-users','tab-avis','tab-mktg'].forEach(t=>{
        const el=document.getElementById(t); if(el) el.style.display=t===id?'block':'none';
    });
    ['tb-dash','tb-prods','tb-cmds','tb-users','tb-avis','tb-mktg'].forEach(b=>{
        const el=document.getElementById(b); if(el) el.classList.toggle('active', b==='tb-'+id.replace('tab-',''));
    });
};

window.filtrerCmdsAdmin = q => {
    const data = window._res.filter(r=>r.code.toLowerCase().includes(q.toLowerCase())||r.nom_client.toLowerCase().includes(q.toLowerCase()));
    document.getElementById('cmds-admin-table').innerHTML = renderCmdsAdmin(data);
};

window.changerStatutAdmin = async (id, statut) => {
    if(!statut)return;
    await db.from('reservations').update({statut}).eq('id',id);
    afficherPanneauAdmin();
};

window.validerAvisAdmin = async id => { await db.from('avis').update({valide:true}).eq('id',id); afficherPanneauAdmin(); };
window.supprimerAvisAdmin = async id => { if(!confirm('Supprimer ?'))return; await db.from('avis').delete().eq('id',id); afficherPanneauAdmin(); };
window.desactiverBanniere = async id => { await db.from('bannières').update({actif:false}).eq('id',id); afficherPanneauAdmin(); };

window.previewAdminImg = input => {
    selectedFile = input.files[0]; if(!selectedFile)return;
    const reader=new FileReader();
    reader.onload=e=>{document.getElementById('adm-img').src=e.target.result;document.getElementById('adm-img-preview').style.display='inline-block';};
    reader.readAsDataURL(selectedFile);
};
window.resetAdminImg = () => {
    selectedFile=null;
    const f=document.getElementById('p-img-file'); if(f)f.value='';
    const u=document.getElementById('p-img-url'); if(u)u.value='';
    const p=document.getElementById('adm-img-preview'); if(p)p.style.display='none';
};

window.sauvegarderProduit = async () => {
    const msg=document.getElementById('prod-msg');
    const name=document.getElementById('p-name').value.trim();
    const qty=parseInt(document.getElementById('p-qty').value);
    const achat=parseFloat(document.getElementById('p-achat').value);
    const vente=parseFloat(document.getElementById('p-vente').value);
    if(!name||!qty||!achat||!vente){msg.style.color='#e63946';msg.textContent='❌ Remplissez les champs obligatoires';return;}
    msg.style.color='#888';msg.textContent='Enregistrement...';
    let imageUrl=document.getElementById('p-img-url').value.trim();
    if(selectedFile){try{imageUrl=await uploadImage(selectedFile);}catch(e){msg.style.color='#e63946';msg.textContent='❌ Upload: '+e.message;return;}}
    const prod={name,description:document.getElementById('p-desc').value.trim()||null,category:document.getElementById('p-cat').value,quantity:qty,purchase_price:achat,resale_price:vente,image_url:imageUrl||null,promo_active:document.getElementById('p-promo-chk').checked,promo_prix:parseFloat(document.getElementById('p-promo').value)||null,flash_active:document.getElementById('p-flash-chk').checked,flash_fin:document.getElementById('p-flash-fin').value?new Date(document.getElementById('p-flash-fin').value).toISOString():null};
    const {error}=editingId?await db.from('products').update(prod).eq('id',editingId):await db.from('products').insert([prod]);
    if(error){msg.style.color='#e63946';msg.textContent='❌ '+error.message;return;}
    msg.style.color='#2dc653';msg.textContent='✅ Enregistré !';
    annulerEdit(); setTimeout(()=>afficherPanneauAdmin(),700);
};

window.chargerEditProduit = id => {
    const p=window._prods.find(x=>x.id===id); if(!p)return;
    editingId=id;
    document.getElementById('prod-form-title').textContent='✏️ Modifier le produit';
    document.getElementById('p-name').value=p.name;
    document.getElementById('p-desc').value=p.description||'';
    document.getElementById('p-cat').value=p.category;
    document.getElementById('p-qty').value=p.quantity;
    document.getElementById('p-achat').value=p.purchase_price;
    document.getElementById('p-vente').value=p.resale_price;
    document.getElementById('p-promo').value=p.promo_prix||'';
    document.getElementById('p-promo-chk').checked=p.promo_active||false;
    document.getElementById('p-flash-chk').checked=p.flash_active||false;
    if(p.image_url){document.getElementById('p-img-url').value=p.image_url;document.getElementById('adm-img').src=p.image_url;document.getElementById('adm-img-preview').style.display='inline-block';}
    document.getElementById('btn-annuler-edit').style.display='';
    showTab('tab-prods'); window.scrollTo({top:0,behavior:'smooth'});
};

window.annulerEdit = () => {
    editingId=null; selectedFile=null;
    ['p-name','p-desc','p-qty','p-achat','p-vente','p-promo','p-img-url'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const c=document.getElementById('p-promo-chk');if(c)c.checked=false;
    const f=document.getElementById('p-flash-chk');if(f)f.checked=false;
    const w=document.getElementById('adm-img-preview');if(w)w.style.display='none';
    const t=document.getElementById('prod-form-title');if(t)t.textContent='➕ Ajouter un Produit';
    const b=document.getElementById('btn-annuler-edit');if(b)b.style.display='none';
};

window.supprimerProduit = async id => { if(!confirm('Supprimer ce produit ?'))return; await db.from('products').delete().eq('id',id); afficherPanneauAdmin(); };
window.toggleFlash = async (id, actif) => { await db.from('products').update({flash_active:!actif}).eq('id',id); afficherPanneauAdmin(); };

window.publierMessage = async () => {
    const msg=document.getElementById('mktg-msg').value.trim();
    const type=document.getElementById('mktg-type').value;
    const res=document.getElementById('mktg-res');
    if(!msg){res.style.color='#e63946';res.textContent='❌ Message vide';return;}
    const payload={message:msg,type,actif:true};
    if(type==='slider'){payload.titre=document.getElementById('mktg-titre').value;payload.tag=document.getElementById('mktg-tag').value;payload.image_url=document.getElementById('mktg-img-url').value;payload.btn_texte=document.getElementById('mktg-btn-txt').value;}
    const {error}=await db.from('bannières').insert([payload]);
    if(error){res.style.color='#e63946';res.textContent='❌ '+error.message;return;}
    res.style.color='#2dc653';res.textContent='✅ Publié !';
    document.getElementById('mktg-msg').value='';
    setTimeout(()=>afficherPanneauAdmin(),600);
};
