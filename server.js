// ═══════════════════════════════════════════════════
// COURA SERVER — Relais de messages chiffrés
// Le serveur ne voit jamais le contenu en clair.
// ═══════════════════════════════════════════════════

const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Base de données SQLite ──────────────────────────
const db = new Database("coura.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    encrypted   TEXT NOT NULL,
    has_file    INTEGER DEFAULT 0,
    file_name   TEXT,
    file_data   TEXT,
    ts          INTEGER NOT NULL,
    read        INTEGER DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    nokey       INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_to_id ON messages(to_id);
  CREATE INDEX IF NOT EXISTS idx_expires ON messages(expires_at);
`);

// ── Migration : ajoute nokey si absent ─────────────
try { db.exec(`ALTER TABLE messages ADD COLUMN nokey INTEGER DEFAULT 0`); } catch {}

// ── Nettoyage automatique des messages expirés ──────
// Toutes les 60 secondes, supprime les messages lus ou expirés
setInterval(() => {
  const now = Date.now();
  const deleted = db.prepare("DELETE FROM messages WHERE expires_at < ? OR read = 1").run(now);
  if (deleted.changes > 0) {
    console.log(`[cleanup] ${deleted.changes} message(s) supprimé(s)`);
  }
}, 60_000);

// ── Middlewares ─────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" })); // 10mb pour les fichiers .coura
app.use(express.static(path.join(__dirname, "public")));

// ── ROUTES ──────────────────────────────────────────

/**
 * GET /ping
 * Vérifier que le serveur est en ligne
 */
app.get("/ping", (req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

/**
 * POST /messages
 * Envoyer un message chiffré
 * Body: { from, to, encrypted, hasFile, fileName, fileData, ttl }
 * ttl = durée de vie en secondes (défaut: 86400 = 24h)
 */
app.post("/messages", (req, res) => {
  const { from, to, encrypted, hasFile, fileName, fileData, ttl, nokey } = req.body;

  // Validation minimale
  if (!from || !to || (!encrypted && !hasFile)) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }
  if (from.length > 20 || to.length > 20) {
    return res.status(400).json({ error: "Identifiant invalide" });
  }
  if (encrypted && encrypted.length > 500_000) {
    return res.status(400).json({ error: "Message trop long" });
  }

  const id = randomUUID();
  const ts = Date.now();
  const liveDuration = Math.min(Math.max(parseInt(ttl) || 86400, 60), 604800);
  const expires_at = ts + liveDuration * 1000;

  // Stocke en base64 pour préserver les symboles Unicode
  const encryptedStored = Buffer.from(encrypted || "", 'utf8').toString('base64');

  db.prepare(`
    INSERT INTO messages (id, from_id, to_id, encrypted, has_file, file_name, file_data, ts, expires_at, nokey)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, from, to, encryptedStored, hasFile ? 1 : 0, fileName || null, fileData || null, ts, expires_at, nokey ? 1 : 0);

  console.log(`[msg] ${from} → ${to} | id: ${id.slice(0, 8)}...`);
  res.json({ id, ts });
});

/**
 * GET /messages/:userId
 * Récupérer les messages en attente pour un utilisateur
 * Les messages sont marqués comme lus et seront supprimés au prochain nettoyage
 */
app.get("/messages/:userId", (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length > 20) {
    return res.status(400).json({ error: "Identifiant invalide" });
  }

  const now = Date.now();
  const msgs = db.prepare(`
    SELECT id, from_id, to_id, encrypted, has_file, file_name, file_data, ts, nokey, expires_at
    FROM messages
    WHERE to_id = ? AND read = 0 AND expires_at > ?
    ORDER BY ts ASC
  `).all(userId, now);

  // Marque comme lus (seront supprimés au prochain nettoyage)
  if (msgs.length > 0) {
    const ids = msgs.map(m => `'${m.id}'`).join(",");
    db.exec(`UPDATE messages SET read = 1 WHERE id IN (${ids})`);
  }

  res.json(msgs.map(m => ({
    id: m.id,
    from: m.from_id,
    to: m.to_id,
    encrypted: m.encrypted ? Buffer.from(m.encrypted, 'base64').toString('utf8') : "",
    hasFile: m.has_file === 1,
    fileName: m.file_name,
    fileData: m.file_data,
    ts: m.ts,
    ttl: Math.round((m.expires_at - m.ts) / 1000),
    nokey: m.nokey === 1
  })));
});

/**
 * GET /messages/:userId/count
 * Nombre de messages en attente (pour le polling léger)
 */
app.get("/messages/:userId/count", (req, res) => {
  const { userId } = req.params;
  const now = Date.now();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE to_id = ? AND read = 0 AND expires_at > ?
  `).get(userId, now);
  res.json({ count: row.count });
});

// ── Démarrage ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ COURA Server démarré sur le port ${PORT}`);
  console.log(`   Les messages sont chiffrés côté client.`);
  console.log(`   Ce serveur ne voit jamais le contenu en clair.\n`);
});
