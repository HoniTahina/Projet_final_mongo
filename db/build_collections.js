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
// db/build_collections.js
//
// Construit les collections `mutations` et `communes`
// à partir de la collection brute `lots_bruts`.
//
// Collection source : lots_bruts
// Une ligne CSV = un lot / une parcelle.
// Plusieurs lignes peuvent avoir le même id_mutation.
//
// Objectif :
// - mutations : 1 document par id_mutation, avec les lots imbriqués
// - communes : 1 document par code_commune
//
// IMPORTANT :
// - lots_bruts n'est jamais supprimée par ce script.
// - mutations et communes sont reconstruites à chaque exécution.

// ==========================================================
// 0) Nettoyage des anciennes collections dérivées
// ==========================================================

db.mutations.drop();
db.communes.drop();

print(
  "Documents bruts importés : " +
  db.lots_bruts.countDocuments({})
);


// ==========================================================
// 1) Construire `mutations`
// ==========================================================
//
// PIÈGE DVF :
// une même mutation peut apparaître sur plusieurs lignes.
// Il faut donc regrouper par id_mutation avant de calculer
// les statistiques ou les prix au m².

db.lots_bruts.aggregate([

  // --------------------------------------------------------
  // 1.1) Garder uniquement les lignes exploitables
  // --------------------------------------------------------

  {
    $match: {
      id_mutation: {
        $nin: [null, ""]
      },
      valeur_fonciere: {
        $nin: [null, ""]
      }
    }
  },


  // --------------------------------------------------------
  // 1.2) Conversion des données venant du CSV
  // --------------------------------------------------------

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
      code_postal_str: { $toString: "$code_postal" },
      code_commune_str: { $toString: "$code_commune" },
    },
  },
  // Un id_mutation = un document, avec ses lots imbriqués (EMBED).

      date_mutation_dt: {
        $dateFromString: {
          dateString: "$date_mutation",
          onError: null,
          onNull: null
        }
      },

      // Un code postal est un identifiant.
      // On le stocke donc comme chaîne de caractères.
      code_postal_str: {
        $convert: {
          input: "$code_postal",
          to: "string",
          onError: null,
          onNull: null
        }
      }
    }
  },


  // --------------------------------------------------------
  // 1.3) Retirer les valeurs foncières non convertibles
  // --------------------------------------------------------

  {
    $match: {
      valeur_fonciere_num: {
        $ne: null
      }
    }
  },


  // --------------------------------------------------------
  // 1.4) Un id_mutation = un document
  // --------------------------------------------------------
  //
  // Les lots sont EMBED dans le document mutation.

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

      date_mutation: {
        $first: "$date_mutation_dt"
      },

      valeur_fonciere: {
        $first: "$valeur_fonciere_num"
      },

      // IMPORTANT :
      // la relation avec communes se fait avec code_commune.
      code_commune: {
        $first: "$code_commune"
      },

      // Code postal converti en string.
      code_postal: {
        $first: "$code_postal_str"
      },

      nom_commune: {
        $first: "$nom_commune"
      },

      longitude: {
        $first: "$longitude_num"
      },

      latitude: {
        $first: "$latitude_num"
      },

      // Tous les types rencontrés dans la mutation.
      types_locaux: {
        $addToSet: "$type_local"
      },

      // Lots imbriqués.
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

          nb_pieces: "$nb_pieces_num"
        }
      }
    }
  },


  // --------------------------------------------------------
  // 1.5) Surface totale + nettoyage + GeoJSON
  // --------------------------------------------------------

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

      surface_totale: {
        $sum: "$lots.surface_reelle_bati"
      },

      // Supprime les types null ou vides.
      types_locaux: {
        $filter: {

          input: "$types_locaux",

          as: "type",

          cond: {
            $and: [
              {
                $ne: [
                  "$$type",
                  null
                ]
              },
              {
                $ne: [
                  "$$type",
                  ""
                ]
              }
            ]
          }
        }
      },

      // Position au format GeoJSON.
      position: {
        $cond: [

          {
            $and: [
              {
                $ne: [
                  "$longitude",
                  null
                ]
              },
              {
                $ne: [
                  "$latitude",
                  null
                ]
              }
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


  // --------------------------------------------------------
  // 1.6) Choix du type_local_dominant
  // --------------------------------------------------------
  //
  // Règle :
  // 1. Maison si la mutation contient une maison
  // 2. sinon Appartement
  // 3. sinon premier type non vide
  // 4. sinon Terrain / non bâti

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


  // --------------------------------------------------------
  // 1.7) Retirer les champs intermédiaires
  // --------------------------------------------------------

  {
    $project: {

      longitude: 0,

      latitude: 0
    }
  },


  // --------------------------------------------------------
  // 1.8) Création de la collection mutations
  // --------------------------------------------------------

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


// Vérification du nettoyage type_local_dominant
print("\n--- Vérification type_local_dominant ---");
print("Valeurs vides ou nulles restantes : " +
      db.mutations.countDocuments({ $or: [{ type_local_dominant: "" }, { type_local_dominant: null }] }));
print("Mutations classées \"Terrain / non bâti\" : " +
      db.mutations.countDocuments({ type_local_dominant: "Terrain / non bâti" }));

// ==========================================================
// 2) Construire `communes`
// ==========================================================
// Clé = code_commune (INSEE), PAS code_postal (cf. anomalie § 0).
// Stats précalculées (pattern Computed) : prix/m² moyen et nb de mutations,
// recalculables à tout moment en relançant ce même script.
//
// Une commune est identifiée avec code_commune,
// et NON avec code_postal.
//
// Plusieurs communes peuvent partager un même code postal.

db.mutations.aggregate([

  // --------------------------------------------------------
  // 2.1) Garder les mutations avec surface exploitable
  // --------------------------------------------------------

  {
    $match: {
      valeur_fonciere: { $gte: 1000 }, // exclut donations/régularisations
      surface_totale: { $gt: 0 },
      code_commune: { $ne: null, $ne: "" },
    },
  },

      surface_totale: {
        $gt: 0
      },

      code_commune: {
        $nin: [
          null,
          ""
        ]
      }
    }
  },


  // --------------------------------------------------------
  // 2.2) Une ligne par code_commune
  // --------------------------------------------------------

  {
    $group: {
      _id: "$code_commune",
      nom_commune: { $first: "$nom_commune" },
      code_postal: { $first: "$code_postal" }, // conservé pour affichage
      valeur_totale: { $sum: "$valeur_fonciere" },
      surface_totale: { $sum: "$surface_totale" },
      nb_mutations: { $sum: 1 },
    },

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


  // --------------------------------------------------------
  // 2.3) Statistiques par commune
  // --------------------------------------------------------

  {
    $project: {

      _id: 1,

      code_commune: "$_id",

      nom_commune: 1,
      code_postal: 1,

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


  // --------------------------------------------------------
  // 2.4) Création de la collection communes
  // --------------------------------------------------------

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

print(
  "\n--- Vérification du piège de comptage ---"
);


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

print(
  "\n--- Vérification des communes ---"
);


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
// 5) Vérification du nettoyage des types
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

    type_local_dominant:
      "Terrain / non bâti"

  })
);


// ==========================================================
// 6) Vérification du type BSON de code_postal
// ==========================================================

print(
  "\n--- Vérification du type de code_postal ---"
);


printjson(

  db.mutations.aggregate([

    {
      $match: {

        code_postal: {
          $ne: null
        }
      }
    },

    {
      $project: {

        _id: 0,

        nom_commune: 1,

        code_postal: 1,

        type_code_postal: {
          $type: "$code_postal"
        },

        type_local_dominant: 1
      }
    },

    {
      $limit: 1
    }

  ]).toArray()

);


// ==========================================================
// 7) Vérification de la relation code_commune
// ==========================================================

print(
  "\n--- Vérification relation mutations / communes ---"
);


printjson(

  db.mutations.findOne(

    {
      code_commune: {
        $nin: [
          null,
          ""
        ]
      }
    },

    {
      _id: 0,

      id_mutation: 1,

      nom_commune: 1,

      code_commune: 1,

      code_postal: 1
    }

  )

);


// ==========================================================
// 3) Vérifications finales (à garder pour le rapport)
// 8) Exemple pour la démonstration
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