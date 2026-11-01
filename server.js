'use strict';
// Avto maktab ilovasi: server (Node 22.13+, tashqi kutubxonalarsiz)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const EXAM = {
  count: Number(process.env.EXAM_QUESTIONS || 20),
  minutes: Number(process.env.EXAM_MINUTES || 25),
  maxErrors: Number(process.env.EXAM_MAX_ERRORS || 2),
};
const WEAK_PCT = 70; // shundan past bo'lsa mavzu "chala"
const WEAK_MIN_ANSWERS = 3;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'avtomaktab.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0, start_date TEXT, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK(role IN('teacher','student')), name TEXT NOT NULL, login TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL, pass_hash TEXT NOT NULL, group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL, phone TEXT, must_change INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attendance(student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(student_id,date));
CREATE TABLE IF NOT EXISTS grades(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, kind TEXT NOT NULL, score INTEGER NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, topic TEXT NOT NULL, data TEXT NOT NULL, source TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, mode TEXT NOT NULL, topic TEXT, started INTEGER NOT NULL,
  finished INTEGER, qids TEXT NOT NULL, perms TEXT NOT NULL, total INTEGER, correct INTEGER, passed INTEGER, late INTEGER);
CREATE TABLE IF NOT EXISTS answers(attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, topic TEXT NOT NULL, ok INTEGER NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_answers_student ON answers(student_id, topic);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? { ...r } : undefined; };
const run = (sql, ...p) => db.prepare(sql).run(...p);
const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);

// ---------- parollar va sessiyalar ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function checkPw(pw, u) {
  const h = crypto.scryptSync(String(pw), u.salt, 64);
  const s = Buffer.from(u.pass_hash, 'hex');
  return s.length === h.length && crypto.timingSafeEqual(h, s);
}
function createUser({ role, name, login, password, group_id = null, phone = null, must_change = 0 }) {
  const { salt, hash } = hashPw(password);
  const r = run('INSERT INTO users(role,name,login,salt,pass_hash,group_id,phone,must_change,created) VALUES(?,?,?,?,?,?,?,?,?)',
    role, name, login, salt, hash, group_id, phone, must_change, nowIso());
  return Number(r.lastInsertRowid);
}
function randomPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 7; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}
function slugLogin(name) {
  const map = { 'ў': 'o', 'ғ': 'g', 'қ': 'q', 'ҳ': 'h', 'ш': 'sh', 'ч': 'ch', 'ё': 'yo', 'ю': 'yu', 'я': 'ya', 'й': 'y', 'х': 'x', 'ж': 'j', 'ц': 's', 'э': 'e' };
  const ru = 'абвгдезиклмнопрстуф';
  const lat = 'abvgdezi klmnoprstuf'.replace(' ', '');
  let base = String(name).toLowerCase().trim().split(/\s+/)[0] || 'oquvchi';
  base = [...base].map((c) => map[c] || (ru.includes(c) ? lat[ru.indexOf(c)] : c)).join('');
  base = base.replace(/[^a-z0-9]/g, '') || 'oquvchi';
  for (let i = 0; i < 50; i++) {
    const login = base + crypto.randomInt(100, 1000);
    if (!one('SELECT 1 x FROM users WHERE login=?', login)) return login;
  }
  return base + Date.now();
}
const failed = new Map(); // login+ip -> {n, until}
function tooMany(key) { const f = failed.get(key); return f && f.n >= 6 && Date.now() < f.until; }
function noteFail(key) { const f = failed.get(key) || { n: 0, until: 0 }; f.n += 1; f.until = Date.now() + 10 * 60 * 1000; failed.set(key, f); }

if (!one('SELECT 1 x FROM users WHERE role=\'teacher\'')) {
  const login = process.env.TEACHER_LOGIN || 'ustoz';
  const pw = process.env.TEACHER_PASSWORD || 'ustoz123';
  createUser({ role: 'teacher', name: "O'qituvchi", login, password: pw, must_change: 1 });
  console.log(`Birinchi o'qituvchi hisobi yaratildi. Login: ${login}  Parol: ${pw}  (kirgach parolni almashtiring)`);
}

// ---------- savollar ----------
const LANGS = ['uz', 'ru', 'en'];
function validateQuestion(x) {
  if (!x || typeof x !== 'object') throw bad('Savol obyekt emas');
  if (typeof x.topic !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(x.topic)) throw bad('topic noto\'g\'ri (faqat kichik lotin harf, raqam, _ va -)');
  if (!x.q || typeof x.q.uz !== 'string' || !x.q.uz.trim()) throw bad('q.uz (o\'zbekcha savol matni) kerak');
  if (!x.options || !Array.isArray(x.options.uz) || x.options.uz.length < 2 || x.options.uz.length > 8) throw bad('options.uz kamida 2 ta javobdan iborat bo\'lishi kerak');
  const n = x.options.uz.length;
  if (!Number.isInteger(x.correct) || x.correct < 0 || x.correct >= n) throw bad('correct noto\'g\'ri');
  const q = {}; const options = {};
  for (const l of LANGS) {
    if (typeof x.q[l] === 'string' && x.q[l].trim()) q[l] = x.q[l].trim().slice(0, 1000);
    if (Array.isArray(x.options[l])) {
      if (x.options[l].length !== n) throw bad(`options.${l} soni options.uz bilan bir xil bo'lishi kerak`);
      options[l] = x.options[l].map((s) => String(s).slice(0, 400));
    }
  }
  q.uz = x.q.uz.trim().slice(0, 1000); options.uz = x.options.uz.map((s) => String(s).slice(0, 400));
  let image = null;
  if (x.image) { if (!/^https:\/\/|^\/img\//.test(String(x.image))) throw bad('image https:// bilan boshlanishi kerak'); image = String(x.image).slice(0, 500); }
  const id = typeof x.id === 'string' && /^[\w.-]{1,80}$/.test(x.id) ? x.id : 'h' + crypto.createHash('sha1').update(x.topic + '|' + q.uz).digest('hex').slice(0, 16);
  return { id, topic: x.topic, data: { q, options, correct: x.correct, image } };
}
function upsertQuestions(list, source) {
  if (!Array.isArray(list)) throw bad('Savollar ro\'yxati (massiv) kerak');
  if (list.length > 5000) throw bad('Bir vaqtda 5000 tadan ko\'p savol yuklab bo\'lmaydi');
  let added = 0, updated = 0; const errors = [];
  db.exec('BEGIN');
  try {
    list.forEach((raw, i) => {
      try {
        const v = validateQuestion(raw);
        const exists = one('SELECT 1 x FROM questions WHERE id=?', v.id);
        run('INSERT OR REPLACE INTO questions(id,topic,data,source,updated) VALUES(?,?,?,?,?)', v.id, v.topic, JSON.stringify(v.data), source, nowIso());
        exists ? updated++ : added++;
      } catch (e) { errors.push(`#${i + 1}: ${e.message}`); }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, updated, errors: errors.slice(0, 20), failed: errors.length };
}
if (!one('SELECT 1 x FROM questions LIMIT 1')) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.seed.json'), 'utf8'));
  console.log('Namuna savollar yuklandi:', JSON.stringify(upsertQuestions(seed, 'namuna')));
}
const getQ = (id) => { const r = one('SELECT * FROM questions WHERE id=?', id); return r && { id: r.id, topic: r.topic, ...JSON.parse(r.data) }; };
const allQ = (topic) => all(topic ? 'SELECT * FROM questions WHERE topic=?' : 'SELECT * FROM questions', ...(topic ? [topic] : []))
  .map((r) => ({ id: r.id, topic: r.topic, source: r.source, ...JSON.parse(r.data) }));

function privateHost(h) {
  return /^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|\[?f[cd])/i.test(h) || !h.includes('.');
}
async function fetchFeed(url) {
  let u; try { u = new URL(url); } catch { throw bad('Havola noto\'g\'ri'); }
  if (u.protocol !== 'https:' || privateHost(u.hostname)) throw bad('Faqat ochiq https:// havola mumkin');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) throw bad(`Havola ${res.status} xatosini qaytardi`);
    const text = await res.text();
    if (text.length > 8 * 1024 * 1024) throw bad('Fayl juda katta');
    let json; try { json = JSON.parse(text); } catch { throw bad('Havoladagi fayl JSON emas'); }
    return upsertQuestions(Array.isArray(json) ? json : json.questions, 'internet');
  } catch (e) { if (e instanceof HttpError) throw e; throw bad('Havolaga ulanib bo\'lmadi: ' + e.message); } finally { clearTimeout(t); }
}
const getSetting = (k) => one('SELECT value FROM settings WHERE key=?', k)?.value || '';
const setSetting = (k, v) => run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', k, v);
async function autoFeed() {
  const url = getSetting('feed_url'); if (!url) return;
  try { const r = await fetchFeed(url); setSetting('feed_last', nowIso() + ' ' + JSON.stringify({ added: r.added, updated: r.updated, failed: r.failed })); }
  catch (e) { setSetting('feed_last', nowIso() + ' xato: ' + e.message); }
}
setInterval(autoFeed, 24 * 3600 * 1000).unref();
setTimeout(autoFeed, 15000).unref();

// ---------- tahlil ----------
function topicStats(studentIds) {
  if (!studentIds.length) return { byStudent: {}, byTopic: {} };
  const ph = studentIds.map(() => '?').join(',');
  const rows = all(`SELECT student_id, topic, SUM(ok) ok, COUNT(*) n FROM answers WHERE student_id IN (${ph}) GROUP BY student_id, topic`, ...studentIds);
  const byStudent = {}; const byTopic = {};
  for (const r of rows) {
    (byStudent[r.student_id] ||= {})[r.topic] = { ok: r.ok, n: r.n, pct: Math.round((100 * r.ok) / r.n) };
    const t = (byTopic[r.topic] ||= { ok: 0, n: 0, weak: 0, students: 0 });
    t.ok += r.ok; t.n += r.n; t.students += 1;
    if (r.n >= WEAK_MIN_ANSWERS && (100 * r.ok) / r.n < WEAK_PCT) t.weak += 1;
  }
  for (const t of Object.values(byTopic)) t.pct = Math.round((100 * t.ok) / t.n);
  return { byStudent, byTopic };
}

// ---------- marshrutlar ----------
const routes = [];
function route(method, pattern, roles, handler) {
  routes.push({ method, roles, handler, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
}
const T = ['teacher']; const S = ['student']; const ANY = ['teacher', 'student'];
const needStr = (v, name, max = 200) => { if (typeof v !== 'string' || !v.trim()) throw bad(`${name} kerak`); return v.trim().slice(0, max); };
const needDate = (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad('Sana noto\'g\'ri (YYYY-MM-DD)'); return v; };
const needInt = (v, name, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} noto'g'ri`); return n; };
const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, login: u.login, group_id: u.group_id, must_change: !!u.must_change });
const studentOrSelf = (ctx, id) => {
  if (ctx.user.role === 'student') return ctx.user.id;
  const s = one('SELECT id FROM users WHERE id=? AND role=\'student\'', Number(id)); if (!s) throw new HttpError(404, 'O\'quvchi topilmadi'); return s.id;
};

route('POST', '/api/login', null, (c) => {
  const login = needStr(c.body.login, 'Login', 60).toLowerCase(); const key = login + '|' + c.ip;
  if (tooMany(key)) throw new HttpError(429, 'Juda ko\'p urinish. 10 daqiqadan keyin qayta urining');
  const u = one('SELECT * FROM users WHERE login=?', login);
  if (!u || !checkPw(String(c.body.password || ''), u)) { noteFail(key); throw new HttpError(401, 'Login yoki parol noto\'g\'ri'); }
  failed.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token,user_id,exp) VALUES(?,?,?)', token, u.id, Date.now() + 14 * 24 * 3600 * 1000);
  return { token, user: publicUser(u), exam: EXAM };
});
route('POST', '/api/logout', ANY, (c) => { run('DELETE FROM sessions WHERE token=?', c.token); return { ok: true }; });
route('GET', '/api/me', ANY, (c) => ({ user: publicUser(c.user), exam: EXAM }));
route('POST', '/api/password', ANY, (c) => {
  const pw = String(c.body.password || '');
  if (pw.length < 6) throw bad('Parol kamida 6 belgi bo\'lsin');
  if (!checkPw(String(c.body.old || ''), c.user)) throw bad('Eski parol noto\'g\'ri');
  const { salt, hash } = hashPw(pw);
  run('UPDATE users SET salt=?, pass_hash=?, must_change=0 WHERE id=?', salt, hash, c.user.id);
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', c.user.id, c.token);
  return { ok: true };
});

// guruhlar
route('GET', '/api/groups', T, () => all('SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id=g.id) students FROM groups g ORDER BY g.id DESC'));
route('POST', '/api/groups', T, (c) => {
  const r = run('INSERT INTO groups(name,price,start_date,created) VALUES(?,?,?,?)', needStr(c.body.name, 'Guruh nomi', 80), needInt(c.body.price || 0, 'Narx', 0, 1e10), c.body.start_date ? needDate(c.body.start_date) : null, nowIso());
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/groups/:id', T, (c) => {
  run('UPDATE groups SET name=?, price=? WHERE id=?', needStr(c.body.name, 'Guruh nomi', 80), needInt(c.body.price || 0, 'Narx', 0, 1e10), Number(c.params.id)); return { ok: true };
});
route('DELETE', '/api/groups/:id', T, (c) => { run('DELETE FROM groups WHERE id=?', Number(c.params.id)); return { ok: true }; });

// o'quvchilar
route('GET', '/api/students', T, (c) => all(`SELECT id,name,login,phone,group_id FROM users WHERE role='student' ${c.query.group ? 'AND group_id=?' : ''} ORDER BY name`, ...(c.query.group ? [Number(c.query.group)] : [])));
route('POST', '/api/students', T, (c) => {
  const name = needStr(c.body.name, 'Ism', 100); const gid = needInt(c.body.group_id, 'Guruh', 1, 1e9);
  if (!one('SELECT 1 x FROM groups WHERE id=?', gid)) throw bad('Guruh topilmadi');
  const login = slugLogin(name); const password = randomPassword();
  const id = createUser({ role: 'student', name, login, password, group_id: gid, phone: c.body.phone ? String(c.body.phone).slice(0, 30) : null });
  return { id, login, password };
});
route('POST', '/api/students/:id/reset', T, (c) => {
  const id = studentOrSelf(c, c.params.id); const password = randomPassword(); const { salt, hash } = hashPw(password);
  run('UPDATE users SET salt=?, pass_hash=? WHERE id=?', salt, hash, id); run('DELETE FROM sessions WHERE user_id=?', id);
  return { login: one('SELECT login FROM users WHERE id=?', id).login, password };
});
route('PUT', '/api/students/:id', T, (c) => {
  const id = studentOrSelf(c, c.params.id);
  run('UPDATE users SET name=?, group_id=?, phone=? WHERE id=?', needStr(c.body.name, 'Ism', 100), needInt(c.body.group_id, 'Guruh', 1, 1e9), c.body.phone ? String(c.body.phone).slice(0, 30) : null, id); return { ok: true };
});
route('DELETE', '/api/students/:id', T, (c) => { run('DELETE FROM users WHERE id=? AND role=\'student\'', Number(c.params.id)); return { ok: true }; });

// davomat
route('GET', '/api/attendance', T, (c) => {
  const date = needDate(c.query.date); const gid = needInt(c.query.group, 'Guruh', 1, 1e9);
  return all('SELECT u.id, u.name, a.status FROM users u LEFT JOIN attendance a ON a.student_id=u.id AND a.date=? WHERE u.role=\'student\' AND u.group_id=? ORDER BY u.name', date, gid);
});
route('POST', '/api/attendance', T, (c) => {
  const date = needDate(c.body.date);
  if (!Array.isArray(c.body.records)) throw bad('records kerak');
  for (const r of c.body.records) {
    if (!['present', 'absent', 'late', 'excused'].includes(r.status)) continue;
    const sid = Number(r.student_id); if (!one('SELECT 1 x FROM users WHERE id=? AND role=\'student\'', sid)) continue;
    run('INSERT OR REPLACE INTO attendance(student_id,date,status) VALUES(?,?,?)', sid, date, r.status);
  }
  return { ok: true };
});
route('GET', '/api/attendance/summary', ANY, (c) => {
  const where = c.user.role === 'student' ? 'u.id=?' : 'u.group_id=?'; const arg = c.user.role === 'student' ? c.user.id : needInt(c.query.group, 'Guruh', 1, 1e9);
  return all(`SELECT u.id, u.name,
    SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present, SUM(CASE WHEN a.status='late' THEN 1 ELSE 0 END) late,
    SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) absent, SUM(CASE WHEN a.status='excused' THEN 1 ELSE 0 END) excused, COUNT(a.status) total
    FROM users u LEFT JOIN attendance a ON a.student_id=u.id WHERE u.role='student' AND ${where} GROUP BY u.id ORDER BY u.name`, arg);
});

// baholar
route('GET', '/api/grades', ANY, (c) => {
  if (c.user.role === 'student') return all('SELECT * FROM grades WHERE student_id=? ORDER BY date DESC, id DESC', c.user.id);
  if (c.query.student) return all('SELECT * FROM grades WHERE student_id=? ORDER BY date DESC, id DESC', Number(c.query.student));
  return all('SELECT g.*, u.name FROM grades g JOIN users u ON u.id=g.student_id WHERE u.group_id=? ORDER BY g.date DESC, g.id DESC LIMIT 300', needInt(c.query.group, 'Guruh', 1, 1e9));
});
route('POST', '/api/grades', T, (c) => {
  const sid = studentOrSelf(c, c.body.student_id);
  run('INSERT INTO grades(student_id,date,kind,score,note) VALUES(?,?,?,?,?)', sid, needDate(c.body.date || today()), needStr(c.body.kind, 'Tur', 30), needInt(c.body.score, 'Baho', 1, 5), c.body.note ? String(c.body.note).slice(0, 300) : null);
  return { ok: true };
});
route('DELETE', '/api/grades/:id', T, (c) => { run('DELETE FROM grades WHERE id=?', Number(c.params.id)); return { ok: true }; });

// to'lovlar (faqat o'qituvchi)
route('GET', '/api/payments/summary', T, (c) => {
  const gid = needInt(c.query.group, 'Guruh', 1, 1e9); const g = one('SELECT * FROM groups WHERE id=?', gid); if (!g) throw new HttpError(404, 'Guruh topilmadi');
  const rows = all('SELECT u.id, u.name, u.phone, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.student_id=u.id),0) paid FROM users u WHERE u.role=\'student\' AND u.group_id=? ORDER BY u.name', gid);
  return { price: g.price, students: rows.map((r) => ({ ...r, debt: Math.max(0, g.price - r.paid) })) };
});
route('GET', '/api/payments', T, (c) => all('SELECT * FROM payments WHERE student_id=? ORDER BY date DESC, id DESC', needInt(c.query.student, 'O\'quvchi', 1, 1e9)));
route('POST', '/api/payments', T, (c) => {
  const sid = studentOrSelf(c, c.body.student_id);
  run('INSERT INTO payments(student_id,date,amount,note) VALUES(?,?,?,?)', sid, needDate(c.body.date || today()), needInt(c.body.amount, 'Summa', 1, 1e10), c.body.note ? String(c.body.note).slice(0, 200) : null);
  return { ok: true };
});
route('DELETE', '/api/payments/:id', T, (c) => { run('DELETE FROM payments WHERE id=?', Number(c.params.id)); return { ok: true }; });

// tahlil
route('GET', '/api/analytics/group', T, (c) => {
  const gid = needInt(c.query.group, 'Guruh', 1, 1e9);
  const students = all('SELECT id,name FROM users WHERE role=\'student\' AND group_id=? ORDER BY name', gid);
  const st = topicStats(students.map((s) => s.id));
  return { students, byStudent: st.byStudent, byTopic: st.byTopic, weakPct: WEAK_PCT, minAnswers: WEAK_MIN_ANSWERS };
});
route('GET', '/api/analytics/student', ANY, (c) => {
  const id = studentOrSelf(c, c.query.student);
  const st = topicStats([id]);
  const attempts = all('SELECT id,mode,topic,started,total,correct,passed,late FROM attempts WHERE student_id=? AND finished IS NOT NULL ORDER BY id DESC LIMIT 20', id);
  return { topics: st.byStudent[id] || {}, attempts, weakPct: WEAK_PCT, minAnswers: WEAK_MIN_ANSWERS };
});

// savollar
route('GET', '/api/topics', ANY, () => all('SELECT topic, COUNT(*) n FROM questions GROUP BY topic ORDER BY topic'));
route('GET', '/api/samples', ANY, (c) => allQ(c.query.topic || null));
route('POST', '/api/questions/import', T, (c) => upsertQuestions(c.body.questions, 'import'));
route('POST', '/api/questions/feed', T, async (c) => {
  const url = needStr(c.body.url, 'Havola', 500); const r = await fetchFeed(url); setSetting('feed_url', url); setSetting('feed_last', nowIso() + ' ' + JSON.stringify({ added: r.added, updated: r.updated, failed: r.failed })); return r;
});
route('GET', '/api/questions/feed', T, () => ({ url: getSetting('feed_url'), last: getSetting('feed_last') }));
route('DELETE', '/api/questions/feed', T, () => { setSetting('feed_url', ''); return { ok: true }; });
route('DELETE', '/api/questions/:id', T, (c) => { run('DELETE FROM questions WHERE id=?', c.params.id); return { ok: true }; });

// test va imtihon
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
route('POST', '/api/test/start', S, (c) => {
  const mode = c.body.mode === 'exam' ? 'exam' : 'topic';
  let pool;
  if (mode === 'exam') pool = allQ(null); else pool = allQ(needStr(c.body.topic, 'Mavzu', 40));
  const want = mode === 'exam' ? EXAM.count : needInt(c.body.count || 10, 'Soni', 1, 50);
  if (pool.length === 0) throw bad('Bu mavzuda savol yo\'q');
  const picked = shuffle(pool).slice(0, want);
  const perms = {}; const questions = picked.map((q) => {
    const perm = shuffle(q.options.uz.map((_, i) => i)); perms[q.id] = perm;
    const options = {}; for (const l of Object.keys(q.options)) options[l] = perm.map((i) => q.options[l][i]);
    return { id: q.id, topic: q.topic, image: q.image, q: q.q, options };
  });
  const r = run('INSERT INTO attempts(student_id,mode,topic,started,qids,perms) VALUES(?,?,?,?,?,?)', c.user.id, mode, mode === 'topic' ? picked[0].topic : null, Date.now(), JSON.stringify(picked.map((q) => q.id)), JSON.stringify(perms));
  return { attempt_id: Number(r.lastInsertRowid), mode, limit_seconds: mode === 'exam' ? EXAM.minutes * 60 : 0, max_errors: EXAM.maxErrors, questions };
});
route('POST', '/api/test/submit', S, (c) => {
  const at = one('SELECT * FROM attempts WHERE id=? AND student_id=?', Number(c.body.attempt_id), c.user.id);
  if (!at) throw new HttpError(404, 'Urinish topilmadi'); if (at.finished) throw bad('Bu test allaqachon topshirilgan');
  const qids = JSON.parse(at.qids); const perms = JSON.parse(at.perms); const given = c.body.answers && typeof c.body.answers === 'object' ? c.body.answers : {};
  const elapsed = Date.now() - at.started; const late = at.mode === 'exam' && elapsed > (EXAM.minutes * 60 + 60) * 1000 ? 1 : 0;
  let correct = 0; const details = []; const ts = Date.now();
  db.exec('BEGIN');
  try {
    for (const id of qids) {
      const q = getQ(id); if (!q) continue;
      const perm = perms[id]; const rightShown = perm.indexOf(q.correct);
      const chosen = Number.isInteger(given[id]) ? given[id] : -1;
      const ok = chosen === rightShown ? 1 : 0; correct += ok;
      run('INSERT INTO answers(attempt_id,student_id,question_id,topic,ok,ts) VALUES(?,?,?,?,?,?)', at.id, c.user.id, id, q.topic, ok, ts);
      details.push({ id, topic: q.topic, chosen, correct: rightShown, ok: !!ok });
    }
    const total = qids.length; const errors = total - correct;
    const passed = at.mode === 'exam' ? (errors <= EXAM.maxErrors && !late ? 1 : 0) : null;
    run('UPDATE attempts SET finished=?, total=?, correct=?, passed=?, late=? WHERE id=?', ts, total, correct, passed, late, at.id);
    db.exec('COMMIT');
    return { total, correct, errors, passed: passed === null ? null : !!passed, late: !!late, details };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { ...SEC, 'content-length': buf.length, ...headers }); res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > 6 * 1024 * 1024) { reject(new HttpError(413, 'So\'rov juda katta')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('JSON noto\'g\'ri')); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) {
      const route_ = routes.find((r) => r.method === req.method && r.re.test(p));
      if (!route_) throw new HttpError(404, 'Topilmadi');
      const ctx = { params: route_.re.exec(p).groups || {}, query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress, body: {} };
      if (route_.roles) {
        const m = /^Bearer (\w{64})$/.exec(req.headers.authorization || '');
        const s = m && one('SELECT s.token, s.exp, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', m[1]);
        if (!s || s.exp < Date.now()) throw new HttpError(401, 'Qayta kiring');
        if (!route_.roles.includes(s.role)) throw new HttpError(403, 'Ruxsat yo\'q');
        ctx.user = s; ctx.token = s.token;
      }
      if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await readBody(req);
      const out = await route_.handler(ctx);
      return send(res, 200, out, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    }
    let file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    send(res, 200, fs.readFileSync(file), { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  } catch (e) {
    const status = e.status || 500; if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Server xatosi' : e.message }, { 'content-type': 'application/json; charset=utf-8' });
  }
});
setInterval(() => run('DELETE FROM sessions WHERE exp<?', Date.now()), 3600 * 1000).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`Avto maktab ilovasi ishga tushdi: http://localhost:${PORT}`));
