# Netlify — frontend statique et fonction Gemini facultative

Netlify construit les pages statiques avec `npm run build:netlify` dans un répertoire isolé `dist/`. Le script copie seulement une liste blanche de pages, ressources frontend et images ; `netlify.toml` ne publie jamais la racine du dépôt. Le redirect `/api/gemini/generate` concerne uniquement le proxy Gemini.

**Ce déploiement ne lance pas `server/index.js` et ne fournit pas la base SQLite des commandes.** Pour recevoir les commandes, gérer les tables et utiliser le tableau de bord, déployer séparément `server/` sur un service Node.js avec stockage persistant, puis renseigner dans `restaurant-config.js` :

- `mode: 'production'`
- `publicUrl` : URL HTTPS du site Netlify
- `apiBaseUrl` : URL HTTPS du backend Node.js

Sur le backend, définir `PUBLIC_SITE_URL` avec le domaine Netlify et `CORS_ORIGINS` avec son origine exacte (par exemple `https://exemple.netlify.app`). Ne pas utiliser de caractères génériques pour autoriser les origines en production.

Le tableau de bord HTML est accessible publiquement comme le reste du frontend. Il ne doit contenir aucun secret ; les données et les opérations administrateur sont protégées par `ADMIN_TOKEN` sur l’API backend. `.netlifyignore` et `.gitignore` excluent aussi les répertoires backend, variables d’environnement, bases, journaux et sauvegardes, mais la protection principale est l’artefact `dist/` en liste blanche.

## Gemini (facultatif)

Si la fonction Gemini est conservée, configurer `GEMINI_API_URL` et `GEMINI_API_KEY` dans les variables d’environnement Netlify. La clé ne doit jamais être placée dans le JavaScript du navigateur. Configurer également le rôle admin ou le secret d’intégration requis par l’implémentation de la fonction. Cette intégration ne remplace pas l’API de commande et n’est pas nécessaire au fonctionnement du menu, des tables, des commandes ou du paiement sur place.

Tester la fonction avec Netlify CLI (`netlify dev`) et vérifier séparément le backend Node.js via `/api/health`. Le paiement mobile et par carte reste indisponible tant qu’un provider réel n’est pas configuré.
