#!/usr/bin/env node
// Generates client/public/bfi-logo.svg (BOLD Financial Intelligence mark) in the visual language of the BCI/BQI logos:
// beveled chrome letters, neon-blue shield, dot-matrix world globe with a glowing node network, segmented compass rings,
// orbit tube and a banner. Run: node scripts/generate-bfi-logo.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = process.env.BFI_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public', 'bfi-logo.svg');
const CX = 600; const CY = 590;

// ---- dot-matrix continents (coarse polygons in a 0..100 box mapped onto the globe) ----
const CONTINENTS = [
  [[6, 20], [18, 10], [34, 12], [42, 22], [36, 34], [31, 46], [24, 52], [18, 42], [9, 33]],
  [[27, 53], [38, 52], [45, 63], [41, 79], [33, 94], [29, 77], [25, 63]],
  [[47, 17], [57, 12], [66, 17], [63, 29], [54, 31], [47, 26]],
  [[46, 34], [58, 31], [67, 40], [65, 57], [58, 74], [52, 67], [45, 52], [43, 40]],
  [[61, 15], [80, 10], [95, 19], [93, 35], [84, 45], [74, 47], [66, 37], [62, 26]],
  [[80, 62], [93, 60], [95, 73], [84, 77]],
];
const inPoly = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i]; const [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const R = 335; const BOX = 2 * R; const STEP = 13;
const dots = [];
for (let py = CY - R; py <= CY + R; py += STEP) {
  for (let px = CX - R; px <= CX + R; px += STEP) {
    if ((px - CX) ** 2 + (py - CY) ** 2 > (R - 10) ** 2) continue;
    const u = ((px - (CX - R)) / BOX) * 100; const v = ((py - (CY - R)) / BOX) * 100;
    if (CONTINENTS.some((p) => inPoly(u, v, p))) dots.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.4"/>`);
  }
}

// ---- compass rings: segmented arcs + ticks ----
const arc = (r, a0, a1) => { const p = (a) => [CX + r * Math.cos((a * Math.PI) / 180), CY + r * Math.sin((a * Math.PI) / 180)]; const [x0, y0] = p(a0); const [x1, y1] = p(a1); return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
const segs = [[-80, -10], [5, 70], [100, 170], [185, 250], [265, 280]].map(([a, b]) => `<path d="${arc(556, a, b)}"/>`).join('');
let ticks = '';
for (let a = 0; a < 360; a += 6) { const rad = (a * Math.PI) / 180; const r0 = 572; const r1 = a % 30 === 0 ? 596 : 586; ticks += `M${(CX + r0 * Math.cos(rad)).toFixed(1)} ${(CY + r0 * Math.sin(rad)).toFixed(1)} L${(CX + r1 * Math.cos(rad)).toFixed(1)} ${(CY + r1 * Math.sin(rad)).toFixed(1)} `; }

// ---- network nodes inside the globe (finance flavour: market line + contagion links) ----
const NODES = [[352, 470, 13], [440, 400, 15], [520, 330, 17], [610, 285, 19], [705, 330, 16], [790, 410, 15], [850, 500, 13], [470, 520, 11], [735, 515, 11], [600, 400, 14]];
const LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 7], [7, 9], [9, 3], [9, 8], [8, 5], [2, 9], [4, 9]];
const links = LINKS.map(([a, b]) => `${NODES[a][0]},${NODES[a][1]} ${NODES[b][0]},${NODES[b][1]}`).map((pts) => `<polyline points="${pts}"/>`).join('');
const balls = NODES.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('');
const hi = NODES.map(([x, y, r]) => `<circle cx="${x - r * 0.3}" cy="${y - r * 0.35}" r="${(r * 0.32).toFixed(1)}"/>`).join('');

// ---- letters ----
const B = 'M232 455 L506 455 L566 500 L566 578 L530 616 L572 654 L572 742 L528 788 L232 788 Z M318 520 L470 520 L492 540 L492 560 L470 580 L318 580 Z M318 650 L486 650 L508 672 L508 718 L486 730 L318 730 Z';
const F = 'M622 455 L866 455 L900 488 V540 H702 V596 H862 V656 H702 V788 H622 Z';
const I = 'M936 455 H1022 V788 H936 Z';
const SH = 'M600 128 L958 238 V626 Q958 850 600 1042 Q242 850 242 626 V238 Z';
const SH_IN = 'M600 158 L930 258 V626 Q930 828 600 1010 Q270 828 270 626 V258 Z';

// ---- thin angular "tech" lettering drawn as strokes (no font dependency, so it renders identically everywhere) ----
const GLYPHS = {
  A: ['M0 16 V3 L3 0 H7 L10 3 V16', 'M0 9 H10'], B: ['M0 16 V0 H7.5 L9.5 2 V6 L7.5 8 H0', 'M7.5 8 L9.5 10 V14 L7.5 16 H0'],
  C: ['M10 3 L7 0 H3 L0 3 V13 L3 16 H7 L10 13'], D: ['M0 0 H7 L10 3 V13 L7 16 H0 Z'], E: ['M10 0 H0 V16 H10', 'M0 8 H8'],
  F: ['M10 0 H0 V16', 'M0 8 H8'], G: ['M10 3 L7 0 H3 L0 3 V13 L3 16 H7 L10 13 V8 H5'], I: ['M0 0 V16'], L: ['M0 0 V16 H9'],
  N: ['M0 16 V0 L10 16 V0'], O: ['M3 0 H7 L10 3 V13 L7 16 H3 L0 13 V3 Z'], T: ['M0 0 H10', 'M5 0 V16'],
};
const GLYPH_W = { I: 0 }; const GAP = 6.5; const SPACE = 11;
function techText(text, { cx, cy, width, height, stroke }) {
  const units = [...text].map((ch) => (ch === ' ' ? SPACE : (GLYPH_W[ch] ?? 10) + GAP));
  const total = units.reduce((a, b) => a + b, 0) - GAP;
  const sx = width / total; const sy = height / 16; let x = cx - width / 2; let d = '';
  [...text].forEach((ch, i) => {
    if (ch !== ' ') {
      for (const path of GLYPHS[ch]) {
        const t = path.match(/[MLHVZ]|-?\d+\.?\d*/g); let px = 0; let py = 0; let k = 0;
        while (k < t.length) {
          const c = t[k++];
          if (c === 'Z') { d += 'Z'; continue; }
          if (c === 'H') px = +t[k++]; else if (c === 'V') py = +t[k++]; else { px = +t[k++]; py = +t[k++]; }
          d += `${c === 'M' ? 'M' : 'L'}${(x + px * sx).toFixed(1)} ${(cy - height / 2 + py * sy).toFixed(1)} `;
        }
      }
    }
    x += units[i] * sx;
  });
  return `<path d="${d}" fill="none" stroke="#f2faff" stroke-width="${stroke}" stroke-linejoin="miter" stroke-linecap="square" filter="url(#glowS)"/>`;
}
// Optional: pre-converted outline of a real typeface (path data file, banner coordinates). Falls back to the stroke lettering.
const BANNER_PATH_FILE = process.env.BFI_BANNER_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'bfi-banner.path');
const BANNER_TEXT = existsSync(BANNER_PATH_FILE)
  ? `<path d="${readFileSync(BANNER_PATH_FILE, 'utf8').trim()}" fill="#f2faff" filter="url(#glowS)"/>`
  : techText('BOLD FINANCIAL INTELLIGENCE', { cx: 600, cy: 873, width: 760, height: 34, stroke: 3.4 });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" role="img" aria-label="BFI - BOLD Financial Intelligence">
<defs>
  <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".12" stop-color="#dfeaf5"/><stop offset=".3" stop-color="#8da6bf"/><stop offset=".47" stop-color="#f7fbff"/><stop offset=".53" stop-color="#6a84a0"/><stop offset=".72" stop-color="#c7d9ea"/><stop offset=".9" stop-color="#8aa3bc"/><stop offset="1" stop-color="#5b7390"/></linearGradient>
  <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".45" stop-color="#fff" stop-opacity=".05"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".25" stop-color="#9fb7cf"/><stop offset=".5" stop-color="#e8f2fb"/><stop offset=".75" stop-color="#7e98b3"/><stop offset="1" stop-color="#d6e6f4"/></linearGradient>
  <linearGradient id="banner" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d2a56"/><stop offset=".5" stop-color="#05142d"/><stop offset="1" stop-color="#020a18"/></linearGradient>
  <radialGradient id="sphere" cx=".5" cy=".42" r=".62"><stop offset="0" stop-color="#1b66d8" stop-opacity=".9"/><stop offset=".6" stop-color="#0a2e78" stop-opacity=".92"/><stop offset="1" stop-color="#030d26" stop-opacity=".98"/></radialGradient>
  <radialGradient id="shieldFill" cx=".5" cy=".35" r=".8"><stop offset="0" stop-color="#0f4bb8" stop-opacity=".6"/><stop offset="1" stop-color="#030c24" stop-opacity=".95"/></radialGradient>
  <radialGradient id="ball" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#ffffff"/><stop offset=".22" stop-color="#8fe0ff"/><stop offset=".55" stop-color="#1d8bff"/><stop offset="1" stop-color="#062f9a"/></radialGradient>
  <radialGradient id="halo" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#2b86ff" stop-opacity=".6"/><stop offset=".7" stop-color="#1450c8" stop-opacity=".18"/><stop offset="1" stop-color="#1450c8" stop-opacity="0"/></radialGradient>
  <filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="glowS" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="18"/></filter>
  <filter id="drop" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="7" flood-color="#010a22" flood-opacity=".95"/></filter>
  <clipPath id="shieldClip"><path d="${SH_IN}"/></clipPath>
  <clipPath id="globeClip"><circle cx="${CX}" cy="${CY}" r="${R}"/></clipPath>
  <path id="B" fill-rule="evenodd" d="${B}"/><path id="F" d="${F}"/><path id="I" d="${I}"/>
</defs>

<circle cx="${CX}" cy="${CY}" r="590" fill="url(#halo)"/>

<!-- compass rings -->
<g fill="none" stroke="#2c8dff" stroke-width="7" stroke-linecap="round" filter="url(#glow)" opacity=".95">${segs}</g>
<g fill="none" stroke="#5db8ff" stroke-width="3" stroke-linecap="round" opacity=".95">${segs}</g>
<path d="${ticks}" stroke="#38a6ff" stroke-width="3" fill="none" opacity=".85" filter="url(#glowS)"/>
<circle cx="${CX}" cy="${CY}" r="534" fill="none" stroke="#1f6fe0" stroke-width="2" opacity=".55"/>
<g stroke="#4db3ff" stroke-width="5" filter="url(#glow)"><path d="M600 4 V128 M600 1052 V1176 M4 590 H128 M1072 590 H1196"/></g>
<g fill="url(#ball)" stroke="#d9f3ff" stroke-width="2" filter="url(#glowS)"><circle cx="600" cy="40" r="19"/><circle cx="600" cy="1140" r="19"/><circle cx="40" cy="590" r="19"/><circle cx="1160" cy="590" r="19"/></g>

<!-- shield body -->
<path d="${SH}" fill="#020a1c"/>
<path d="${SH_IN}" fill="url(#shieldFill)"/>
<g clip-path="url(#shieldClip)">
  <!-- globe -->
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#sphere)"/>
  <g clip-path="url(#globeClip)">
    <g fill="none" stroke="#2f9bff" stroke-width="2" opacity=".6">
      <ellipse cx="${CX}" cy="${CY}" rx="${R}" ry="115"/><ellipse cx="${CX}" cy="${CY}" rx="${R}" ry="230"/>
      <ellipse cx="${CX}" cy="${CY}" rx="115" ry="${R}"/><ellipse cx="${CX}" cy="${CY}" rx="230" ry="${R}"/>
      <path d="M${CX - R} ${CY} H${CX + R} M${CX} ${CY - R} V${CY + R}"/>
    </g>
    <g fill="#6fd0ff" opacity=".95">${dots.join('')}</g>
  </g>
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#3aa3ff" stroke-width="4" opacity=".8" filter="url(#glowS)"/>
  <!-- network -->
  <g fill="none" stroke="#7fd6ff" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity=".55" filter="url(#glow)">${links}</g>
  <g fill="none" stroke="#e8f8ff" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round">${links}</g>
  <g fill="url(#ball)" stroke="#d9f3ff" stroke-width="2" filter="url(#glowS)">${balls}</g>
  <g fill="#ffffff" opacity=".9">${hi}</g>
</g>

<!-- shield bevel rim -->
<path d="${SH}" fill="none" stroke="#1a6dff" stroke-width="22" opacity=".5" filter="url(#glow)"/>
<path d="${SH}" fill="none" stroke="#0b1f45" stroke-width="30" stroke-linejoin="round"/>
<path d="${SH}" fill="none" stroke="url(#rim)" stroke-width="18" stroke-linejoin="round"/>
<path d="${SH_IN}" fill="none" stroke="#2f94ff" stroke-width="4" opacity=".95" filter="url(#glowS)"/>
<g fill="url(#ball)" stroke="#d9f3ff" stroke-width="2.5" filter="url(#glowS)"><circle cx="600" cy="128" r="20"/><circle cx="958" cy="238" r="14"/><circle cx="242" cy="238" r="14"/></g>

<!-- orbit tube -->
<g transform="rotate(-22 600 640)">
  <ellipse cx="600" cy="640" rx="578" ry="210" fill="none" stroke="#0a3fb8" stroke-width="30" opacity=".55" filter="url(#glow)"/>
  <ellipse cx="600" cy="640" rx="578" ry="210" fill="none" stroke="#1d7bff" stroke-width="14"/>
  <ellipse cx="600" cy="640" rx="578" ry="210" fill="none" stroke="#9fe0ff" stroke-width="4"/>
  <circle cx="1178" cy="640" r="26" fill="url(#ball)" stroke="#d9f3ff" stroke-width="2.5" filter="url(#glowS)"/>
  <circle cx="22" cy="640" r="20" fill="url(#ball)" stroke="#d9f3ff" stroke-width="2" filter="url(#glowS)"/>
</g>

<!-- letters -->
<g transform="translate(627 621) scale(.88) translate(-627 -621)">
<g filter="url(#blur)" fill="#1a7bff" opacity=".95"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<g filter="url(#drop)" fill="#041a44" stroke="#041a44" stroke-width="34" stroke-linejoin="round" transform="translate(0 14)"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<g fill="none" stroke="#2f9bff" stroke-width="22" stroke-linejoin="round" filter="url(#glow)"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<g fill="none" stroke="#0a2a66" stroke-width="12" stroke-linejoin="round"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<g fill="url(#chrome)" stroke="#bfe3ff" stroke-width="3" stroke-linejoin="round"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<g fill="url(#gloss)"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<g fill="none" stroke="#04204f" stroke-width="3" opacity=".55" stroke-linejoin="round" transform="translate(7 9)"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<g fill="none" stroke="#ffffff" stroke-width="2.2" opacity=".9" stroke-linejoin="round" transform="translate(-3 -3)"><use href="#B"/><use href="#F"/><use href="#I"/></g>
<path d="M318 520 L470 520 L492 540 L492 560 L470 580 L318 580 Z M318 650 L486 650 L508 672 L508 718 L486 730 L318 730 Z" fill="none" stroke="#39a9ff" stroke-width="5" filter="url(#glowS)" stroke-linejoin="round"/>

</g>

<!-- banner -->
<g filter="url(#drop)">
  <path d="M138 850 L206 812 H994 L1062 850 L1012 934 H188 Z" fill="url(#banner)" stroke="#0b1f45" stroke-width="16" stroke-linejoin="round"/>
  <path d="M138 850 L206 812 H994 L1062 850 L1012 934 H188 Z" fill="none" stroke="url(#rim)" stroke-width="9" stroke-linejoin="round"/>
  <path d="M160 852 L216 824 H984 L1040 852" fill="none" stroke="#2f94ff" stroke-width="3" opacity=".95" filter="url(#glowS)"/>
  ${BANNER_TEXT}
</g>
</svg>
`;
writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${svg.length} bytes, ${dots.length} globe dots)`);
