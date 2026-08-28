# Squelette de départ — projet final NoSQL

Trois services qui démarrent ensemble : **MongoDB** (authentification activée),
une **API REST** FastAPI, un **front statique** servi par nginx.

Ce squelette est **testé et fonctionnel**. Il ne constitue pas votre projet :
remplacez la collection `items`, les modèles et les pipelines par ceux de votre sujet.

## Démarrage

```bash
cp .env.example .env          # puis changez les deux mots de passe
docker compose up -d --build

curl http://localhost:8000/health     # {"status":"ok", ..., "documents":0}
open http://localhost:3000            # front minimal
open http://localhost:8000/docs       # documentation interactive de l'API
```

Arrêt : `docker compose down` — arrêt **et suppression des données** : `docker compose down -v`.

## Ce que fait le squelette

| Route | Rôle |
|---|---|
| `GET /health` | Vérifie la liaison API ↔ MongoDB et compte les documents |
| `GET /items?categorie=&page=&limite=` | Liste **paginée** avec filtre optionnel |
| `GET /items/{id}` | Détail, `404` si absent, `422` si l'identifiant est mal formé |
| `POST /items` | Création, entrée validée par Pydantic (`422` si invalide) |
| `PUT /items/{id}` | Mise à jour par `$set` |
| `DELETE /items/{id}` | Suppression |
| `GET /agg/par-categorie` | Exemple de pipeline `$group` / `$sort` / `$limit` exposé en REST |
| `GET /agg/explain` | Renvoie la **chaîne de stages**, `totalDocsExamined`, `nReturned` et le ratio — pour vos captures avant/après index |
| `POST /admin/index` | Crée les index à la demande |
| `DELETE /admin/index` | Supprime tous les index sauf `_id_` |

Vérification rapide :
```bash
curl -X POST http://localhost:8000/items -H 'Content-Type: application/json' \
  -d '{"nom":"Casque X","categorie":"accessoire","valeur":89.9}'
curl http://localhost:8000/agg/par-categorie
curl "http://localhost:8000/agg/explain?categorie=accessoire"
```

## Produire la capture `explain()` avant / après (exigence n° 5)

C'est l'exigence sur laquelle le plus de binômes se font piéger, pour une raison
simple : **si les index existent dès le premier démarrage, l'état « avant »
n'existe jamais.** D'où le protocole, à faire une fois vos vraies données importées :

```bash
# 1. démarrer SANS index
sed -i '' 's/^AUTO_INDEX=.*/AUTO_INDEX=false/' .env   # Linux : sed -i 's/.../'
docker compose up -d --force-recreate api
curl "http://localhost:8000/agg/explain?categorie=accessoire"
#    -> {"stages":["COLLSCAN"], "index_utilise":false, "totalDocsExamined":70000, ...}

# 2. créer les index
curl -X POST http://localhost:8000/admin/index

# 3. recapturer
curl "http://localhost:8000/agg/explain?categorie=accessoire"
#    -> {"stages":["FETCH","IXSCAN"], "index_utilise":true, "totalDocsExamined":42, ...}

# 4. remettre AUTO_INDEX=true : un index ne doit pas dépendre d'un geste manuel
```

> **Le détail qui compte.** Après indexation, le stage **racine** est `FETCH`, pas
> `IXSCAN` — l'`IXSCAN` est son `inputStage`. Un rapport qui annonce
> « COLLSCAN → FETCH » montre qu'on a lu le mauvais champ. C'est pour cela que la
> route renvoie la **chaîne complète** (`["FETCH","IXSCAN"]`) et un booléen
> `index_utilise`, et non le seul stage racine.

## Points à conserver quand vous le modifierez

1. **Un seul `MongoClient`** pour tout le processus — il gère son propre pool de connexions. En créer un par requête est l'erreur de performance classique.
2. **Les index sont créés au démarrage** (`creer_index`, appelé par le `lifespan`), donc versionnés avec le code. Un index créé à la main en séance disparaît à la prochaine installation. Le drapeau `AUTO_INDEX` n'est là que pour la capture avant/après — il reste à `true` le reste du temps.
3. **Les entrées sont validées** par un modèle Pydantic. N'insérez jamais un `dict` reçu tel quel : c'est la porte ouverte à l'injection d'opérateurs.
4. **Les secrets viennent de l'environnement.** `.env` est dans `.gitignore`, `.env.example` est commité.
5. **L'utilisateur applicatif n'est pas `root`** : `db/01-init-app-user.js` lui donne `readWrite` sur la seule base du projet.
6. **CORS est restreint** à l'origine du front. `allow_origins=["*"]` est un défaut relevé à la validation.
7. **Le cycle de vie passe par `lifespan`**, pas par `@app.on_event("startup")`, déprécié depuis FastAPI 0.93. Beaucoup de tutoriels en ligne montrent encore l'ancienne forme : ne la recopiez pas.

## Importer votre jeu de données

```bash
# JSON (une ligne par document)
docker cp mesdonnees.json projet-mongo:/tmp/
docker exec projet-mongo mongoimport -u admin -p "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --db projet --collection items --drop \
  --file /tmp/mesdonnees.json

# CSV avec en-tête
docker exec projet-mongo mongoimport -u admin -p "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --db projet --collection items --drop \
  --type csv --headerline --file /tmp/mesdonnees.csv
```

Placez ces commandes dans un script `db/import.sh` : votre README doit permettre
à un tiers de **tout rejouer** depuis zéro.

## Piège connu

`db/01-init-app-user.js` n'est exécuté **qu'à la création du volume**. Si vous le
modifiez après un premier démarrage, il ne se rejouera pas : `docker compose down -v`
puis `docker compose up -d` pour repartir d'une base vierge.
