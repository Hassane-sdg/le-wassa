# Backend — exécution et tests

Le backend Express nécessite Node.js 20.17 ou plus récent. En local, il utilise SQLite par défaut et place la base hors du dépôt (`%LOCALAPPDATA%\LeWASSA\db.sqlite` sous Windows, `$XDG_DATA_HOME/le-wassa/db.sqlite` ou `~/.local/share/le-wassa/db.sqlite` sous Linux/macOS). Un adaptateur PostgreSQL existe et est sélectionné lorsque `DATABASE_URL` est renseignée, mais il n’a pas encore été validé par la suite de tests complète ni sur une instance PostgreSQL de production.

À la racine de `server/` :

```powershell
npm install
$env:ADMIN_TOKEN = 'local-demo-token-change-this-32chars'
npm start
```

Le serveur écoute sur le port `5173` par défaut et initialise le schéma, les tables de démonstration et le menu s’ils sont absents. `ADMIN_TOKEN` est obligatoire pour les routes d’administration en toute configuration. En production, `NODE_ENV=production` impose un jeton d’au moins 32 caractères.

## Smoke test

Laisser le serveur démarré dans un terminal, puis exécuter dans un autre terminal :

```powershell
Set-Location '...\Projet de 1Million\server'
$env:ADMIN_TOKEN = 'local-demo-token-change-this-32chars'
$env:BASE_URL = 'http://localhost:5173'
npm run smoke
```

Le smoke test actuel est destiné au mode SQLite : il crée et supprime une table et un produit temporaires et vérifie les sessions QR, le calcul serveur des commandes, les statuts, la fidélité, les réservations et le mode de paiement manuel. Il modifie directement l’expiration d’une session dans SQLite. Ne le lancez pas contre une base contenant des données réelles.

## Variables d’environnement

`server/.env.example` est le modèle à copier vers un fichier `.env` local non versionné ou à configurer dans l’environnement du service :

- `PORT` : port d’écoute.
- `ADMIN_TOKEN` : secret aléatoire d’au moins 32 caractères en production.
- `PUBLIC_SITE_URL` : domaine HTTPS réel du frontend, utilisé pour générer les QR.
- `ALLOWED_ORIGINS` (alias historique : `CORS_ORIGINS`) : origines exactes, sans chemin.
- `DATABASE_URL` : quand elle est présente, sélectionne PostgreSQL ; vide, le backend utilise SQLite local.
- `WASSA_DB_PATH` et `WASSA_DATA_DIR` : chemins privés optionnels pour les données SQLite locales.
- `GEMINI_API_URL` et `GEMINI_API_KEY` : uniquement si la fonction Gemini facultative est utilisée.

Ne publiez jamais `.env`, le jeton d’administration, la clé Gemini ou la base contenant les commandes. Le tableau de bord statique peut être consulté sans authentification ; seules les routes d’administration de l’API autorisent la consultation/modification des données après validation du jeton.

Ne publiez jamais `.env`, le jeton d’administration, la clé Gemini ou une base contenant des données clients. Le tableau de bord statique peut être consulté sans authentification ; seules les routes d’administration de l’API sont protégées par le jeton.

Netlify publie uniquement `dist/`, produit à partir d’une liste blanche de ressources web ; ni `server/`, ni la base, ni ses sauvegardes ne font partie du build. `.netlifyignore` ajoute des exclusions en défense en profondeur, mais ne remplace pas cette séparation.

## Limite avant production

SQLite sur un runtime serverless ou éphémère ne garantit pas la persistance. L’adaptateur PostgreSQL est présent, mais le démarrage réel, les tests métier complets, la migration de données et le déploiement n’ont pas été validés. Ne déclarez pas le backend prêt pour la production avant d’avoir testé avec une vraie base PostgreSQL isolée, puis configuré le service de production et validé les parcours HTTPS.
