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
// 0) Anomalie : code_postal n'identifie pas une commune de façon unique
// ==========================================================
// Vérification faite AVANT toute construction, pour documenter la découverte
// au moment où elle se produit (cf. cahier des charges, § rapport).

const nbCodesPostaux = db.lots_bruts.distinct("code_postal").length;
const nbCodesCommune = db.lots_bruts.distinct("code_commune").length;
print("\n--- Anomalie : code_postal vs code_commune ---");
print("Codes postaux distincts : " + nbCodesPostaux);
print("Codes commune (INSEE) distincts : " + nbCodesCommune);
print("=> code_postal ne peut PAS servir de clé de référence pour une commune.");
print("   On utilise code_commune (identifiant administratif unique) à la place.\n");

// ==========================================================
// 1) Construire `mutations` — regroupement par id_mutation (LE PIÈGE DVF)
// ==========================================================
// Une mutation peut s'étaler sur plusieurs lignes (plusieurs lots/parcelles).
// Ne JAMAIS calculer un prix/m² sans regrouper par id_mutation d'abord :
// sinon valeur_fonciere est comptée plusieurs fois pour la même vente.

db.lots_bruts.aggregate([
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
      code_commune_str: { $toString: "$code_commune" },
    },
  },
  // Un id_mutation = un document, avec ses lots imbriqués (EMBED).
  {
    $group: {
      _id: "$id_mutation",
      date_mutation: { $first: "$date_mutation_dt" },
      valeur_fonciere: { $first: "$valeur_fonciere_num" },
      code_commune: { $first: "$code_commune_str" },
      code_postal: { $first: "$code_postal_str" },
      nom_commune: { $first: "$nom_commune" },
      longitude: { $first: "$longitude_num" },
      latitude: { $first: "$latitude_num" },
      lots: {
        $push: {
          type_local: "$type_local",
          surface_reelle_bati: "$surface_num",
          nb_pieces: "$nb_pieces_num",
        },
      },
    },
  },
  // type_local_dominant : Maison > Appartement > premier type non vide >
  // "Terrain / non bâti" (aucun type renseigné = terrain non bâti).
  {
    $addFields: {
      id_mutation: "$_id",
      surface_totale: { $sum: "$lots.surface_reelle_bati" },
      type_local_dominant: {
        $switch: {
          branches: [
            { case: { $in: ["Maison", "$lots.type_local"] }, then: "Maison" },
            { case: { $in: ["Appartement", "$lots.type_local"] }, then: "Appartement" },
            {
              case: {
                $gt: [
                  { $size: { $filter: { input: "$lots.type_local", cond: { $ne: ["$$this", ""] } } } },
                  0,
                ],
              },
              then: {
                $arrayElemAt: [
                  { $filter: { input: "$lots.type_local", cond: { $ne: ["$$this", ""] } } },
                  0,
                ],
              },
            },
          ],
          default: "Terrain / non bâti",
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
  { $project: { longitude: 0, latitude: 0 } },
  { $merge: { into: "mutations", whenMatched: "replace", whenNotMatched: "insert" } },
]);

print("Mutations construites : " + db.mutations.countDocuments({}));

// Vérification du nettoyage type_local_dominant
print("\n--- Vérification type_local_dominant ---");
print("Valeurs vides ou nulles restantes : " +
      db.mutations.countDocuments({ $or: [{ type_local_dominant: "" }, { type_local_dominant: null }] }));
print("Mutations classées \"Terrain / non bâti\" : " +
      db.mutations.countDocuments({ type_local_dominant: "Terrain / non bâti" }));

// ==========================================================
// 2) Construire `communes` — référentiel léger (REFERENCE)
// ==========================================================
// Clé = code_commune (INSEE), PAS code_postal (cf. anomalie § 0).
// Stats précalculées (pattern Computed) : prix/m² moyen et nb de mutations,
// recalculables à tout moment en relançant ce même script.

db.mutations.aggregate([
  {
    $match: {
      valeur_fonciere: { $gte: 1000 }, // exclut donations/régularisations
      surface_totale: { $gt: 0 },
      code_commune: { $ne: null, $ne: "" },
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
// 3) Vérifications finales (à garder pour le rapport)
// ==========================================================
print("\n--- Vérification du piège de comptage (id_mutation) ---");
print("Lignes brutes (lots_bruts) : " + db.lots_bruts.countDocuments({}));
print("id_mutation distincts (naïf, sur lots_bruts) : " +
      db.lots_bruts.distinct("id_mutation").length);
print("Mutations après regroupement : " + db.mutations.countDocuments({}));

print("\n--- Vérification des valeurs foncières symboliques ---");
print("Mutations avec valeur_fonciere < 1000€ : " +
      db.mutations.countDocuments({ valeur_fonciere: { $lt: 1000 } }));
print("Mutations avec valeur_fonciere <= 1€ : " +
      db.mutations.countDocuments({ valeur_fonciere: { $lte: 1 } }));

print("\nExemple de mutation avec plusieurs lots :");
printjson(db.mutations.findOne({ "lots.1": { $exists: true } }));