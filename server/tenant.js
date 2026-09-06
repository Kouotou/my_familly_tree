const db = require('./db');

// a family's URL slug, doubling as the source for its schema name — kept strict since it's
// interpolated directly into `SET search_path` (which can't take a bound parameter) and into
// the schema name itself (`family_<slug>` with hyphens turned to underscores, since Postgres
// identifiers can't contain hyphens unquoted-safely across every context we use them in).
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function isValidSlug(slug) { return typeof slug === 'string' && slug.length <= 60 && SLUG_RE.test(slug); }
function schemaNameForSlug(slug) { return `family_${slug.replace(/-/g, '_')}`; }

const DEFAULT_FAMILY = { id: 'najambeta', slug: 'najambeta', schema_name: 'public', name: 'Nah Adja Mbethe', status: 'active' };

async function lookupFamilyBySlug(slug) {
  if (slug === DEFAULT_FAMILY.slug) return DEFAULT_FAMILY;
  const row = await db.pool.query('SELECT * FROM public.families WHERE slug = $1', [slug]);
  return row.rows[0] || null;
}

// Resolves which family this request belongs to from a `/f/<slug>/...` URL prefix (defaulting
// to Na Ajanbeta for any request with no such prefix, so every existing bookmarked URL keeps
// working unchanged through the transition — see server/app.js), strips that prefix from
// req.url so the existing static-file and /api routing underneath needs no changes at all,
// then attaches a dedicated, schema-scoped Postgres client for the rest of this request's
// lifetime.
//
// The client is released on the response's 'finish'/'close' events rather than in a `finally`
// after awaiting the rest of the middleware chain — Express's `next()` is a synchronous
// continuation, not something you can `await` to know "the request is now fully handled";
// awaiting it would resolve almost immediately (long before the route handler actually runs)
// and release the client while it's still in active use elsewhere in the request, letting a
// concurrent request grab the same physical connection out from under it. Tying release to
// the response lifecycle is the correct scope for a resource meant to live exactly as long as
// the request does.
async function tenantMiddleware(req, res, next) {
  try {
    const match = req.path.match(/^\/f\/([a-z0-9-]+)(\/.*)?$/);
    let family;
    if (match) {
      if (!isValidSlug(match[1])) return res.status(404).send('Not found');
      family = await lookupFamilyBySlug(match[1]);
      if (!family || family.status !== 'active') return res.status(404).send('Family not found');
      const rest = match[2] || '/';
      const qsIndex = req.url.indexOf('?');
      req.url = rest + (qsIndex >= 0 ? req.url.slice(qsIndex) : '');
    } else {
      family = DEFAULT_FAMILY;
    }
    req.family = family;

    // Only /api/... requests ever touch the database — static assets and the SPA-shell
    // catch-all (plain res.sendFile calls) don't run a single query. A page load fires off
    // several static requests at once (styles.css, app.js, images...); routing every one of
    // them through a checked-out, schema-scoped client would needlessly compete for the pool's
    // 4 connections against the /api/ requests that actually need one.
    if (!req.url.startsWith('/api/') && req.url !== '/api') return next();

    const { client, schemaIdent } = await db.connectForTenant(family.schema_name);
    let released = false;
    const release = () => { if (!released) { released = true; client.release(); } };
    res.on('finish', release);
    res.on('close', release);
    db.runInTenantContext(client, schemaIdent, next);
  } catch (err) {
    next(err);
  }
}

module.exports = { tenantMiddleware, lookupFamilyBySlug, isValidSlug, schemaNameForSlug, DEFAULT_FAMILY };
