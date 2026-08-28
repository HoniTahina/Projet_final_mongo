// db/build_collections.js — Construit `mutations` et `communes` à partir du
// CSV DVF importé brut (une ligne = un lot, id_mutation répété).
//
// PRÉREQUIS : import brut déjà fait dans la collection `lots_bruts` :
//
//   mongoimport -u admin -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
//     --db immo --collection lots_bruts --type csv --headerline --drop \
//     --file /tmp/dvf34.csv
//
// Exécution (une fois lots_bruts importé) :
//   docker exec -i projet-mongo mongosh -u admin -p "$MONGO_ROOT_PASSWORD" \
//     --authenticationDatabase admin immo < db/build_collections.js

print("Documents bruts importés : " + db.lots_bruts.countDocuments({}));

// ==========================================================
// 1) Construire `mutations` — regroupement par id_mutation (LE PIÈGE DVF)
// ==========================================================
// Une mutation peut s'étaler sur plusieurs lignes (plusieurs lots/parcelles).
// Ne JAMAIS calculer un prix/m² sans regrouper par id_mutation d'abord :
// sinon valeur_fonciere est comptée plusieurs fois pour la même vente.

db.lots_bruts.aggregate([
  // On ignore les lignes sans valeur ou sans coordonnées essentielles.
  {
    $match: {
      id_mutation: { $ne: null, $ne: "" },
      valeur_fonciere: { $ne: null, $ne: "" },
    },
  },
  // Conversion des champs texte CSV vers les bons types.
  {
    $addFields: {
      valeur_fonciere_num: { $toDouble: "$valeur_fonciere" },
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
      date_mutation_dt: { $dateFromString: { dateString: "$date_mutation", onError: null } },
      code_postal_str: { $toString: "$code_postal" },
    },
  },
  // Un id_mutation = un document, avec ses lots imbriqués (EMBED).
  {
    $group: {
      _id: "$id_mutation",
      date_mutation: { $first: "$date_mutation_dt" },
      valeur_fonciere: { $first: "$valeur_fonciere_num" },
      code_postal: { $first: "$code_postal_str" },
      nom_commune: { $first: "$nom_commune" },
      longitude: { $first: "$longitude_num" },
      latitude: { $first: "$latitude_num" },
      type_local_dominant: { $first: "$type_local" },
      lots: {
        $push: {
          type_local: "$type_local",
          surface_reelle_bati: "$surface_num",
          nb_pieces: "$nb_pieces_num",
        },
      },
    },
  },
  // GeoJSON : uniquement si les deux coordonnées existent.
  {
    $addFields: {
      id_mutation: "$_id",
      position: {
        $cond: [
          { $and: [{ $ne: ["$longitude", null] }, { $ne: ["$latitude", null] }] },
          { type: "Point", coordinates: ["$longitude", "$latitude"] },
          "$$REMOVE",
        ],
      },
    },
  },
  { $project: { longitude: 0, latitude: 0 } },
  { $merge: { into: "mutations", whenMatched: "replace", whenNotMatched: "insert" } },
]);

print("Mutations construites : " + db.mutations.countDocuments({}));

// ==========================================================
// 2) Construire `communes` — référentiel léger (REFERENCE)
// ==========================================================
// Stats précalculées (pattern Computed, Jour 2) : prix/m² moyen et nombre
// de mutations par commune, recalculables à tout moment par ce même script.

db.mutations.aggregate([
  { $addFields: { surface_totale: { $sum: "$lots.surface_reelle_bati" } } },
  { $match: { surface_totale: { $gt: 0 }, code_postal: { $ne: null } } },
  {
    $group: {
      _id: "$code_postal",
      nom_commune: { $first: "$nom_commune" },
      valeur_totale: { $sum: "$valeur_fonciere" },
      surface_totale: { $sum: "$surface_totale" },
      nb_mutations: { $sum: 1 },
    },
  },
  {
    $project: {
      nom_commune: 1,
      nb_mutations: 1,
      prix_m2_moyen: { $round: [{ $divide: ["$valeur_totale", "$surface_totale"] }, 2] },
    },
  },
  { $merge: { into: "communes", whenMatched: "replace", whenNotMatched: "insert" } },
]);

print("Communes construites : " + db.communes.countDocuments({}));

// ==========================================================
// 3) Vérifications rapides (à garder pour le rapport)
// ==========================================================
print("\n--- Vérification du piège de comptage ---");
print("Lignes brutes (lots_bruts) : " + db.lots_bruts.countDocuments({}));
print("id_mutation distincts (naïf, sur lots_bruts) : " +
      db.lots_bruts.distinct("id_mutation").length);
print("Mutations après regroupement : " + db.mutations.countDocuments({}));
print("(Ces deux derniers chiffres doivent être égaux — sinon le $group a un bug.)");

print("\nExemple de mutation avec plusieurs lots :");
printjson(db.mutations.findOne({ "lots.1": { $exists: true } }));