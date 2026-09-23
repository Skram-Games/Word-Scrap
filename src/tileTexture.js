/* tileTexture.js — procedural canvas textures for scrap-metal letter tiles.
   No image assets: every tile face is drawn on an offscreen <canvas> once
   per letter and cached, then reused as a THREE.CanvasTexture across every
   tile mesh that needs it (26 textures total, not one per tile). */
import * as THREE from "three";

const SIZE = 256; // texture resolution per face
const cache = new Map();

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

function drawTileFace(ctx, letter, colourblindSafe) {
  const s = SIZE;
  const rand = seededRand(letter.charCodeAt(0) * 7919);

  // base metal gradient
  const grad = ctx.createLinearGradient(0, 0, s, s);
  if (colourblindSafe) {
    grad.addColorStop(0, "#9c8a76");
    grad.addColorStop(1, "#7c6b57");
  } else {
    grad.addColorStop(0, "#8a7460");
    grad.addColorStop(1, "#6b5844");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);

  // brushed-metal streaks
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = "#ffffff";
  for (let i = 0; i < 40; i++) {
    ctx.lineWidth = 1 + rand() * 1.5;
    const y = rand() * s;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s, y + (rand() - 0.5) * 18);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // rust speckle + blotches
  const rustColour = colourblindSafe ? "#c98a3c" : "#9a5a2c";
  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = 0.12 + rand() * 0.18;
    ctx.fillStyle = rustColour;
    const rx = rand() * s, ry = rand() * s, r = 4 + rand() * 14;
    ctx.beginPath();
    ctx.ellipse(rx, ry, r, r * (0.6 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // bevel edge
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, s - 10, s - 10);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, s - 20, s - 20);

  // rivets in the corners
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  const rv = 22;
  [[rv, rv], [s - rv, rv], [rv, s - rv], [s - rv, s - rv]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.arc(x - 2, y - 2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
  });

  // stamped letter
  ctx.save();
  ctx.translate(s / 2, s / 2 + 6);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.font = "900 148px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, 4, 4); // drop shadow
  ctx.fillStyle = colourblindSafe ? "#f4ead9" : "#241a10";
  ctx.fillText(letter, 0, 0);
  ctx.restore();
}

export function getLetterTexture(letter, colourblindSafe) {
  const key = letter + (colourblindSafe ? ":cb" : "");
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  drawTileFace(ctx, letter, colourblindSafe);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

export function clearTextureCache() {
  cache.forEach((t) => t.dispose());
  cache.clear();
}
