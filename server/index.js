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
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { parseFile } from "music-metadata";
import mysql from "mysql2/promise";
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
    fileStorage: process.env.FILE_STORAGE === "database",
  },
  secret: process.env.SECRET_KEY || "rgm-cle-de-developpement-a-changer",
  adminEmail: (process.env.ADMIN_EMAIL || "admin@rgm.local").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || "rgm2026",
  maxMb: Number(process.env.MAX_UPLOAD_MB) || 500,
  uploads: process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, "uploads"),
};
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
const MEDIA_STORAGE_LIMIT_BYTES = 4 * 1024 ** 3;

/** Comptes de studio. Les mots de passe sont stockés sous forme de hash. */
const Admin = sequelize.define("Admin", {
  email: { type: STRING(255), allowNull: false, unique: true },
  passwordHash: { type: STRING(255), allowNull: false },
  isActive: { type: BOOLEAN, allowNull: false, defaultValue: true },
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
  archivedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
}, { tableName: "tracks" });

/** Note de 1 à 5. Un visiteur (reconnu par cookie) = une note par titre. */
const Rating = sequelize.define("Rating", {
  trackId: { type: INTEGER, allowNull: false },
  visitorId: { type: STRING(64), allowNull: false },
  value: { type: INTEGER, allowNull: false },
}, { tableName: "ratings", timestamps: false, indexes: [{ unique: true, fields: ["trackId", "visitorId"] }] });

const MediaFile = sequelize.define("MediaFile", {
  objectKey: { type: STRING(300), primaryKey: true },
  contentType: { type: STRING(100), allowNull: false },
  data: { type: DataTypes.BLOB("long"), allowNull: false },
}, { tableName: "media_files", timestamps: false });

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
  const [adminColumns, trackColumns] = await Promise.all([
    sequelize.query("SHOW COLUMNS FROM admins LIKE 'isActive'"),
    sequelize.query("SHOW COLUMNS FROM tracks LIKE 'archivedAt'"),
  ]);
  if (!adminColumns[0].length) {
    await sequelize.query("ALTER TABLE admins ADD COLUMN isActive TINYINT(1) NOT NULL DEFAULT 1");
  }
  if (!trackColumns[0].length) {
    await sequelize.query("ALTER TABLE tracks ADD COLUMN archivedAt DATETIME NULL");
  }
  if (await Admin.count() === 0) {
    await Admin.create({
      email: cfg.adminEmail,
      passwordHash: await bcrypt.hash(cfg.adminPassword, 10),
      isActive: true,
    });
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
async function storeObject(sub, name, source, contentType) {
  if (cfg.db.fileStorage) {
    const data = typeof source === "string" ? await fs.promises.readFile(source) : Buffer.from(source);
    await MediaFile.create({ objectKey: `${sub}/${name}`, contentType, data });
  } else if (typeof source !== "string") {
    await fs.promises.writeFile(path.join(cfg.uploads, sub, name), Buffer.from(source), { flag: "wx" });
  }
}

async function removeFile(sub, name) {
  if (!name) return;
  if (cfg.db.fileStorage) {
    await MediaFile.destroy({ where: { objectKey: `${sub}/${name}` } });
    return;
  }
  await fs.promises.rm(path.join(cfg.uploads, sub, path.basename(name)), { force: true });
}

async function getMediaStorageBytes() {
  const [usage] = await sequelize.query(
    "SELECT COALESCE(SUM(OCTET_LENGTH(data)), 0) AS usedBytes FROM media_files",
    { type: Sequelize.QueryTypes.SELECT },
  );
  return Number(usage.usedBytes) || 0;
}

async function serveStoredObject(req, res, sub) {
  const name = req.params.name;
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/i.test(name)) return fail(res, 404, "Fichier introuvable.");
  const objectKey = `${sub}/${name}`;
  const file = await MediaFile.findByPk(objectKey);
  if (!file) return fail(res, 404, "Fichier introuvable.");
  const size = file.data.length;
  let start = 0;
  let end = size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.set("Content-Range", `bytes */${size}`);
      return fail(res, 416, "Plage de lecture invalide.");
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      start = Math.max(size - suffixLength, 0);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
    }
    if (start >= size || start > end) {
      res.set("Content-Range", `bytes */${size}`);
      return fail(res, 416, "Plage de lecture invalide.");
    }
    end = Math.min(end, size - 1);
    res.status(206);
    res.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  const data = file.data.subarray(start, end + 1);
  res.set("Cache-Control", "public, max-age=3600");
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Type", file.contentType);
  res.set("Content-Length", String(data.length));
  res.end(data);
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
if (cfg.db.fileStorage) {
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
  return track?.published && !track.archivedAt ? track : null;
}

app.get("/api/tracks", async (req, res) => {
  const tracks = await Track.findAll({ where: { published: true, archivedAt: null }, order: newest });
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
  if (!admin || !admin.isActive || !(await bcrypt.compare(String(password), admin.passwordHash))) {
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
    const admin = await Admin.findByPk(data.sub);
    if (admin?.isActive) {
      req.admin = admin;
      return next();
    }
  } catch { /* jeton absent ou invalide */ }
  fail(res, 401, "Session expirée, reconnectez-vous.");
}

app.get("/api/admin/accounts", requireAdmin, async (req, res) => {
  res.json(await Admin.findAll({ attributes: ["id", "email", "isActive"], order: [["id", "ASC"]] }));
});

app.get("/api/admin/me", requireAdmin, async (req, res) => {
  res.json({ id: req.admin.id, email: req.admin.email });
});

app.post("/api/admin/accounts", requireAdmin, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 422, "Adresse e-mail invalide.");
  if (password.length < 12) return fail(res, 422, "Le mot de passe doit contenir au moins 12 caractères.");
  if (await Admin.count() >= 10) return fail(res, 409, "La limite de 10 comptes administrateur est atteinte.");
  if (await Admin.findOne({ where: { email } })) return fail(res, 409, "Cette adresse e-mail possède déjà un compte.");
  const admin = await Admin.create({ email, passwordHash: await bcrypt.hash(password, 12), isActive: true });
  res.status(201).json({ id: admin.id, email: admin.email, isActive: admin.isActive });
});

app.patch("/api/admin/accounts/:id", requireAdmin, async (req, res) => {
  const admin = await Admin.findByPk(req.params.id);
  if (!admin) return fail(res, 404, "Compte administrateur introuvable.");
  if (req.body?.password !== undefined) {
    if (typeof req.body.password !== "string" || req.body.password.length < 12) {
      return fail(res, 422, "Le mot de passe doit contenir au moins 12 caractères.");
    }
    admin.passwordHash = await bcrypt.hash(req.body.password, 12);
  }
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") return fail(res, 422, "État du compte invalide.");
    if (!req.body.isActive && await Admin.count({ where: { isActive: true } }) <= 1) {
      return fail(res, 409, "Impossible de désactiver le dernier compte administrateur actif.");
    }
    admin.isActive = req.body.isActive;
  }
  await admin.save();
  res.json({ id: admin.id, email: admin.email, isActive: admin.isActive });
});

app.get("/api/admin/tracks", requireAdmin, async (req, res) => {
  res.json(await serialize(await Track.findAll({ where: { archivedAt: null }, order: newest }), null));
});

app.get("/api/admin/tracks/archived", requireAdmin, async (req, res) => {
  res.json(await serialize(await Track.findAll({
    where: { archivedAt: { [Sequelize.Op.ne]: null } }, order: newest,
  }), null));
});

app.get("/api/admin/storage", requireAdmin, async (req, res) => {
  if (!cfg.db.fileStorage) return res.json({ tracked: false });
  const usedBytes = await getMediaStorageBytes();
  const warningBytes = MEDIA_STORAGE_LIMIT_BYTES * 0.7;
  res.json({
    tracked: true,
    usedBytes,
    limitBytes: MEDIA_STORAGE_LIMIT_BYTES,
    warning: usedBytes >= warningBytes,
    importBlocked: usedBytes >= MEDIA_STORAGE_LIMIT_BYTES,
  });
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
      if (cfg.db.fileStorage) await fs.promises.rm(file.path, { force: true });
      else await removeFile("audio", file.filename);
      errors.push({ file: shown, error: "Fichier audio illisible ou corrompu." });
      continue;
    }

    let coverFile = null;
    let audioStored = false;
    let coverStored = false;
    const picture = meta.common.picture?.[0];
    if (cfg.db.fileStorage) {
      const usedBytes = await getMediaStorageBytes();
      const pendingBytes = file.size + (picture?.data.byteLength || 0);
      if (usedBytes + pendingBytes > MEDIA_STORAGE_LIMIT_BYTES) {
        await fs.promises.rm(file.path, { force: true });
        errors.push({ file: shown, error: "Espace médias insuffisant. Ce fichier n'a pas été importé ; les morceaux déjà enregistrés sont conservés." });
        continue;
      }
    }
    try {
      await storeObject("audio", file.filename, file.path, file.mimetype);
      audioStored = true;
      if (picture) {
        coverFile = randomName(picture.format.includes("png") ? ".png" : ".jpg");
        await storeObject("covers", coverFile, picture.data, picture.format);
        coverStored = true;
      }
      created.push(await Track.create({
        title: (meta.common.title || path.parse(shown).name.replace(/_/g, " ")).trim().slice(0, 200),
        album: (meta.common.album || "").slice(0, 200),
        audioFile: file.filename, coverFile, duration: meta.format.duration || 0,
      }));
    } catch (err) {
      if (audioStored) await removeFile("audio", file.filename);
      if (coverStored && coverFile) await removeFile("covers", coverFile);
      throw err;
    } finally {
      if (cfg.db.fileStorage) await fs.promises.rm(file.path, { force: true });
    }
  }
  res.json({ created: await serialize(created, null), errors });
});

app.patch("/api/admin/tracks/:id", requireAdmin, async (req, res) => {
  const track = await Track.findByPk(req.params.id);
  if (!track || track.archivedAt) return fail(res, 404, "Titre introuvable.");
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

app.post("/api/admin/tracks/:id/archive", requireAdmin, async (req, res) => {
  const track = await Track.findByPk(req.params.id);
  if (!track || track.archivedAt) return fail(res, 404, "Titre introuvable.");
  await track.update({ archivedAt: new Date() });
  res.json({ archived: track.id });
});

app.post("/api/admin/tracks/:id/restore", requireAdmin, async (req, res) => {
  const track = await Track.findByPk(req.params.id);
  if (!track?.archivedAt) return fail(res, 404, "Titre archivé introuvable.");
  await track.update({ archivedAt: null });
  res.json((await serialize([track], null))[0]);
});

app.delete("/api/admin/tracks/:id", requireAdmin, async (req, res) => {
  const track = await Track.findByPk(req.params.id);
  if (!track?.archivedAt) return fail(res, 409, "Archivez d'abord le morceau avant toute suppression définitive.");
  if (req.body?.title !== track.title) return fail(res, 422, "Le titre saisi ne correspond pas au morceau.");
  if (!(await bcrypt.compare(String(req.body?.password || ""), req.admin.passwordHash))) {
    return fail(res, 401, "Mot de passe administrateur incorrect.");
  }
  await sequelize.transaction(async (transaction) => {
    await Rating.destroy({ where: { trackId: track.id }, transaction });
    if (cfg.db.fileStorage) {
      await MediaFile.destroy({
        where: { objectKey: [`audio/${track.audioFile}`, ...(track.coverFile ? [`covers/${track.coverFile}`] : [])] },
        transaction,
      });
    }
    await track.destroy({ transaction });
  });
  if (!cfg.db.fileStorage) {
    await removeFile("audio", track.audioFile);
    await removeFile("covers", track.coverFile);
  }
  res.json({ deleted: track.id });
});

app.post("/api/admin/tracks/:id/cover", requireAdmin, coverUpload.single("file"), async (req, res) => {
  if (!req.file) return fail(res, 400, req.rejected?.[0]?.error || "Aucune image reçue.");
  const track = await Track.findByPk(req.params.id);
  if (!track || track.archivedAt) {
    if (cfg.db.fileStorage) await fs.promises.rm(req.file.path, { force: true });
    else await removeFile("covers", req.file.filename);
    return fail(res, 404, "Titre introuvable.");
  }
  let coverStored = false;
  try {
    await storeObject("covers", req.file.filename, req.file.path, req.file.mimetype);
    coverStored = true;
    await track.update({ coverFile: req.file.filename });
  } catch (err) {
    if (coverStored) await removeFile("covers", req.file.filename);
    throw err;
  } finally {
    if (cfg.db.fileStorage) await fs.promises.rm(req.file.path, { force: true });
  }
  res.json((await serialize([track], null))[0]);
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
  if (["ER_DISK_FULL", "ER_RECORD_FILE_FULL"].includes(err.code || err.parent?.code)) {
    return fail(res, 507, "Le stockage TiDB est plein. Aucun morceau existant n'a été supprimé. Vérifiez l'espace disponible avant de réessayer.");
  }
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
