const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

const app    = express();
const ADMINS   = ['0506391216', '0507700623'];
const DATA_DIR = process.env.FLY_APP_NAME ? '/app/data' : __dirname;
const DB_FILE     = path.join(DATA_DIR, 'bookings.json');
const RECUR_FILE  = path.join(DATA_DIR, 'recurring.json');
const SH = 7; // start hour of the schedule grid — must match the frontend

/* ── Simple JSON store ─────────────────────────────── */
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}
function writeDB(rows) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/* ── Recurring-rule JSON store ─────────────────────── */
function readRecurring() {
  try { return JSON.parse(fs.readFileSync(RECUR_FILE, 'utf8')); }
  catch { return null; } // null = file missing (first run), distinct from an empty list
}
function writeRecurring(rules) {
  const tmp = RECUR_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2), 'utf8');
  fs.renameSync(tmp, RECUR_FILE);
}

/* ── Materialize upcoming bookings for every recurring rule (next 12 weeks) ── */
function seedRecurring() {
  let rules = readRecurring();

  if (rules === null) {
    // First run on this data store: migrate the old hardcoded Mon/Thu tennis
    // lesson into a real recurring rule, and tag existing lesson rows so
    // they aren't duplicated below.
    const defaultRule = {
      id: uuidv4(), name: 'שיעורי טניס', courts: ['west', 'east'], days: [1, 4],
      startSlot: 34, endSlot: 60, fromDate: null, toDate: null,
      created_at: new Date().toISOString(),
    };
    rules = [defaultRule];
    writeRecurring(rules);

    const rows = readDB();
    let migrated = false;
    for (const b of rows) {
      if (b.is_lesson && !b.recurring_id) { b.recurring_id = defaultRule.id; migrated = true; }
    }
    if (migrated) writeDB(rows);
  }

  if (!rules.length) return;

  const rows  = readDB();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let added = false;

  for (const rule of rules) {
    for (let i = 0; i < 84; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dow = d.getDay();
      if (!rule.days.includes(dow)) continue;

      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (rule.fromDate && dateStr < rule.fromDate) continue;
      if (rule.toDate   && dateStr > rule.toDate)   continue;

      for (const court of rule.courts) {
        const exists = rows.some(b => b.recurring_id === rule.id && b.date === dateStr && b.court === court);
        if (!exists) {
          rows.push({
            id: uuidv4(),
            court,
            date: dateStr,
            start_slot: rule.startSlot,
            end_slot: rule.endSlot,
            user_name: rule.name,
            phone: '',
            is_lesson: true,
            recurring_id: rule.id,
            created_at: new Date().toISOString(),
          });
          added = true;
        }
      }
    }
  }
  if (added) writeDB(rows);
}

/* ── Middleware ────────────────────────────────────── */
app.use(express.json());
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

/* ── GET /api/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD ─ */
app.get('/api/bookings', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  const rows = readDB().filter(b => !b.deleted && b.date >= from && b.date <= to);
  res.json(rows);
});

/* ── POST /api/bookings ────────────────────────────── */
app.post('/api/bookings', (req, res) => {
  const { court, date, startSlot, endSlot, userName, phone, isLesson, note } = req.body;

  if (!court || !date || startSlot == null || endSlot == null || !userName)
    return res.status(400).json({ error: 'שדות חסרים' });

  if (!['west', 'east'].includes(court))
    return res.status(400).json({ error: 'מגרש לא חוקי' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'תאריך לא חוקי' });

  if (endSlot > 68)
    return res.status(400).json({ error: 'שעה מאוחרת מדי' });

  const isAdminReq  = ADMINS.includes(phone);
  const lessonFlag  = isAdminReq && !!isLesson; // only an admin phone may mark a booking as a lesson

  const duration = endSlot - startSlot;
  // Regular users: max 2 hours. Admins and lesson bookings: unlimited.
  if (!isAdminReq && !lessonFlag && (duration < 1 || duration > 8))
    return res.status(400).json({ error: 'ניתן להזמין בין 15 דקות לשעתיים' });
  if (duration < 1)
    return res.status(400).json({ error: 'משך הזמן אינו תקין' });

  const rows = readDB();
  const conflict = rows.some(b =>
    !b.deleted && b.court === court && b.date === date &&
    b.start_slot < endSlot && b.end_slot > startSlot
  );
  if (conflict)
    return res.status(409).json({ error: 'השעות המבוקשות כבר תפוסות' });

  const booking = {
    id: uuidv4(),
    court,
    date,
    start_slot: startSlot,
    end_slot: endSlot,
    user_name: userName,
    phone: phone || '',
    ...(lessonFlag ? { is_lesson: true } : {}),
    ...(note ? { note } : {}),
    created_at: new Date().toISOString(),
  };
  rows.push(booking);
  writeDB(rows);
  res.status(201).json(booking);
});

/* ── PUT /api/bookings/:id ────────────────────────── */
app.put('/api/bookings/:id', (req, res) => {
  const { startSlot, endSlot, phone, userName, bookPhone, note } = req.body;

  const rows = readDB();
  const idx  = rows.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

  const bk = rows[idx];
  if (bk.phone !== phone && !ADMINS.includes(phone))
    return res.status(403).json({ error: 'אין הרשאה לערוך הזמנה זו' });

  const newStart = startSlot ?? bk.start_slot;
  const newEnd   = endSlot   ?? bk.end_slot;

  if (startSlot != null) {
    if (newEnd > 68) return res.status(400).json({ error: 'שעה מאוחרת מדי' });

    const duration = newEnd - newStart;
    if (!ADMINS.includes(phone) && !bk.is_lesson && (duration < 1 || duration > 8))
      return res.status(400).json({ error: 'ניתן להזמין בין 15 דקות לשעתיים' });
    if (duration < 1) return res.status(400).json({ error: 'משך הזמן אינו תקין' });

    const conflict = rows.some((b, i) =>
      i !== idx && !b.deleted && b.court === bk.court && b.date === bk.date &&
      b.start_slot < newEnd && b.end_slot > newStart
    );
    if (conflict)
      return res.status(409).json({ error: 'השעות המבוקשות כבר תפוסות' });
  }

  rows[idx] = { ...bk, start_slot: newStart, end_slot: newEnd,
    ...(userName  ? { user_name: userName } : {}),
    ...(bookPhone != null && ADMINS.includes(phone) ? { phone: bookPhone } : {}),
    ...(note != null && ADMINS.includes(phone) ? { note: note || undefined } : {}) };
  writeDB(rows);
  res.json(rows[idx]);
});

/* ── GET /api/recurring ───────────────────────────── */
app.get('/api/recurring', (req, res) => {
  res.json(readRecurring() || []);
});

/* ── POST /api/recurring ──────────────────────────── */
app.post('/api/recurring', (req, res) => {
  const { phone, name, courts, days, startSlot, endSlot, fromDate, toDate } = req.body;

  if (!ADMINS.includes(phone))
    return res.status(403).json({ error: 'רק מנהל יכול להוסיף הזמנה קבועה' });

  if (!name || !Array.isArray(courts) || !courts.length || !Array.isArray(days) || !days.length ||
      startSlot == null || endSlot == null || !fromDate)
    return res.status(400).json({ error: 'שדות חסרים' });

  if (!courts.every(c => ['west', 'east'].includes(c)))
    return res.status(400).json({ error: 'מגרש לא חוקי' });

  if (!days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))
    return res.status(400).json({ error: 'יום לא חוקי' });

  if (endSlot <= startSlot || endSlot > 68 || startSlot < 0)
    return res.status(400).json({ error: 'טווח שעות לא תקין' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)))
    return res.status(400).json({ error: 'תאריך לא חוקי' });

  const rules = readRecurring() || [];
  const rule = {
    id: uuidv4(), name, courts, days, startSlot, endSlot,
    fromDate, toDate: toDate || null,
    created_at: new Date().toISOString(),
  };
  rules.push(rule);
  writeRecurring(rules);
  seedRecurring(); // materialize the first occurrences immediately
  res.status(201).json(rule);
});

/* ── DELETE /api/recurring/:id ─────────────────────── */
app.delete('/api/recurring/:id', (req, res) => {
  const { phone } = req.body || {};
  if (!ADMINS.includes(phone))
    return res.status(403).json({ error: 'רק מנהל יכול למחוק הזמנה קבועה' });

  const rules = readRecurring() || [];
  const idx   = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'לא נמצא' });
  rules.splice(idx, 1);
  writeRecurring(rules);

  // Soft-delete not-yet-started instances so they stop showing up
  const rows = readDB();
  const now  = new Date();
  let changed = false;
  for (const b of rows) {
    if (b.recurring_id === req.params.id && !b.deleted) {
      const [y, m, d] = b.date.split('-').map(Number);
      const slotTime = new Date(y, m - 1, d);
      slotTime.setMinutes(SH * 60 + b.start_slot * 15);
      if (slotTime > now) { b.deleted = true; changed = true; }
    }
  }
  if (changed) writeDB(rows);
  res.json({ success: true });
});

/* ── DELETE /api/bookings/:id ─────────────────────── */
app.delete('/api/bookings/:id', (req, res) => {
  const { phone } = req.body || {};
  const rows = readDB();
  const idx  = rows.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  const bk = rows[idx];
  if (bk.phone !== phone && !ADMINS.includes(phone))
    return res.status(403).json({ error: 'אין הרשאה למחוק הזמנה זו' });

  if (bk.is_lesson) {
    // Soft-delete lessons so the seed won't recreate them
    rows[idx] = { ...bk, deleted: true };
  } else {
    rows.splice(idx, 1);
  }
  writeDB(rows);
  res.json({ success: true });
});

/* ── Start ────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎾  שרת פועל בכתובת http://localhost:${PORT}`);
  seedRecurring();
  setInterval(seedRecurring, 6 * 60 * 60 * 1000); // keep the rolling 12-week window filled
});
