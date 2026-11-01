# RGM — Real Ghetto Man

Application d'écoute pour un studio : le public écoute, note et enregistre ses titres favoris ;
le studio gère les morceaux depuis `/admin`.

**Technologies :** React, Node.js/Express, Sequelize et MySQL.

## Lancer en local

Prérequis : Node.js 22 ou plus et MySQL/MariaDB (par exemple avec XAMPP).

1. Démarrer MySQL.
2. À la racine du projet, installer et lancer :

```bash
npm install
npm run dev
```

Site : http://localhost:5173 — Studio : http://localhost:5173/admin

Pour compiler le site et le servir avec le serveur Node :

```bash
npm run prod
```

L'application sera alors disponible sur http://localhost:3000. Le compte local par défaut est
`admin@rgm.local` / `rgm2026` : change-le avant tout déploiement.

## Lancer avec Docker

Prérequis : Docker Desktop démarré. À la racine du projet :

```powershell
Copy-Item .env.docker.example .env.docker
```

Modifier les mots de passe et `SECRET_KEY` dans `.env.docker`, puis lancer :

```powershell
docker compose --env-file .env.docker up -d --build
```

Ouvrir http://localhost:3000. Arrêter les conteneurs sans supprimer les données :

```powershell
docker compose --env-file .env.docker down
```

**Attention :** `docker compose down -v` supprime aussi la base et les imports.

## Démo hébergée

Le projet peut être hébergé sans Docker pour une démonstration avec :

- **Render** pour l'application ;
- **TiDB Cloud** pour la base compatible MySQL ;
- la base TiDB pour conserver les musiques et pochettes.

Dans Render, connecter le dépôt GitHub et choisir :

- Build : `npm ci && npm run build`
- Start : `npm start`
- Node : `22`

Dans les variables d'environnement Render, configurer `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`, `DB_AUTO_CREATE=false`, `FILE_STORAGE=database`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SECRET_KEY` et `MAX_UPLOAD_MB=20`. Créer la base `rgm` dans
TiDB avant le premier démarrage. Les fichiers sont alors stockés dans TiDB avec les titres.

Le plan Starter propose un quota gratuit et une limite de dépenses à `$0` ; lorsque le quota est
épuisé, la base peut être bridée. Ne pas ajouter de mots de passe ou de clés dans GitHub. Utiliser
des secrets uniques, jamais le mot de passe local `rgm2026`.

Le mode `FILE_STORAGE=database` conserve les médias dans TiDB après un redémarrage de Render.
Pour garder la démonstration dans les limites du forfait, les imports sont limités à 20 Mo par
fichier avec `MAX_UPLOAD_MB=20`. Le forfait Starter MySQL-compatible inclut 5 Gio de stockage ;
l'application affiche l'espace occupé par les fichiers dans `/admin`, avertit quand il approche de
4 Gio et refuse un nouvel import qui dépasserait cette réserve. Les 1 Gio restants sont réservés
aux tables et aux autres données de la base. TiDB reste la référence pour le quota réel.

Aucun morceau ni fichier média n'est supprimé automatiquement pour libérer de l'espace. L'interface
d'administration ne propose pas de suppression de titres ; remplacer une pochette conserve aussi
l'ancienne image dans la base. Quand la réserve est atteinte, les nouveaux imports sont refusés et
les morceaux déjà stockés restent en place. Les données et les quotas des fournisseurs peuvent
évoluer : surveiller également l'utilisation affichée dans TiDB Cloud.

Le stockage des morceaux et des pochettes utilise les opérations et l'espace du quota TiDB. Le mode
local par défaut (`FILE_STORAGE=local`) reste adapté au développement avec XAMPP.

L'offre gratuite convient à une démo : le service Render peut s'endormir après une période
d'inactivité, et le premier chargement peut être lent. Surveiller les limites des offres.
Ne pas ajouter d'abonnement payant ni de moyen de paiement pour cette configuration ; les offres
gratuites restent soumises aux quotas et conditions de chaque fournisseur.

## Fichiers utiles

- [Dockerfile](./Dockerfile) : image de l'application.
- [compose.yaml](./compose.yaml) : application et MySQL en local.
- [.env.docker.example](./.env.docker.example) : configuration Docker d'exemple.
- [.env.example](./.env.example) : configuration locale et variables d'hébergement.

Les fichiers `.env`, `.env.docker`, les imports et les secrets ne doivent pas être publiés.
Docker Compose sert au test local ; le déploiement Kubernetes est une étape séparée.
