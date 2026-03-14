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
const fs         = require("fs");

// Disque éphémère Railway — pas de volume
const DATA_DIR = __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "coura.db");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
console.log(`[init] DB: ${DB_PATH}`);
console.log(`[init] Uploads: ${UPLOADS_DIR}`);

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

// ── Migration colonnes manquantes ──────────────────
try { db.exec(`ALTER TABLE messages ADD COLUMN media_group TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN group_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN group_total INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN group_index INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN seen INTEGER DEFAULT 0`); } catch {}

// ── Base de données SQLite ──────────────────────────
const db = new Database(DB_PATH);

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
    nokey       INTEGER DEFAULT 0,
    is_voice    INTEGER DEFAULT 0,
    file_type   TEXT,
    media_group TEXT,
    group_id    TEXT,
    group_total INTEGER DEFAULT 1,
    group_index INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    last_seen  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS keys (
    user_id     TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    user_a      TEXT NOT NULL,
    user_b      TEXT NOT NULL,
    state_a     TEXT,
    state_b     TEXT,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_to_id ON messages(to_id);
  CREATE INDEX IF NOT EXISTS idx_expires ON messages(expires_at);
  CREATE INDEX IF NOT EXISTS idx_session_ab ON sessions(user_a, user_b);
`);

// Migrations silencieuses
try { db.exec(`ALTER TABLE messages ADD COLUMN nokey INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN seen INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN is_voice INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN file_type TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN file_url TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN file_size INTEGER`); } catch {}

// ── Nettoyage auto ──────────────────────────────────
setInterval(() => {
  const { changes } = db.prepare("DELETE FROM messages WHERE expires_at < ?").run(Date.now());
  if (changes > 0) console.log(`[cleanup] ${changes} message(s) supprimé(s)`);
}, 60_000);

// ── Middlewares ─────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(UPLOADS_DIR));

// ── Registre WebSocket ──────────────────────────────
const clients = new Map();

function register(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
  db.prepare("INSERT OR REPLACE INTO users (id, last_seen) VALUES (?, ?)").run(userId, Date.now());
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

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === "register" && msg.userId) {
        myId = msg.userId;
        register(myId, ws);
        ws.send(JSON.stringify({ type: "registered", userId: myId }));

        const now = Date.now();
        const pending = db.prepare(`
          SELECT id, from_id, to_id, encrypted, has_file, file_name, file_data, file_type, ts, nokey, is_voice, expires_at
          FROM messages WHERE to_id = ? AND read = 0 AND expires_at > ?
          ORDER BY ts ASC
        `).all(myId, now);

        if (pending.length > 0) {
          const ids = pending.map(m => `'${m.id}'`).join(",");
          db.exec(`UPDATE messages SET read = 1 WHERE id IN (${ids})`);
          // Notifier les expéditeurs que leurs messages sont délivrés
          for (const m of pending) {
            push(m.from_id, { type: "msg-delivered", msgId: m.id });
          }
          for (const m of pending) {
            ws.send(JSON.stringify({
              type: "message",
              id: m.id, from: m.from_id, to: m.to_id,
              encrypted: m.encrypted ? Buffer.from(m.encrypted, 'base64').toString('utf8') : "",
              hasFile: m.has_file === 1,
              fileName: m.file_name,
              fileData: m.file_data,
              fileType: m.file_type || "",
              ts: m.ts,
              ttl: Math.round((m.expires_at - m.ts) / 1000),
              nokey: m.nokey === 1,
              isVoice: m.is_voice === 1
            }));
          }
        }
        return;
      }

      // Signaling WebRTC
      if (["call-offer","call-answer","call-reject","call-end","ice-candidate"].includes(msg.type)) {
        if (msg.to) push(msg.to, { ...msg, from: myId });
      }

      // Confirmation de lecture
      if (msg.type === "msg-seen" && msg.msgId && myId) {
        db.prepare("UPDATE messages SET seen = 1 WHERE id = ?").run(msg.msgId);
        const m = db.prepare("SELECT from_id FROM messages WHERE id = ?").get(msg.msgId);
        if (m) push(m.from_id, { type: "msg-seen", msgId: msg.msgId, by: myId });
      }

    } catch {}
  });

  ws.on("close", () => { if (myId) unregister(myId, ws); });
  ws.on("error", () => { if (myId) unregister(myId, ws); });
});

// ── ROUTES HTTP ─────────────────────────────────────

app.get("/ping", (req, res) => res.json({ status: "ok", ts: Date.now() }));

// ── Vérifier si un utilisateur existe ──
app.get("/user/:userId", (req, res) => {
  const userId = req.params.userId.toUpperCase();
  const liveNow = clients.has(userId);
  const inDb = db.prepare("SELECT 1 FROM users WHERE id = ? LIMIT 1").get(userId);
  if (liveNow || inDb) {
    res.json({ exists: true });
  } else {
    res.status(404).json({ exists: false });
  }
});

// ══════════════════════════════════════════════════════
// PREKEYS — Clés publiques pour chiffrement E2E
// ══════════════════════════════════════════════════════

// Déposer sa clé publique sur le serveur
app.post("/keys/register", (req, res) => {
  const { userId, publicKey } = req.body;
  if (!userId || !publicKey) return res.status(400).json({ error: "userId et publicKey requis" });
  if (userId.length > 20) return res.status(400).json({ error: "Identifiant invalide" });
  if (publicKey.length > 2000) return res.status(400).json({ error: "Clé invalide" });

  db.prepare("INSERT OR REPLACE INTO keys (user_id, public_key, updated_at) VALUES (?, ?, ?)")
    .run(userId.toUpperCase(), publicKey, Date.now());

  console.log(`[keys] Clé publique enregistrée pour ${userId}`);
  res.json({ ok: true });
});

// Récupérer la clé publique d'un utilisateur
app.get("/keys/:userId", (req, res) => {
  const userId = req.params.userId.toUpperCase();
  const row = db.prepare("SELECT public_key FROM keys WHERE user_id = ?").get(userId);
  if (!row) return res.status(404).json({ error: "Clé introuvable" });
  res.json({ userId, publicKey: row.public_key });
});

// ══════════════════════════════════════════════════════
// SESSIONS — État Double Ratchet chiffré
// Le serveur stocke l'état de session chiffré côté client
// Il ne peut pas le lire — il est chiffré avec les clés des utilisateurs
// ══════════════════════════════════════════════════════

// Obtenir l'ID de session canonique (toujours A < B alphabétiquement)
function sessionId(a, b) {
  return [a, b].sort().join(":");
}

// Sauvegarder l'état de session d'un utilisateur
app.post("/sessions/:userId", (req, res) => {
  const userId = req.params.userId.toUpperCase();
  const { peerId, state } = req.body;
  if (!userId || !peerId || !state) return res.status(400).json({ error: "Paramètres manquants" });
  if (state.length > 100_000) return res.status(400).json({ error: "État trop grand" });

  const sid = sessionId(userId, peerId.toUpperCase());
  const existing = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sid);
  const now = Date.now();

  if (existing) {
    // Mettre à jour l'état de l'utilisateur concerné
    const col = existing.user_a === userId ? "state_a" : "state_b";
    db.prepare(`UPDATE sessions SET ${col} = ?, updated_at = ? WHERE session_id = ?`).run(state, now, sid);
  } else {
    // Créer la session
    const [userA, userB] = [userId, peerId.toUpperCase()].sort();
    const stateA = userA === userId ? state : null;
    const stateB = userB === userId ? state : null;
    db.prepare("INSERT INTO sessions (session_id, user_a, user_b, state_a, state_b, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sid, userA, userB, stateA, stateB, now);
  }

  res.json({ ok: true });
});

// Récupérer l'état de session pour un utilisateur
app.get("/sessions/:userId/:peerId", (req, res) => {
  const userId = req.params.userId.toUpperCase();
  const peerId = req.params.peerId.toUpperCase();
  const sid = sessionId(userId, peerId);
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sid);
  if (!session) return res.status(404).json({ error: "Session introuvable" });

  // Retourner l'état de l'utilisateur demandeur
  const state = session.user_a === userId ? session.state_a : session.state_b;
  res.json({ state: state || null });
});

// Supprimer une session (reset des clés)
app.delete("/sessions/:userId/:peerId", (req, res) => {
  const userId = req.params.userId.toUpperCase();
  const peerId = req.params.peerId.toUpperCase();
  const sid = sessionId(userId, peerId);
  db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sid);
  res.json({ deleted: true });
});


// ── Upload fichier chiffré ────────────────────────────
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 Mo

app.post("/files", (req, res) => {
  const fileId = randomUUID();
  const ext = req.headers["x-file-ext"] || "bin";
  const fileName = fileId + "." + ext;
  const filePath = path.join(UPLOADS_DIR, fileName);
  const chunks = [];
  let totalSize = 0;
  let aborted = false;

  req.on("data", chunk => {
    totalSize += chunk.length;
    if (totalSize > MAX_FILE_SIZE) {
      aborted = true;
      req.destroy();
      return res.status(413).json({ error: "Fichier trop volumineux (max 100 Mo)" });
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    fs.writeFile(filePath, buf, (err) => {
      if (err) return res.status(500).json({ error: "Erreur écriture" });
      const fileUrl = "/files/" + fileName;
      console.log(`[file] Upload ${fileName} (${buf.length} bytes)`);
      res.json({ fileId, fileUrl, size: buf.length });
    });
  });
  req.on("error", () => { if (!aborted) res.status(500).json({ error: "Erreur upload" }); });
});

// ── Supprimer fichier lié à un message ────────────────
// ── Messages ─────────────────────────────────────────

app.post("/messages", (req, res) => {
  const { from, to, encrypted, hasFile, fileName, fileData, fileType, fileUrl, fileSize, ttl, nokey, isVoice, mediaGroup, groupId, groupTotal, groupIndex } = req.body;
  if (!from || !to || (!encrypted && !hasFile && !mediaGroup)) return res.status(400).json({ error: "Paramètres manquants" });
  if (from.length > 20 || to.length > 20) return res.status(400).json({ error: "Identifiant invalide" });

  const id = randomUUID(), ts = Date.now();
  const liveDuration = Math.min(Math.max(parseInt(ttl) || 86400, 60), 604800);
  const expires_at = ts + liveDuration * 1000;
  const encStored = Buffer.from(encrypted || "", 'utf8').toString('base64');
  const mediaGroupStr = mediaGroup ? JSON.stringify(mediaGroup) : null;

  // Si fileUrl fourni → nouveau système (fichier uploadé séparément)
  // Sinon → ancien système (fileData inline) pour rétrocompatibilité
  const storedFileData = fileUrl ? null : (fileData || null);

  db.prepare(`
    INSERT INTO messages (id, from_id, to_id, encrypted, has_file, file_name, file_data, file_type, file_url, file_size, ts, expires_at, nokey, is_voice, media_group, group_id, group_total, group_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, from, to, encStored, hasFile ? 1 : 0, fileName || null, storedFileData, fileType || null, fileUrl || null, fileSize || 0, ts, expires_at, nokey ? 1 : 0, isVoice ? 1 : 0, mediaGroupStr, groupId || null, groupTotal || 1, groupIndex || 0);

  push(to, {
    type: "message", id, from, to,
    encrypted: encrypted || "",
    hasFile: !!hasFile,
    fileName: fileName || null,
    fileData: fileUrl ? null : (fileData || null), // ne pas envoyer fileData si fileUrl présent
    fileUrl: fileUrl || null,
    fileSize: fileSize || 0,
    fileType: fileType || "",
    mediaGroup: mediaGroup ? "__fetch__" : null,
    groupId: groupId || null,
    groupTotal: groupTotal || 1,
    groupIndex: groupIndex || 0,
    ts, ttl: liveDuration,
    nokey: !!nokey,
    isVoice: !!isVoice
  });

  if (clients.has(to) && !mediaGroup) {
    db.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(id);
    push(from, { type: "msg-delivered", msgId: id });
  } else if (clients.has(to) && mediaGroup) {
    push(from, { type: "msg-delivered", msgId: id });
  }

  console.log(`[msg] ${from} → ${to} | ${id.slice(0,8)} | nokey=${nokey} | file=${fileUrl||fileData?"oui":"non"}`);
  res.json({ id, ts });
});

app.get("/messages/fetch/:id", (req, res) => {
  const { id } = req.params;
  const m = db.prepare(`SELECT id, from_id, to_id, encrypted, has_file, file_name, file_data, file_type, ts, nokey, is_voice, expires_at, media_group, group_id, group_total, group_index FROM messages WHERE id = ?`).get(id);
  if (!m) return res.status(404).json({ error: "Introuvable" });
  db.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(id);
  res.json({
    id: m.id, from: m.from_id, to: m.to_id,
    encrypted: m.encrypted ? Buffer.from(m.encrypted, 'base64').toString('utf8') : "",
    hasFile: m.has_file === 1,
    fileName: m.file_name,
    fileData: m.file_data,
    fileType: m.file_type || "",
    ts: m.ts,
    nokey: m.nokey === 1,
    isVoice: m.is_voice === 1,
    mediaGroup: m.media_group ? JSON.parse(m.media_group) : null,
    groupId: m.group_id || null,
    groupTotal: m.group_total || 1,
    groupIndex: m.group_index || 0
  });
});

app.get("/messages/:userId", (req, res) => {
  const { userId } = req.params;
  if (!userId || userId.length > 20) return res.status(400).json({ error: "Identifiant invalide" });
  const now = Date.now();
  const msgs = db.prepare(`
    SELECT id, from_id, to_id, encrypted, has_file, file_name, file_data, file_type, ts, nokey, is_voice, expires_at, media_group, group_id, group_total, group_index
    FROM messages WHERE to_id = ? AND read = 0 AND expires_at > ?
    ORDER BY ts ASC
  `).all(userId, now);

  if (msgs.length > 0) {
    db.exec(`UPDATE messages SET read = 1 WHERE id IN (${msgs.map(m => `'${m.id}'`).join(",")})`);
    // Notifier les expéditeurs que leurs messages sont délivrés
    for (const m of msgs) {
      push(m.from_id, { type: "msg-delivered", msgId: m.id });
    }
  }

  res.json(msgs.map(m => ({
    id: m.id, from: m.from_id, to: m.to_id,
    encrypted: m.encrypted ? Buffer.from(m.encrypted, 'base64').toString('utf8') : "",
    hasFile: m.has_file === 1,
    fileName: m.file_name,
    fileData: m.file_data,
    fileType: m.file_type || "",
    ts: m.ts,
    ttl: Math.round((m.expires_at - m.ts) / 1000),
    nokey: m.nokey === 1,
    isVoice: m.is_voice === 1,
    mediaGroup: m.media_group ? JSON.parse(m.media_group) : null,
    groupId: m.group_id || null,
    groupTotal: m.group_total || 1,
    groupIndex: m.group_index || 0
  })));
});

app.delete("/messages/:id", (req, res) => {
  const { id } = req.params;
  const msg = db.prepare("SELECT id, to_id, from_id, file_url FROM messages WHERE id = ?").get(id);
  if (!msg) return res.status(404).json({ error: "Message introuvable" });
  // Supprimer le fichier si présent
  if (msg.file_url) {
    const fp = path.join(UPLOADS_DIR, path.basename(msg.file_url));
    try { fs.unlinkSync(fp); } catch {}
  }
  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  push(msg.to_id, { type: "deleted", id });
  push(msg.from_id, { type: "deleted", id });
  res.json({ deleted: true });
});

server.listen(PORT, () => {
  console.log(`\n✅ COURA Server (WebSocket + Prekeys) démarré sur le port ${PORT}\n`);
});
