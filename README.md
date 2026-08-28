# Immobilier Hérault — Prix au m² (DVF 2024)

Back-end de WebApp adossé à MongoDB — Projet final, Module MIA4, IPSSI Montpellier.

## 1. Sujet et questions métier

**Source des données** : Demandes de Valeurs Foncières (DVF), data.gouv.fr — mutations immobilières réelles et géolocalisées, département de l'Hérault (34), année 2024.

```
https://files.data.gouv.fr/geo-dvf/latest/csv/2024/departements/34.csv.gz
```

**Volume** : 69 651 lignes brutes importées → 29 519 mutations distinctes après regroupement (cf. § Anomalies).

**Questions métier traitées** :

1. **Quelle est l'évolution du prix au m² pour une commune donnée, par année ?**
2. **Quelles sont les 10 communes les plus chères de l'Hérault (prix au m² moyen) ?**
3. **Quelles mutations ont eu lieu dans un rayon donné autour d'un point géographique ?**

## 2. Modélisation

### Schéma retenu — deux collections liées

**`mutations`** (collection principale — une mutation immobilière = un document) :

```javascript
{
  _id: ObjectId,
  id_mutation: "2024-404965",
  date_mutation: ISODate("2024-09-17"),
  valeur_fonciere: 695000,
  code_commune: "34172",           // référence vers `communes` — clé fiable (INSEE)
  code_postal: "34280",             // information d'affichage uniquement
  nom_commune: "La Grande-Motte",
  type_local_dominant: "Maison",    // règle de priorité, cf. § Anomalies
  surface_totale: 90,                // précalculé (pattern Computed)
  position: { type: "Point", coordinates: [4.073078, 43.561898] },
  lots: [                            // EMBED — 1:peu, jamais consultés seuls
    { type_local: "Maison", surface_reelle_bati: 90, nb_pieces: 4 }
  ]
}
```

**`communes`** (référentiel léger, ~340 documents) :

```javascript
{
  _id: "34172",              // code_commune (INSEE) — PAS code_postal
  nom_commune: "La Grande-Motte",
  code_postal: "34280",
  nb_mutations: 714,
  prix_m2_moyen: 4106.69
}
```

### Justification embed vs reference

| Relation | Choix | Pourquoi |
|---|---|---|
| Mutation → Lots | **Embed** | 1:peu (rarement plus de 5-6 lots), aucune existence propre hors de leur mutation, toujours lus ensemble |
| Mutation → Commune | **Reference** | Réutilisée par des milliers de mutations, existe indépendamment, stats recalculées périodiquement (pattern Computed) |

**Ce qui nous ferait changer d'avis** : nous avons initialement référencé les communes par `code_postal`, avant de découvrir par la mesure que ce champ n'identifie pas une commune de façon unique (cf. anomalie ci-dessous). Si un futur besoin métier nécessitait de grouper par zone postale plutôt que par commune administrative, on regarderait `code_postal` comme une dimension d'analyse supplémentaire, pas comme clé de référence.

## 3. Anomalies rencontrées et traitées

| Anomalie | Constat chiffré | Traitement |
|---|---|---|
| Une mutation s'étale sur plusieurs lignes | 69 651 lignes brutes → 29 565 `id_mutation` distincts (naïf) | Regroupement par `id_mutation` **avant** tout calcul de prix (`$group` + `$push` pour les lots) |
| Valeurs foncières symboliques | 622 mutations (≈2,1 %) à `valeur_fonciere` < 1000 €, dont 235 à ≤1 € (donations, régularisations) | Exclues des calculs de prix au m² (`$match: { valeur_fonciere: { $gte: 1000 } }`) |
| Mutations sans valeur exploitable | 46 mutations sans `valeur_fonciere` renseignée | Exclues du regroupement (29 565 → 29 519 mutations utilisables) |
| **`code_postal` non fiable comme identifiant de commune** | **81 codes postaux distincts contre 340 codes commune (INSEE) distincts** | Bascule de la clé de référence vers `code_commune` (identifiant administratif unique) |
| `type_local` vide sur les lots | Terrains non bâtis, aucun type renseigné | Règle de priorité : Maison > Appartement > premier type non vide > `"Terrain / non bâti"` (7 379 mutations concernées) |

## 4. Procédure d'installation

### Prérequis
Docker Desktop, Git.

### Étapes

```bash
git clone https://github.com/<votre-compte>/<votre-depot>.git
cd <votre-depot>
cp .env.example .env
# Éditez .env : changez MONGO_ROOT_PASSWORD et MONGO_APP_PASSWORD
docker compose up -d --build
```

### Import des données (une seule fois)

```bash
# 1. Télécharger et décompresser le CSV DVF (voir § 1 pour l'URL)
# 2. Import brut :
docker cp dvf34.csv projet-mongo:/tmp/dvf34.csv
docker exec projet-mongo mongoimport -u admin -p "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --db immo --collection lots_bruts \
  --type csv --headerline --drop --file /tmp/dvf34.csv

# 3. Construction des collections mutations + communes :
docker exec -i projet-mongo mongosh -u admin -p "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin immo < db/build_collections.js
```

### Vérification

```bash
curl http://localhost:8000/health
# {"status":"ok","base":"immo","collection":"mutations","documents":29519,"communes":340}
```

Front : http://localhost:3000
Documentation interactive de l'API : http://localhost:8000/docs

## 5. Index créés

| Index | Sert à |
|---|---|
| `{ code_commune: 1, date_mutation: -1 }` | Filtrage par commune + tri temporel (ESR) — requête la plus fréquente de l'API |
| `{ id_mutation: 1 }` unique | Empêche les doublons de mutation (piège de comptage) |
| `{ position: "2dsphere" }` | Requêtes de proximité géographique (`$geoNear`) |

**Capture `explain()` avant/après** (filtre par commune, requête la plus fréquente) :

| Métrique | Avant (COLLSCAN) | Après (FETCH → IXSCAN) |
|---|---|---|
| Stage | COLLSCAN | FETCH → IXSCAN |
| totalDocsExamined | 29 519 | 1 931 |
| nReturned | 1 931 | 1 931 |
| Ratio | 15,3 | **1,0** |
| Temps d'exécution | 161 ms | 5 ms |

Captures complètes dans `rapport/captures/`.

## 6. Routes de l'API

### CRUD (`mutations`)

| Méthode | Route | Description |
|---|---|---|
| GET | `/mutations` | Liste paginée, filtrable par `code_commune` |
| GET | `/mutations/{id}` | Détail d'une mutation (enrichi du nom de commune via `$lookup`) |
| POST | `/mutations` | Création (422 si invalide, 409 si `id_mutation` déjà existant) |
| PUT | `/mutations/{id}` | Modification (404 si inexistant) |
| DELETE | `/mutations/{id}` | Suppression (404 si inexistant) |

### Agrégations métier

| Méthode | Route | Question métier |
|---|---|---|
| GET | `/agg/prix-m2-evolution/{code_commune}` | Q1 — évolution du prix/m² par année |
| GET | `/agg/top10-communes` | Q2 — top 10 communes les plus chères (`$lookup` significatif) |
| GET | `/agg/proximite?lon=...&lat=...&rayon_km=...` | Q3 — mutations à proximité (`$geoNear`) |

### Diagnostic & administration

| Méthode | Route | Description |
|---|---|---|
| GET | `/health` | Statut de l'API et de la connexion MongoDB |
| GET | `/agg/explain?code_commune=...` | Plan d'exécution de la requête la plus fréquente |
| POST / DELETE | `/admin/index` | Créer / supprimer les index (protocole de capture avant/après) |

## 7. Sécurité

- Authentification MongoDB activée (pas d'accès anonyme).
- Utilisateur applicatif `app` : rôle `readWrite` limité à la base `immo` uniquement (vérifié : `not authorized on admin` sur toute commande d'administration).
- `.env` exclu du dépôt (`.gitignore`), `.env.example` fourni avec des valeurs factices.
- Aucun secret réel trouvé dans l'historique Git (`git log -p` vérifié).

## 8. Répartition du travail

| Tâche | Responsable |
|---|---|
| Import et nettoyage des données, construction des collections | *(nom à compléter)* |
| Détection et traitement des anomalies (comptage, valeurs aberrantes, `code_postal`/`code_commune`) | *(nom à compléter)* |
| Index et captures `explain()` | *(nom à compléter)* |
| Sécurité MongoDB (utilisateur applicatif) | *(nom à compléter)* |
| API FastAPI (CRUD, routes d'agrégation, gestion des erreurs) | *(nom à compléter)* |
| Front HTML/JS | *(nom à compléter)* |
| README et rapport | Les deux membres |