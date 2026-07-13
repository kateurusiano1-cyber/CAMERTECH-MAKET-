const CONFIG = {
    SUPABASE_URL: "https://czrxdtacgbaccdsctlxv.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6cnhkdGFjZ2JhY2Nkc2N0bHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MDcyNzEsImV4cCI6MjA5NzE4MzI3MX0.0pXS9iPbRqN9_7bqKogEZLgHlaLHcA-d1MuX-FTyXCU",
    BUCKET: "images",
    WA1: "237699781160",
    WA2: "237653756167",
    ADMIN_PATH: "admin-cmr2025",
    ADMINS: [
        { id:"EVAR_ADMIN_1", mdp:"Ev@r2025#Cm1", wa:"237699781160" },
        { id:"EVAR_ADMIN_2", mdp:"C@mTech#753!", wa:"237653756167" },
        { id:"EVAR_ADMIN_3", mdp:"M@rket#670Xt", wa:"237670554637" }
    ],
    API: {
        INITIER_PAIEMENT: "/api/initier-paiement",
        VERIFIER_PAIEMENT: "/api/verifier-paiement"
    },
    // Quartiers livrés directement (1 000 FCFA). Tout autre quartier = retrait en agence.
    ZONES_COUVERTES: ["Akwa","Bonamoussadi","Ndokoti","PK14","Makepe","Bassa","Logbaba","Deido","Bonaberi"],
    FRAIS_LIVRAISON: 1000,
    // ⚠️ À personnaliser : adresse exacte et numéro de contact pour le retrait en agence
    AGENCE_ADRESSE: "Douala, PK14, Cameroun (adresse précise à confirmer)",
    AGENCE_TEL: "237699781160",
    // EmailJS — activé pour l'envoi du code de réinitialisation par email
    EMAILJS: {
        PUBLIC_KEY: "b1FiU2dX42MRGVVUI",
        SERVICE_ID: "service_6pduwrq",
        TEMPLATE_ID: "template_acxekdc"
    }
};
