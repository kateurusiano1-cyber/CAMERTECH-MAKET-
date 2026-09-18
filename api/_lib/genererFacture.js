// api/_lib/genererFacture.js
// Construit un PDF de facture simple (logo, articles, prix, total,
// coordonnées client) à partir d'une ligne de la table `reservations`.
// Retourne un Buffer, prêt à être renvoyé au navigateur ou joint à un email.

const PDFDocument = require('pdfkit');

// Le logo est récupéré depuis le site en ligne plutôt que depuis le
// dépôt : plus fiable, Vercel ne bundle pas toujours les images statiques
// avec les fonctions serverless.
async function recupererLogo() {
    try {
        const resp = await fetch('https://camertech-maket.vercel.app/logo.png');
        if (!resp.ok) return null;
        const arr = await resp.arrayBuffer();
        return Buffer.from(arr);
    } catch (e) {
        return null;
    }
}

// Récupère une image d'article depuis son URL pour l'intégrer au PDF.
// Ne bloque jamais la génération de la facture si une image est absente,
// invalide, ou trop lente à charger — dans ce cas, la ligne s'affiche
// simplement sans photo plutôt que de faire échouer tout le document.
const sharp = require('sharp');

// Récupère une image d'article depuis son URL pour l'intégrer au PDF.
// pdfkit ne sait afficher nativement que du JPEG/PNG — on convertit donc
// systématiquement en PNG via sharp, ce qui couvre aussi le WebP, l'AVIF,
// etc. Ne bloque jamais la génération de la facture si une image est
// absente, invalide, ou trop lente à charger — dans ce cas, la ligne
// s'affiche simplement sans photo plutôt que de faire échouer tout le document.
async function recupererImageArticle(url) {
    if (!url) { console.log('Facture image : URL vide, article ignoré'); return null; }
    try {
        const controleur = new AbortController();
        const delai = setTimeout(() => controleur.abort(), 4000);
        const resp = await fetch(url, { signal: controleur.signal });
        clearTimeout(delai);
        if (!resp.ok) { console.error('Facture image : HTTP', resp.status, 'pour', url); return null; }
        const contentType = resp.headers.get('content-type') || '';
        const arr = await resp.arrayBuffer();
        try {
            const png = await sharp(Buffer.from(arr)).resize(120, 120, { fit: 'cover' }).png().toBuffer();
            console.log('Facture image : convertie en PNG (', contentType, '->image/png) -', url);
            return png;
        } catch (eConv) {
            console.error('Facture image : échec conversion sharp (', contentType, ') pour', url, '-', eConv.message);
            return null;
        }
    } catch (e) {
        console.error('Facture image : échec fetch pour', url, '-', e.message);
        return null;
    }
}

function genererFacturePdf(reservation) {
    const estPaye = reservation.statut === 'valide' || reservation.statut === 'livre';
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const vert = '#0E7C4A';
            const gris = '#52606B';
            const rouge = '#E63946';

            // En-tête : logo + nom, et bloc titre à droite avec assez
            // d'espace vertical pour ne jamais se chevaucher.
            const logo = await recupererLogo();
            if (logo) {
                doc.image(logo, 50, 45, { width: 42 });
                doc.fillColor(vert).fontSize(18).font('Helvetica-Bold').text('CAMERTECH MARKET', 100, 50);
                doc.fillColor(gris).fontSize(9).font('Helvetica').text('Douala, PK14 — Cameroun', 100, 72);
            } else {
                doc.fillColor(vert).fontSize(20).font('Helvetica-Bold').text('CAMERTECH MARKET', 50, 50);
                doc.fillColor(gris).fontSize(9).font('Helvetica').text('Douala, PK14 — Cameroun', 50, 74);
            }

            const colDroiteX = 300, colDroiteW = 245;
            let yDroite = 48;
            const titre = estPaye ? 'FACTURE' : 'SUIVI DE COMMANDE';
            doc.fillColor(estPaye ? '#000' : rouge).fontSize(14).font('Helvetica-Bold')
                .text(titre, colDroiteX, yDroite, { align: 'right', width: colDroiteW });
            yDroite += 20;
            if (!estPaye) {
                doc.fillColor(rouge).fontSize(10).font('Helvetica-Bold')
                    .text('NON PAYÉ', colDroiteX, yDroite, { align: 'right', width: colDroiteW });
                yDroite += 16;
            }
            doc.fillColor(gris).fontSize(9).font('Helvetica')
                .text(`N° ${reservation.code}`, colDroiteX, yDroite, { align: 'right', width: colDroiteW });
            yDroite += 14;
            doc.text(`Date : ${new Date(reservation.paye_le || reservation.created_at).toLocaleDateString('fr-FR')}`, colDroiteX, yDroite, { align: 'right', width: colDroiteW });

            doc.moveTo(50, 120).lineTo(545, 120).strokeColor('#E7E9EC').stroke();

            // Client
            doc.fillColor('#000').fontSize(10).font('Helvetica-Bold').text(estPaye ? 'Facturé à :' : 'Commande de :', 50, 135);
            doc.font('Helvetica').fontSize(10)
                .text(reservation.nom_client || '—', 50, 150)
                .text(reservation.telephone || '', 50, 164);
            let yClient = 178;
            if (reservation.email_client) { doc.text(reservation.email_client, 50, yClient); yClient += 14; }
            doc.text(`Livraison : ${reservation.zone_livraison || '—'}`, 50, yClient); yClient += 14;
            doc.text(`Statut : ${reservation.statut}`, 50, yClient); yClient += 14;
            if (estPaye) { doc.text('Moyen de paiement : Payé via iKeePay', 50, yClient); yClient += 14; }
            if (reservation.date_limite_retrait) {
                doc.fillColor('#c24c00').font('Helvetica-Bold')
                    .text(`⏳ À retirer avant le ${new Date(reservation.date_limite_retrait).toLocaleDateString('fr-FR')} (au-delà, marchandise non garantie)`, 50, yClient, { width: 495 });
                doc.fillColor('#000').font('Helvetica');
            }

            // Tableau articles
            let y = yClient + 26;
            doc.font('Helvetica-Bold').fontSize(10);
            doc.text('Article', 85, y).text('P.U.', 285, y, { width: 65, align: 'right' }).text('Qté', 355, y, { width: 40, align: 'right' }).text('Total', 450, y, { width: 95, align: 'right' });
            y += 16;
            doc.moveTo(50, y).lineTo(545, y).strokeColor('#E7E9EC').stroke();
            y += 8;

            doc.font('Helvetica').fontSize(10);
            const items = Array.isArray(reservation.items) ? reservation.items : [];
            // Préchargement en parallèle : plus rapide qu'un fetch par article
            // l'un après l'autre, et une image qui échoue n'affecte pas les autres.
            const imagesArticles = await Promise.all(items.map(it => recupererImageArticle(it.image_url)));
            const TAILLE_IMG = 30;
            for (let idx = 0; idx < items.length; idx++) {
                const item = items[idx];
                const img = imagesArticles[idx];
                const ligneTotal = (item.prix || 0) * (item.qty || 1);
                if (img) {
                    try {
                        doc.image(img, 50, y - 4, { width: TAILLE_IMG, height: TAILLE_IMG, fit: [TAILLE_IMG, TAILLE_IMG] });
                    } catch (e) {
                        console.error('Facture image : pdfkit n\'a pas pu intégrer l\'image de', item.name, '-', e.message);
                    }
                } else {
                    console.log('Facture image : aucune image disponible pour', item.name, '(id:', item.id, ')');
                }
                doc.fillColor('#000').text((item.name || 'Article') + (item.combo ? `  (Flash Combo : ${item.combo})` : ''), 85, y, { width: 195 });
                doc.text(fmt(item.prix || 0) + ' F', 285, y, { width: 65, align: 'right' });
                doc.text(String(item.qty || 1), 355, y, { width: 40, align: 'right' });
                doc.text(fmt(ligneTotal) + ' FCFA', 450, y, { width: 95, align: 'right' });
                y += Math.max(24, TAILLE_IMG - 2);
            }

            // Toujours affiché, même sans code promo (0 FCFA dans ce cas) —
            // pour que ce soit sans ambiguïté sur la facture.
            {
                const reduction = reservation.reduction || 0;
                doc.fillColor(gris).text(reservation.code_promo ? `Réduction (code ${reservation.code_promo})` : 'Réduction (aucun code promo)', 85, y, { width: 245 });
                doc.text((reduction > 0 ? '-' : '') + fmt(reduction) + ' FCFA', 450, y, { width: 95, align: 'right' });
                y += 20;
            }

            if (reservation.frais_livraison) {
                doc.fillColor(gris).text('Frais de livraison', 85, y, { width: 245 });
                doc.text(fmt(reservation.frais_livraison) + ' FCFA', 450, y, { width: 95, align: 'right' });
                y += 20;
            }

            y += 10;
            doc.moveTo(350, y).lineTo(545, y).strokeColor('#E7E9EC').stroke();
            y += 12;
            doc.fillColor(estPaye ? vert : rouge).font('Helvetica-Bold').fontSize(13).text('TOTAL', 350, y, { width: 95 });
            doc.text(fmt(reservation.total) + ' FCFA', 450, y, { width: 95, align: 'right' });

            if (!estPaye) {
                y += 34;
                doc.fillColor(rouge).font('Helvetica-Bold').fontSize(10).text('Ce document est un suivi de commande, pas une facture.', 50, y, { width: 495, align: 'center' });
                doc.font('Helvetica').fontSize(9).text("Le paiement n'a pas encore été confirmé pour cette commande.", 50, y + 14, { width: 495, align: 'center' });
            }

            doc.fillColor(gris).font('Helvetica').fontSize(8)
                .text('Politique de retour : 7 jours après réception pour demander un retour (rubrique "Politique de retour" du site ou "Mes commandes").', 50, 745, { align: 'center', width: 495 });
            doc.text('Merci pour votre confiance — CAMERTECH MARKET', 50, 760, { align: 'center', width: 495 });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

// Sépare les milliers avec une espace normale — surtout NE PAS utiliser
// toLocaleString('fr-FR') ici : sa police intègre une espace fine
// insécable (caractère spécial) que la police Helvetica de PDFKit ne sait
// pas afficher, ce qui produisait un "/" à la place (bug corrigé).
function fmt(n) {
    return Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

module.exports = { genererFacturePdf };
