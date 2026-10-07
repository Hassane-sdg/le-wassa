Lancer l'API Le WASSA sous Windows

Dans un terminal PowerShell :

1) Se placer dans le dossier server et installer les dépendances :

   Set-Location .\server
   npm install

2) Définir les variables de développement :

   $env:ADMIN_TOKEN = 'local-demo-token-change-this-32chars'
   $env:WASSA_DB_PATH = "$env:TEMP\wassa-local.sqlite"

3) Démarrer l'API :

   npm start

L'API écoute sur http://localhost:5173 par défaut. Démarrer le frontend séparément à la racine du projet avec `npm start` (http://localhost:5000). Le menu sélectionné sur le frontend utilise l'API ; les commandes de démo non transmises restent signalées comme locales.

Le tableau de bord `dashboard.html` demande le même ADMIN_TOKEN. Utiliser un jeton d'au moins 32 caractères aléatoires en production, définir NODE_ENV=production, PUBLIC_SITE_URL en HTTPS, CORS_ORIGINS sur les domaines du frontend et WASSA_DB_PATH sur un stockage persistant. Les secrets doivent rester côté serveur ; ne publiez jamais le fichier .env.

Pour tester les parcours API, laisser le serveur actif et exécuter `npm run smoke` dans un second terminal. Voir `README_TESTING.md` et le README à la racine du projet pour les QR, commandes, paiement manuel et déploiement.

GEMINI_API_URL et GEMINI_API_KEY ne sont nécessaires que si le proxy Gemini facultatif est activé. Elles ne sont pas requises pour les commandes.
