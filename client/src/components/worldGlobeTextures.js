import * as THREE from 'three';

// Split out of WorldGlobe.jsx: procedural canvas-drawn textures with no
// React/Three-scene dependencies of their own (pure Canvas 2D -> THREE.
// CanvasTexture), so they don't need to live alongside the component tree
// that consumes them.

/** Round soft-glow sprite texture drawn via the Canvas 2D API. */
export function makeGlowSprite() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, half * 0.08, half, half, half * 0.55);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.7, 'rgba(88,221,255,0.9)');
  gradient.addColorStop(1, 'rgba(88,221,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/** Conic-gradient radar sweep wedge, matching the previous 2D CSS radar look. */
export function makeRadarSweepTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;
  ctx.clearRect(0, 0, size, size);
  const startAngle = -Math.PI / 2;
  const sweepAngle = Math.PI / 3;
  const grad = ctx.createConicGradient
    ? ctx.createConicGradient(startAngle, cx, cy)
    : null;
  if (grad) {
    grad.addColorStop(0, 'rgba(88,221,255,0)');
    grad.addColorStop((sweepAngle) / (2 * Math.PI), 'rgba(88,221,255,0.55)');
    grad.addColorStop((sweepAngle + 0.001) / (2 * Math.PI), 'rgba(88,221,255,0)');
    grad.addColorStop(1, 'rgba(88,221,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Fallback for engines without createConicGradient: draw the wedge manually.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, startAngle, startAngle + sweepAngle);
    ctx.closePath();
    const wedgeGrad = ctx.createLinearGradient(0, 0, r, 0);
    wedgeGrad.addColorStop(0, 'rgba(88,221,255,0.55)');
    wedgeGrad.addColorStop(1, 'rgba(88,221,255,0.05)');
    ctx.fillStyle = wedgeGrad;
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(88,221,255,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ─── Procedural planet textures (ported from the mrdoob/three.js-derived
// reference solar system — pure canvas drawing, no external assets) ─────────

export function makeJupiterTex() {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bd = [
    [0.00, '#c07030'], [0.06, '#f0d090'], [0.12, '#b85820'], [0.18, '#e8c880'],
    [0.25, '#d07838'], [0.32, '#f4e09a'], [0.40, '#c06828'], [0.48, '#f0cc80'],
    [0.54, '#c88040'], [0.60, '#e8c078'], [0.66, '#b86020'], [0.72, '#ecc880'],
    [0.78, '#c07830'], [0.86, '#f0d090'], [0.93, '#c06030'], [1.00, '#c07030'],
  ];
  for (let i = 0; i < bd.length - 1; i++) {
    const y1 = bd[i][0] * H, y2 = bd[i + 1][0] * H;
    const g = ctx.createLinearGradient(0, y1, 0, y2);
    g.addColorStop(0, bd[i][1]); g.addColorStop(1, bd[i + 1][1]);
    ctx.fillStyle = g; ctx.fillRect(0, y1, W, y2 - y1 + 1);
  }
  ctx.globalAlpha = 0.14;
  for (let y = 0; y < H; y += 3) {
    const wave = Math.sin(y * 0.06) * 14 + Math.sin(y * 0.025) * 20;
    const dark = ((y / H * bd.length) | 0) % 2 === 0;
    for (let x = 0; x < W; x += 3)
      if (Math.sin((x + wave) * 0.035 + y * 0.015) > 0.62) {
        ctx.fillStyle = dark ? 'rgba(70,30,5,1)' : 'rgba(250,210,130,1)';
        ctx.fillRect(x, y, 3, 3);
      }
  }
  ctx.globalAlpha = 1;
  ctx.save(); ctx.translate(W * 0.68, H * 0.575); ctx.scale(1, 0.5);
  const grs = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.056);
  grs.addColorStop(0, 'rgba(175,50,15,0.97)'); grs.addColorStop(0.35, 'rgba(185,65,22,0.83)');
  grs.addColorStop(0.68, 'rgba(160,68,28,0.55)'); grs.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grs; ctx.beginPath(); ctx.arc(0, 0, W * 0.056, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  return new THREE.CanvasTexture(canvas);
}

export function makeSaturnTex() {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bd = [
    [0.00, '#d4b870'], [0.10, '#e8cc88'], [0.22, '#c8a858'], [0.34, '#ead8a0'],
    [0.46, '#d0b868'], [0.56, '#ecdca8'], [0.66, '#c8a858'], [0.76, '#ead8a0'],
    [0.86, '#d4b870'], [1.00, '#d4b870'],
  ];
  for (let i = 0; i < bd.length - 1; i++) {
    const y1 = bd[i][0] * H, y2 = bd[i + 1][0] * H;
    const g = ctx.createLinearGradient(0, y1, 0, y2);
    g.addColorStop(0, bd[i][1]); g.addColorStop(1, bd[i + 1][1]);
    ctx.fillStyle = g; ctx.fillRect(0, y1, W, y2 - y1 + 1);
  }
  ctx.globalAlpha = 0.08;
  for (let y = 0; y < H; y += 4) {
    const wave = Math.sin(y * 0.04) * 10;
    for (let x = 0; x < W; x += 4)
      if (Math.sin((x + wave) * 0.03 + y * 0.01) > 0.6) {
        ctx.fillStyle = ((y / H * 9) | 0) % 2 === 0 ? 'rgba(100,70,20,1)' : 'rgba(255,235,165,1)';
        ctx.fillRect(x, y, 4, 4);
      }
  }
  ctx.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}

export function makeSaturnRingTex() {
  const W = 512, H = 1;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.05, 'rgba(160,140,100,0.15)');
  g.addColorStop(0.20, 'rgba(200,180,130,0.55)');
  g.addColorStop(0.42, 'rgba(235,215,165,0.88)');
  g.addColorStop(0.56, 'rgba(210,190,140,0.72)');
  g.addColorStop(0.60, 'rgba(12,6,2,0.08)');
  g.addColorStop(0.63, 'rgba(12,6,2,0.06)');
  g.addColorStop(0.68, 'rgba(190,170,120,0.60)');
  g.addColorStop(0.82, 'rgba(175,155,108,0.48)');
  g.addColorStop(0.90, 'rgba(155,138,98,0.28)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  return new THREE.CanvasTexture(canvas);
}

export function makeMarsTex() {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#e0e0d8'); base.addColorStop(0.07, '#cc5030');
  base.addColorStop(0.28, '#c84c2a'); base.addColorStop(0.50, '#d05c38');
  base.addColorStop(0.58, '#b03c24'); base.addColorStop(0.72, '#cc5030');
  base.addColorStop(0.90, '#c04428'); base.addColorStop(0.95, '#e0e0d8');
  base.addColorStop(1, '#f0f0e8');
  ctx.fillStyle = base; ctx.fillRect(0, 0, W, H);
  const patches = [
    [0.35, 0.40, 0.12, 0.09, 'rgba(90,28,8,0.38)'],
    [0.62, 0.52, 0.26, 0.06, 'rgba(80,22,6,0.45)'],
    [0.77, 0.46, 0.09, 0.08, 'rgba(75,18,5,0.35)'],
    [0.14, 0.43, 0.07, 0.07, 'rgba(100,38,12,0.30)'],
    [0.50, 0.35, 0.06, 0.05, 'rgba(85,25,8,0.28)'],
  ];
  for (const [px, py, rx, ry, c] of patches) {
    ctx.save(); ctx.translate(px * W, py * H); ctx.scale(rx * W, ry * H);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  const ncap = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.11);
  ncap.addColorStop(0, 'rgba(245,245,238,0.97)'); ncap.addColorStop(0.55, 'rgba(230,230,220,0.75)'); ncap.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ncap; ctx.fillRect(0, 0, W, H * 0.15);
  const scap = ctx.createRadialGradient(W / 2, H, 0, W / 2, H, H * 0.09);
  scap.addColorStop(0, 'rgba(248,248,240,0.95)'); scap.addColorStop(0.55, 'rgba(230,228,218,0.65)'); scap.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = scap; ctx.fillRect(0, H * 0.86, W, H * 0.14);
  return new THREE.CanvasTexture(canvas);
}

export function makeMercuryTex() {
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8a7e70'; ctx.fillRect(0, 0, W, H);
  const spots = [
    [0.20, 0.40, 0.12, 'rgba(48,38,28,0.32)'], [0.50, 0.60, 0.10, 'rgba(58,48,35,0.28)'],
    [0.75, 0.34, 0.08, 'rgba(118,108,88,0.38)'], [0.90, 0.62, 0.07, 'rgba(48,38,28,0.22)'],
    [0.35, 0.28, 0.06, 'rgba(108,98,78,0.30)'], [0.62, 0.45, 0.09, 'rgba(42,32,22,0.25)'],
  ];
  for (const [px, py, pr, pc] of spots) {
    const g = ctx.createRadialGradient(px * W, py * H, 0, px * W, py * H, pr * W);
    g.addColorStop(0, pc); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  return new THREE.CanvasTexture(canvas);
}

export function makeVenusTex() {
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#f8e8b0'); base.addColorStop(0.3, '#f0d888');
  base.addColorStop(0.5, '#e8cc78'); base.addColorStop(0.7, '#f0d888');
  base.addColorStop(1, '#f8e8b0');
  ctx.fillStyle = base; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.20;
  for (let y = 0; y < H; y += 3) {
    const wave = Math.sin(y * 0.04) * 18 + Math.sin(y * 0.016) * 12;
    for (let x = 0; x < W; x += 3)
      if (Math.sin((x + wave) * 0.025 + y * 0.012) > 0.5) {
        ctx.fillStyle = Math.sin((x + wave) * 0.025 + y * 0.012) > 0.75 ? 'rgba(215,175,55,1)' : 'rgba(255,240,155,1)';
        ctx.fillRect(x, y, 3, 3);
      }
  }
  ctx.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}

export function makeUranusTex() {
  const W = 256, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#72ccd4'); g.addColorStop(0.35, '#80dce4');
  g.addColorStop(0.5, '#78d2da'); g.addColorStop(0.65, '#80dce4'); g.addColorStop(1, '#72ccd4');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  return new THREE.CanvasTexture(canvas);
}

export function makeNeptuneTex() {
  const W = 256, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2858c8'); g.addColorStop(0.3, '#2048b8');
  g.addColorStop(0.5, '#3060d0'); g.addColorStop(0.7, '#2048b8'); g.addColorStop(1, '#2858c8');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.32;
  for (let y = 0; y < H; y += 4) {
    const wave = Math.sin(y * 0.08) * 6;
    for (let x = 0; x < W; x += 4)
      if (Math.sin((x + wave) * 0.05 + y * 0.02) > 0.62) {
        ctx.fillStyle = 'rgba(148,188,238,1)'; ctx.fillRect(x, y, 4, 2);
      }
  }
  ctx.globalAlpha = 1;
  ctx.save(); ctx.translate(W * 0.55, H * 0.45); ctx.scale(1, 0.5);
  const ds = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.09);
  ds.addColorStop(0, 'rgba(18,28,95,0.88)'); ds.addColorStop(0.7, 'rgba(18,28,95,0.4)'); ds.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ds; ctx.beginPath(); ctx.arc(0, 0, W * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  return new THREE.CanvasTexture(canvas);
}
