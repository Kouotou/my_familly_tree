// Subtle decorative cultural-motif background for the Family Tree and Archives pages
// (and their exported PNG/PDF). Purely visual: aria-hidden, no focusable elements, no
// data ever stored or sent anywhere. Every icon below is an original minimal line-art
// glyph inspired by documented Cameroonian cultural forms — not a copy of any photograph
// or museum artifact. Icons use currentColor so the same markup works in light/dark mode
// on-screen (inherits the page's --text custom property) and is given a resolved hex when
// baked into the canvas export (see drawOnCanvas below).
(function(){
  // Archives leans on more figurative/silhouette motifs (a face, an elephant, a human
  // shape) which the eye picks out far more readily than abstract line-art at the same
  // opacity — pareidolia makes them read "louder" than geometric shapes even when the pixel
  // coverage is similar. Kept lower than the tree page's mostly-abstract set for that reason.
  const OPACITY = { tree: 0.07, archives: 0.04 };

  // 21 original motifs, each a self-contained 0..100 viewBox glyph. Kept intentionally
  // simple/geometric (circles, arcs, short strokes) — at ~7% opacity as scattered
  // background texture, restraint reads better than detail.
  const ICONS = {
    spider: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">
      <ellipse cx="50" cy="54" rx="12" ry="9" fill="currentColor" stroke="none"/>
      <circle cx="50" cy="38" r="6" fill="currentColor" stroke="none"/>
      <path d="M40,46 L18,30 M40,46 L14,48 M42,52 L16,60 M44,60 L22,76"/>
      <path d="M60,46 L82,30 M60,46 L86,48 M58,52 L84,60 M56,60 L78,76"/>
    </g>`,
    // Redrawn after a reference photo of a Bamoun ceremonial double-gong pendant: two
    // serpent bodies braid around each other (not a single S-curve), splayed tusk-like
    // heads at top linked by a short crossbar, small curled tail tips at the bottom.
    two_headed_serpent: `<g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M32,18 L32.9,19.6 L35.4,21.2 L39.4,22.8 L44.4,24.4 L50,26 L55.6,27.6 L60.6,29.2 L64.6,30.8 L67.1,32.4 L68,34 L67.1,35.6 L64.6,37.2 L60.6,38.8 L55.6,40.4 L50,42 L44.4,43.6 L39.4,45.2 L35.4,46.8 L32.9,48.4 L32,50 L32.9,51.6 L35.4,53.2 L39.4,54.8 L44.4,56.4 L50,58 L55.6,59.6 L60.6,61.2 L64.6,62.8 L67.1,64.4 L68,66 L67.1,67.6 L64.6,69.2 L60.6,70.8 L55.6,72.4 L50,74 L44.4,75.6 L39.4,77.2 L35.4,78.8 L32.9,80.4 L32,82"/>
      <path d="M68,18 L67.1,19.6 L64.6,21.2 L60.6,22.8 L55.6,24.4 L50,26 L44.4,27.6 L39.4,29.2 L35.4,30.8 L32.9,32.4 L32,34 L32.9,35.6 L35.4,37.2 L39.4,38.8 L44.4,40.4 L50,42 L55.6,43.6 L60.6,45.2 L64.6,46.8 L67.1,48.4 L68,50 L67.1,51.6 L64.6,53.2 L60.6,54.8 L55.6,56.4 L50,58 L44.4,59.6 L39.4,61.2 L35.4,62.8 L32.9,64.4 L32,66 L32.9,67.6 L35.4,69.2 L39.4,70.8 L44.4,72.4 L50,74 L55.6,75.6 L60.6,77.2 L64.6,78.8 L67.1,80.4 L68,82"/>
      <path d="M32,18 C26,14 22,10 20,8 M68,18 C74,14 78,10 80,8"/>
      <path d="M20,8 L80,8" stroke-width="2.2"/>
      <path d="M32,82 C30,86 34,88 37,85 M68,82 C70,86 66,88 63,85"/>
    </g>`,
    double_gong: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M28,20 L60,20"/>
      <path d="M30,20 C20,40 22,66 32,80 L44,80 C40,60 38,36 42,20 Z"/>
      <path d="M58,20 C50,40 52,66 62,80 L74,80 C72,60 72,36 78,20 Z"/>
      <circle cx="38" cy="74" r="2.5" fill="currentColor" stroke="none"/>
      <circle cx="68" cy="74" r="2.5" fill="currentColor" stroke="none"/>
    </g>`,
    elephant_head: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M30,28 C18,28 14,44 22,52 C16,54 16,62 24,64"/>
      <ellipse cx="42" cy="38" rx="22" ry="18"/>
      <path d="M24,50 C20,64 22,80 30,90 C34,80 32,66 34,54"/>
      <ellipse cx="14" cy="34" rx="10" ry="14" transform="rotate(-15 14 34)"/>
      <circle cx="48" cy="34" r="2.4" fill="currentColor" stroke="none"/>
    </g>`,
    leopard_motif: `<g fill="none" stroke="currentColor" stroke-width="3.6">
      <circle cx="34" cy="36" r="9"/><circle cx="34" cy="36" r="2" fill="currentColor" stroke="none"/>
      <circle cx="64" cy="34" r="9"/><circle cx="64" cy="34" r="2" fill="currentColor" stroke="none"/>
      <circle cx="50" cy="62" r="9"/><circle cx="50" cy="62" r="2" fill="currentColor" stroke="none"/>
    </g>`,
    ceremonial_mask: `<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round">
      <path d="M50,10 C70,10 78,32 74,54 C71,76 62,90 50,92 C38,90 29,76 26,54 C22,32 30,10 50,10 Z"/>
      <path d="M50,52 L50,64"/>
      <path d="M42,76 C46,80 54,80 58,76"/>
    </g>`,
    ndop_pattern: `<g fill="none" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round">
      <rect x="26" y="26" width="48" height="48" transform="rotate(45 50 50)"/>
      <rect x="38" y="38" width="24" height="24" transform="rotate(45 50 50)"/>
      <circle cx="50" cy="50" r="4" fill="currentColor" stroke="none"/>
    </g>`,
    balafon: `<g fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round">
      <path d="M14,66 C30,78 70,78 86,66"/>
      <path d="M22,60 L22,44 M34,62 L34,40 M46,63 L46,38 M58,63 L58,40 M70,62 L70,44 M78,60 L78,48"/>
    </g>`,
    drum: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M28,22 L72,22 L66,82 L34,82 Z"/>
      <path d="M28,22 C40,28 60,28 72,22"/>
      <path d="M34,82 C44,86 56,86 66,82"/>
      <path d="M32,34 L68,34 M30,50 L70,50 M32,66 L68,66"/>
    </g>`,
    calabash: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M50,18 C40,18 40,28 44,32 C24,36 18,56 26,72 C34,88 66,88 74,72 C82,56 76,36 56,32 C60,28 60,18 50,18 Z"/>
      <path d="M44,32 C48,34 52,34 56,32"/>
    </g>`,
    ceremonial_trumpet: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16,26 C40,20 58,34 62,54 C66,74 80,78 88,72 C80,84 60,82 54,66 C48,50 34,42 16,44 Z"/>
      <path d="M16,26 C10,30 10,40 16,44"/>
    </g>`,
    talking_drum: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">
      <path d="M30,18 C22,18 20,26 26,30 C18,44 18,56 26,70 C20,74 22,82 30,82"/>
      <path d="M70,18 C78,18 80,26 74,30 C82,44 82,56 74,70 C80,74 78,82 70,82"/>
      <path d="M30,18 L70,18 M30,82 L70,82"/>
      <path d="M28,26 L72,74 M72,26 L28,74"/>
    </g>`,
    horse_silhouette: `<g fill="currentColor" stroke="none">
      <path d="M20,78 L24,50 C22,44 24,36 32,32 C30,26 34,18 42,18 C48,18 50,22 50,26 L60,26 C66,26 72,30 74,38 L80,40 L74,46 L70,44 C70,52 66,58 60,60 L62,78 L56,78 L54,62 L44,62 L44,78 L38,78 L38,58 C30,58 24,64 24,72 L26,78 Z"/>
    </g>`,
    mvet_instrument: `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">
      <path d="M18,80 C30,30 70,18 84,22"/>
      <path d="M18,80 L18,68 M84,22 L84,32"/>
      <path d="M22,74 C40,32 66,24 80,26"/>
      <ellipse cx="50" cy="70" rx="14" ry="9"/>
    </g>`,
    ancestral_figure: `<g fill="currentColor" stroke="none">
      <circle cx="50" cy="22" r="12"/>
      <path d="M38,36 L62,36 L66,60 L58,60 L58,88 L48,88 L48,64 L42,64 L42,88 L34,88 L34,60 L38,60 Z"/>
      <rect x="30" y="38" width="8" height="24" rx="3"/>
      <rect x="62" y="38" width="8" height="24" rx="3"/>
    </g>`,
    leaf_vine: `<g fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round">
      <path d="M14,86 C30,66 30,34 50,14"/>
      <path d="M24,74 C32,70 36,62 34,54 C26,58 22,64 24,74 Z" fill="currentColor" stroke="none"/>
      <path d="M36,52 C44,48 48,40 46,32 C38,36 34,42 36,52 Z" fill="currentColor" stroke="none"/>
      <path d="M40,28 C46,22 48,16 46,10 C40,14 36,20 40,28 Z" fill="currentColor" stroke="none"/>
    </g>`,
    raffia_motif: `<g fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round">
      <path d="M50,86 L50,50"/>
      <path d="M50,50 C34,44 22,30 18,14"/>
      <path d="M50,50 C42,38 40,22 44,8"/>
      <path d="M50,50 C50,36 54,22 62,10"/>
      <path d="M50,50 C58,38 68,28 82,22"/>
      <path d="M50,50 C60,46 72,44 86,46"/>
    </g>`,
    basket_weave: `<g fill="none" stroke="currentColor" stroke-width="3.6">
      <rect x="16" y="16" width="68" height="68" rx="6"/>
      <path d="M16,34 L84,34 M16,50 L84,50 M16,66 L84,66"/>
      <path d="M34,16 L34,84 M50,16 L50,84 M66,16 L66,84"/>
    </g>`,
    bird_silhouette: `<g fill="currentColor" stroke="none">
      <path d="M50,40 C40,20 18,18 10,26 C22,28 28,34 30,42 C16,42 6,50 4,60 C16,54 26,54 34,58 C30,66 32,76 40,82 C40,72 44,64 52,60 C62,64 74,62 84,52 C74,54 66,52 60,46 C70,42 78,34 78,22 C68,28 58,32 50,40 Z"/>
    </g>`,
    neutral_geometric: `<g fill="none" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round">
      <path d="M50,12 L88,50 L50,88 L12,50 Z"/>
      <path d="M50,30 L70,50 L50,70 L30,50 Z"/>
    </g>`,
    // The documented Bamoun royal triad (spider + two-headed serpent + double gong),
    // combined into one recurring motif — balanced by the rest of the library above/below
    // so the overall set doesn't read as exclusively Bamoun.
    bamoun_triad: `<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
      <g transform="translate(50,24) scale(0.34)">
        <ellipse cx="50" cy="54" rx="12" ry="9" fill="currentColor" stroke="none"/>
        <circle cx="50" cy="38" r="6" fill="currentColor" stroke="none"/>
        <path d="M40,46 L18,30 M40,46 L14,48 M42,52 L16,60 M44,60 L22,76"/>
        <path d="M60,46 L82,30 M60,46 L86,48 M58,52 L84,60 M56,60 L78,76"/>
      </g>
      <g transform="translate(22,72) scale(0.32)">
        <path d="M14,50 C28,22 36,78 50,50 C64,22 72,78 86,50"/>
        <ellipse cx="12" cy="50" rx="6" ry="4.5" fill="currentColor" stroke="none"/>
        <ellipse cx="88" cy="50" rx="6" ry="4.5" fill="currentColor" stroke="none"/>
      </g>
      <g transform="translate(78,72) scale(0.3)">
        <path d="M28,20 L60,20"/>
        <path d="M30,20 C20,40 22,66 32,80 L44,80 C40,60 38,36 42,20 Z"/>
        <path d="M58,20 C50,40 52,66 62,80 L74,80 C72,60 72,36 78,20 Z"/>
      </g>
    </g>`,
  };

  // Only ~7-10 unique icons show per page at once, a different subset per page — same
  // design system, different balance (Family Tree leans geometric, Archives leans organic).
  const SUBSETS = {
    tree: ['spider', 'two_headed_serpent', 'double_gong', 'bamoun_triad', 'ndop_pattern',
      'neutral_geometric', 'basket_weave', 'talking_drum', 'balafon'],
    archives: ['leaf_vine', 'raffia_motif', 'bird_silhouette', 'horse_silhouette', 'elephant_head',
      'calabash', 'ceremonial_mask', 'ancestral_figure', 'mvet_instrument'],
  };

  // Hand-placed, irregular scatter (fractions of the box, some bleeding past 0/1 on
  // purpose) — deliberately not a grid, not evenly spaced, varied size/rotation.
  const PLACEMENTS = {
    tree: [
      { icon: 'spider', x: 0.08, y: 0.12, s: 0.09, r: 15 },
      { icon: 'two_headed_serpent', x: 0.32, y: 0.06, s: 0.13, r: -8 },
      { icon: 'double_gong', x: 0.63, y: 0.09, s: 0.10, r: 5 },
      { icon: 'bamoun_triad', x: 0.90, y: 0.20, s: 0.16, r: 0 },
      { icon: 'ndop_pattern', x: 0.18, y: 0.30, s: 0.08, r: 25 },
      { icon: 'neutral_geometric', x: 0.48, y: 0.33, s: 0.07, r: 40 },
      { icon: 'basket_weave', x: 0.03, y: 0.48, s: 0.11, r: -12 },
      { icon: 'talking_drum', x: 0.75, y: 0.42, s: 0.09, r: 10 },
      { icon: 'balafon', x: 0.35, y: 0.58, s: 0.12, r: -4 },
      { icon: 'spider', x: 0.94, y: 0.60, s: 0.07, r: -20 },
      { icon: 'two_headed_serpent', x: 0.10, y: 0.72, s: 0.10, r: 18 },
      { icon: 'ndop_pattern', x: 0.58, y: 0.76, s: 0.09, r: -30 },
      { icon: 'double_gong', x: 0.24, y: 0.90, s: 0.08, r: 8 },
      { icon: 'bamoun_triad', x: 0.82, y: 0.93, s: 0.13, r: -6 },
      { icon: 'neutral_geometric', x: -0.02, y: 0.97, s: 0.09, r: 20 },
      { icon: 'basket_weave', x: 0.52, y: 1.02, s: 0.10, r: 5 },
    ],
    archives: [
      { icon: 'leaf_vine', x: 0.06, y: 0.07, s: 0.14, r: 10 },
      { icon: 'bird_silhouette', x: 0.30, y: 0.04, s: 0.07, r: -10 },
      { icon: 'elephant_head', x: 0.58, y: 0.09, s: 0.10, r: 6 },
      { icon: 'raffia_motif', x: 0.88, y: 0.15, s: 0.12, r: -8 },
      { icon: 'calabash', x: 0.14, y: 0.26, s: 0.08, r: 15 },
      { icon: 'ceremonial_mask', x: 0.44, y: 0.27, s: 0.085, r: 0 },
      { icon: 'horse_silhouette', x: 0.73, y: 0.33, s: 0.09, r: -5 },
      { icon: 'ancestral_figure', x: 0.04, y: 0.46, s: 0.08, r: 0 },
      { icon: 'mvet_instrument', x: 0.34, y: 0.50, s: 0.13, r: 12 },
      { icon: 'leaf_vine', x: 0.63, y: 0.55, s: 0.10, r: -25 },
      { icon: 'bird_silhouette', x: 0.94, y: 0.49, s: 0.07, r: 20 },
      { icon: 'raffia_motif', x: 0.18, y: 0.68, s: 0.11, r: 5 },
      { icon: 'elephant_head', x: 0.50, y: 0.75, s: 0.08, r: -10 },
      { icon: 'calabash', x: 0.81, y: 0.79, s: 0.09, r: -18 },
      { icon: 'ceremonial_mask', x: 0.05, y: 0.92, s: 0.07, r: 8 },
      { icon: 'mvet_instrument', x: 0.67, y: 0.95, s: 0.12, r: -6 },
    ],
  };

  function defsMarkup(pageKey){
    return (SUBSETS[pageKey] || [])
      .map(name => `<symbol id="cbg-${name}" viewBox="0 0 100 100">${ICONS[name]}</symbol>`)
      .join('');
  }

  function usesMarkup(pageKey, boxW, boxH){
    const base = Math.min(boxW, boxH);
    return (PLACEMENTS[pageKey] || []).map(p=>{
      const size = base * p.s;
      const cx = boxW * p.x, cy = boxH * p.y;
      return `<use href="#cbg-${p.icon}" x="${(cx - size/2).toFixed(1)}" y="${(cy - size/2).toFixed(1)}" `
        + `width="${size.toFixed(1)}" height="${size.toFixed(1)}" transform="rotate(${p.r} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`;
    }).join('');
  }

  function innerMarkup(pageKey, boxW, boxH){
    const opacity = OPACITY[pageKey] || 0.07;
    return `<defs>${defsMarkup(pageKey)}</defs><g opacity="${opacity}">${usesMarkup(pageKey, boxW, boxH)}</g>`;
  }

  // On-screen: injected once as the first child of <body>, fixed behind everything
  // (z-index:0; every real element on these pages is unpositioned or explicitly z-index
  // >=80, so plain DOM order already keeps this behind them). Uses currentColor bound to
  // the page's own --text custom property, so it re-colors automatically on theme toggle
  // with no re-render needed.
  function injectOnScreen(pageKey){
    if (!SUBSETS[pageKey] || document.getElementById('cultural-bg-layer')) return;
    const boxW = 1200, boxH = 900;
    const svg = `<svg width="100%" height="100%" viewBox="0 0 ${boxW} ${boxH}" `
      + `preserveAspectRatio="xMidYMid slice" style="display:block;color:var(--text)" aria-hidden="true" focusable="false">`
      + innerMarkup(pageKey, boxW, boxH) + `</svg>`;
    const wrap = document.createElement('div');
    wrap.id = 'cultural-bg-layer';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;';
    wrap.innerHTML = svg;
    document.body.insertBefore(wrap, document.body.firstChild);
  }

  // Export: draws the same pattern onto a canvas at the exact export pixel size, with a
  // resolved hex color (an <img> rendering a standalone SVG document doesn't inherit page
  // CSS custom properties, so currentColor is bound via an inline style with a literal
  // color chosen to match this app's light/dark --text tone).
  async function drawOnCanvas(ctx, width, height, isDark, pageKey){
    pageKey = pageKey || 'tree';
    if (!SUBSETS[pageKey]) return;
    const ink = isDark ? '#eef1f7' : '#3c2c1c';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
      + `viewBox="0 0 ${width} ${height}" style="color:${ink}">` + innerMarkup(pageKey, width, height) + `</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try{
      const img = await new Promise((resolve, reject)=>{
        const im = new Image();
        im.onload = ()=> resolve(im);
        im.onerror = ()=> reject(new Error('cultural background render failed'));
        im.src = url;
      });
      ctx.drawImage(img, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  window.CulturalBackground = { injectOnScreen, drawOnCanvas };

  if (window.CULTURAL_BG_PAGE){
    document.addEventListener('DOMContentLoaded', ()=> injectOnScreen(window.CULTURAL_BG_PAGE));
  }
})();
