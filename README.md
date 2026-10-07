# Le WASSA

Site web mobile-first du maquis-restaurant Le WASSA : présentation, menu, réservations et commandes à table. Le dépôt contient le frontend statique, l’API Express et les outils de build Netlify.

> **État du déploiement :** le frontend peut être construit pour Netlify. Le backend local utilise SQLite par défaut. Un adaptateur PostgreSQL est présent dans le code, mais son fonctionnement et son déploiement ne sont pas encore validés ; ne pas considérer le service comme prêt pour la production.

## Fonctionnalités

- Menu du restaurant, informations et pages publiques.
- Commandes par table avec sessions QR, validation côté serveur et prix recalculés depuis le catalogue serveur.
- Clé d’idempotence pour éviter les commandes en double lors d’une nouvelle tentative.
- Administration des commandes, produits et tables avec authentification API.
- Réservations et fidélité gérées par l’API.
- Paiement sur place uniquement (`PAY_ON_SITE`). Aucun paiement en ligne n’est simulé.

## Architecture

```text
Navigateur → frontend statique (Netlify) → API Express → base de données
```

- Les pages et ressources publiques sont dans le dépôt racine.
- `server/` contient l’API, les adaptateurs de base et les scripts backend.
- `scripts/build-netlify.js` construit une liste blanche de ressources web vers `dist/`. Le backend, les bases et les secrets ne sont pas publiés.
- `restaurant-config.js` contient la configuration publique du navigateur. N’y placez jamais de secrets.
- `dashboard.html` est une page publique ; les opérations et données d’administration sont protégées par le backend, pas par le fait de cacher la page.

## Prérequis

- Node.js 20.17 ou plus récent.
- npm.

## Développement local

Installez les dépendances du frontend depuis la racine :

```powershell
npm ci
npm start
```

Le frontend est servi sur `http://localhost:5000`.

Dans un second terminal, démarrez l’API :

```powershell
Set-Location .\server
$env:ADMIN_TOKEN = 'local-demo-token-change-this-32chars'
npm ci
npm start
```

L’API écoute par défaut sur `http://localhost:5173`. En l’absence de `DATABASE_URL`, elle utilise SQLite et crée la base hors du dépôt (Windows : `%LOCALAPPDATA%\LeWASSA\db.sqlite`). Elle initialise le catalogue et les tables d’exemple si la base est vide. N’utilisez jamais le jeton local comme secret de production.

Ouvrez `admin-login.html` pour vous connecter au tableau de bord avec le même jeton. Le jeton d’administration n’est pas une configuration à inscrire dans les fichiers publics.

## Configuration

Les valeurs publiques (nom, contacts, liens et URLs publiques/API) se règlent dans `restaurant-config.js`. L’URL API de production est publique et doit être une URL HTTPS réelle ; elle n’est pas un secret.

Les variables backend se règlent dans l’environnement du processus ou à partir de `server/.env.example` copié dans un fichier `.env` local non versionné :

| Variable | Usage |
| --- | --- |
| `PORT` | Port HTTP du backend (défaut : `5173`) |
| `ADMIN_TOKEN` | Jeton d’administration ; au moins 32 caractères en production |
| `PUBLIC_SITE_URL` | Origine HTTPS utilisée par les QR en production |
| `ALLOWED_ORIGINS` / `CORS_ORIGINS` | Origines frontend autorisées, séparées par des virgules |
| `WASSA_DB_PATH` / `WASSA_DATA_DIR` | Chemin privé SQLite en développement |
| `DATABASE_URL` | Connexion PostgreSQL ; sélectionne l’adaptateur PostgreSQL |
| `GEMINI_API_URL` / `GEMINI_API_KEY` | Fonction Gemini facultative, côté serveur uniquement |

Ne commitez jamais `.env`, `DATABASE_URL`, tokens, clés API, fichiers SQLite ou sauvegardes. Le `.gitignore` protège ces fichiers ; vérifiez tout de même les fichiers proposés avant chaque commit.

## Tests et build

Depuis la racine, construisez puis vérifiez les ressources Netlify :

```powershell
npm run build:netlify
npm run test:netlify-build
```

Pour le smoke test du backend, démarrez d’abord l’API avec une base SQLite jetable et un jeton de test. Dans un autre terminal :

```powershell
Set-Location .\server
$env:WASSA_DB_PATH = Join-Path $env:TEMP 'wassa-smoke-test.sqlite'
$env:ADMIN_TOKEN = 'local-demo-token-change-this-32chars'
$env:BASE_URL = 'http://localhost:5173'
npm run smoke
```

Le test vérifie notamment les accès admin, tables/sessions, QR, calcul des prix, idempotence, commandes, statuts, fidélité, réservations et paiement manuel. Il nécessite une API démarrée avec le même environnement et nettoie les enregistrements de test ; utilisez une base isolée, jamais les données d’un établissement.

## Production et déploiement

Le frontend statique peut être déployé sur Netlify en utilisant `npm run build:netlify` et `dist/` comme répertoire publié. L’API Express doit être hébergée séparément sur une plateforme Node.js ; elle doit utiliser une base réellement persistante et une URL HTTPS.

**État actuel :**

- Le build Netlify est filtré par liste blanche.
- SQLite est le stockage local par défaut, pas une base de production pour un runtime éphémère.
- L’adaptateur PostgreSQL est sélectionné quand `DATABASE_URL` est fourni, mais il n’a pas été validé par un test complet sur PostgreSQL réel.
- Aucune URL backend/frontend, base distante, variable secrète ni infrastructure de production n’est configurée dans ce dépôt.

Avant tout déploiement réel, il faut configurer les secrets dans la plateforme d’hébergement, une base PostgreSQL persistante, les origines CORS exactes, les URLs HTTPS du frontend/API et réaliser des tests complets sur les parcours client et administrateur. Ne publiez pas de QR de production avant de connaître le domaine public définitif.

Pour Netlify, le backend ne fait pas partie du build ; la fonction Gemini facultative est documentée dans [NETLIFY_FUNCTIONS_SETUP.md](./NETLIFY_FUNCTIONS_SETUP.md) et n’est pas l’API de commande.

## Préparer une contribution

1. Créez une branche pour votre changement.
2. Ne versionnez pas les dépendances installées, `dist/`, les bases locales, `.env` ou les sauvegardes.
3. Exécutez `npm run build:netlify` et `npm run test:netlify-build`.
4. Relisez `git status` et le diff avant de créer un commit.

Le projet n’inclut pas de licence open source ; demandez l’accord du propriétaire avant d’en ajouter une.
