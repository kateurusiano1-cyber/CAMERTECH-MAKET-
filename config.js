const CONFIG = {
    SUPABASE_URL: "https://czrxdtacgbaccdsctlxv.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6cnhkdGFjZ2JhY2Nkc2N0bHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MDcyNzEsImV4cCI6MjA5NzE4MzI3MX0.0pXS9iPbRqN9_7bqKogEZLgHlaLHcA-d1MuX-FTyXCU",
    BUCKET: "images",
    WA1: "237699781160",
    WA2: "237653756167",
    ADMIN_PATH: "admin-cmr2025",
    // Les identifiants admin ne sont plus ici : ils vivent uniquement côté
    // serveur (variables d'environnement Vercel), vérifiés par /api/admin-login
    // et /api/admin-verify-otp. Voir supabase_admin_auth.sql pour le détail.
    API: {
        PREPARER_PAIEMENT: "/api/preparer-paiement"   // widget iKeePay, conforme à leur documentation
    },
    PAIEMENT_MODE: "widget",
    // Quartiers livrés directement (1 000 FCFA). Tout autre quartier = retrait en agence.
    ZONES_COUVERTES: ["Akwa","Bonamoussadi","Ndokoti","PK14","Makepe","Bassa","Logbaba","Deido","Bonaberi","Bonanjo","Bali","New-Bell","Bépanda","Ndogpassi","Ndogbong","Cité SIC","Kotto","PK8","PK9","PK10","PK12","PK16","PK21","Logpom","Yassa","Village","Bonapriso","Japoma","Nyalla","Zone Industrielle Bassa","Cité des Palmiers"],
    FRAIS_LIVRAISON: 1000,
    // ⚠️ À personnaliser : adresse exacte et numéro de contact pour le retrait en agence
    AGENCE_ADRESSE: "Douala, PK14, Cameroun (adresse précise à confirmer)",
    AGENCE_TEL: "237699781160",
    // EmailJS — activé pour l'envoi du code de réinitialisation par email
    EMAILJS: {
        PUBLIC_KEY: "b1FiU2dX42MRGVVUI",
        SERVICE_ID: "service_6pduwrq",
        TEMPLATE_ID: "template_acxekdc"
    },
    // ⚠️ À compléter : URL d'une vraie photo pour chaque catégorie (depuis Unsplash/Pexels ou tes propres photos produits)
    CATEGORY_IMAGES: {
        "Téléphonie": "",
        "Accessoires": "",
        "Électronique": "",
        "Gaming": "",
        "Réseau": "",
        "Flash": ""
    }
};
