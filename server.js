const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

const app    = express();
const DB_FILE = path.join(__dirname, 'bookings.json');

/* ── Simple JSON store ─────────────────────────────── */
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}
function writeDB(rows) {
  fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2), 'utf8');
}

/* ── Middleware ────────────────────────────────────── */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── GET /api/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD ─ */
app.get('/api/bookings', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  const rows = readDB().filter(b => b.date >= from && b.date <= to);
  res.json(rows);
});

/* ── POST /api/bookings ────────────────────────────── */
app.post('/api/bookings', (req, res) => {
  const { court, date, startSlot, endSlot, userName, phone } = req.body;

  if (!court || !date || startSlot == null || endSlot == null || !userName)
    return res.status(400).json({ error: 'שדות חסרים' });

  if (!['west', 'east'].includes(court))
    return res.status(400).json({ error: 'מגרש לא חוקי' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'תאריך לא חוקי' });

  const duration = endSlot - startSlot;
  if (duration < 1 || duration > 8)
    return res.status(400).json({ error: 'ניתן להזמין בין 15 דקות לשעתיים' });

  if (endSlot > 68)
    return res.status(400).json({ error: 'שעה מאוחרת מדי' });

  // שיעורי טניס קבועים — שני וחמישי 15:30–22:00 (slots 34–60)
  const LESSON_DAYS  = [1, 4];
  const LESSON_START = 34;
  const LESSON_END   = 60;
  const [y,m,d] = date.split('-').map(Number);
  const dow = new Date(y,m-1,d).getDay();
  if (LESSON_DAYS.includes(dow) && startSlot < LESSON_END && endSlot > LESSON_START)
    return res.status(400).json({ error: 'שעות אלו שמורות לשיעורי טניס' });

  const rows = readDB();
  const conflict = rows.some(b =>
    b.court === court && b.date === date &&
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
    created_at: new Date().toISOString(),
  };
  rows.push(booking);
  writeDB(rows);
  res.status(201).json(booking);
});

/* ── DELETE /api/bookings/:id ─────────────────────── */
app.delete('/api/bookings/:id', (req, res) => {
  const rows = readDB();
  const idx  = rows.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  rows.splice(idx, 1);
  writeDB(rows);
  res.json({ success: true });
});

/* ── Start ────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎾  שרת פועל בכתובת http://localhost:${PORT}`);
});
