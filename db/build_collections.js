// db/build_collections.js — Construit `mutations` et `communes` à partir de
// la collection brute `lots_bruts` (une ligne CSV = un lot/une parcelle,
// id_mutation répété).
//
// PRÉREQUIS : import brut déjà fait dans lots_bruts :
//
//   mongoimport -u admin -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
//     --db immo --collection lots_bruts --type csv --headerline --drop \
//     --file /tmp/dvf34.csv
//
// Exécution (relançable à tout moment — mutations/communes sont reconstruites
// à chaque exécution, lots_bruts n'est jamais modifiée) :
//   docker exec -i projet-mongo mongosh -u admin -p "$MONGO_ROOT_PASSWORD" \
//     --authenticationDatabase admin immo < db/build_collections.js

db.mutations.drop();
db.communes.drop();

print("Documents bruts importés : " + db.lots_bruts.countDocuments({}));

// ==========================================================
// 0) Anomalie : code_postal n'identifie pas une commune de façon unique
// ==========================================================
// Vérifié AVANT toute construction, pour documenter la découverte au moment
// où elle se produit (cf. cahier des charges, § rapport).

const nbCodesPostaux = db.lots_bruts.distinct("code_postal").length;
const nbCodesCommune = db.lots_bruts.distinct("code_commune").length;
print("\n--- Anomalie : code_postal vs code_commune ---");
print("Codes postaux distincts : " + nbCodesPostaux);
print("Codes commune (INSEE) distincts : " + nbCodesCommune);
print("=> Un code postal peut couvrir plusieurs communes : il ne peut PAS");
print("   servir de clé de référence. On utilise code_commune (INSEE) à la place.\n");

// ==========================================================
// 1) Construire `mutations` — regroupement par id_mutation (LE PIÈGE DVF)
// ==========================================================
// Une mutation peut s'étaler sur plusieurs lignes. Ne JAMAIS calculer un
// prix/m² sans regrouper par id_mutation d'abord : sinon valeur_fonciere
// est comptée plusieurs fois pour la même vente.

db.lots_bruts.aggregate([
  // 1.1) Garder uniquement les lignes potentiellement exploitables.
  {
    $match: {
      id_mutation: { $nin: [null, ""] },
      valeur_fonciere: { $nin: [null, ""] },
    },
  },

  // 1.2) Conversion des champs texte CSV vers les bons types.
  // $convert avec onError/onNull:null (plutôt que $toDouble qui lèverait
  // une erreur bloquante) : les valeurs non convertibles deviennent null,
  // filtrées explicitement à l'étape 1.3 plutôt que de faire échouer tout
  // le pipeline sur une seule ligne corrompue.
  {
    $addFields: {
      valeur_fonciere_num: {
        $convert: { input: "$valeur_fonciere", to: "double", onError: null, onNull: null },
      },
      surface_num: {
        $convert: { input: "$surface_reelle_bati", to: "double", onError: 0, onNull: 0 },
      },
      nb_pieces_num: {
        $convert: { input: "$nombre_pieces_principales", to: "int", onError: 0, onNull: 0 },
      },
      longitude_num: {
        $convert: { input: "$longitude", to: "double", onError: null, onNull: null },
      },
      latitude_num: {
        $convert: { input: "$latitude", to: "double", onError: null, onNull: null },
      },
      date_mutation_dt: {
        $dateFromString: { dateString: "$date_mutation", onError: null, onNull: null },
      },
      code_postal_str: {
        $convert: { input: "$code_postal", to: "string", onError: null, onNull: null },
      },
      code_commune_str: {
        $convert: { input: "$code_commune", to: "string", onError: null, onNull: null },
      },
    },
  },

  // 1.3) Retirer les lignes dont la valeur foncière n'a pas pu être convertie.
  { $match: { valeur_fonciere_num: { $ne: null } } },

  // 1.4) Un id_mutation = un document. Les lots sont EMBED (1:peu, jamais
  // consultés hors de leur mutation).
  {
    $group: {
      _id: "$id_mutation",
      date_mutation: { $first: "$date_mutation_dt" },
      valeur_fonciere: { $first: "$valeur_fonciere_num" },
      code_commune: { $first: "$code_commune_str" }, // clé de référence fiable
      code_postal: { $first: "$code_postal_str" },    // attribut d'affichage
      nom_commune: { $first: "$nom_commune" },
      longitude: { $first: "$longitude_num" },
      latitude: { $first: "$latitude_num" },
      types_locaux: { $addToSet: "$type_local" }, // tous les types rencontrés
      lots: {
        $push: {
          type_local: "$type_local",
          surface_reelle_bati: "$surface_num",
          nb_pieces: "$nb_pieces_num",
        },
      },
    },
  },

  // 1.5) Champs calculés : surface totale (pattern Computed, stockée plutôt
  // que recalculée à chaque requête), nettoyage de types_locaux, GeoJSON.
  {
    $addFields: {
      id_mutation: "$_id",
      surface_totale: { $sum: "$lots.surface_reelle_bati" },
      types_locaux: {
        $filter: {
          input: "$types_locaux",
          as: "type",
          cond: { $and: [{ $ne: ["$$type", null] }, { $ne: ["$$type", ""] }] },
        },
      },
      position: {
        $cond: [
          { $and: [{ $ne: ["$longitude", null] }, { $ne: ["$latitude", null] }] },
          { type: "Point", coordinates: ["$longitude", "$latitude"] },
          "$$REMOVE",
        ],
      },
    },
  },

  // 1.6) type_local_dominant : Maison > Appartement > premier type non vide
  // > "Terrain / non bâti" (aucun type renseigné = terrain non bâti).
  {
    $addFields: {
      type_local_dominant: {
        $switch: {
          branches: [
            { case: { $in: ["Maison", "$types_locaux"] }, then: "Maison" },
            { case: { $in: ["Appartement", "$types_locaux"] }, then: "Appartement" },
          ],
          default: {
            $ifNull: [{ $arrayElemAt: ["$types_locaux", 0] }, "Terrain / non bâti"],
          },
        },
      },
    },
  },

  // 1.7) Retirer les champs intermédiaires.
  { $project: { longitude: 0, latitude: 0 } },

  // 1.8) Écriture (relançable sans dupliquer).
  { $merge: { into: "mutations", whenMatched: "replace", whenNotMatched: "insert" } },
]);

print("Mutations construites : " + db.mutations.countDocuments({}));

// ==========================================================
// 2) Construire `communes` — référentiel léger (REFERENCE)
// ==========================================================
// Clé = code_commune (INSEE), PAS code_postal (cf. § 0 : plusieurs communes
// peuvent partager un même code postal). Stats précalculées (Computed).

db.mutations.aggregate([
  {
    $match: {
      valeur_fonciere: { $gte: 1000 }, // exclut donations/régularisations
      surface_totale: { $gt: 0 },
      code_commune: { $nin: [null, ""] },
    },
  },
  {
    $group: {
      _id: "$code_commune",
      nom_commune: { $first: "$nom_commune" },
      code_postal: { $first: "$code_postal" }, // conservé pour affichage
      valeur_totale: { $sum: "$valeur_fonciere" },
      surface_totale: { $sum: "$surface_totale" },
      nb_mutations: { $sum: 1 },
    },
  },
  {
    $project: {
      nom_commune: 1,
      code_postal: 1,
      nb_mutations: 1,
      prix_m2_moyen: { $round: [{ $divide: ["$valeur_totale", "$surface_totale"] }, 2] },
    },
  },
  { $merge: { into: "communes", whenMatched: "replace", whenNotMatched: "insert" } },
]);

print("Communes construites : " + db.communes.countDocuments({}));

// ==========================================================
// 3) Vérifications (à garder pour le rapport — captures au moment où ça
//    se produit, cf. § "le rapport repoussé à plus tard")
// ==========================================================

print("\n--- Piège de comptage (id_mutation) ---");
const lignesBrutes = db.lots_bruts.countDocuments({});
const idDistinctsTotal = db.lots_bruts.distinct("id_mutation").length;
const idExploitables = db.lots_bruts.distinct("id_mutation", {
  id_mutation: { $nin: [null, ""] },
  valeur_fonciere: { $nin: [null, ""] },
}).length;
const mutationsConstruites = db.mutations.countDocuments({});
print("Lignes brutes (lots_bruts) : " + lignesBrutes);
print("id_mutation distincts au total : " + idDistinctsTotal);
print("id_mutation exploitables (avec valeur_fonciere renseignée) : " + idExploitables);
print("Mutations après regroupement : " + mutationsConstruites);
print("Mutations exclues faute de valeur foncière exploitable : " +
      (idExploitables - mutationsConstruites));

print("\n--- Valeurs foncières symboliques ---");
print("Mutations avec valeur_fonciere < 1000€ : " +
      db.mutations.countDocuments({ valeur_fonciere: { $lt: 1000 } }));
print("Mutations avec valeur_fonciere <= 1€ : " +
      db.mutations.countDocuments({ valeur_fonciere: { $lte: 1 } }));

print("\n--- Anomalie code_postal / code_commune (rappel) ---");
print("Codes postaux distincts : " + nbCodesPostaux);
print("Codes commune (INSEE) distincts : " + nbCodesCommune);
print("Communes dans le référentiel final : " + db.communes.countDocuments({}));

print("\n--- Nettoyage type_local_dominant ---");
print("Valeurs vides ou nulles restantes : " +
      db.mutations.countDocuments({ $or: [{ type_local_dominant: "" }, { type_local_dominant: null }] }));
print("Mutations classées \"Terrain / non bâti\" : " +
      db.mutations.countDocuments({ type_local_dominant: "Terrain / non bâti" }));

print("\n--- Type BSON de code_postal (doit être 'string') ---");
printjson(
  db.mutations.aggregate([
    { $match: { code_postal: { $ne: null } } },
    { $project: { _id: 0, nom_commune: 1, code_postal: 1, type_code_postal: { $type: "$code_postal" } } },
    { $limit: 1 },
  ]).toArray()
);

print("\n--- Relation mutations -> communes (exemple) ---");
printjson(
  db.mutations.findOne(
    { code_commune: { $nin: [null, ""] } },
    { _id: 0, id_mutation: 1, nom_commune: 1, code_commune: 1, code_postal: 1 }
  )
);

print("\n--- Exemple de mutation avec plusieurs lots ---");
printjson(db.mutations.findOne({ "lots.1": { $exists: true } }));