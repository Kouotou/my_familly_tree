# Family Tree App — MVP

This repository contains an initial MVP for the Family Census & Family Tree app.

Vision

This project aims to provide a small, privacy-friendly family census and interactive family tree for a close-knit family. People can register with their full date of birth and photo; registrations become pending requests that an administrator reviews. Approved profiles appear in a browsable SVG family tree showing photos, names and relationships. Administrators can edit, approve, reject, modify approved profiles, or delete accounts (deletions are recorded for audit). The UI supports English and French and a light/dark theme persisted per user via localStorage.


Quick start (Windows):

1. Install dependencies:

```powershell
npm install
```

2. Seed the database (creates a demo admin):

```powershell
npm run init-db
```

3. Start the server:

```powershell
npm run dev
```

4. Open http://localhost:3000 in your browser.

Default seeded admin: username `admin` password `changeme` (see `.env.example`). Change in environment before running `npm run init-db`.

What this initial scaffold includes:
- Express + SQLite (better-sqlite3)
- Simple name+birthyear login flow and admin username/password login
- Pending request create and admin approve endpoint
- Static frontend (landing, simple member view, admin request viewer)

Next steps (I'll implement on request):
- Full profile CRUD UI and self-registration flow
- Relationship forms with parent-alignment logic and birth order
- Interactive zoomable/pannable tree visualization
- PDF/JPEG export, CSV export, archive admin
- Bilingual French/English strings and theme toggle persistence
