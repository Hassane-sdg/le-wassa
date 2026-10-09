# Backend — exécution et tests

Le backend Express nécessite Node.js 20.17 ou plus récent. En local, il utilise SQLite par défaut et place la base hors du dépôt (`%LOCALAPPDATA%\LeWASSA\db.sqlite` sous Windows, `$XDG_DATA_HOME/le-wassa/db.sqlite` ou `~/.local/share/le-wassa/db.sqlite` sous Linux/macOS). Un adaptateur PostgreSQL existe et est sélectionné lorsque `DATABASE_URL` est renseignée, mais il n’a pas encore été validé par la suite de tests complète ni sur une instance PostgreSQL de production.

À la racine de `server/` :

```powershell
npm install
$env:ADMIN_TOKEN = 'local-demo-token-change-this-32chars'
npm start
```

Le serveur écoute sur le port `5173` par défaut. En SQLite local, il initialise le schéma et le catalogue/tables d’exemple historiques si nécessaire. En PostgreSQL, il crée uniquement le schéma et les index, sans ajouter de données de démonstration ; les vraies tables et produits doivent être créés via le dashboard. `ADMIN_TOKEN` est obligatoire pour les routes d’administration. En production, `NODE_ENV=production` impose un jeton d’au moins 32 caractères et `DATABASE_URL`.

## Smoke test

Le smoke test démarre le serveur Express dans le même processus Node que le test, lié à `127.0.0.1` sur un port éphémère, avec une base SQLite créée dans un dossier temporaire. Il ne lit ni `BASE_URL`, ni `DATABASE_URL`/`TEST_DATABASE_URL` et refuse ces variables si elles sont renseignées. Aucun serveur déjà démarré ni base existante ne reçoit ses écritures.

```powershell
Set-Location '...\Projet de 1Million\server'
npm run smoke
```

Les commandes, sessions, réservation, produits/tables et points de fidélité sont créés uniquement dans cette base temporaire ; le serveur Express est fermé et le répertoire temporaire supprimé à la fin, y compris si le test échoue. Une erreur de démarrage ou de nettoyage est signalée.

Les garde-fous de l’URL sont testés par `node --test ./scripts/smoke-target.test.js`. Ils acceptent uniquement une origine HTTP de loopback sur le port éphémère attendu ; les URLs externes, HTTPS, ports inattendus, identifiants, chemins et redirections sont refusés ou désactivés. Le smoke test lui-même n’offre pas de mode cible distante ni de mode PostgreSQL.

## Variables d’environnement

`server/.env.example` est le modèle à copier vers un fichier `.env` local non versionné ou à configurer dans l’environnement du service :

- `PORT` : port d’écoute.
- `ADMIN_TOKEN` : secret aléatoire d’au moins 32 caractères en production.
- `PUBLIC_SITE_URL` : domaine HTTPS réel du frontend, utilisé pour générer les QR.
- `ALLOWED_ORIGINS` (alias historique : `CORS_ORIGINS`) : origines exactes, sans chemin.
- `DATABASE_URL` : quand elle est présente, sélectionne PostgreSQL ; vide, le backend utilise SQLite local.
- `PGSSLMODE=require` : active TLS avec vérification du certificat si le fournisseur l’exige.
- `WASSA_DB_PATH` et `WASSA_DATA_DIR` : chemins privés optionnels pour les données SQLite locales.
- `GEMINI_API_URL` et `GEMINI_API_KEY` : uniquement si la fonction Gemini facultative est utilisée.

Ne publiez jamais `.env`, le jeton d’administration, la clé Gemini ou une base contenant des données clients. Le tableau de bord statique peut être consulté sans authentification ; seules les routes d’administration de l’API sont protégées par le jeton.

Netlify publie uniquement `dist/`, produit à partir d’une liste blanche de ressources web ; ni `server/`, ni la base, ni ses sauvegardes ne font partie du build. `.netlifyignore` ajoute des exclusions en défense en profondeur, mais ne remplace pas cette séparation.

## Limite avant production

SQLite sur un runtime serverless ou éphémère ne garantit pas la persistance. L’adaptateur PostgreSQL est présent, mais le démarrage réel, les tests métier complets, la migration de données et le déploiement n’ont pas été validés. Ne déclarez pas le backend prêt pour la production avant d’avoir testé avec une vraie base PostgreSQL isolée, puis configuré le service de production et validé les parcours HTTPS.

L’initialisation PostgreSQL est additive et idempotente (`CREATE TABLE/INDEX IF NOT EXISTS`) : elle ne supprime aucune donnée et ne peuple pas le menu ou les tables. Aucun transfert SQLite → PostgreSQL n’est effectué au démarrage ; prévoyez une migration contrôlée des données utiles avant la mise en service.
