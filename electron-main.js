const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');

let mainWindow;
let expressApp;
let serverPort = 0;
let httpServer;

// Directorio de datos persistente (AppData/Roaming/Presupuesto en Windows)
function getDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function getPublicPath() {
  if (!app.isPackaged) {
    return path.join(__dirname, 'public');
  }
  // extraResources copia a resources/public (no resources/app/public)
  return path.join(process.resourcesPath, 'public');
}

// ===== EXPRESS SERVER SETUP (copiado y adaptado de server.js) =====
function setupExpressServer() {
  const DATA_DIR = getDataDir();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(path.join(DATA_DIR, 'budget.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      parent_id INTEGER,
      code TEXT,
      name TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES lines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS disbursements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL,
      disbursement_id INTEGER,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE,
      FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      link_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      disbursement_id INTEGER NOT NULL,
      line_id INTEGER NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE,
      FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS allocation_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      disbursement_id INTEGER NOT NULL,
      from_line_id INTEGER NOT NULL,
      to_line_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE,
      FOREIGN KEY (from_line_id) REFERENCES lines(id) ON DELETE CASCADE,
      FOREIGN KEY (to_line_id) REFERENCES lines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reserve_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      disbursement_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE
    );
  `);

  try { db.exec('ALTER TABLE lines ADD COLUMN code TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE executions ADD COLUMN disbursement_id INTEGER'); } catch (e) {}
  try { db.exec('ALTER TABLE disbursements ADD COLUMN target_pct REAL DEFAULT 80'); } catch (e) {}
  try { db.exec('ALTER TABLE adjustments ADD COLUMN link_id INTEGER'); } catch (e) {}

  const appExpress = express();
  appExpress.use(express.json());
  appExpress.use(express.static(getPublicPath()));

  const SESSION_COOKIE = 'budget_session';
  const SESSION_DAYS = 30;

  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  }

  function readCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
    }
    return null;
  }

  function currentUser(req) {
    const token = readCookie(req);
    if (!token) return null;
    return db.prepare(`
      SELECT u.id, u.username
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.created_at > ?
    `).get(token, Date.now() - SESSION_DAYS * 24 * 60 * 60 * 1000) || null;
  }

  function setSession(res, userId) {
    db.prepare('DELETE FROM sessions WHERE created_at < ?')
      .run(Date.now() - SESSION_DAYS * 24 * 60 * 60 * 1000);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
      .run(token, userId, Date.now());
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  }

  function clearSession(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    req.user = user;
    next();
  }

  function parseAmount(value) {
    if (typeof value === 'string') value = value.replace(',', '.');
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function parseTargetPct(value, fallback = 80) {
    if (value == null || value === '') return fallback;
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(1000, n);
  }

  function getOwnedLine(userId, lineId) {
    return db.prepare('SELECT id, name, code FROM lines WHERE id = ? AND user_id = ?').get(lineId, userId);
  }

  function getOwnedDisbursement(userId, disbursementId) {
    return db.prepare('SELECT * FROM disbursements WHERE id = ? AND user_id = ?').get(disbursementId, userId);
  }

  function verifyPasswordFor(userId, password) {
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(userId);
    return !!user && verifyPassword(String(password || ''), user.password);
  }

  // --- API Routes ---
  appExpress.get('/api/health', (req, res) => res.json({ ok: true }));

  // Debug: ver la ruta pública resuelta
  appExpress.get('/api/debug/public-path', (req, res) => {
    const publicPath = getPublicPath();
    const fs = require('fs');
    const files = fs.existsSync(publicPath) ? fs.readdirSync(publicPath) : 'NO EXISTE';
    res.json({ publicPath, files, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged });
  });

  appExpress.get('/api/me', (req, res) => {
    const user = currentUser(req);
    res.json({ user: user ? { id: user.id, username: user.username } : null });
  });

  appExpress.post('/api/register', (req, res) => {
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');
    if (username.length < 3) return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
    if (password.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }
    const info = db.prepare('INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), Date.now());
    setSession(res, info.lastInsertRowid);
    res.json({ user: { id: info.lastInsertRowid, username } });
  });

  appExpress.post('/api/login', (req, res) => {
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    setSession(res, user.id);
    res.json({ user: { id: user.id, username: user.username } });
  });

  appExpress.post('/api/logout', (req, res) => {
    const token = readCookie(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearSession(res);
    res.json({ ok: true });
  });

  appExpress.get('/api/data', requireAuth, (req, res) => {
    const lines = db.prepare('SELECT * FROM lines WHERE user_id = ? ORDER BY id').all(req.user.id);
    const executions = db.prepare(`
      SELECT e.* FROM executions e JOIN lines l ON l.id = e.line_id
      WHERE l.user_id = ? ORDER BY e.date DESC, e.id DESC
    `).all(req.user.id);
    const adjustments = db.prepare(`
      SELECT a.* FROM adjustments a JOIN lines l ON l.id = a.line_id
      WHERE l.user_id = ? ORDER BY a.date DESC, a.id DESC
    `).all(req.user.id);
    const disbursements = db.prepare(`
      SELECT * FROM disbursements WHERE user_id = ? ORDER BY date, id
    `).all(req.user.id);
    const allocations = db.prepare(`
      SELECT * FROM allocations WHERE user_id = ? ORDER BY id
    `).all(req.user.id);
    const transfers = db.prepare(`
      SELECT * FROM allocation_transfers WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(req.user.id);
    const reserveMoves = db.prepare(`
      SELECT * FROM reserve_moves WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(req.user.id);
    res.json({ lines, executions, adjustments, disbursements, allocations, transfers, reserveMoves });
  });

  appExpress.post('/api/lines', requireAuth, (req, res) => {
    const { name, amount, parent_id, code } = req.body || {};
    const lineName = String(name || '').trim();
    if (!lineName) return res.status(400).json({ error: 'El nombre de la línea es obligatorio' });
    const amt = parseAmount(amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    if (parent_id != null && parent_id !== '') {
      const parent = getOwnedLine(req.user.id, parent_id);
      if (!parent) return res.status(400).json({ error: 'La línea padre no existe' });
    }
    const lineCode = code ? String(code).trim().toUpperCase() : null;
    const info = db.prepare('INSERT INTO lines (user_id, parent_id, code, name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, parent_id || null, lineCode, lineName, amt, Date.now());
    res.json({ id: info.lastInsertRowid });
  });

  appExpress.put('/api/lines/:id', requireAuth, (req, res) => {
    const line = getOwnedLine(req.user.id, req.params.id);
    if (!line) return res.status(404).json({ error: 'Línea no encontrada' });
    const { name, amount, code, parent_id } = req.body || {};
    const lineName = String(name || '').trim();
    if (!lineName) return res.status(400).json({ error: 'El nombre de la línea es obligatorio' });
    const amt = parseAmount(amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    const lineCode = code ? String(code).trim().toUpperCase() : null;
    if (parent_id === line.id) return res.status(400).json({ error: 'Una línea no puede ser padre de sí misma' });
    const newParent = parent_id != null && parent_id !== '' ? Number(parent_id) : null;
    if (newParent) {
      const parent = getOwnedLine(req.user.id, newParent);
      if (!parent) return res.status(400).json({ error: 'La línea padre no existe' });
    }
    db.prepare('UPDATE lines SET name = ?, amount = ?, code = ?, parent_id = ? WHERE id = ? AND user_id = ?')
      .run(lineName, amt, lineCode, newParent, req.params.id, req.user.id);
    res.json({ ok: true });
  });

  appExpress.delete('/api/lines/:id', requireAuth, (req, res) => {
    if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const info = db.prepare('DELETE FROM lines WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'Línea no encontrada' });
    res.json({ ok: true });
  });

  appExpress.delete('/api/data', requireAuth, (req, res) => {
    if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const lineIds = db.prepare('SELECT id FROM lines WHERE user_id = ?').all(req.user.id).map(l => l.id);
    db.prepare('DELETE FROM allocations WHERE user_id = ?').run(req.user.id);
    db.prepare('DELETE FROM allocation_transfers WHERE user_id = ?').run(req.user.id);
    db.prepare('DELETE FROM reserve_moves WHERE user_id = ?').run(req.user.id);
    if (lineIds.length) {
      const placeholders = lineIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM executions WHERE line_id IN (${placeholders})`).run(...lineIds);
      db.prepare(`DELETE FROM adjustments WHERE line_id IN (${placeholders})`).run(...lineIds);
      db.prepare('DELETE FROM lines WHERE user_id = ?').run(req.user.id);
    }
    db.prepare('DELETE FROM disbursements WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  appExpress.post('/api/disbursements', requireAuth, (req, res) => {
    const { name, date, amount, note, target_pct } = req.body || {};
    const dName = String(name || '').trim();
    if (!dName) return res.status(400).json({ error: 'El nombre del desembolso es obligatorio' });
    const d = String(date || '').trim();
    if (!d) return res.status(400).json({ error: 'La fecha del desembolso es obligatoria' });
    const amt = parseAmount(amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    const target = parseTargetPct(target_pct);
    const info = db.prepare('INSERT INTO disbursements (user_id, name, date, amount, note, target_pct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, dName, d, amt, String(note || '').trim() || null, target, Date.now());
    res.json({ id: info.lastInsertRowid });
  });

  appExpress.put('/api/disbursements/:id', requireAuth, (req, res) => {
    const disb = getOwnedDisbursement(req.user.id, req.params.id);
    if (!disb) return res.status(404).json({ error: 'Desembolso no encontrado' });
    const { name, date, amount, note, target_pct } = req.body || {};
    const dName = String(name || '').trim();
    if (!dName) return res.status(400).json({ error: 'El nombre del desembolso es obligatorio' });
    const d = String(date || '').trim();
    if (!d) return res.status(400).json({ error: 'La fecha del desembolso es obligatoria' });
    const amt = parseAmount(amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    const target = parseTargetPct(target_pct, disb.target_pct != null ? disb.target_pct : 80);
    db.prepare('UPDATE disbursements SET name = ?, date = ?, amount = ?, note = ?, target_pct = ? WHERE id = ? AND user_id = ?')
      .run(dName, d, amt, String(note || '').trim() || null, target, req.params.id, req.user.id);
    res.json({ ok: true });
  });

  appExpress.delete('/api/disbursements/:id', requireAuth, (req, res) => {
    if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const disb = getOwnedDisbursement(req.user.id, req.params.id);
    if (!disb) return res.status(404).json({ error: 'Desembolso no encontrado' });
    db.prepare('DELETE FROM allocations WHERE disbursement_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    db.prepare(`
      DELETE FROM executions WHERE disbursement_id = ?
      AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
    `).run(req.params.id, req.user.id);
    db.prepare('DELETE FROM disbursements WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  appExpress.post('/api/disbursements/:id/release-balance', requireAuth, (req, res) => {
    const disb = getOwnedDisbursement(req.user.id, req.params.id);
    if (!disb) return res.status(404).json({ error: 'Desembolso no encontrado' });

    const body0 = req.body || {};
    if (body0.record_only) {
      const amt0 = parseAmount(body0.amount);
      if (amt0 === null || amt0 <= 0) return res.status(400).json({ error: 'Monto inválido' });
      const ts0 = Number(body0.created_at) > 0 ? Number(body0.created_at) : Date.now();
      db.prepare('INSERT INTO reserve_moves (user_id, disbursement_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, disb.id, amt0, String(body0.note || '').trim() || null, ts0);
      return res.json({ released: amt0, recorded: true });
    }

    const allocRows = db.prepare('SELECT line_id, amount FROM allocations WHERE user_id = ? AND disbursement_id = ?')
      .all(req.user.id, disb.id);
    const byLine = new Map();
    for (const r of allocRows) byLine.set(r.line_id, (byLine.get(r.line_id) || 0) + r.amount);
    const execStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM executions WHERE line_id = ? AND disbursement_id = ?');

    const delAllocs = db.prepare('DELETE FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
    const insAlloc = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)');
    const insMove = db.prepare('INSERT INTO reserve_moves (user_id, disbursement_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?)');

    let released = 0;
    const tx = db.transaction(() => {
      for (const [lineId, total] of byLine) {
        const exec = execStmt.get(lineId, disb.id).s;
        const keep = Math.min(total, exec);
        const free = total - keep;
        if (free <= 1e-9) continue;
        released += free;
        delAllocs.run(req.user.id, disb.id, lineId);
        if (keep > 0) insAlloc.run(req.user.id, disb.id, lineId, keep, Date.now());
      }
      if (released > 1e-9) {
        insMove.run(req.user.id, disb.id, released, String((req.body || {}).note || '').trim() || null, Date.now());
      }
    });
    tx();
    res.json({ released });
  });

  appExpress.post('/api/allocations', requireAuth, (req, res) => {
    const { disbursement_id, line_id, amount } = req.body || {};
    const disb = getOwnedDisbursement(req.user.id, disbursement_id);
    if (!disb) return res.status(400).json({ error: 'El desembolso no existe' });
    const line = getOwnedLine(req.user.id, line_id);
    if (!line) return res.status(400).json({ error: 'La línea no existe' });
    const amt = parseAmount(amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    const info = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, disb.id, line.id, amt, Date.now());
    res.json({ id: info.lastInsertRowid });
  });

  appExpress.put('/api/allocations/:id', requireAuth, (req, res) => {
    const alloc = db.prepare('SELECT id FROM allocations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!alloc) return res.status(404).json({ error: 'Asignación no encontrada' });
    const amt = parseAmount((req.body || {}).amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    db.prepare('UPDATE allocations SET amount = ? WHERE id = ? AND user_id = ?').run(amt, req.params.id, req.user.id);
    res.json({ ok: true });
  });

  appExpress.delete('/api/allocations/:id', requireAuth, (req, res) => {
    if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const info = db.prepare('DELETE FROM allocations WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'Asignación no encontrada' });
    res.json({ ok: true });
  });

  appExpress.post('/api/allocations/transfer', requireAuth, (req, res) => {
    const { disbursement_id, from_line_id, to_line_id, amount, note, record_only, created_at } = req.body || {};
    const disb = getOwnedDisbursement(req.user.id, disbursement_id);
    if (!disb) return res.status(400).json({ error: 'El desembolso no existe' });
    const fromLine = getOwnedLine(req.user.id, from_line_id);
    const toLine = getOwnedLine(req.user.id, to_line_id);
    if (!fromLine || !toLine) return res.status(400).json({ error: 'La línea no existe' });
    if (fromLine.id === toLine.id) return res.status(400).json({ error: 'Elige dos líneas distintas' });
    const amt = parseAmount(amount);
    if (amt === null || amt <= 0) return res.status(400).json({ error: 'Monto inválido' });

    if (record_only) {
      const ts = Number(created_at) > 0 ? Number(created_at) : Date.now();
      db.prepare('INSERT INTO allocation_transfers (user_id, disbursement_id, from_line_id, to_line_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.user.id, disb.id, fromLine.id, toLine.id, amt, String(note || '').trim() || null, ts);
      return res.json({ ok: true, recorded: true });
    }

    const readAllocs = db.prepare('SELECT amount FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
    const fromTotal = readAllocs.all(req.user.id, disb.id, fromLine.id).reduce((s, r) => s + r.amount, 0);
    const toTotal = readAllocs.all(req.user.id, disb.id, toLine.id).reduce((s, r) => s + r.amount, 0);
    const exec = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM executions WHERE line_id = ? AND disbursement_id = ?')
      .get(fromLine.id, disb.id).s;
    const available = fromTotal - exec;
    if (amt > available + 1e-9) {
      return res.status(400).json({ error: `En esa línea solo tienes ${available.toFixed(2)} sin gastar para mover` });
    }

    const delAllocs = db.prepare('DELETE FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
    const insAlloc = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)');
    const insTransfer = db.prepare('INSERT INTO allocation_transfers (user_id, disbursement_id, from_line_id, to_line_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      const rest = fromTotal - amt;
      delAllocs.run(req.user.id, disb.id, fromLine.id);
      if (rest > 0) insAlloc.run(req.user.id, disb.id, fromLine.id, rest, Date.now());
      delAllocs.run(req.user.id, disb.id, toLine.id);
      insAlloc.run(req.user.id, disb.id, toLine.id, toTotal + amt, Date.now());
      insTransfer.run(req.user.id, disb.id, fromLine.id, toLine.id, amt, String(note || '').trim() || null, Date.now());
    });
    tx();
    res.json({ ok: true });
  });

  appExpress.delete('/api/allocations/transfers/:id', requireAuth, (req, res) => {
    if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const t = db.prepare('SELECT * FROM allocation_transfers WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!t) return res.status(404).json({ error: 'Ajuste de reparto no encontrado' });
    const fromLine = getOwnedLine(req.user.id, t.from_line_id);
    const toLine = getOwnedLine(req.user.id, t.to_line_id);
    if (!fromLine || !toLine) return res.status(400).json({ error: 'La línea ya no existe' });

    const readAllocs = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
    const fromTotal = readAllocs.get(req.user.id, t.disbursement_id, t.from_line_id).s;
    const toTotal = readAllocs.get(req.user.id, t.disbursement_id, t.to_line_id).s;
    const newFrom = fromTotal + t.amount;
    const newTo = toTotal - t.amount;
    if (newTo < -1e-9) {
      return res.status(400).json({ error: `No se puede deshacer: «${toLine.name}» ya no tiene ese saldo asignado.` });
    }

    const delAllocs = db.prepare('DELETE FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
    const insAlloc = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
      delAllocs.run(req.user.id, t.disbursement_id, t.from_line_id);
      if (newFrom > 0) insAlloc.run(req.user.id, t.disbursement_id, t.from_line_id, newFrom, Date.now());
      delAllocs.run(req.user.id, t.disbursement_id, t.to_line_id);
      if (newTo > 0) insAlloc.run(req.user.id, t.disbursement_id, t.to_line_id, newTo, Date.now());
      db.prepare('DELETE FROM allocation_transfers WHERE id = ? AND user_id = ?').run(t.id, req.user.id);
    })();
    res.json({ ok: true, reverted: t.amount });
  });

  appExpress.post('/api/executions', requireAuth, (req, res) => {
    const { line_id, date, amount, note, disbursement_id } = req.body || {};
    const line = getOwnedLine(req.user.id, line_id);
    if (!line) return res.status(400).json({ error: 'La línea no existe' });
    const amt = parseAmount(amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    const d = String(date || '').trim();
    if (!d) return res.status(400).json({ error: 'La fecha es obligatoria' });
    let disbId = null;
    if (disbursement_id != null && disbursement_id !== '') {
      const disb = getOwnedDisbursement(req.user.id, disbursement_id);
      if (!disb) return res.status(400).json({ error: 'El desembolso no existe' });
      disbId = disb.id;
    }
    const info = db.prepare('INSERT INTO executions (line_id, disbursement_id, date, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(line_id, disbId, d, amt, String(note || '').trim() || null, Date.now());
    res.json({ id: info.lastInsertRowid });
  });

  appExpress.delete('/api/executions/:id', requireAuth, (req, res) => {
    if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const info = db.prepare(`
      DELETE FROM executions WHERE id = ?
      AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
    `).run(req.params.id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'Movimiento no encontrado' });
    res.json({ ok: true });
  });

  appExpress.post('/api/adjustments', requireAuth, (req, res) => {
    const { line_id, date, amount, note, dest_line_id } = req.body || {};
    const line = getOwnedLine(req.user.id, line_id);
    if (!line) return res.status(400).json({ error: 'La línea no existe' });
    const amt = parseAmount(amount);
    if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
    const d = String(date || '').trim();
    if (!d) return res.status(400).json({ error: 'El ajuste requiere una fecha obligatoria' });
    const baseNote = String(note || '').trim() || null;

    let dest = null;
    if (dest_line_id != null && dest_line_id !== '') {
      dest = getOwnedLine(req.user.id, dest_line_id);
      if (!dest) return res.status(400).json({ error: 'La línea destino no existe' });
      if (Number(dest.id) === Number(line.id)) {
        return res.status(400).json({ error: 'Elige dos líneas distintas para la transferencia' });
      }
    }

    const insSingle = db.prepare('INSERT INTO adjustments (line_id, date, amount, note, link_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)');
    const insLinked = db.prepare('INSERT INTO adjustments (line_id, date, amount, note, link_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const info = db.transaction(() => {
      if (!dest) return insSingle.run(line.id, d, amt, baseNote, Date.now());
      const link = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      const srcName = line.code || line.name;
      const destNote = (baseNote ? baseNote + ' → ' : '') + 'Transferido desde ' + srcName;
      insLinked.run(line.id, d, amt, baseNote, link, Date.now());
      return insLinked.run(dest.id, d, -amt, destNote, link, Date.now());
    })();
    res.json({ id: info.lastInsertRowid, linked: !!dest });
  });

  appExpress.delete('/api/adjustments/:id', requireAuth, (req, res) => {
    if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const adj = db.prepare(`
      SELECT a.id, a.link_id FROM adjustments a
      JOIN lines l ON l.id = a.line_id
      WHERE a.id = ? AND l.user_id = ?
    `).get(req.params.id, req.user.id);
    if (!adj) return res.status(404).json({ error: 'Movimiento no encontrado' });
    let changes;
    if (adj.link_id != null) {
      changes = db.prepare(`
        DELETE FROM adjustments WHERE link_id = ?
        AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
      `).run(adj.link_id, req.user.id).changes;
    } else {
      changes = db.prepare(`
        DELETE FROM adjustments WHERE id = ?
        AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
      `).run(adj.id, req.user.id).changes;
    }
    res.json({ ok: true, deleted: changes });
  });

  // Catch-all para SPA
  appExpress.get('*', (req, res) => res.sendFile(path.join(getPublicPath(), 'index.html')));

  return appExpress;
}

// ===== ELECTRON MAIN =====
async function startServer() {
  const net = require('net');
  await new Promise((resolve) => {
    const testServer = net.createServer();
    testServer.listen(0, () => {
      serverPort = testServer.address().port;
      testServer.close(resolve);
    });
  });

  expressApp = setupExpressServer();
  
  return new Promise((resolve, reject) => {
    httpServer = expressApp.listen(serverPort, '127.0.0.1', () => {
      console.log(`Budget dashboard en http://localhost:${serverPort}`);
      setTimeout(resolve, 300);
    });
    httpServer.on('error', reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Dashboard de Presupuesto',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  const loadApp = async () => {
    try {
      await startServer();
      const url = `http://localhost:${serverPort}`;
      console.log('Loading:', url);
      await mainWindow.loadURL(url);
      mainWindow.show();
      mainWindow.focus();
    } catch (err) {
      console.error('Failed to load app:', err);
      dialog.showErrorBox('Error al iniciar', `No se pudo iniciar la aplicación:\n${err.message}`);
      app.quit();
    }
  };

  loadApp();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${serverPort}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  // Descargas: preguntar siempre dónde guardar (evita descargas silenciosas o canceladas)
  session.defaultSession.on('will-download', async (event, item, webContents) => {
    if (item.getSavePath()) return;
    const win = webContents ? BrowserWindow.fromWebContents(webContents) : mainWindow;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Guardar archivo',
      defaultPath: path.join(app.getPath('documents'), item.getFilename()),
    });
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (httpServer) httpServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (httpServer) httpServer.close();
});

// IPC
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-data-path', () => getDataDir());
ipcMain.handle('app:open-data-folder', async () => {
  shell.openPath(getDataDir());
});
ipcMain.handle('app:restart-server', async () => {
  if (httpServer) httpServer.close();
  await startServer();
  return { port: serverPort };
});

// Guardar un archivo binario (ej. exportación a Excel) con diálogo «Guardar como»
ipcMain.handle('file:save-binary', async (event, payload) => {
  const { defaultName, data, filters } = payload || {};
  try {
    if (!data) return { saved: false, error: 'No hay datos para guardar' };
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showSaveDialog(win, {
      title: 'Guardar archivo',
      defaultPath: path.join(app.getPath('documents'), String(defaultName || 'archivo.bin')),
      filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'Todos los archivos', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, Buffer.from(data));
    return { saved: true, filePath: result.filePath };
  } catch (err) {
    return { saved: false, error: err.message };
  }
});