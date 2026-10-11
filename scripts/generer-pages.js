#!/usr/bin/env node
// =====================================================================
// Génère, à chaque déploiement Vercel, UNE page HTML par produit
//   /produit/<nom-du-produit>-<id>/index.html
// ainsi que le plan de site (sitemap.xml) qui les liste.
//
// Pourquoi : la boutique est une application à page unique ; sans ça Google
// ne peut proposer qu'une seule adresse (la page d'accueil). Avec une page par
// produit, chaque produit peut apparaître dans les résultats de recherche.
//
// Principe de sécurité : CE SCRIPT NE DOIT JAMAIS FAIRE ÉCHOUER UN DÉPLOIEMENT.
// En cas de problème (réseau, base indisponible, données inattendues), il le
// signale dans les journaux et se termine normalement : le site est alors
// déployé comme avant, simplement sans les pages produit.
//
// Aucune dépendance : uniquement Node (fetch intégré, Node 18 ou plus).
//
// Variables d'environnement (utilisées surtout par les tests) :
//   PAGES_ROOT         dossier du projet (défaut : dossier parent du script)
//   PAGES_OUT_DIR      dossier de sortie (défaut : PAGES_ROOT)
//   PAGES_SOURCE_FILE  fichier JSON de produits à utiliser au lieu de la base
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.PAGES_ROOT || path.join(__dirname, '..');
const OUT = process.env.PAGES_OUT_DIR || ROOT;
const SITE = 'https://www.kapmaket.shop';
const NOM_BOUTIQUE = 'Kapmaket';

// ---------------------------------------------------------------------
// Règles communes avec le navigateur (script.js) — À GARDER IDENTIQUES :
// l'adresse d'un produit doit être la même ici et dans le site.
// ---------------------------------------------------------------------
function idCourt(id) {
    return String(id).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-8) || 'x';
}
function slugBase(nom) {
    return String(nom || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' et ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/, '') || 'produit';
}
function slugProduit(p) { return slugBase(p.name) + '-' + idCourt(p.id); }

// Prix AFFICHÉ aux clients (prix « charme », identique à prixCharme/getPrix de script.js).
function prixCharme(prix) {
    const p = Math.round(prix || 0);
    return (p > 0 && p % 100 === 0) ? p - 1 : p;
}
function prixAffiche(p) {
    return prixCharme((p.promo_active || p.flash_active) && p.promo_prix ? p.promo_prix : p.resale_price);
}

// ---------------------------------------------------------------------
// Outils texte
// ---------------------------------------------------------------------
function echapperHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function texteSimple(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function couper(s, max) {
    s = texteSimple(s);
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1);
    const dernierEspace = cut.lastIndexOf(' ');
    return (dernierEspace > max * 0.6 ? cut.slice(0, dernierEspace) : cut).replace(/[ ,;:.-]+$/, '') + '…';
}
// JSON placé dans une balise <script> : on neutralise « < » pour qu'aucun texte ne puisse fermer la balise.
function jsonPourScript(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c'); }
function fmtPrix(n) { return Math.round(n).toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' '); }
function urlImageValide(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }

// ---------------------------------------------------------------------
// Lecture des produits
// ---------------------------------------------------------------------
function lireConfig() {
    const code = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
    const ctx = vm.createContext({});
    return vm.runInContext(code + '\n;CONFIG', ctx, { timeout: 1000 });
}

async function lireProduits() {
    if (process.env.PAGES_SOURCE_FILE) {
        return JSON.parse(fs.readFileSync(process.env.PAGES_SOURCE_FILE, 'utf8'));
    }
    if (typeof fetch !== 'function') throw new Error('fetch indisponible (Node trop ancien)');
    const cfg = lireConfig();
    const base = cfg.SUPABASE_URL, cle = cfg.SUPABASE_ANON_KEY;
    if (!base || !cle) throw new Error('SUPABASE_URL ou SUPABASE_ANON_KEY introuvable dans config.js');
    const tous = [];
    const TAILLE = 1000;
    for (let debut = 0; debut < 20000; debut += TAILLE) {
        const ctrl = new AbortController();
        const minuteur = setTimeout(() => ctrl.abort(), 20000);
        let rep;
        try {
            rep = await fetch(base + '/rest/v1/products?select=*&order=created_at.desc', {
                headers: { apikey: cle, Authorization: 'Bearer ' + cle, Range: debut + '-' + (debut + TAILLE - 1), 'Range-Unit': 'items' },
                signal: ctrl.signal
            });
        } finally { clearTimeout(minuteur); }
        if (!rep.ok) throw new Error('Supabase a répondu ' + rep.status);
        const lot = await rep.json();
        if (!Array.isArray(lot)) throw new Error('Réponse inattendue de Supabase');
        tous.push(...lot);
        if (lot.length < TAILLE) break;
    }
    return tous;
}

// ---------------------------------------------------------------------
// Fabrication d'une page
// ---------------------------------------------------------------------
function remplacerMeta(html, attribut, nom, contenu) {
    const re = new RegExp('<meta\\s+' + attribut + '="' + nom.replace(/[:]/g, '\\:') + '"[^>]*>', 'i');
    const balise = '<meta ' + attribut + '="' + nom + '" content="' + echapperHtml(contenu) + '">';
    return re.test(html) ? html.replace(re, balise) : html.replace('</head>', '    ' + balise + '\n</head>');
}

function fabriquerPage(modele, p) {
    const slug = slugProduit(p);
    const url = SITE + '/produit/' + slug;
    const nom = texteSimple(p.name) || 'Produit';
    const prix = prixAffiche(p);
    const image = urlImageValide(p.image_url);
    const categorie = texteSimple(p.category);
    const enStock = Number(p.quantity) > 0;
    const description = texteSimple(p.description) || nom;

    const titre = couper(nom, 48) + ' — ' + fmtPrix(prix) + ' FCFA | ' + NOM_BOUTIQUE + ' Douala';
    const meta = couper(description, 120) + ' Livraison à Douala, paiement Mobile Money, retrait en agence. Achetez sur ' + NOM_BOUTIQUE + '.';

    let h = modele;
    h = h.replace(/<title>[\s\S]*?<\/title>/i, '<title>' + echapperHtml(titre) + '</title>');
    h = remplacerMeta(h, 'name', 'description', couper(meta, 160));
    h = h.replace(/<link\s+rel="canonical"[^>]*>/i, '<link rel="canonical" href="' + echapperHtml(url) + '">');
    h = remplacerMeta(h, 'property', 'og:type', 'product');
    h = remplacerMeta(h, 'property', 'og:title', titre);
    h = remplacerMeta(h, 'property', 'og:description', couper(meta, 200));
    h = remplacerMeta(h, 'property', 'og:url', url);
    h = remplacerMeta(h, 'name', 'twitter:title', titre);
    h = remplacerMeta(h, 'name', 'twitter:description', couper(meta, 200));
    if (image) {
        h = remplacerMeta(h, 'property', 'og:image', image);
        h = remplacerMeta(h, 'name', 'twitter:image', image);
    }

    // Données structurées : on retire celles de la page d'accueil et on met celles du produit.
    // (Le prix est celui AFFICHÉ sur la page, comme l'exige Google.)
    h = h.replace(/[ \t]*<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>\s*/gi, '');
    const produitLd = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: nom,
        description: couper(description, 500),
        sku: String(p.id),
        category: categorie || undefined,
        image: image ? [image] : undefined,
        itemCondition: 'https://schema.org/NewCondition',
        offers: {
            '@type': 'Offer',
            url: url,
            priceCurrency: 'XAF',
            price: prix,
            availability: enStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
            seller: { '@type': 'Organization', name: NOM_BOUTIQUE, url: SITE + '/' }
        }
    };
    const filLd = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Accueil', item: SITE + '/' },
            { '@type': 'ListItem', position: 2, name: nom, item: url }
        ]
    };
    const blocLd =
        '    <script type="application/ld+json" id="schema-produit">' + jsonPourScript(produitLd) + '</script>\n' +
        '    <script type="application/ld+json" id="schema-fil">' + jsonPourScript(filLd) + '</script>\n';
    h = h.replace('</head>', blocLd + '</head>');

    // Contenu lisible par les robots, identique à ce que montre la fiche produit à l'écran.
    // Il est masqué visuellement : le site ouvre aussitôt la vraie fiche produit.
    const blocProduit =
        '<div id="seo-produit" class="sr-only">\n' +
        '    <nav aria-label="Fil d\'Ariane"><a href="/">Accueil</a> › ' + (categorie ? echapperHtml(categorie) + ' › ' : '') + echapperHtml(nom) + '</nav>\n' +
        '    <h1>' + echapperHtml(nom) + '</h1>\n' +
        (image ? '    <img src="' + echapperHtml(image) + '" alt="' + echapperHtml(nom) + '" width="400" height="400">\n' : '') +
        '    <p>' + echapperHtml(description) + '</p>\n' +
        '    <p>Prix : ' + fmtPrix(prix) + ' FCFA — ' + (enStock ? 'en stock' : 'momentanément indisponible') + '</p>\n' +
        '    <p>Livraison à Douala, paiement Mobile Money (MTN, Orange), retrait en agence.</p>\n' +
        '    <p><a href="/">Voir tous les produits ' + NOM_BOUTIQUE + '</a></p>\n' +
        '</div>';
    const reH1 = /<h1 class="sr-only" id="seo-accueil">[\s\S]*?<\/h1>/i;
    if (reH1.test(h)) h = h.replace(reH1, blocProduit);
    else h = h.replace(/<body[^>]*>/i, m => m + '\n' + blocProduit);

    return { slug, url, html: h, image };
}

function fabriquerSitemap(pages) {
    const lignes = ['<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
        '  <url>', '    <loc>' + SITE + '/</loc>', '    <changefreq>daily</changefreq>', '    <priority>1.0</priority>', '  </url>'];
    for (const pg of pages) {
        lignes.push('  <url>', '    <loc>' + echapperHtml(pg.url) + '</loc>', '    <changefreq>weekly</changefreq>', '    <priority>0.8</priority>');
        if (pg.image) lignes.push('    <image:image><image:loc>' + echapperHtml(pg.image) + '</image:loc></image:image>');
        lignes.push('  </url>');
    }
    lignes.push('</urlset>', '');
    return lignes.join('\n');
}

// ---------------------------------------------------------------------
// Programme principal
// ---------------------------------------------------------------------
async function principal() {
    const debut = Date.now();
    const produits = await lireProduits();
    if (!Array.isArray(produits) || produits.length === 0) {
        console.log('[pages-produit] aucun produit trouvé : aucune page générée.');
        return;
    }
    const modele = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    // Génération en mémoire d'abord : on n'écrit sur le disque que si tout s'est bien passé.
    const pages = [];
    const vus = new Set();
    let ignores = 0;
    for (const p of produits) {
        try {
            if (!p || p.id == null || !texteSimple(p.name)) { ignores++; continue; }
            const page = fabriquerPage(modele, p);
            if (vus.has(page.slug)) { console.warn('[pages-produit] adresse en double ignorée :', page.slug); ignores++; continue; }
            vus.add(page.slug);
            pages.push(page);
        } catch (e) {
            ignores++;
            console.warn('[pages-produit] produit ignoré (' + (p && p.id) + ') :', e.message);
        }
    }
    if (pages.length === 0) { console.log('[pages-produit] aucune page valable : rien d\'écrit.'); return; }

    const dossier = path.join(OUT, 'produit');
    fs.rmSync(dossier, { recursive: true, force: true });
    for (const pg of pages) {
        const d = path.join(dossier, pg.slug);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'index.html'), pg.html, 'utf8');
    }
    fs.writeFileSync(path.join(OUT, 'sitemap.xml'), fabriquerSitemap(pages), 'utf8');
    console.log('[pages-produit] ' + pages.length + ' page(s) produit générée(s)' + (ignores ? ', ' + ignores + ' ignorée(s)' : '') +
        ' + sitemap.xml, en ' + (Date.now() - debut) + ' ms.');
}

if (require.main === module) {
    principal().then(() => process.exit(0)).catch((e) => {
        // Volontairement SANS code d'erreur : le déploiement continue, sans pages produit.
        console.error('[pages-produit] ÉCHEC (le site est déployé sans pages produit) :', e && e.message ? e.message : e);
        process.exit(0);
    });
}

module.exports = { slugProduit, slugBase, idCourt, prixCharme, prixAffiche, fabriquerPage, fabriquerSitemap, echapperHtml, couper };
