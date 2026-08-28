// Joué automatiquement par l'image mongo À LA CRÉATION du volume uniquement.
// Crée l'utilisateur applicatif : readWrite sur la seule base du projet.
// Si vous modifiez ce fichier, il faut recréer le volume : docker compose down -v

const base = process.env.MONGO_INITDB_DATABASE;

db.getSiblingDB(base).createUser({
  user: process.env.MONGO_APP_USER || "app",
  pwd:  process.env.MONGO_APP_PASSWORD || "app",
  roles: [{ role: "readWrite", db: base }]
});

print(`Utilisateur applicatif créé sur la base ${base} (rôle readWrite uniquement).`);
