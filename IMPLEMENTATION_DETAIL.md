# Family Census & Interactive Family Tree App — Implementation Detail

## 1) Project objective

This project is a family census and interactive family tree app for a family group. The main goal is to build a secure, private, and manageable digital family archive where family members can:

- create a profile
- log in using their full name + date of birth
- access a family tree structured around approved family members
- view their relatives and relationships visually
- register and wait for admin approval
- have an administrator review and manage all pending registrations

The product is meant to feel like a family directory + interactive genealogical tree, but in a lightweight version intended for a close family network rather than a huge public genealogy platform.

The app is designed to support:

- public landing page
- member profile login
- self-registration with photo upload
- admin approval workflow
- admin editing of accepted profiles
- family relationship mapping
- SVG family tree view
- bilingual interface (FR/EN)
- light/dark theme toggle
- SQLite persistence
- local file uploads for profile photos

---

## 2) Requirements and business goals captured from the earlier conversation

### General objective

Build a usable family tree application for the family with the following features:

- Users arrive on a landing page and can log in using their full name and date of birth.
- A family member can create a profile if they do not already exist.
- New registrations are not automatically approved; they become pending requests.
- An admin panel reviews pending registrations and can approve, reject, or edit them.
- Fully approved people appear in a family tree.
- Family relationships such as father, mother, spouse, child, siblings must be represented.
- The tree must display each person with a profile image and their name.
- The user should be able to click a profile for more details.
- The interface should support French and English.
- The theme should be persisted in localStorage.
- The app should be easy to run locally with Node.js and SQLite.

### Specific features agreed earlier

- Member login by full name + birth date (or birth year fallback)
- Admin username/password login
- Registration page that creates pending requests
- Each request stores username, password, full DOB, photo upload, and parent relation fields
- Admin approval queue with approve/reject/edit actions
- When an admin approves a request, it creates the approved person record and links family relationships
- Parent relationship logic: if a parent is declared from the same family, link the parent and spouse relationship accordingly
- Auto-link spouses when both parents belong to the same family
- Tree page should render an interactive SVG family graph
- The tree should support zoom/pan and focus on the current member
- Each profile node should show image and name
- Each node should have an information/action button for more details
- Bilingual UI and theme persistence
- File uploads are saved under server/uploads and served from /uploads
- Database is local SQLite stored in server/data.sqlite

---

## 3) Current implementation status

The project is already substantially implemented and has reached a good working milestone. The app has the following stated state:

### Backend implemented

- Express server in [server/index.js](server/index.js)
- SQLite database initialization in [server/db.js](server/db.js)
- API routes in [server/routes.js](server/routes.js)
- Session authentication and admin login support
- Registration request creation with photo upload
- Admin request listing by status: pending / approved / rejected
- Approve and reject flows
- Edit-approve routes for pending requests
- Person update and delete flows for approved records
- Family tree data endpoints

### Frontend implemented

- Landing page in [public/index.html](public/index.html)
- Admin page in [public/admin.html](public/admin.html)
- Tree page in [public/tree.html](public/tree.html)
- Shared logic in [public/app.js](public/app.js)
- Styling in [public/styles.css](public/styles.css)

### Functional progress already achieved

- Registration requests are created and stored as pending
- Admin can review pending requests
- Admin can approve and reject requests
- Admin can edit and approve pending profiles
- Admin can modify approved profiles and soft-delete them
- Members can log in using full name and birth date
- The full tree endpoint returns approved people
- Tree rendering works with SVG nodes and relationships
- Tree nodes are designed to include profile images and names
- Theme and language toggles are present
- Some defensive rendering and fallback logic was added to avoid crash conditions

### Important fixes already performed

The project has already gone through several bug fixes, including:

- Fixing SQLite SQL quotations and errors caused by double-quoted literals
- Preventing duplicate inserts with `INSERT OR IGNORE` logic
- Fixing username/person linking errors
- Ensuring admin flows work after edits and approvals
- Fixing family tree route ordering so `/tree/full` works correctly instead of being shadowed by `/tree/:id`
- Preventing tree rendering crash when nodes or relationships are missing
- Adding fallback behavior when `/tree/full` returns empty data
- Adapting UI to show images and profile info more clearly

---

## 4) Project structure

### Root files

- [package.json](package.json) — project metadata and scripts
- [README.md](README.md) — basic project instructions
- [.env](.env) — local env config if present
- [.env.example](.env.example) — example env configuration
- [Beige-Neutral-Simple-Family-Tree-edit-online.webp](Beige-Neutral-Simple-Family-Tree-edit-online.webp) — reference image of the family tree style the user wants to match

### Server folder

- [server/index.js](server/index.js) — server bootstrap, session config, static file serving
- [server/db.js](server/db.js) — SQLite schema initialization and DB connection
- [server/routes.js](server/routes.js) — API routes for auth, requests, users, approvals, person CRUD, and family tree data
- [server/uploads](server/uploads) — uploaded profile photos
- [server/data.sqlite](server/data.sqlite) — SQLite database

### Public folder

- [public/index.html](public/index.html) — landing page
- [public/tree.html](public/tree.html) — family tree page
- [public/admin.html](public/admin.html) — admin dashboard
- [public/admin-login.html](public/admin-login.html) — admin login page
- [public/app.js](public/app.js) — main client logic, API calls, rendering, translations, theme
- [public/styles.css](public/styles.css) — all styling
- [public/profile_icons](public/profile_icons) or root profile_icons folder — default portraits

---

## 5) Current data model

The app uses SQLite and has tables such as:

- `people` — approved family records
- `relationships` — family links like parent, child, spouse
- `users` — admin/member credentials
- `requests` — registration and approval records
- `archive` — archival entries

### Key person fields

- `id`
- `username`
- `full_name`
- `gender`
- `birth_year`
- `birth_date`
- `occupation`
- `residence`
- `phone`
- `photo_path`
- `approval_status`

### Relationship model

The app stores relationships in the `relationships` table with fields:

- `person_id`
- `relative_id`
- `type`

Typical relationship types include:

- `parent`
- `child`
- `spouse`

This is the core structure that drives the family tree graph.

---

## 6) What we have done and what remains

### Completed

- App structure exists and runs locally
- Auth flows exist
- Registration to pending requests works
- Admin request workflow is in place
- Approved profiles exist in SQLite
- Tree data is served through `/api/tree/full`
- Tree clients can render nodes and edges
- Defensive methods reduce crashes
- Several UX improvements were made

### Still not fully aligned with the target design

The app is still not yet matching the exact expected look from the reference image:

- the family tree does not yet fully reflect the final visual composition
- node spacing and hierarchy need more refinement
- some edges or node positioning may still be imperfect
- the final polish should be closer to a real family tree layout from the reference image
- profile cards need more visual refinement
- a better displayed info/menu experience should be implemented for each node
- some generated siblings/ancestor/descendant relations may need deeper validation

This is the current “almost there” stage. The data layer and app behavior are mostly working, but the visual interpretation of the family tree still needs a more deliberate design pass.

---

## 7) Next debugging and implementation steps

The following steps should be the next work stream for whoever continues this project:

### Step 1: Match the reference image more closely

- Use the uploaded reference image in the root folder as the design guide.
- Study the composition: node layout, spacing, vertical hierarchy, labeling style, colors, and tree shape.
- Build the tree layout in a way that behaves like a real ancestor/descendant view, not just a generic collection of cards.
- Tune node positions and edge routing to show a family tree, not just a formation of boxes.

### Step 2: Validate relationship correctness

- Ensure all relationships like parent-child and spouse are created correctly on approval.
- Confirm that the same family parent-child relations create usable sibling connections.
- Validate that `relationships` rows are stored consistently in both directions.
- Check duplicates and missing links.

### Step 3: Refine tree layout logic

- Improve level assignment and node placement logic for family trees.
- Ensure the root / center person stays visible and centered.
- Better distribute nodes across levels based on depth and family clusters.
- Avoid overlapping or collapsed nodes.

### Step 4: Improve details/profile UX

- Add a better info menu or icon beside every node.
- Make the profile modal clearer and more polished.
- Show a default image when `photo_path` is missing.
- Keep the modal info and actions intuitive.

### Step 5: Verify login and registration flow fully

- Check the member self-login logic with full DOB matches.
- Ensure fallback handling for birth year still works correctly.
- Verify newly approved user records are correctly linked to `users` and `people`.

### Step 6: Final polish and test passes

- Test real login flows in browser
- Test admin approval flow with real family entries
- Test tree display for multiple persons
- Test with at least one member that has a photo and one without
- Confirm all node names and photos render correctly

---

## 8) How to run this project locally

From a PowerShell terminal:

```powershell
cd C:\Users\Ahmad\familly_tree
npm install
npm run init-db
npm start
```

Then open:

```text
http://localhost:3000
```

If port 3000 is busy, stop the previous Node process first:

```powershell
taskkill /F /IM node.exe
npm start
```

---

## 9) Recommended next-agent handoff prompt

This is the prompt to paste into Claude Code or a similar agent in this project folder:

```text
You are continuing the development of a family census and interactive family tree web app in this repo.

Project context:
- Repo root: C:\Users\Ahmad\familly_tree
- Stack: Node.js + Express + SQLite + better-sqlite3 + vanilla JS frontend
- Server entry: server/index.js
- DB: server/db.js
- Routes: server/routes.js
- Frontend: public/index.html, public/tree.html, public/admin.html, public/app.js, public/styles.css
- Uploaded profile images are stored in server/uploads and served from /uploads
- DB file: server/data.sqlite

Objectives:
1. Build a family census + interactive family tree app for a family.
2. Allow member login by full name + DOB and admin login by username/password.
3. Support registration requests that become pending until admin review.
4. Admin can approve, reject, or edit pending registrations.
5. Approved profiles appear in a family tree.
6. Family relationships must be represented: parent, spouse, child, siblings.
7. Tree nodes should show profile image, full name, and an info/action control.
8. UI should support FR/EN and light/dark themes.
9. The visual style should match the provided reference image at the repo root:
   Beige-Neutral-Simple-Family-Tree-edit-online.webp

Current status:
- The app already has a working backend and a lot of frontend functionality.
- The server runs and the API returns approved people.
- The full-tree endpoint is implemented at /api/tree/full.
- We discovered an Express routing issue where /tree/full was being masked by /tree/:id and fixed it.
- The app has defensive logic for missing nodes and relationships.
- The app still does not yet match the exact expected family tree visual design from the reference image.
- The render logic is close but needs to be refined to match the target layout more closely.

Important implementation guidance:
- Keep working locally; do not push to GitHub unless explicitly asked.
- Use the existing project structure and do not rewrite the whole app from scratch.
- Prefer incremental edits in server/routes.js, public/app.js, and public/styles.css.
- Preserve the working auth, registration, admin, and tree APIs.
- Validate with real browser or HTTP requests before claiming success.

Priority tasks:
1. Refine the SVG family tree layout to better match the reference image.
2. Make node positions and hierarchy visually clear and natural.
3. Improve each node card to display photo + name + info button.
4. Validate relationship creation and ensure parent/child/spouse links are correct.
5. Test login and registration flows end-to-end.
6. Finalize the UX for profile detail modal and family navigation.

Behavior constraints:
- Do not update GitHub unless the user explicitly asks you to.
- Keep the app easy to run locally with npm start.
- Preserve SQLite local DB and uploaded file storage under server/uploads.
- If you need to debug an issue, identify the root cause first and patch the narrowest relevant area.
- Every fix should be verified with a real command or browser step before concluding it works.

Please continue and do the next best engineering step from here, preserving the existing functionality while bringing the tree design closer to the expected visual reference.
```

---

## 10) Final summary

This project is already far along: the main backend, admin flows, login flows, and family tree retrieval already exist. The remaining focus is no longer basic functionality but final visual fidelity and validation of the relationship-driven family tree layout. The reference image is the design anchor. The next agent should therefore focus on tree rendering quality, family relationship correctness, and polishing the profiles on the tree while preserving the app’s existing working logic.

This document should act as the main continuation reference so the project can continue without losing context, even if work is handed off to another AI assistant or developer.
