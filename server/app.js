const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cookieParser = require('cookie-parser');
const cors = require('cors');
const multer = require('multer');

const db = require('./db');
const routes = require('./routes');
const { tenantMiddleware } = require('./tenant');

const app = express();

// Vercel terminates TLS and forwards X-Forwarded-Proto; without this, cookie.secure below
// would never evaluate true behind the proxy.
app.set('trust proxy', 1);

// wait for schema to be ready before handling any request — cheap once warm, since
// db.ready resolves once and every request after that awaits an already-resolved promise
app.use((req, res, next) => { db.ready.then(() => next(), next); });

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({extended:true}));
app.use(cookieParser());
app.use(session({
  store: new pgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000*60*60*24,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  }
}));

app.use(cors());

// resolves which family (Postgres schema) this request belongs to from a `/f/<slug>/...` URL
// prefix, stripping that prefix so the routes/static-file handling below needs no changes —
// see server/tenant.js
app.use(tenantMiddleware);

// API routes
app.use('/api', routes);

// The platform's own marketing page lives at the bare root — but a request to a specific
// family's own root (e.g. /f/najambeta/, which tenantMiddleware already rewrote down to
// req.url === '/' by this point) must still reach that family's login page below, not this.
// req.familyFromPrefix (set by tenantMiddleware) is what tells the two apart, since by now
// req.url alone can't.
app.get('/', (req, res, next) => {
  if (req.familyFromPrefix) return next();
  res.sendFile(path.join(__dirname, '../public/welcome.html'));
});

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// clean JSON error responses for multer errors (e.g. file too large) and anything an
// async route handler's `wrap()` forwards via next(err) — without this, Express's default
// HTML error page would leak through instead of a response the frontend can parse
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 4MB).' : err.message;
    return res.status(413).json({ error: message });
  }
  console.error('[unhandled route error]', err && err.stack || err);
  res.status(500).json({ error: (err && err.message) || 'Internal server error' });
});

module.exports = app;
