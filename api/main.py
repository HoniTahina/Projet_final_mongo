"""Projet final NoSQL — Immobilier Hérault (DVF).

Deux collections liées :
  - mutations : une mutation immobilière = un document, avec ses lots
    imbriqués (embed — 1:peu, jamais consultés hors de leur mutation).
  - communes  : référentiel léger (~340 communes de l'Hérault), REFERENCE
    depuis mutations via `code_postal` — existence indépendante, réutilisée
    par des milliers de mutations, stats recalculées périodiquement.

Documentation interactive une fois démarré : http://localhost:8000/docs
"""

import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, GEOSPHERE, MongoClient
from pymongo.errors import DuplicateKeyError

MONGO_URI = os.environ["MONGO_URI"]
MONGO_DB = os.environ.get("MONGO_DB", "immo")
COLLECTION = os.environ.get("COLLECTION", "mutations")
COMMUNES_COLLECTION = os.environ.get("COMMUNES_COLLECTION", "communes")
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "http://localhost:3000")

# Mettez AUTO_INDEX=false dans .env pour démarrer SANS index : c'est ce qui vous
# permet de capturer l'explain() "avant" exigé par le cahier des charges (§1.5).
AUTO_INDEX = os.environ.get("AUTO_INDEX", "true").lower() != "false"


@asynccontextmanager
async def lifespan(_: FastAPI):
    if AUTO_INDEX:
        creer_index()
    yield
    client.close()


app = FastAPI(title="Projet NoSQL — Immobilier Hérault", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

# UN SEUL client pour tout le processus : il gère lui-même son pool.
client = MongoClient(MONGO_URI)
db = client[MONGO_DB]
col = db[COLLECTION]
col_communes = db[COMMUNES_COLLECTION]


def creer_index() -> list[str]:
    """Index justifiés par les 3 questions métier :

    - (code_postal, date_mutation) : ESR — Equality (filtre par commune),
      puis Range (plage de dates) — sert la Q1 (évolution prix/m² par commune)
      et la route /agg/explain (requête la plus fréquente de l'API).
    - id_mutation unique : le piège de comptage documenté du jeu DVF (une
      mutation ne doit jamais être dupliquée après regroupement des lots).
    - position 2dsphere : sert la Q3 (recherche par rayon autour d'un point).
    """
    return [
        col.create_index([("code_postal", ASCENDING), ("date_mutation", DESCENDING)]),
        col.create_index([("id_mutation", ASCENDING)], unique=True, sparse=True),
        col.create_index([("position", GEOSPHERE)]),
    ]


class LotEntrant(BaseModel):
    """Un lot embarqué : n'existe jamais indépendamment de sa mutation."""

    type_local: str = Field(min_length=1, max_length=50)
    surface_reelle_bati: float = Field(ge=0)
    nb_pieces: int = Field(ge=0, default=0)


class MutationEntrant(BaseModel):
    """Ce que le client a le droit d'envoyer. Tout le reste est rejeté en 422."""

    id_mutation: str = Field(min_length=1, max_length=50)
    date_mutation: str = Field(description="Format ISO : YYYY-MM-DD")
    valeur_fonciere: float = Field(ge=0)
    type_local_dominant: str = Field(min_length=1, max_length=50)
    code_postal: str = Field(min_length=5, max_length=5)
    longitude: float | None = None
    latitude: float | None = None
    lots: list[LotEntrant] = Field(default_factory=list)


def vers_document(mutation: MutationEntrant) -> dict[str, Any]:
    """Traduit le modèle d'entrée validé en document MongoDB (date + GeoJSON)."""
    doc = mutation.model_dump(exclude={"longitude", "latitude", "date_mutation"})
    doc["date_mutation"] = datetime.fromisoformat(mutation.date_mutation)
    if mutation.longitude is not None and mutation.latitude is not None:
        doc["position"] = {
            "type": "Point",
            "coordinates": [mutation.longitude, mutation.latitude],
        }
    return doc


def serialiser(doc: dict[str, Any]) -> dict[str, Any]:
    doc["_id"] = str(doc["_id"])
    if "date_mutation" in doc and isinstance(doc["date_mutation"], datetime):
        doc["date_mutation"] = doc["date_mutation"].isoformat()
    return doc


def en_object_id(item_id: str) -> ObjectId:
    try:
        return ObjectId(item_id)
    except InvalidId:
        raise HTTPException(status_code=422, detail="Identifiant invalide")


# --------------------------------------------------------------- diagnostic
@app.get("/health")
def health() -> dict[str, Any]:
    """Première commande du passage de validation."""
    client.admin.command("ping")
    return {
        "status": "ok",
        "base": MONGO_DB,
        "collection": COLLECTION,
        "documents": col.count_documents({}),
        "communes": col_communes.count_documents({}),
    }


# --------------------------------------------------------------------- CRUD
@app.get("/mutations")
def lister(
    code_postal: str | None = None,
    limite: int = Query(20, ge=1, le=100),
    page: int = Query(1, ge=1),
) -> dict[str, Any]:
    """Liste paginée, filtrable par commune (code_postal)."""
    filtre = {"code_postal": code_postal} if code_postal else {}
    curseur = col.find(filtre).skip((page - 1) * limite).limit(limite)
    return {
        "page": page,
        "limite": limite,
        "total": col.count_documents(filtre),
        "resultats": [serialiser(d) for d in curseur],
    }


@app.get("/mutations/{item_id}")
def detail(item_id: str) -> dict[str, Any]:
    """Détail d'une mutation, enrichi du nom de la commune via $lookup."""
    pipeline = [
        {"$match": {"_id": en_object_id(item_id)}},
        {
            "$lookup": {
                "from": COMMUNES_COLLECTION,
                "localField": "code_postal",
                "foreignField": "_id",
                "as": "commune",
            }
        },
        {"$unwind": {"path": "$commune", "preserveNullAndEmptyArrays": True}},
    ]
    resultats = list(col.aggregate(pipeline))
    if not resultats:
        raise HTTPException(status_code=404, detail="Document introuvable")
    doc = resultats[0]
    if "commune" in doc and doc["commune"]:
        doc["commune"]["_id"] = str(doc["commune"]["_id"])
    return serialiser(doc)


@app.post("/mutations", status_code=201)
def creer(mutation: MutationEntrant) -> dict[str, str]:
    try:
        resultat = col.insert_one(vers_document(mutation))
    except DuplicateKeyError:
        raise HTTPException(
            status_code=409,
            detail=f"Une mutation avec id_mutation={mutation.id_mutation!r} existe déjà",
        )
    return {"_id": str(resultat.inserted_id)}


@app.put("/mutations/{item_id}")
def modifier(item_id: str, mutation: MutationEntrant) -> dict[str, Any]:
    resultat = col.update_one(
        {"_id": en_object_id(item_id)}, {"$set": vers_document(mutation)}
    )
    if resultat.matched_count == 0:
        raise HTTPException(status_code=404, detail="Document introuvable")
    return {"modifies": resultat.modified_count}


@app.delete("/mutations/{item_id}")
def supprimer(item_id: str) -> dict[str, int]:
    resultat = col.delete_one({"_id": en_object_id(item_id)})
    if resultat.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Document introuvable")
    return {"supprimes": resultat.deleted_count}


# --------------------------------------------------------------- agrégation
@app.get("/agg/prix-m2-evolution/{code_postal}")
def prix_m2_evolution(code_postal: str) -> list[dict[str, Any]]:
    """Question métier 1 : évolution du prix au m² par commune, par année.

    Piège évité : `surface_totale` est calculée par mutation (somme des
    lots) AVANT tout $group, jamais après un $unwind — sinon `valeur_fonciere`
    serait comptée une fois par lot et fausserait le prix au m².
    """
    pipeline = [
        {
            "$match": {
                "code_postal": code_postal,
                # Exclut les mutations à valeur symbolique (donations,
                # transmissions familiales, régularisations administratives)
                # non représentatives d'un prix de marché. Mesuré sur le
                # jeu complet : 622 mutations sur 29519 (≈ 2,1 %) ont une
                # valeur_fonciere < 1000€, dont 235 à 1€ ou moins.
                "valeur_fonciere": {"$gte": 1000},
            }
        },
        {"$addFields": {"surface_totale": {"$sum": "$lots.surface_reelle_bati"}}},
        {"$match": {"surface_totale": {"$gt": 0}}},
        {
            "$group": {
                "_id": {"$year": "$date_mutation"},
                "valeur_totale": {"$sum": "$valeur_fonciere"},
                "surface_totale": {"$sum": "$surface_totale"},
                "n": {"$sum": 1},
            }
        },
        {
            "$project": {
                "_id": 0,
                "annee": "$_id",
                "prix_m2_moyen": {
                    "$round": [{"$divide": ["$valeur_totale", "$surface_totale"]}, 2]
                },
                "n": 1,
            }
        },
        {"$sort": {"annee": 1}},
    ]
    return list(col.aggregate(pipeline))


@app.get("/agg/top10-communes")
def top10_communes(limite: int = Query(10, ge=1, le=50)) -> list[dict[str, Any]]:
    """Question métier 2 : top communes les plus chères (prix/m² moyen).

    Contient le $lookup significatif exigé par le cahier des charges :
    `mutations` ne stocke que `code_postal`, le nom de la commune est
    récupéré depuis le référentiel `communes`.
    """
    pipeline = [
        {
            "$match": {
                # Cf. commentaire de prix_m2_evolution : exclut les valeurs
                # symboliques non représentatives d'un prix de marché.
                "valeur_fonciere": {"$gte": 1000},
            }
        },
        {"$addFields": {"surface_totale": {"$sum": "$lots.surface_reelle_bati"}}},
        {"$match": {"surface_totale": {"$gt": 0}}},
        {
            "$group": {
                "_id": "$code_postal",
                "valeur_totale": {"$sum": "$valeur_fonciere"},
                "surface_totale": {"$sum": "$surface_totale"},
                "n": {"$sum": 1},
            }
        },
        # Évite qu'une commune à 1-2 mutations fausse le classement.
        {"$match": {"n": {"$gte": 5}}},
        {
            "$project": {
                "prix_m2_moyen": {
                    "$round": [{"$divide": ["$valeur_totale", "$surface_totale"]}, 2]
                },
                "n": 1,
            }
        },
        {"$sort": {"prix_m2_moyen": -1}},
        {"$limit": limite},
        {
            "$lookup": {
                "from": COMMUNES_COLLECTION,
                "localField": "_id",
                "foreignField": "_id",
                "as": "commune",
            }
        },
        {"$unwind": "$commune"},
        {
            "$project": {
                "_id": 0,
                "code_postal": "$_id",
                "nom_commune": "$commune.nom_commune",
                "prix_m2_moyen": 1,
                "n": 1,
            }
        },
    ]
    return list(col.aggregate(pipeline))


@app.get("/agg/proximite")
def proximite(
    lon: float, lat: float, rayon_km: float = Query(5, gt=0, le=50)
) -> list[dict[str, Any]]:
    """Question métier 3 : mutations dans un rayon donné autour d'un point.

    $geoNear doit être le PREMIER stage : il exploite directement l'index
    2dsphere de la collection source, avant toute transformation.
    """
    pipeline = [
        {
            "$geoNear": {
                "near": {"type": "Point", "coordinates": [lon, lat]},
                "distanceField": "distance_m",
                "maxDistance": rayon_km * 1000,
                "spherical": True,
            }
        },
        {
            "$project": {
                "_id": 0,
                "id_mutation": 1,
                "valeur_fonciere": 1,
                "code_postal": 1,
                "distance_m": {"$round": ["$distance_m", 0]},
            }
        },
        {"$limit": 100},
    ]
    return list(col.aggregate(pipeline))


# -------------------------------------------------- index & plan d'exécution
@app.post("/admin/index", status_code=201)
def creer_les_index() -> dict[str, Any]:
    return {"index_crees": creer_index()}


@app.delete("/admin/index")
def supprimer_les_index() -> dict[str, Any]:
    avant = [i for i in col.index_information() if i != "_id_"]
    col.drop_indexes()
    return {"index_supprimes": avant}


def _chaine_de_stages(etage: dict[str, Any]) -> list[str]:
    """ATTENTION — le stage RACINE d'une requête indexée est `FETCH`, pas
    `IXSCAN`. L'IXSCAN est son `inputStage`. Ne rapportez jamais le seul
    stage racine."""
    chaine = []
    while etage:
        chaine.append(etage["stage"])
        etage = etage.get("inputStage") or (etage.get("inputStages") or [None])[0]
    return chaine


@app.get("/agg/explain")
def expliquer(code_postal: str = "34000") -> dict[str, Any]:
    """Plan d'exécution de la requête la plus fréquente de l'API
    (filtrage par commune) : de quoi produire la capture avant/après index.

    Protocole :
      1. démarrer avec AUTO_INDEX=false, appeler cette route  -> COLLSCAN
      2. POST /admin/index
      3. rappeler cette route                                 -> FETCH <- IXSCAN
    """
    plan = db.command(
        "explain",
        {"find": COLLECTION, "filter": {"code_postal": code_postal}},
        verbosity="executionStats",
    )
    stats = plan["executionStats"]
    stages = _chaine_de_stages(stats["executionStages"])
    nb_rendus = stats["nReturned"]
    return {
        "stages": stages,
        "stage_racine": stages[0],
        "index_utilise": "IXSCAN" in stages,
        "totalDocsExamined": stats["totalDocsExamined"],
        "totalKeysExamined": stats["totalKeysExamined"],
        "nReturned": nb_rendus,
        "ratio_examines_sur_rendus": (
            round(stats["totalDocsExamined"] / nb_rendus, 1) if nb_rendus else None
        ),
        "executionTimeMillis": stats["executionTimeMillis"],
    }