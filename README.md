# RGM - Real Ghetto Man

Site d'écoute pour un studio : le studio importe ses musiques depuis un espace privé,
le public les écoute, les note et peut enregistrer ses titres favoris.

L'application est développée en JavaScript : **React** (client), **Node.js / Express** (serveur),
**Sequelize** (ORM) et **MySQL** (base de données).

## Architecture

```text
Navigateur
    │ http://localhost:3000
    ▼
Conteneur app : serveur Node.js + site React compilé
    │ réseau privé Docker Compose
    ▼
Conteneur mysql : base de données MySQL

Volumes Docker :
  rgm_mysql_data  → données de la base MySQL
  rgm_uploads     → morceaux audio et pochettes importés
```

Le `Dockerfile` est la recette qui construit l'image de l'application. `compose.yaml` démarre
l'application et MySQL ensemble. L'image ne contient pas la base de données ni les fichiers
importés : ils sont conservés dans les volumes Docker. L'image n'est pas un ISO.

## Démarrer avec Docker (recommandé pour l'équipe)

### Prérequis

- Docker Desktop installé et démarré (Windows, macOS ou Linux).
- Git et un terminal (PowerShell sous Windows).

Vérifier que Docker est disponible :

```powershell
docker --version
docker compose version
docker info
```

Si `docker info` indique que le moteur ne répond pas, ouvrir Docker Desktop et attendre qu'il
soit démarré.

### 1. Préparer les secrets locaux

Depuis la racine du dépôt, créer la configuration Docker personnelle :

```powershell
Copy-Item .env.docker.example .env.docker
notepad .env.docker
```

Remplacer les mots de passe et la clé d'exemple par des valeurs fortes et privées. Au minimum,
modifier `DB_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `ADMIN_PASSWORD` et `SECRET_KEY`. `DB_PASSWORD`
est le mot de passe de l'utilisateur MySQL de l'application ; la même valeur est utilisée pour
initialiser cet utilisateur dans le conteneur MySQL.

Pour générer une valeur aléatoire hexadécimale avec Node.js, exécuter la commande ci-dessous
quatre fois et utiliser une sortie différente pour chacun de ces quatre réglages :

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Le fichier `.env.docker` est ignoré par Git. **Ne jamais le publier ou envoyer ses secrets.**
Chaque collaborateur crée son propre fichier local à partir de `.env.docker.example`.

### 2. Vérifier la configuration et construire l'image

```powershell
docker compose --env-file .env.docker config
docker compose --env-file .env.docker build
```

La première commande affiche la configuration résolue (ne pas partager la sortie si elle révèle
des secrets). La seconde installe les dépendances, compile le site React et construit l'image
locale `rgm-app:local`.

### 3. Démarrer l'application et MySQL

```powershell
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs app
```

Compose attend que MySQL soit prêt avant de lancer l'application. Au premier démarrage, MySQL
peut prendre un peu de temps pour initialiser son volume.

Ouvrir ensuite :

| Écran | Adresse |
|---|---|
| Site public | http://localhost:3000 |
| Espace studio | http://localhost:3000/admin |

Se connecter avec `ADMIN_EMAIL` et `ADMIN_PASSWORD` définis dans `.env.docker`. Le serveur crée
la base, les tables et le compte studio au démarrage : il n'est pas nécessaire d'utiliser
phpMyAdmin.

### 4. Tester les fonctions et la persistance

Dans le navigateur, vérifier le site public et `/admin`, importer un morceau, puis écouter le
morceau. Vérifier également l'état et les journaux :

```powershell
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail=100 app
docker compose --env-file .env.docker logs --tail=100 mysql
```

Redémarrer les conteneurs :

```powershell
docker compose --env-file .env.docker restart
```

Après redémarrage, vérifier que les morceaux, pochettes et titres sont toujours disponibles.
La base est conservée dans `rgm_mysql_data`, et les fichiers importés dans `rgm_uploads`.

### Commandes Docker utiles

```powershell
# Suivre les journaux de tous les services (Ctrl+C arrête seulement le suivi)
docker compose --env-file .env.docker logs -f

# Arrêter et supprimer les conteneurs, en conservant les volumes et les données
docker compose --env-file .env.docker down

# Après un changement du code, reconstruire l'image puis relancer
docker compose --env-file .env.docker up -d --build
```

**Attention :** `docker compose down -v` supprime aussi les volumes et donc les données
persistantes de la base et des imports. Ne l'utiliser que si l'on souhaite réellement effacer
les données locales.

Si le port 3000 est déjà pris, changer `APP_PORT` dans `.env.docker` (par exemple `APP_PORT=3001`)
puis ouvrir `http://localhost:3001`.

## Livrable Docker pour Kubernetes

Le `Dockerfile` produit une image Linux de l'application : serveur Node.js, client React compilé
et dépendances de production. Il n'embarque ni MySQL, ni les secrets, ni les morceaux importés.
Le port du serveur dans le conteneur est `3000`.

La construction et la publication de cette image peuvent être faites par un membre de l'équipe
sur un autre ordinateur avec Docker opérationnel. Il n'est pas nécessaire d'installer ou de lancer
Docker Desktop sur chaque poste pour préparer le code. Depuis la racine du dépôt, sur le poste qui
construira l'image :

```powershell
docker --version
docker build --pull -t rgm-app:1.0.0 .
docker image inspect rgm-app:1.0.0
```

Pour que Kubernetes puisse récupérer l'image, il faut la publier dans un registre accessible au
cluster. Exemple avec GHCR (remplacer `organisation` par le propriétaire du registre et choisir
un tag de version cohérent avec l'équipe) :

```powershell
docker login ghcr.io --username VOTRE_NOM_GITHUB
docker tag rgm-app:1.0.0 ghcr.io/organisation/rgm:1.0.0
docker push ghcr.io/organisation/rgm:1.0.0
```

À l'invite de connexion, utiliser un jeton GitHub ayant le droit de publier des paquets ; ne pas
inscrire ce jeton dans le dépôt, le Dockerfile ou une commande partagée. Si le paquet GHCR reste
privé, la personne qui configure Kubernetes devra également créer un secret `imagePullSecret`.
Vérifier avec l'équipe le registre, son propriétaire et l'architecture du cluster avant de
publier. L'image doit être accessible et compatible avec l'architecture des nœuds Kubernetes.

Transmettre à la personne chargée de Kubernetes le nom complet et le tag de l'image publiée,
par exemple `ghcr.io/organisation/rgm:1.0.0`, ainsi que les variables de configuration à fournir
au démarrage : `PORT=3000`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD` et `SECRET_KEY`. Ces valeurs doivent être configurées dans
Kubernetes, pas intégrées à l'image. Le service MySQL et le stockage persistant des imports
(`/app/uploads`) devront être prévus séparément dans le déploiement Kubernetes ; les volumes de
`compose.yaml` ne sont pas automatiquement transférés dans Kubernetes.

## Partager le travail avec les collaborateurs

À versionner dans GitHub :

- le code source ;
- `Dockerfile`, `compose.yaml` et `.dockerignore` ;
- `.env.docker.example` (valeurs d'exemple uniquement) ;
- ce README et les changements associés.

Ne pas versionner `.env`, `.env.docker`, les bases de données, les fichiers audio privés ni les
pochettes importées. Les collaborateurs récupèrent le dépôt, créent leur propre `.env.docker`,
puis exécutent les commandes de démarrage ci-dessus. Docker construit alors l'image à partir du
code partagé.

L'image Docker ne se versionne pas dans le dépôt Git : le dépôt contient le code et les recettes,
le registre contient l'image construite. Pour le transfert vers Kubernetes, suivre les étapes
ci-dessus afin de la publier dans un registre et transmettre son nom et son tag à l'équipe.
L'image publiée ne transporte pas les volumes ni les données utilisateur.

## Développement sans Docker (XAMPP)

Prérequis : Node.js 22 ou plus et XAMPP (ou un serveur MySQL/MariaDB). Démarrer MySQL dans
XAMPP, puis depuis la racine du dépôt :

```powershell
npm install
npm run dev
```

| Écran | Adresse |
|---|---|
| Site public | http://localhost:5173 |
| Espace studio | http://localhost:5173/admin |

Pour compiler le client et le servir avec le serveur Node :

```powershell
npm run prod
```

L'application sera sur http://localhost:3000. Pour les démarrages suivants sans recompiler :
`npm start`.

Sans configuration personnalisée, le compte de démonstration est `admin@rgm.local` /
`rgm2026`. Ne pas utiliser ces valeurs en production.

## Configuration et données

- `.env.example` documente la configuration du lancement local avec XAMPP.
- `.env.docker.example` documente la configuration Docker ; la copier en `.env.docker` et
  modifier les secrets avant le lancement.
- `ADMIN_EMAIL` et `ADMIN_PASSWORD` configurent le compte studio. Le compte est créé ou mis à
  jour au démarrage du serveur à partir de ces valeurs.
- `SECRET_KEY` signe les jetons de connexion ; choisir une longue valeur aléatoire.
- Les fichiers audio et pochettes importés sont stockés sous `uploads/` hors Docker, ou dans le
  volume `rgm_uploads` avec Docker.
- Pour conserver des données de production, sauvegarder la base MySQL et les fichiers importés.
  Les volumes Docker ne remplacent pas une sauvegarde externe.

Les images de l'application sont conçues pour Linux (`node:22-bookworm-slim`). Docker Desktop
fournit l'environnement nécessaire sous Windows.

## Modifier le contenu et le design

- Texte, email et liens du studio : objet `STUDIO` en haut de `client/src/Public.jsx`.
- Couleurs : section `:root` de `client/src/styles.css`.
- Logo : remplacer `client/public/logo.jpg`.

## Organisation du code

```text
package.json               scripts npm et dépendances serveur
package-lock.json          versions verrouillées pour npm ci et Docker
Dockerfile                 construction de l'image de l'application
compose.yaml               application, MySQL et volumes Docker
.dockerignore              fichiers exclus du contexte de construction
.env.docker.example        exemple de configuration Docker sans secrets réels
.env.example               exemple de configuration XAMPP
server/index.js            serveur, base de données, routes et import audio
client/                    application React et client compilé pour la production
uploads/                   fichiers audio et pochettes en développement local
```

## Fonctionnalités

- **Import** : le studio dépose des fichiers MP3, WAV, FLAC, M4A, AAC ou OGG dans `/admin`.
  Les métadonnées et pochettes disponibles sont lues ; les fichiers invalides sont refusés.
- **Brouillons** : un titre non publié dans l'espace studio n'apparaît pas sur le site.
- **Écoute** : lecteur avec navigation entre titres et compteur d'écoutes.
- **Notes** : un visiteur identifié par cookie peut noter chaque titre et modifier sa note.
- **Favoris** : les visiteurs peuvent enregistrer des titres likés dans leur navigateur.
- **Administration** : connexion protégée, import, édition et suppression des titres.

## Dépannage

| Problème | À vérifier |
|---|---|
| Docker ne répond pas | Démarrer Docker Desktop puis lancer `docker info`. |
| `.env.docker` absent | Copier `.env.docker.example` vers `.env.docker` et remplacer les valeurs d'exemple. |
| `variable is not set` ou valeur obligatoire manquante | Vérifier les noms des variables dans `.env.docker`, sans espaces autour du signe `=`. |
| Port 3000 utilisé | Modifier `APP_PORT` dans `.env.docker` et utiliser le nouveau port dans le navigateur. |
| L'application ne se connecte pas à MySQL | Vérifier `docker compose --env-file .env.docker logs mysql` et que `DB_PASSWORD` correspond bien au mot de passe de l'utilisateur MySQL. `DB_HOST` est fourni par Compose comme `mysql`. |
| MySQL ne démarre pas après un changement de mot de passe | Le volume existant conserve l'ancien mot de passe MySQL. Pour un environnement local sans données à garder, arrêter puis supprimer les volumes avec `docker compose --env-file .env.docker down -v`, puis relancer. **Cette opération efface la base et les fichiers importés.** |
| L'application démarre trop tôt | Vérifier que le service `mysql` est `healthy` avec `docker compose --env-file .env.docker ps`, puis consulter `docker compose --env-file .env.docker logs app`. |
| Une modification du code n'est pas visible dans Docker | Reconstruire et relancer : `docker compose --env-file .env.docker up -d --build`. |

## Périmètre du projet

La partie Docker fournit le Dockerfile de l'application, Compose pour le test local avec MySQL,
et les instructions pour construire et publier une image de version destinée à Kubernetes.
Le déploiement Kubernetes, NGINX Ingress et l'autoscaling restent à réaliser par les membres
chargés de ces étapes.
