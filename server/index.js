const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const fs = require('fs');

const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({limit: '5mb'}));
app.use(express.urlencoded({extended:true}));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24 }
}));

app.use(cors());

// Serve uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, {recursive:true});
app.use('/uploads', express.static(uploadsDir));

// API routes
app.use('/api', routes);

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
