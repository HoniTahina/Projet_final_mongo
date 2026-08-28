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
// 1) Construire `mutations`
// ==========================================================
//
// PIÈGE DVF :
// une même mutation peut apparaître sur plusieurs lignes.
// Il faut donc regrouper par id_mutation avant de calculer
// les statistiques ou les prix au m².

db.lots_bruts.aggregate([

  // On conserve uniquement les lignes qui possèdent :
  // - un id_mutation
  // - une valeur foncière exploitable
  {
    $match: {
      id_mutation: { $nin: [null, ""] },
      valeur_fonciere: { $nin: [null, ""] }
    }
  },

  // Conversion des valeurs provenant du CSV.
  {
    $addFields: {

      valeur_fonciere_num: {
        $convert: {
          input: "$valeur_fonciere",
          to: "double",
          onError: null,
          onNull: null
        }
      },

      surface_num: {
        $convert: {
          input: "$surface_reelle_bati",
          to: "double",
          onError: 0,
          onNull: 0
        }
      },

      nb_pieces_num: {
        $convert: {
          input: "$nombre_pieces_principales",
          to: "int",
          onError: 0,
          onNull: 0
        }
      },

      longitude_num: {
        $convert: {
          input: "$longitude",
          to: "double",
          onError: null,
          onNull: null
        }
      },

      latitude_num: {
        $convert: {
          input: "$latitude",
          to: "double",
          onError: null,
          onNull: null
        }
      },
      date_mutation_dt: { $dateFromString: { dateString: "$date_mutation", onError: null } },
    },
  },
  // Un id_mutation = un document, avec ses lots imbriqués (EMBED).
  {
    $group: {

      _id: "$id_mutation",
      date_mutation: { $first: "$date_mutation_dt" },
      valeur_fonciere: { $first: "$valeur_fonciere_num" },
      code_postal: { $first: "$code_postal" },
      nom_commune: { $first: "$nom_commune" },
      longitude: { $first: "$longitude_num" },
      latitude: { $first: "$latitude_num" },
      type_local_dominant: { $first: "$type_local" },
      lots: {
        $push: {
          type_local: "$type_local",
          surface_reelle_bati: "$surface_num",
          nb_pieces: "$nb_pieces_num"
        }
      }
    }
  },

  // Calcul de la surface bâtie totale de la mutation,
  // création de la position GeoJSON et nettoyage des types locaux.
  {
    $addFields: {

      id_mutation: "$_id",

      surface_totale: {
        $sum: "$lots.surface_reelle_bati"
      },

      // On retire null et "" de la liste des types de locaux.
      types_locaux: {
        $filter: {
          input: "$types_locaux",
          as: "type",
          cond: {
            $and: [
              { $ne: ["$$type", null] },
              { $ne: ["$$type", ""] }
            ]
          }
        }
      },

      // Coordonnées au format GeoJSON.
      position: {
        $cond: [
          {
            $and: [
              { $ne: ["$longitude", null] },
              { $ne: ["$latitude", null] }
            ]
          },
          {
            type: "Point",
            coordinates: [
              "$longitude",
              "$latitude"
            ]
          },
          "$$REMOVE"
        ]
      }
    }
  },

  // On choisit un type principal exploitable pour le front.
  //
  // Règle :
  // 1. si la mutation contient une Maison -> Maison
  // 2. sinon si elle contient un Appartement -> Appartement
  // 3. sinon premier type_local non vide
  // 4. si aucun type_local n'est renseigné -> Terrain / non bâti
  {
    $addFields: {
      type_local_dominant: {
        $switch: {
          branches: [
            {
              case: {
                $in: [
                  "Maison",
                  "$types_locaux"
                ]
              },
              then: "Maison"
            },
            {
              case: {
                $in: [
                  "Appartement",
                  "$types_locaux"
                ]
              },
              then: "Appartement"
            }
          ],

          default: {
            $ifNull: [
              {
                $arrayElemAt: [
                  "$types_locaux",
                  0
                ]
              },
              "Terrain / non bâti"
            ]
          }
        }
      }
    }
  },

  // Les coordonnées intermédiaires ne sont plus nécessaires.
  {
    $project: {
      longitude: 0,
      latitude: 0
    }
  },

  // Création de la collection mutations.
  {
    $merge: {
      into: "mutations",
      whenMatched: "replace",
      whenNotMatched: "insert"
    }
  }
]);

print(
  "Mutations construites : " +
  db.mutations.countDocuments({})
);


// ==========================================================
// 2) Construire `communes`
// ==========================================================
//
// Une commune est identifiée avec code_commune,
// et NON avec code_postal.
//
// Plusieurs communes peuvent partager le même code postal.

db.mutations.aggregate([
  { $addFields: { surface_totale: { $sum: "$lots.surface_reelle_bati" } } },
  { $match: { surface_totale: { $gt: 0 }, code_postal: { $ne: null } } },
  {
    $group: {

      _id: "$code_commune",

      nom_commune: {
        $first: "$nom_commune"
      },

      code_postal: {
        $first: "$code_postal"
      },

      valeur_totale: {
        $sum: "$valeur_fonciere"
      },

      surface_totale: {
        $sum: "$surface_totale"
      },

      nb_mutations: {
        $sum: 1
      }
    }
  },

  // Statistiques précalculées par commune.
  {
    $project: {

      _id: 1,

      code_commune: "$_id",

      nom_commune: 1,

      code_postal: 1,

      nb_mutations: 1,

      prix_m2_moyen: {
        $round: [
          {
            $divide: [
              "$valeur_totale",
              "$surface_totale"
            ]
          },
          2
        ]
      }
    }
  },

  // Création de la collection communes.
  {
    $merge: {
      into: "communes",
      whenMatched: "replace",
      whenNotMatched: "insert"
    }
  }
]);

print(
  "Communes construites : " +
  db.communes.countDocuments({})
);


// ==========================================================
// 3) Vérifications pour le rapport
// ==========================================================

print("\n--- Vérification du piège de comptage ---");

const lignesBrutes =
  db.lots_bruts.countDocuments({});

const totalMutations =
  db.lots_bruts.distinct(
    "id_mutation"
  ).length;

const mutationsExploitables =
  db.lots_bruts.distinct(
    "id_mutation",
    {
      id_mutation: {
        $nin: [
          null,
          ""
        ]
      },

      valeur_fonciere: {
        $nin: [
          null,
          ""
        ]
      }
    }
  ).length;

const mutationsConstruites =
  db.mutations.countDocuments({});

print(
  "Lignes brutes (lots_bruts) : " +
  lignesBrutes
);

print(
  "id_mutation distincts au total : " +
  totalMutations
);

print(
  "id_mutation exploitables : " +
  mutationsExploitables
);

print(
  "Mutations après regroupement : " +
  mutationsConstruites
);

print(
  "Mutations exclues faute de valeur foncière : " +
  (
    totalMutations -
    mutationsExploitables
  )
);


// ==========================================================
// 4) Vérification des communes
// ==========================================================

print("\n--- Vérification des communes ---");

print(
  "Codes postaux distincts dans les données brutes : " +
  db.lots_bruts.distinct(
    "code_postal"
  ).length
);

print(
  "Codes communes distincts dans les données brutes : " +
  db.lots_bruts.distinct(
    "code_commune"
  ).length
);

print(
  "Communes présentes dans le référentiel final : " +
  db.communes.countDocuments({})
);


// ==========================================================
// 5) Vérifications après nettoyage
// ==========================================================

print(
  "\n--- Vérification des types après nettoyage ---"
);

print(
  "Mutations avec type_local_dominant vide ou null : " +
  db.mutations.countDocuments({
    $or: [
      {
        type_local_dominant: null
      },
      {
        type_local_dominant: ""
      }
    ]
  })
);

print(
  "Mutations classées Terrain / non bâti : " +
  db.mutations.countDocuments({
    type_local_dominant: "Terrain / non bâti"
  })
);


// ==========================================================
// 6) Vérification de code_postal
// ==========================================================

print(
  "\n--- Vérification du type de code_postal ---"
);

printjson(
  db.mutations.findOne(
    {
      code_postal: {
        $ne: null
      }
    },
    {
      _id: 0,
      nom_commune: 1,
      code_postal: 1,
      type_local_dominant: 1
    }
  )
);


// ==========================================================
// 7) Exemple pour la démonstration
// ==========================================================

print(
  "\n--- Exemple de mutation avec plusieurs lots ---"
);

printjson(
  db.mutations.findOne({
    "lots.1": {
      $exists: true
    }
  })
);