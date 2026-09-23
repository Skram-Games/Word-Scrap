/* tileTexture.js — procedural canvas textures for scrap-metal letter tiles.
   No image assets: every tile face is drawn on an offscreen <canvas>, once
   per (letter, variant, colourblind) combination, and cached as a
   THREE.CanvasTexture reused across every tile mesh that needs it.

   VARIANT is a "kind of scrap metal" (steel/copper/aluminum/rusted-iron/
   chrome) chosen per tile at spawn time — this is what gives the pile
   actual material variety instead of every tile being the same dull tan. */
import * as THREE from "three";

const SIZE = 256; // texture resolution per face
const cache = new Map();

export const TILE_VARIANTS = { STEEL: 0, COPPER: 1, ALUMINUM: 2, RUSTED_IRON: 3, CHROME: 4 };

const PALETTES = {
  0: { // steel — the original default look
    grad: ["#8f7863", "#6f5b45", "#4d3d2c"], gradCB: ["#a8927a", "#8d795f", "#6f5d47"],
    rust: "#9a5a2c", rustDark: "#5c3416", rustCB: "#c98a3c", rustDarkCB: "#7a5220",
    rustAmount: 1, metalness: 0.25, roughness: 0.62
  },
  1: { // copper — warm orange-pink, greenish oxidation instead of rust
    grad: ["#b97a4a", "#8a4f2e", "#5f331c"], gradCB: ["#cf9a68", "#a06a3e", "#754824"],
    rust: "#4f7a5c", rustDark: "#2c4a35", rustCB: "#6fa382", rustDarkCB: "#3f6a4d",
    rustAmount: 0.7, metalness: 0.55, roughness: 0.5
  },
  2: { // aluminum — cool grey, brushed, minimal rust (just dark grime)
    grad: ["#c3c7c9", "#9aa0a4", "#6f7679"], gradCB: ["#cdd1d3", "#a6acaf", "#7a8083"],
    rust: "#5a5f61", rustDark: "#33383a", rustCB: "#6a7073", rustDarkCB: "#454a4c",
    rustAmount: 0.35, metalness: 0.65, roughness: 0.4
  },
  3: { // rusted iron — the "worst condition" tile, heavier corrosion
    grad: ["#7a5638", "#5a3a22", "#3a2415"], gradCB: ["#8e6a48", "#6e4c2e", "#4a3020"],
    rust: "#a35a24", rustDark: "#6b3812", rustCB: "#c98a3c", rustDarkCB: "#8a5420",
    rustAmount: 1.5, metalness: 0.1, roughness: 0.88
  },
  4: { // chrome/gold — rare, shiny, mostly clean, sparkle streaks
    // Dialled back from near-mirror (0.92/0.16) which produced a hard,
    // unstable specular highlight that "flickered badly" as the tile
    // tumbled or the pile shook. The "shiny" read now comes from the
    // painted sparkle-streak texture below (a fixed, stable look) rather
    // than a real-time specular response that changes every frame.
    grad: ["#f0d68a", "#c9a24a", "#93722c"], gradCB: ["#f5e2ab", "#d6b566", "#a3823c"],
    rust: "#8a6a2a", rustDark: "#5c4418", rustCB: "#a3823c", rustDarkCB: "#75581f",
    rustAmount: 0.15, metalness: 0.55, roughness: 0.34, sparkle: true
  }
};
function palette(variant) { return PALETTES[variant] || PALETTES[0]; }

// Deterministic pseudo-random per letter so each letter's rust speckle
// pattern is stable across a session instead of re-randomizing every spawn.
function seededRand(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawTileFace(ctx, letter, colourblindSafe, variant) {
  const s = SIZE;
  // seed mixes the letter AND a variant-only term so different metal kinds
  // of the same letter don't share an identical speckle pattern
  const rand = seededRand(letter.charCodeAt(0) * 7919 + variant * 104729);
  const pal = palette(variant);

  // base metal gradient — patchier than a clean brushed sheet, like an
  // offcut that's been sitting outdoors
  const stops = colourblindSafe ? pal.gradCB : pal.grad;
  const grad = ctx.createLinearGradient(0, 0, s, s);
  grad.addColorStop(0, stops[0]);
  grad.addColorStop(0.5, stops[1]);
  grad.addColorStop(1, stops[2]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);

  // low-frequency grime blotches (patchy discolouration, not just noise) —
  // scaled down for the shinier variants, which stay cleaner
  const grimeCount = Math.round(6 * Math.min(1, pal.rustAmount + 0.3));
  for (let i = 0; i < grimeCount; i++) {
    ctx.globalAlpha = 0.08 + rand() * 0.1;
    ctx.fillStyle = rand() > 0.5 ? "#1a120a" : "#3a2a18";
    const gx = rand() * s, gy = rand() * s, gr = 30 + rand() * 60;
    ctx.beginPath();
    ctx.ellipse(gx, gy, gr, gr * (0.5 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // brushed-metal streaks
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = "#ffffff";
  for (let i = 0; i < 46; i++) {
    ctx.lineWidth = 1 + rand() * 1.5;
    const y = rand() * s;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s, y + (rand() - 0.5) * 18);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // scratches — thin, angled, a few brighter ones cutting through the grime
  for (let i = 0; i < 14; i++) {
    ctx.globalAlpha = 0.1 + rand() * 0.22;
    ctx.strokeStyle = rand() > 0.3 ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)";
    ctx.lineWidth = 0.6 + rand() * 1.4;
    const x0 = rand() * s, y0 = rand() * s;
    const ang = rand() * Math.PI * 2, len = 14 + rand() * 46;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // rust/oxidation speckle + blotches — heavier, more saturated, with a
  // darker core per blotch so it reads as corrosion, not just tint. Amount
  // and colour both come from the variant palette (copper oxidises green,
  // aluminum barely rusts at all, chrome almost never does).
  const rustColour = colourblindSafe ? pal.rustCB : pal.rust;
  const rustDark = colourblindSafe ? pal.rustDarkCB : pal.rustDark;
  const rustCount = Math.round(34 * pal.rustAmount);
  for (let i = 0; i < rustCount; i++) {
    const rx = rand() * s, ry = rand() * s, r = 4 + rand() * 16;
    ctx.globalAlpha = 0.14 + rand() * 0.2;
    ctx.fillStyle = rustColour;
    ctx.beginPath();
    ctx.ellipse(rx, ry, r, r * (0.6 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    if (rand() > 0.5) {
      ctx.globalAlpha = 0.18 + rand() * 0.15;
      ctx.fillStyle = rustDark;
      ctx.beginPath();
      ctx.ellipse(rx + (rand() - 0.5) * 4, ry + (rand() - 0.5) * 4, r * 0.45, r * 0.35, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // chrome/gold sparkle — a handful of bright diagonal glints, the tell
  // that marks this tile as the rare shiny one in the pile
  if (pal.sparkle) {
    for (let i = 0; i < 5; i++) {
      ctx.globalAlpha = 0.4 + rand() * 0.4;
      ctx.strokeStyle = "#fff8e0";
      ctx.lineWidth = 2 + rand() * 2;
      const x0 = rand() * s, y0 = rand() * s, len = 20 + rand() * 30;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + len, y0 + len * 0.3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // a torn/chipped hazard-paint corner — small, junkyard-signage flavour,
  // varies which corner per letter so tiles don't look stamped from a mould
  const hazardCorner = Math.floor(rand() * 4);
  const hazardOn = rand() > 0.45;
  if (hazardOn) {
    ctx.save();
    const cx = hazardCorner % 2 === 0 ? 0 : s;
    const cy = hazardCorner < 2 ? 0 : s;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.rect(0, 0, s, s);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    for (let i = -2; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#e0b23a" : "#171310";
      ctx.fillRect(i * 9 - 40, -40, 9, 80);
    }
    ctx.restore();
    ctx.globalAlpha = 0.55; // let the grime/rust show through — chipped, not fresh paint
    ctx.fillStyle = stops[1];
    for (let i = 0; i < 5; i++) {
      const px = cx + (rand() - 0.5) * 60 * (cx === 0 ? 1 : -1);
      const py = cy + (rand() - 0.5) * 60 * (cy === 0 ? 1 : -1);
      ctx.beginPath();
      ctx.ellipse(px, py, 6 + rand() * 10, 6 + rand() * 10, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // bevel edge, deliberately a little uneven (offcut, not machine-perfect)
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, s - 10, s - 10);
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, s - 20, s - 20);
  // a couple of small dark nicks along the edge
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  for (let i = 0; i < 4; i++) {
    const onTop = rand() > 0.5;
    const nx = 20 + rand() * (s - 40);
    ctx.beginPath();
    ctx.ellipse(nx, onTop ? 6 : s - 6, 4 + rand() * 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // rivets in the corners — real dark holes with a metallic highlight ring
  const rv = 22;
  [[rv, rv], [s - rv, rv], [rv, s - rv], [s - rv, s - rv]].forEach(([x, y]) => {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(x, y, 6, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath(); ctx.arc(x - 2, y - 2, 2.6, 0, Math.PI * 2); ctx.fill();
  });

  // welded seam — a rough, slightly glowing line across a random edge,
  // like this tile was cut from something bigger
  if (rand() > 0.4) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = colourblindSafe ? "#e8c98a" : "#d4832f";
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 2.5]);
    const vertical = rand() > 0.5;
    const at = 30 + rand() * (s - 60);
    ctx.beginPath();
    if (vertical) { ctx.moveTo(at, 14); ctx.lineTo(at, s - 14); } else { ctx.moveTo(14, at); ctx.lineTo(s - 14, at); }
    ctx.stroke();
    ctx.restore();
  }

  // stamped letter
  ctx.save();
  ctx.translate(s / 2, s / 2 + 6);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.font = "900 148px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, 4, 4); // drop shadow
  ctx.fillStyle = colourblindSafe ? "#f4ead9" : "#241a10";
  ctx.fillText(letter, 0, 0);
  // a thin worn highlight along the top edge of the stamped letter, as if
  // the paint/stamp caught the light unevenly
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "#fff4d6";
  ctx.fillText(letter, -1, -2);
  ctx.restore();
}

export function getLetterTexture(letter, colourblindSafe, variant) {
  const v = variant == null ? TILE_VARIANTS.STEEL : variant;
  const key = letter + ":" + v + (colourblindSafe ? ":cb" : "");
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  drawTileFace(ctx, letter, colourblindSafe, v);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

export function tileMaterialProps(variant) {
  const pal = palette(variant == null ? TILE_VARIANTS.STEEL : variant);
  return { metalness: pal.metalness, roughness: pal.roughness, isSparkly: !!pal.sparkle };
}

export function clearTextureCache() {
  cache.forEach((t) => t.dispose());
  cache.clear();
}
