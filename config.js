const CONFIG = {
    SUPABASE_URL: "https://czrxdtacgbaccdsctlxv.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6cnhkdGFjZ2JhY2Nkc2N0bHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MDcyNzEsImV4cCI6MjA5NzE4MzI3MX0.0pXS9iPbRqN9_7bqKogEZLgHlaLHcA-d1MuX-FTyXCU",
    BUCKET: "images",
    WA1: "237653756167",
    WA2: "237653756167",
    // Clé publique VAPID (notifications push) — publique par nature, sans risque à exposer ici.
    VAPID_PUBLIC_KEY: "BN9iA4TgEDfv_Cfc1JrOdtfiU3z3jeCYiqw3BXh67M2LjJN1x6-1k-aoBj8W_6araz_RT52BX2B627a8ni9O-Bg",
    // Les identifiants admin ne sont plus ici : ils vivent uniquement côté
    // serveur (variables d'environnement Vercel), vérifiés par /api/admin-login
    // et /api/admin-verify-otp. Voir supabase_admin_auth.sql pour le détail.
    API: {
        PREPARER_PAIEMENT: "/api/preparer-paiement"   // widget iKeePay, conforme à leur documentation
    },
    PAIEMENT_MODE: "widget",
    // Quartiers livrés directement (1 000 FCFA). Tout autre quartier = retrait en agence.
    // Limites anti-abus côté CLIENTS : commande, paiement, code promo, suivi, facture, recherche par photo, questions à l'assistant
    // (par visiteur). false = aucune limite (phase de démarrage). true = limites actives (voir api/_lib/rateLimit.js).
    // Les protections de connexion administrateur restent TOUJOURS actives, quelle que soit cette valeur.
    LIMITES_CLIENTS_ACTIVES: false,
    ZONES_COUVERTES: ["Akwa","Bonamoussadi","Ndokoti","PK14","Makepe","Bassa","Logbaba","Deido","Bonaberi","Bonanjo","Bali","New-Bell","Bépanda","Ndogpassi","Ndogbong","Cité SIC","Kotto","PK8","PK9","PK10","PK12","PK16","PK21","Logpom","Yassa","Village","Bonapriso","Japoma","Nyalla","Zone Industrielle Bassa","Cité des Palmiers"],
    FRAIS_LIVRAISON: 1000,
    // ⚠️ À personnaliser : adresse exacte et numéro de contact pour le retrait en agence
    AGENCE_ADRESSE: "Douala, PK14, Cameroun (adresse précise à confirmer)",
    AGENCE_TEL: "237653756167",
    // EmailJS — activé pour l'envoi du code de réinitialisation par email
    EMAILJS: {
        PUBLIC_KEY: "b1FiU2dX42MRGVVUI",
        SERVICE_ID: "service_6pduwrq",
        TEMPLATE_ID: "template_acxekdc"
    },
    // Vraies photos des catégories (Unsplash, licence libre). Si l'admin téléverse une photo
    // (Paramètres), elle remplace celle-ci. Pour changer une photo : coller une autre adresse ici.
    CATEGORY_IMAGES: {
        "Téléphonie": "https://images.unsplash.com/photo-1619287032765-de47edc49091?w=600&h=600&fit=crop&q=70&auto=format",
        "Accessoires": "https://images.unsplash.com/photo-1596628319258-c6f3f387a1ed?w=600&h=600&fit=crop&q=70&auto=format",
        "Électronique": "https://images.unsplash.com/photo-1584907797075-c5308ada266f?w=600&h=600&fit=crop&q=70&auto=format",
        "Gaming": "https://images.unsplash.com/photo-1482855549413-2a6c9b1955a7?w=600&h=600&fit=crop&q=70&auto=format",
        "Réseau": "https://images.unsplash.com/photo-1745847768408-b7b83796cae6?w=600&h=600&fit=crop&q=70&auto=format",
        "Flash": ""
    },
    // Petites photos qui remplacent les emojis (miniatures rondes) : emoji -> identifiant Unsplash.
    // Un emoji absent de cette liste reste un emoji. Si la photo ne charge pas, l'emoji revient.
    // Pour en ajouter : coller l'identifiant "photo-XXXX" de l'adresse images.unsplash.com/photo-XXXX
    ICON_PHOTOS: {
        "📱": { id: "photo-1619287032765-de47edc49091", alt: "Smartphone" },
        "🎧": { id: "photo-1596628319258-c6f3f387a1ed", alt: "Casque audio" },
        "💻": { id: "photo-1584907797075-c5308ada266f", alt: "Ordinateur portable" },
        "🎮": { id: "photo-1482855549413-2a6c9b1955a7", alt: "Manette de jeu" },
        "📡": { id: "photo-1745847768408-b7b83796cae6", alt: "Routeur Wi-Fi" },
        "📦": { id: "photo-1631010231931-d2c396b444ec", alt: "Colis" }
    }
};

// Rend CONFIG accessible depuis les fonctions serverless (Node/CommonJS) sans
// rien changer côté navigateur — évite de dupliquer ZONES_COUVERTES (et le
// reste) à deux endroits qui pourraient un jour se désynchroniser.
if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
