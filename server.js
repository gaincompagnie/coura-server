// ═══════════════════════════════════════════════════
// COURA SERVER — WebSocket + Express
// ═══════════════════════════════════════════════════

const express    = require("express");
const { createServer } = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const Database   = require("better-sqlite3");
const cors       = require("cors");
const { randomUUID } = require("crypto");
const path       = require("path");

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

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

// Migrations silencieuses
try { db.exec(`ALTER TABLE messages ADD COLUMN nokey INTEGER DEFAULT 0`); } catch {}

// ── Nettoyage auto ──────────────────────────────────
setInterval(() => {
  const { changes } = db.prepare("DELETE FROM messages WHERE expires_at < ?").run(Date.now());
  if (changes > 0) console.log(`[cleanup] ${changes} message(s) supprimé(s)`);
}, 60_000);

// ── Middlewares ─────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Registre WebSocket : userId → Set<ws> ──────────
const clients = new Map(); // userId → Set<WebSocket>

function register(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
}
function unregister(userId, ws) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) clients.delete(userId);
}
function push(userId, payload) {
  const set = clients.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ── WebSocket ───────────────────────────────────────
wss.on("connection", (ws) => {
  let myId = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "register" && msg.userId) {
        myId = msg.userId;
        register(myId, ws);
        ws.send(JSON.stringify({ type: "registered", userId: myId }));

        // Envoie les messages non lus en attente
        const now = Date.now();
        const pending = db.prepare(`
          SELECT id, from_id, to_id, encrypted, has_file, file_name, file_data, ts, nokey, expires_at
          FROM messages WHERE to_id = ? AND read = 0 AND expires_at > ?
          ORDER BY ts ASC
        `).all(myId, now);

        if (pending.length > 0) {
          const ids = pending.map(m => `'${m.id}'`).join(",");
          db.exec(`UPDATE messages SET read = 1 WHERE id IN (${ids})`);
          for (const m of pending) {
            ws.send(JSON.stringify({
              type: "message",
              id: m.id, from: m.from_id, to: m.to_id,
              encrypted: m.encrypted ? Buffer.from(m.encrypted, 'base64').toString('utf8') : "",
              hasFile: m.has_file === 1, fileName: m.file_name, fileData: m.file_data,
              ts: m.ts, ttl: Math.round((m.expires_at - m.ts) / 1000), nokey: m.nokey === 1
            }));
          }
        }
      }

      // ── Signaling WebRTC ────────────────────────────
      // Relaie les messages de signaling (offer, answer, candidate, call-*, etc.)
      if (["call-offer","call-answer","call-reject","call-end","ice-candidate"].includes(msg.type)) {
        if (msg.to) push(msg.to, { ...msg, from: myId });
      }

    } catch {}
  });

  ws.on("close", () => { if (myId) unregister(myId, ws); });
  ws.on("error", () => { if (myId) unregister(myId, ws); });
});

// ── ROUTES HTTP ─────────────────────────────────────

app.get("/ping", (req, res) => res.json({ status: "ok", ts: Date.now() }));

/**
 * POST /messages — Envoyer un message
 */
app.post("/messages", (req, res) => {
  const { from, to, encrypted, hasFile, fileName, fileData, ttl, nokey } = req.body;

  if (!from || !to || (!encrypted && !hasFile))
    return res.status(400).json({ error: "Paramètres manquants" });
  if (from.length > 20 || to.length > 20)
    return res.status(400).json({ error: "Identifiant invalide" });
  if (encrypted && encrypted.length > 500_000)
    return res.status(400).json({ error: "Message trop long" });

  const id          = randomUUID();
  const ts          = Date.now();
  const liveDuration = Math.min(Math.max(parseInt(ttl) || 86400, 60), 604800);
  const expires_at  = ts + liveDuration * 1000;
  const encStored   = Buffer.from(encrypted || "", 'utf8').toString('base64');

  db.prepare(`
    INSERT INTO messages (id, from_id, to_id, encrypted, has_file, file_name, file_data, ts, expires_at, nokey)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, from, to, encStored, hasFile ? 1 : 0, fileName || null, fileData || null, ts, expires_at, nokey ? 1 : 0);

  // Push WebSocket immédiat au destinataire
  push(to, {
    type: "message",
    id, from, to,
    encrypted: encrypted || "",
    hasFile: !!hasFile,
    fileName: fileName || null,
    fileData: fileData || null,
    ts,
    ttl: liveDuration,
    nokey: !!nokey
  });

  // Marque comme lu si destinataire connecté
  if (clients.has(to)) {
    db.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(id);
  }

  console.log(`[msg] ${from} → ${to} | ${id.slice(0, 8)}`);
  res.json({ id, ts });
});

/**
 * GET /messages/:userId — Fallback polling (si WS non connecté)
 */
app.get("/messages/:userId", (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length > 20)
    return res.status(400).json({ error: "Identifiant invalide" });

  const now  = Date.now();
  const msgs = db.prepare(`
    SELECT id, from_id, to_id, encrypted, has_file, file_name, file_data, ts, nokey, expires_at
    FROM messages WHERE to_id = ? AND read = 0 AND expires_at > ?
    ORDER BY ts ASC
  `).all(userId, now);

  if (msgs.length > 0) {
    const ids = msgs.map(m => `'${m.id}'`).join(",");
    db.exec(`UPDATE messages SET read = 1 WHERE id IN (${ids})`);
  }

  res.json(msgs.map(m => ({
    id: m.id, from: m.from_id, to: m.to_id,
    encrypted: m.encrypted ? Buffer.from(m.encrypted, 'base64').toString('utf8') : "",
    hasFile: m.has_file === 1, fileName: m.file_name, fileData: m.file_data,
    ts: m.ts, ttl: Math.round((m.expires_at - m.ts) / 1000), nokey: m.nokey === 1
  })));
});

/**
 * DELETE /messages/:id — Supprime un message et notifie le destinataire
 */
app.delete("/messages/:id", (req, res) => {
  const { id } = req.params;
  const msg = db.prepare("SELECT id, to_id FROM messages WHERE id = ?").get(id);
  if (!msg) return res.status(404).json({ error: "Message introuvable" });
  db.prepare("DELETE FROM messages WHERE id = ?").run(id);

  // Push suppression immédiate via WebSocket
  push(msg.to_id, { type: "deleted", id });

  res.json({ deleted: true });
});

// ── Démarrage ────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n✅ COURA Server (WebSocket) démarré sur le port ${PORT}\n`);
});
