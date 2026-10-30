// RGM : serveur complet (Express + Sequelize + MySQL/MariaDB).
//
// Au démarrage, ce fichier :
//   1. crée la base de données si DB_AUTO_CREATE n'est pas désactivé ;
//   2. crée les tables automatiquement (Sequelize) ;
//   3. crée ou met à jour le compte admin à partir du fichier .env.
// En hébergement managé, créer la base et désactiver DB_AUTO_CREATE.
//
// Sections : 1. Réglages · 2. Base de données · 3. Outils · 4. Routes publiques
//            5. Routes admin · 6. Démarrage
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { parseFile } from "music-metadata";
import mysql from "mysql2/promise";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DataTypes, Sequelize, col, fn } from "sequelize";

// ============================================================ 1. RÉGLAGES
// Les valeurs par défaut correspondent à XAMPP. Le fichier .env (facultatif) les remplace.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = {
  port: Number(process.env.PORT) || 3000,
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD ?? "",
    name: process.env.DB_NAME || "rgm",
    ssl: process.env.DB_SSL === "true",
    autoCreate: process.env.DB_AUTO_CREATE !== "false",
  },
  secret: process.env.SECRET_KEY || "rgm-cle-de-developpement-a-changer",
  adminEmail: (process.env.ADMIN_EMAIL || "admin@rgm.local").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || "rgm2026",
  maxMb: Number(process.env.MAX_UPLOAD_MB) || 500,
  uploads: process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, "uploads"),
};
const r2Env = {
  accountId: process.env.R2_ACCOUNT_ID,
  bucket: process.env.R2_BUCKET,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
};
const r2Values = Object.values(r2Env);
if (r2Values.some(Boolean) && !r2Values.every(Boolean)) {
  throw new Error("R2 requiert R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID et R2_SECRET_ACCESS_KEY.");
}
const r2 = r2Values.every(Boolean)
  ? new S3Client({
    region: "auto",
    endpoint: `https://${r2Env.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2Env.accessKeyId, secretAccessKey: r2Env.secretAccessKey },
  })
  : null;
const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VISITOR_COOKIE = "rgm_visitor";

for (const sub of ["audio", "covers"]) fs.mkdirSync(path.join(cfg.uploads, sub), { recursive: true });

// ============================================================ 2. BASE DE DONNÉES
const sequelize = new Sequelize(cfg.db.name, cfg.db.user, cfg.db.password, {
  host: cfg.db.host,
  port: cfg.db.port,
  dialect: "mysql",
  ...(cfg.db.ssl && { dialectOptions: { ssl: { minVersion: "TLSv1.2" } } }),
  logging: false,
  define: { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" },
});
const { STRING, FLOAT, INTEGER, BOOLEAN } = DataTypes;

/** Compte unique du studio. Son email et son mot de passe viennent toujours du .env. */
const Admin = sequelize.define("Admin", {
  email: { type: STRING(255), allowNull: false, unique: true },
  passwordHash: { type: STRING(255), allowNull: false },
}, { tableName: "admins", timestamps: false });

/** Un titre publié (ou en brouillon) par le studio. */
const Track = sequelize.define("Track", {
  title: { type: STRING(200), allowNull: false },
  artist: { type: STRING(200), defaultValue: "RGM" },
  album: { type: STRING(200), defaultValue: "" },
  audioFile: { type: STRING(255), allowNull: false },
  coverFile: { type: STRING(255) },
  duration: { type: FLOAT, defaultValue: 0 },
  plays: { type: INTEGER, defaultValue: 0 },
  published: { type: BOOLEAN, defaultValue: true },
}, { tableName: "tracks" });

/** Note de 1 à 5. Un visiteur (reconnu par cookie) = une note par titre. */
const Rating = sequelize.define("Rating", {
  trackId: { type: INTEGER, allowNull: false },
  visitorId: { type: STRING(64), allowNull: false },
  value: { type: INTEGER, allowNull: false },
}, { tableName: "ratings", timestamps: false, indexes: [{ unique: true, fields: ["trackId", "visitorId"] }] });

Track.hasMany(Rating, { foreignKey: "trackId", onDelete: "CASCADE" });
Rating.belongsTo(Track, { foreignKey: "trackId" });

async function ensureDatabase() {
  if (!/^\w+$/.test(cfg.db.name)) throw new Error("DB_NAME ne peut contenir que des lettres, chiffres et _.");
  if (!cfg.db.autoCreate) return;
  const { host, port, user, password, name } = cfg.db;
  const conn = await mysql.createConnection({
    host, port, user, password,
    ...(cfg.db.ssl && { ssl: { minVersion: "TLSv1.2" } }),
  });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end();
  }
}

async function ensureAdmin() {
  const [admin] = await Admin.findOrCreate({
    where: { id: 1 },
    defaults: { email: cfg.adminEmail, passwordHash: await bcrypt.hash(cfg.adminPassword, 10) },
  });
  const same = admin.email === cfg.adminEmail && (await bcrypt.compare(cfg.adminPassword, admin.passwordHash));
  if (!same) {
    admin.email = cfg.adminEmail;
    admin.passwordHash = await bcrypt.hash(cfg.adminPassword, 10);
    await admin.save();
  }
}

// ============================================================ 3. OUTILS
/** Transforme des titres en JSON, avec la note moyenne et la note du visiteur. */
async function serialize(tracks, visitorId) {
  const ids = tracks.map((t) => t.id);
  const stats = {};
  const mine = {};
  if (ids.length) {
    const rows = await Rating.findAll({
      attributes: ["trackId", [fn("AVG", col("value")), "avg"], [fn("COUNT", col("id")), "n"]],
      where: { trackId: ids }, group: ["trackId"], raw: true,
    });
    rows.forEach((r) => { stats[r.trackId] = { avg: Number(r.avg), n: Number(r.n) }; });
    if (visitorId) {
      const own = await Rating.findAll({ where: { trackId: ids, visitorId }, raw: true });
      own.forEach((r) => { mine[r.trackId] = r.value; });
    }
  }
  return tracks.map((t) => ({
    id: t.id, title: t.title, artist: t.artist, album: t.album,
    duration: Math.round(t.duration || 0), plays: t.plays, published: t.published, created_at: t.createdAt,
    audio_url: `/media/audio/${t.audioFile}`,
    cover_url: t.coverFile ? `/media/covers/${t.coverFile}` : null,
    rating_avg: stats[t.id] ? Math.round(stats[t.id].avg * 10) / 10 : null,
    rating_count: stats[t.id]?.n ?? 0,
    my_rating: mine[t.id] ?? null,
  }));
}

const newest = [["createdAt", "DESC"], ["id", "DESC"]];
const fail = (res, status, detail) => res.status(status).json({ detail });
const randomName = (ext) => crypto.randomUUID().replaceAll("-", "") + ext;
async function storeObject(sub, name, body, contentType, contentLength) {
  if (r2) {
    await r2.send(new PutObjectCommand({
      Bucket: r2Env.bucket,
      Key: `${sub}/${name}`,
      Body: body,
      ContentType: contentType,
      ContentLength: contentLength,
    }));
  } else if (Buffer.isBuffer(body)) {
    await fs.promises.writeFile(path.join(cfg.uploads, sub, name), body);
  }
}

async function removeFile(sub, name) {
  if (!name) return;
  if (r2) {
    await r2.send(new DeleteObjectCommand({ Bucket: r2Env.bucket, Key: `${sub}/${name}` }));
    return;
  }
  await fs.promises.rm(path.join(cfg.uploads, sub, path.basename(name)), { force: true });
}

async function serveStoredObject(req, res, sub) {
  const name = req.params.name;
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/i.test(name)) return fail(res, 404, "Fichier introuvable.");
  try {
    const result = await r2.send(new GetObjectCommand({
      Bucket: r2Env.bucket,
      Key: `${sub}/${name}`,
      ...(req.headers.range && { Range: req.headers.range }),
    }));
    res.set("Cache-Control", "public, max-age=3600");
    res.set("Accept-Ranges", "bytes");
    if (result.ContentType) res.set("Content-Type", result.ContentType);
    if (result.ContentLength !== undefined) res.set("Content-Length", String(result.ContentLength));
    if (result.ContentRange) {
      res.status(206);
      res.set("Content-Range", result.ContentRange);
    }
    if (!result.Body) throw new Error("R2 a renvoyé un objet sans contenu.");
    await pipeline(result.Body, res);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return fail(res, 404, "Fichier introuvable.");
    }
    if (err.$metadata?.httpStatusCode === 416) return fail(res, 416, "Plage de lecture invalide.");
    throw err;
  }
}

/** Limite le nombre de requêtes par adresse IP (protège les notes contre les abus). */
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return fail(res, 429, "Trop de requêtes, réessayez dans un instant.");
    recent.push(now);
    hits.set(req.ip, recent);
    next();
  };
}

/** Réception des fichiers. Les formats refusés sont notés dans req.rejected, les autres sont gardés. */
function uploader(sub, allowed, label, maxMb) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, path.join(cfg.uploads, sub)),
      filename: (req, file, cb) => cb(null, randomName(path.extname(file.originalname).toLowerCase())),
    }),
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      // Les navigateurs envoient le nom en UTF-8 mais multer le lit en latin1 : on remet les accents.
      file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
      const ext = path.extname(file.originalname).toLowerCase();
      const ok = allowed.has(ext);
      if (!ok) (req.rejected ||= []).push({ file: file.originalname, error: `Format non accepté (${ext || "inconnu"}). Utilisez : ${label}.` });
      cb(null, ok);
    },
  });
}
const audioUpload = uploader("audio", AUDIO_EXT, "mp3, wav, flac, m4a, aac, ogg", cfg.maxMb);
const coverUpload = uploader("covers", IMAGE_EXT, "jpg, png ou webp", 10);

// ============================================================ APPLICATION
const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(cookieParser());
if (r2) {
  app.get("/media/audio/:name", (req, res) => serveStoredObject(req, res, "audio"));
  app.get("/media/covers/:name", (req, res) => serveStoredObject(req, res, "covers"));
} else {
  app.use("/media/audio", express.static(path.join(cfg.uploads, "audio")));
  app.use("/media/covers", express.static(path.join(cfg.uploads, "covers")));
}

// ============================================================ 4. ROUTES PUBLIQUES
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

async function publishedTrack(id) {
  const track = await Track.findByPk(id);
  return track?.published ? track : null;
}

app.get("/api/tracks", async (req, res) => {
  const tracks = await Track.findAll({ where: { published: true }, order: newest });
  res.json(await serialize(tracks, req.cookies[VISITOR_COOKIE]));
});

app.get("/api/tracks/:id", async (req, res) => {
  const track = await publishedTrack(req.params.id);
  if (!track) return fail(res, 404, "Titre introuvable.");
  res.json((await serialize([track], req.cookies[VISITOR_COOKIE]))[0]);
});

app.post("/api/tracks/:id/play", async (req, res) => {
  const track = await publishedTrack(req.params.id);
  if (!track) return fail(res, 404, "Titre introuvable.");
  await track.increment("plays");
  res.json({ plays: track.plays + 1 });
});

/** Note de 1 à 5. Un visiteur peut changer sa note mais n'en garde qu'une par titre. */
app.post("/api/tracks/:id/rate", limiter(60, 60_000), async (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isInteger(value) || value < 1 || value > 5) return fail(res, 422, "La note doit être entre 1 et 5.");
  const track = await publishedTrack(req.params.id);
  if (!track) return fail(res, 404, "Titre introuvable.");
  const visitorId = req.cookies[VISITOR_COOKIE] || crypto.randomUUID().replaceAll("-", "");
  const existing = await Rating.findOne({ where: { trackId: track.id, visitorId } });
  if (existing) await existing.update({ value });
  else await Rating.create({ trackId: track.id, visitorId, value });
  res.cookie(VISITOR_COOKIE, visitorId, { maxAge: 2 * 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: "lax" });
  res.json((await serialize([track], visitorId))[0]);
});

// ============================================================ 5. ROUTES ADMIN
const loginFails = new Map();   // adresse IP -> heures des échecs récents
const tooManyFails = (ip) => {
  const recent = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 15 * 60_000);
  loginFails.set(ip, recent);
  return recent.length >= 10;
};

app.post("/api/admin/login", async (req, res) => {
  if (tooManyFails(req.ip)) return fail(res, 429, "Trop d'essais. Réessayez dans 15 minutes.");
  const { email = "", password = "" } = req.body || {};
  const admin = await Admin.findOne({ where: { email: String(email).trim().toLowerCase() } });
  if (!admin || !(await bcrypt.compare(String(password), admin.passwordHash))) {
    loginFails.get(req.ip).push(Date.now());
    return fail(res, 401, "Email ou mot de passe incorrect.");
  }
  loginFails.delete(req.ip);
  res.json({ access_token: jwt.sign({ sub: admin.id }, cfg.secret, { expiresIn: "7d" }) });
});

/** Vérifie le jeton de connexion. Toutes les routes ci-dessous en dépendent. */
async function requireAdmin(req, res, next) {
  try {
    const data = jwt.verify((req.headers.authorization || "").replace(/^Bearer /, ""), cfg.secret);
    if (await Admin.findByPk(data.sub)) return next();
  } catch { /* jeton absent ou invalide */ }
  fail(res, 401, "Session expirée, reconnectez-vous.");
}

app.get("/api/admin/tracks", requireAdmin, async (req, res) => {
  res.json(await serialize(await Track.findAll({ order: newest }), null));
});

/** Importe un ou plusieurs fichiers audio. Titre, album, pochette et durée sont lus dans le fichier. */
app.post("/api/admin/tracks", requireAdmin, audioUpload.array("files", 50), async (req, res) => {
  const created = [];
  const errors = [...(req.rejected || [])];
  for (const file of req.files || []) {
    const shown = file.originalname;
    let meta;
    try {
      meta = await parseFile(file.path, { duration: true });
      if (!meta.format.duration) throw new Error("pas de durée : ce n'est pas un vrai fichier audio");
    } catch {
      if (r2) await fs.promises.rm(file.path, { force: true });
      else await removeFile("audio", file.filename);
      errors.push({ file: shown, error: "Fichier audio illisible ou corrompu." });
      continue;
    }

    let coverFile = null;
    try {
      await storeObject("audio", file.filename, fs.createReadStream(file.path), file.mimetype, file.size);
      const picture = meta.common.picture?.[0];
      if (picture) {
        coverFile = randomName(picture.format.includes("png") ? ".png" : ".jpg");
        await storeObject("covers", coverFile, picture.data, picture.format, picture.data.length);
      }
      created.push(await Track.create({
        title: (meta.common.title || path.parse(shown).name.replace(/_/g, " ")).trim().slice(0, 200),
        album: (meta.common.album || "").slice(0, 200),
        audioFile: file.filename, coverFile, duration: meta.format.duration || 0,
      }));
    } catch (err) {
      await removeFile("audio", file.filename);
      if (coverFile) await removeFile("covers", coverFile);
      throw err;
    } finally {
      if (r2) await fs.promises.rm(file.path, { force: true });
    }
  }
  res.json({ created: await serialize(created, null), errors });
});

app.patch("/api/admin/tracks/:id", requireAdmin, async (req, res) => {
  const track = await Track.findByPk(req.params.id);
  if (!track) return fail(res, 404, "Titre introuvable.");
  const { title, album, published } = req.body || {};
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim() || title.length > 200) return fail(res, 422, "Titre invalide.");
    track.title = title.trim();
  }
  if (album !== undefined) {
    if (typeof album !== "string" || album.length > 200) return fail(res, 422, "Album invalide.");
    track.album = album;
  }
  if (published !== undefined) track.published = Boolean(published);
  await track.save();
  res.json((await serialize([track], null))[0]);
});

app.post("/api/admin/tracks/:id/cover", requireAdmin, coverUpload.single("file"), async (req, res) => {
  if (!req.file) return fail(res, 400, req.rejected?.[0]?.error || "Aucune image reçue.");
  const track = await Track.findByPk(req.params.id);
  if (!track) {
    if (r2) await fs.promises.rm(req.file.path, { force: true });
    else await removeFile("covers", req.file.filename);
    return fail(res, 404, "Titre introuvable.");
  }
  const previousCover = track.coverFile;
  try {
    await storeObject("covers", req.file.filename, fs.createReadStream(req.file.path), req.file.mimetype, req.file.size);
    await track.update({ coverFile: req.file.filename });
  } catch (err) {
    await removeFile("covers", req.file.filename);
    throw err;
  } finally {
    if (r2) await fs.promises.rm(req.file.path, { force: true });
  }
  await removeFile("covers", previousCover);
  res.json((await serialize([track], null))[0]);
});

app.delete("/api/admin/tracks/:id", requireAdmin, async (req, res) => {
  const track = await Track.findByPk(req.params.id);
  if (!track) return fail(res, 404, "Titre introuvable.");
  await Rating.destroy({ where: { trackId: track.id } });
  await track.destroy();
  await removeFile("audio", track.audioFile);
  await removeFile("covers", track.coverFile);
  res.json({ deleted: track.id });
});

// Site compilé (npm run build) : servi par ce même serveur, pour tout ce qui n'est pas /api ou /media.
const dist = path.join(ROOT, "client", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => (req.method === "GET" && !/^\/(api|media)\//.test(req.path) ? res.sendFile(path.join(dist, "index.html")) : next()));
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return err.code === "LIMIT_FILE_SIZE" ? fail(res, 413, "Fichier trop lourd.") : fail(res, 400, "Envoi impossible.");
  }
  console.error(err);
  if (res.headersSent) return next(err);
  fail(res, 500, "Erreur du serveur.");
});

// ============================================================ 6. DÉMARRAGE
async function start() {
  await ensureDatabase();
  await sequelize.sync({ alter: process.env.DB_ALTER === "true" });
  await ensureAdmin();
  app.listen(cfg.port, () => {
    console.log(`\nRGM est prêt : http://localhost:${cfg.port}  (studio : /admin)`);
    if (!process.env.ADMIN_PASSWORD) console.log("Attention : mot de passe admin par défaut (rgm2026). Changez-le dans .env avant la mise en ligne.");
  });
}

start().catch((err) => {
  const messages = {
    ECONNREFUSED: `Impossible de joindre MySQL (${cfg.db.host}:${cfg.db.port}). Vérifiez l'hôte, le port et la disponibilité du service de base de données.`,
    ER_ACCESS_DENIED_ERROR: "MySQL refuse la connexion. Vérifiez DB_USER et DB_PASSWORD dans les variables d'environnement.",
  };
  console.error("\n" + (messages[err.code] || messages[err.parent?.code] || err.stack || err));
  process.exit(1);
});
