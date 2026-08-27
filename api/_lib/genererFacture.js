// api/_lib/genererFacture.js
// Construit un PDF de facture simple (logo, articles, prix, total,
// coordonnées client) à partir d'une ligne de la table `reservations`.
// Retourne un Buffer, prêt à être renvoyé au navigateur ou joint à un email.

const PDFDocument = require('pdfkit');

function genererFacturePdf(reservation) {
    const estPaye = reservation.statut === 'valide' || reservation.statut === 'livre';
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const vert = '#0E7C4A';
        const gris = '#52606B';
        const rouge = '#E63946';

        // En-tête
        doc.fillColor(vert).fontSize(22).font('Helvetica-Bold').text('CAMERTECH MARKET', 50, 50);
        doc.fillColor(gris).fontSize(9).font('Helvetica').text('Douala, PK14 — Cameroun', 50, 78);

        const titre = estPaye ? 'FACTURE' : 'SUIVI DE COMMANDE';
        doc.fillColor(estPaye ? '#000' : rouge).fontSize(16).font('Helvetica-Bold').text(titre, 350, 50, { align: 'right', width: 145 });
        if (!estPaye) {
            doc.fillColor(rouge).fontSize(10).font('Helvetica-Bold').text('⚠ NON PAYÉ', 350, 72, { align: 'right', width: 145 });
        }
        doc.fillColor(gris).fontSize(9).font('Helvetica')
            .text(`N° ${reservation.code}`, 350, estPaye ? 72 : 88, { align: 'right', width: 145 })
            .text(`Date : ${new Date(reservation.paye_le || reservation.created_at).toLocaleDateString('fr-FR')}`, 350, estPaye ? 86 : 102, { align: 'right', width: 145 });

        doc.moveTo(50, 120).lineTo(545, 120).strokeColor('#E7E9EC').stroke();

        // Client
        doc.fillColor('#000').fontSize(10).font('Helvetica-Bold').text(estPaye ? 'Facturé à :' : 'Commande de :', 50, 135);
        doc.font('Helvetica').fontSize(10)
            .text(reservation.nom_client || '—', 50, 150)
            .text(reservation.telephone || '', 50, 164)
            .text(`Livraison : ${reservation.zone_livraison || '—'}`, 50, 178)
            .text(`Statut : ${reservation.statut}`, 50, 192);

        // Tableau articles
        let y = 225;
        doc.font('Helvetica-Bold').fontSize(10);
        doc.text('Article', 50, y).text('Qté', 350, y, { width: 50, align: 'right' }).text('Total', 450, y, { width: 95, align: 'right' });
        y += 16;
        doc.moveTo(50, y).lineTo(545, y).strokeColor('#E7E9EC').stroke();
        y += 10;

        doc.font('Helvetica').fontSize(10);
        const items = Array.isArray(reservation.items) ? reservation.items : [];
        for (const item of items) {
            const ligneTotal = (item.prix || 0) * (item.qty || 1);
            doc.text(item.name || 'Article', 50, y, { width: 280 });
            doc.text(String(item.qty || 1), 350, y, { width: 50, align: 'right' });
            doc.text(fmt(ligneTotal) + ' FCFA', 450, y, { width: 95, align: 'right' });
            y += 20;
        }

        if (reservation.frais_livraison) {
            doc.fillColor(gris).text('Frais de livraison', 50, y, { width: 280 });
            doc.text(fmt(reservation.frais_livraison) + ' FCFA', 450, y, { width: 95, align: 'right' });
            y += 20;
        }

        y += 10;
        doc.moveTo(350, y).lineTo(545, y).strokeColor('#E7E9EC').stroke();
        y += 12;
        doc.fillColor(estPaye ? vert : rouge).font('Helvetica-Bold').fontSize(13).text('TOTAL', 350, y, { width: 95 });
        doc.text(fmt(reservation.total) + ' FCFA', 450, y, { width: 95, align: 'right' });

        if (!estPaye) {
            y += 30;
            doc.fillColor(rouge).font('Helvetica-Bold').fontSize(10).text('Ce document est un suivi de commande, pas une facture.', 50, y, { width: 495, align: 'center' });
            doc.font('Helvetica').fontSize(9).text('Le paiement n\'a pas encore été confirmé pour cette commande.', 50, y + 14, { width: 495, align: 'center' });
        }

        doc.fillColor(gris).font('Helvetica').fontSize(8)
            .text('Merci pour votre confiance — CAMERTECH MARKET', 50, 760, { align: 'center', width: 495 });

        doc.end();
    });
}

function fmt(n) {
    return Math.round(n || 0).toLocaleString('fr-FR');
}

module.exports = { genererFacturePdf };
