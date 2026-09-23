/* main.js — Word Skrap (3D build): boot sequence + game glue.

   Everything engine-specific (rendering, physics) lives in pileWorld.js and
   tileTexture.js. Everything here is the same game — word selection,
   difficulty curve, scoring, menus — ported from the verified 2D canvas
   prototype, with the canvas-hit-testing layer swapped for 3D raycasting
   against the PileWorld.

   IMPORTANT: three/rapier3d-compat are loaded with dynamic import() inside
   loadEngine(), not static top-of-file imports. A static `import ... from
   "three"` that fails to resolve (CDN down, offline, ad-blocker) kills the
   whole module before a single line of our code runs — there's no try/catch
   that can catch that. Dynamic import() rejects into a normal Promise
   instead, which is what lets the #bootError UI ever have a chance to show.
*/

const bootOverlay = document.getElementById("bootOverlay");
const bootLabel = document.getElementById("bootLabel");
const bootSpinner = document.querySelector(".bootSpinner");
const bootError = document.getElementById("bootError");
const bootErrorDetail = document.getElementById("bootErrorDetail");

const BUILD_TAG = "8"; // bump this on every delivered build so cached JS can't masquerade as the new one
let THREE, RAPIER, getLetterTexture, PileWorld, TILE_VARIANTS, tileMaterialProps;

async function loadEngine() {
  bootLabel.textContent = "Loading 3D engine…";
  THREE = await import("three");

  bootLabel.textContent = "Loading physics engine…";
  const RapierMod = await import("rapier3d-compat");
  RAPIER = RapierMod.default || RapierMod;
  await RAPIER.init();

  bootLabel.textContent = "Building world…";
  // Cache-busting query string — browsers (and GitHub Pages) will happily
  // keep serving a stale cached copy of these modules after a file is
  // replaced in the repo otherwise, which has been the cause of at least
  // one "it didn't work" report that was actually just an old build still
  // running. Bump BUILD_TAG any time these files change.
  const tileTextureMod = await import(`./tileTexture.js?v=${BUILD_TAG}`);
  getLetterTexture = tileTextureMod.getLetterTexture;
  TILE_VARIANTS = tileTextureMod.TILE_VARIANTS;
  tileMaterialProps = tileTextureMod.tileMaterialProps;
  ({ PileWorld } = await import(`./pileWorld.js?v=${BUILD_TAG}`));

  if (!window.WS_TIER1 || !window.WS_TIER2) {
    throw new Error("wordskrap-data.js failed to load — keep it in the same folder as index.html.");
  }
}

loadEngine()
  .then(() => {
    bootOverlay.classList.add("hidden");
    runGame();
  })
  .catch((err) => {
    console.error("Word Skrap boot failed:", err);
    bootLabel.style.display = "none";
    if (bootSpinner) bootSpinner.style.display = "none";
    bootError.classList.add("show");
    bootErrorDetail.textContent = (err && err.message) ? err.message : String(err);
  });

/* =========================================================================
   Everything below only ever runs once loadEngine() has succeeded, so
   THREE / RAPIER / getLetterTexture / PileWorld are all safe to use.
   ========================================================================= */
function runGame() {
"use strict";

/* ---------------------------- Word data --------------------------------
   Two tiers, generated offline from the system's real en_US dictionary and
   hand-curated/verified (see wordskrap-data.js's own header comment).
     TIER 1 (window.WS_TIER1) — curated, verified-common + theme words. The
       ONLY pool target words are drawn from, so nobody is ever asked to
       spell something obscure.
     TIER 2 (window.WS_TIER2) — the full filtered dictionary, used only for
       "any valid word" bonus-scoring, never as a required target.
--------------------------------------------------------------------------*/
const WORD_BANK = window.WS_TIER1.byLen;      // {len: [WORD, ...]} — target-eligible only
const FULL_DICT = window.WS_TIER2;            // {len: [WORD, ...]} — validity-only, huge
const ALL_WORDS = (function () {
  const s = new Set();
  Object.values(WORD_BANK).forEach((arr) => arr.forEach((w) => s.add(w)));
  Object.values(FULL_DICT).forEach((arr) => arr.forEach((w) => s.add(w)));
  return s;
})();

// Rotating libraries of feedback text so a bad weld doesn't say the exact
// same "NOT A WORD" every single time — picked at random per fail, never
// twice in a row.
const FAIL_MESSAGES = ["NOT A WORD", "NO SUCH SCRAP", "OOH, CLOSE", "NOT QUITE RIGHT", "MISFIRE", "SCRAP THAT ONE", "NICE TRY"];
const TOO_SHORT_MESSAGES = ["TOO SHORT", "NEED MORE SCRAP", "KEEP BUILDING"];
let lastFailMsg = "";
function pickFailMessage(list) {
  if (list.length === 1) return list[0];
  let msg;
  do { msg = list[Math.floor(Math.random() * list.length)]; } while (msg === lastFailMsg);
  lastFailMsg = msg;
  return msg;
}

const THEMES = [
  { name: "Tool Shed", lens: [3, 4, 5] },
  { name: "Scrapyard", lens: [4, 5, 6] },
  { name: "Machine Shop", lens: [5, 6, 7] },
  { name: "Workshop", lens: [3, 4, 5, 6] },
  { name: "Heavy Haul", lens: [5, 6, 7, 8, 9] },
];

/* ---------------------------- Utility ---------------------------------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function fmtPct(v) { return Math.round(clamp(v, 0, 1) * 100) + "%"; }

/* ---------------------------- Persistence ------------------------------ */
const STORAGE_KEY = "wordskrap_save_v1";
function defaultSave() {
  return {
    bestScore: 0, wordsWelded: 0, streak: 0, lastPlayDate: null,
    settings: { sfx: true, music: true, shake: true, reduceMotion: false, colourblind: false, hintLevel: 1, startDiff: "standard", quality: "auto" }
  };
}
function loadSave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw);
    const d = defaultSave();
    // deep-ish merge so a save written before a new setting existed (e.g.
    // "quality", added in the 3D build) still picks up its default instead
    // of losing the whole settings object to a shallow Object.assign.
    return Object.assign(d, parsed, { settings: Object.assign(d.settings, parsed.settings || {}) });
  } catch (e) { return defaultSave(); }
}
let SAVE = loadSave();
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(SAVE)); } catch (e) { /* best effort */ }
}

/* ---------------------------- Difficulty curve -------------------------- */
// Redesigned so each level asks for exactly ONE target word, sized to
// wordLen — the belt is built with exactly that many slots, so there's
// never ambiguity about "maybe a 4 or maybe 5 letter word". Pile size now
// grows much more steeply than the word length: early levels are a small,
// quick sieve; later levels bury the target letters in a much bigger pile.
function levelConfig(level, startDiff) {
  const diffOffset = startDiff === "relaxed" ? -1 : startDiff === "scrapper" ? 1 : 0;
  const L = Math.max(1, level + diffOffset);
  const theme = THEMES[(level - 1) % THEMES.length];
  // One word per level. Starts at 3 letters, climbs roughly one letter
  // every 2 levels, capped at 9.
  const wordLen = clamp(3 + Math.floor((L - 1) / 2), 3, 9);
  // Early levels: a small, almost-bare pile (mostly just the target's own
  // letters) so a new player can find them at a glance. Later levels bury
  // the word in a much bigger, noisier pile — a real sieve.
  const pileSize = clamp(wordLen + 4 + L * 3, wordLen + 4, 60);
  const badWeldDamage = clamp(14 + Math.floor(L / 3) * 2, 14, 26);
  const timerSeconds = L >= 4 ? clamp(70 - L * 2, 30, 70) : null;
  const magnetsAwarded = level === 1 ? 3 : (level % 3 === 0 ? 1 : 0);
  return { level, theme, wordLen, pileSize, badWeldDamage, timerSeconds, magnetsAwarded };
}
function chooseTargetWord(rng, cfg) {
  const bank = WORD_BANK[cfg.wordLen];
  if (bank && bank.length) return pick(rng, bank);
  // Fallback: the validity-only dictionary keyed by length the same way.
  const wide = FULL_DICT[cfg.wordLen];
  if (wide && wide.length) return pick(rng, wide);
  return pick(rng, WORD_BANK[4] || WORD_BANK[3]);
}
const LETTER_FREQ = "EEEEEEEEEAAAAAAAARRRRRRRIIIIIIIOOOOOOOTTTTTTTNNNNNNSSSSSSLLLLLCCCCUUUUDDDDPPPMMMHHHGGBBFFYYWWKVXZJQ";
function buildPileLetters(rng, cfg, targetWords) {
  const letters = [];
  targetWords.forEach((w) => letters.push(...w.split("")));
  while (letters.length < cfg.pileSize) letters.push(LETTER_FREQ[Math.floor(rng() * LETTER_FREQ.length)]);
  return shuffle(rng, letters).slice(0, Math.max(cfg.pileSize, letters.length));
}

/* ---------------------------- Sound (WebAudio, synthesized) ------------- */
const Sound = (function () {
  let ctx = null;
  function ensureCtx() { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } } return ctx; }
  function tone(freq, dur, type, gain, when) {
    if (!SAVE.settings.sfx) return;
    const c = ensureCtx(); if (!c) return;
    const t0 = c.currentTime + (when || 0);
    const osc = c.createOscillator(); const g = c.createGain();
    osc.type = type || "sine"; osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain || 0.2, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g); g.connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  return {
    pickup() { tone(320, 0.06, "square", 0.08); },
    place() { tone(220, 0.05, "square", 0.09); },
    weldGood() { tone(520, 0.09, "sawtooth", 0.15); tone(780, 0.12, "sine", 0.12, 0.05); tone(1040, 0.14, "sine", 0.1, 0.09); },
    weldBad() { tone(140, 0.18, "square", 0.14); tone(90, 0.22, "square", 0.1, 0.05); },
    levelUp() { [440, 554, 659, 880].forEach((f, i) => tone(f, 0.16, "triangle", 0.12, i * 0.08)); },
    magnet() { tone(660, 0.05, "sine", 0.1); tone(880, 0.07, "sine", 0.1, 0.05); },
    click() { tone(300, 0.03, "square", 0.06); }
  };
})();

/* ============================== 3D SCENE ================================ */
const root = document.getElementById("gameRoot");
const canvas = document.getElementById("glCanvas");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc97a3f);
scene.fog = new THREE.Fog(0xc97a3f, 13, 34);

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
// Pulled back further still — the previous framing left the pit filling
// almost the whole screen with nothing of the yard around it visible.
// Wider FOV + more distance brings the ground/junk scatter and belt into
// frame at the same time as the pit.
const CAM_BASE = new THREE.Vector3(0, 11.2, 13.2);
const CAM_LOOKAT = new THREE.Vector3(0, 0.4, 0);
camera.position.copy(CAM_BASE);
camera.lookAt(CAM_LOOKAT);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const hemi = new THREE.HemisphereLight(0xfff2d8, 0x2a1810, 0.85);
scene.add(hemi);
const dirLight = new THREE.DirectionalLight(0xffdca8, 1.15);
dirLight.position.set(4, 8, 3);
dirLight.shadow.mapSize.set(1024, 1024);
dirLight.shadow.camera.left = -6; dirLight.shadow.camera.right = 6;
dirLight.shadow.camera.top = 6; dirLight.shadow.camera.bottom = -6;
dirLight.shadow.camera.near = 1; dirLight.shadow.camera.far = 20;
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.22);
fillLight.position.set(-5, 3, -4);
scene.add(fillLight);

// A focused spot aimed straight down into the pit — the pile's middle was
// reading flat under just the two directional lights, "a bowl of cereal"
// as described. This gives the tiles real shadow/depth in the center.
// Widened and softened from the original tight cone — a narrow, hard-edged
// spotlight pool on the ground creates its own visible circular boundary
// (a bright disc against a darker surround) even with no "bowl" geometry
// drawn at all, which is exactly the leftover "pit" look reported after
// the container mesh was removed. A wide, soft-edged cone plus a touch
// more ambient fill keeps the pile well-lit without drawing a ring.
const pitSpot = new THREE.SpotLight(0xffe3b0, 1.6, 20, Math.PI / 2.4, 0.95, 1.1);
pitSpot.position.set(0.4, 8.4, 2.6);
pitSpot.target.position.set(0, 0.1, 0);
scene.add(pitSpot);
scene.add(pitSpot.target);

/* ---------------------------- Junkyard backdrop ---------------------------
   A single billboard plane behind the pit with a painted silhouette skyline
   (crane, stacked car husks, a fence line) so the background reads as a
   place, not a flat colour field. Cheap — one extra draw call, no new
   dependency, no risk to the physics/boot sequence. */
function buildSkylineBackdrop() {
  const w = 1024, h = 420;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const bctx = c.getContext("2d");
  const sky = bctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#e8ad63"); sky.addColorStop(0.55, "#c97a3f"); sky.addColorStop(1, "#a35a30");
  bctx.fillStyle = sky; bctx.fillRect(0, 0, w, h);

  bctx.fillStyle = "rgba(30,16,8,0.55)";
  // distant hazy hill line
  bctx.beginPath(); bctx.moveTo(0, h * 0.62);
  for (let x = 0; x <= w; x += 40) bctx.lineTo(x, h * 0.62 - Math.sin(x * 0.01) * 14 - 6);
  bctx.lineTo(w, h); bctx.lineTo(0, h); bctx.closePath(); bctx.fill();

  // stacked crushed-car silhouettes
  bctx.fillStyle = "rgba(15,8,4,0.72)";
  const stackX = [90, 250, 430, 700, 860];
  stackX.forEach((sx, i) => {
    const blocks = 2 + (i % 3);
    for (let b = 0; b < blocks; b++) {
      const bw = 70 + (b % 2) * 10, bh = 34;
      bctx.fillRect(sx - bw / 2, h * 0.62 - (b + 1) * bh, bw, bh - 3);
    }
  });

  // a crane silhouette
  bctx.strokeStyle = "rgba(15,8,4,0.8)"; bctx.lineWidth = 6; bctx.lineCap = "round";
  bctx.beginPath();
  bctx.moveTo(600, h * 0.62); bctx.lineTo(600, h * 0.2);
  bctx.lineTo(760, h * 0.24);
  bctx.moveTo(600, h * 0.34); bctx.lineTo(690, h * 0.3);
  bctx.stroke();
  bctx.fillStyle = "rgba(15,8,4,0.8)";
  bctx.beginPath(); bctx.moveTo(748, h * 0.24); bctx.lineTo(742, h * 0.36); bctx.lineTo(756, h * 0.36); bctx.closePath(); bctx.fill();

  // chain-link fence line across the foreground
  bctx.strokeStyle = "rgba(20,12,6,0.35)"; bctx.lineWidth = 1.5;
  for (let x = -20; x < w + 40; x += 26) { bctx.beginPath(); bctx.moveTo(x, h * 0.6); bctx.lineTo(x + 40, h * 0.72); bctx.stroke(); }

  const tex = new THREE.CanvasTexture(c);
  // fog:false — the plane's own painted gradient already fades to the same
  // hue at its base, and the scene fog is the SAME colour as scene.background,
  // so with fog on this plane was blending into total invisibility at its
  // distance. Unlit + fog-exempt keeps the silhouette readable at all times.
  const mat = new THREE.MeshBasicMaterial({ map: tex, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(30, 12.3), mat);
  mesh.position.set(0, 4.6, -10.5);
  scene.add(mesh);
}
buildSkylineBackdrop();

/* ---------------------------- Scrapyard ground + heaps ---------------------
   With the pit's own drum/rim visuals removed (see pileWorld.js), the
   clearing where tiles land needs to read as bounded by the YARD itself —
   scrap heaps, machinery and a bit of green pressing in close around an
   open patch — rather than by any container. Three rings: a close band of
   junk right at the tile-physics radius (so the eye reads "that's the
   edge"), a mid band of bigger heaps/machinery for depth, and scattered
   weeds/plants throughout for a lived-in, non-industrial-showroom feel. */
function buildYardGround() {
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.95, metalness: 0.05 });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(18, 48), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  const junkMat = new THREE.MeshStandardMaterial({ color: 0x2c2016, roughness: 0.9, metalness: 0.25 });
  const junkMat2 = new THREE.MeshStandardMaterial({ color: 0x5a3a20, roughness: 0.85, metalness: 0.15 });
  const rustMat = new THREE.MeshStandardMaterial({ color: 0x7a4322, roughness: 0.8, metalness: 0.3 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4c6b34, roughness: 0.95, metalness: 0.02 });
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x3a2f1c, roughness: 0.9, metalness: 0.05 });

  function scatterPiece(x, z) {
    const kind = Math.random();
    let mesh;
    if (kind < 0.3) {
      mesh = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.11, 8, 14), junkMat);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = 0.11;
    } else if (kind < 0.6) {
      const h = 0.5 + Math.random() * 0.5;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, h, 0.55), Math.random() < 0.5 ? junkMat : junkMat2);
      mesh.rotation.y = Math.random() * Math.PI;
      mesh.position.y = h / 2;
    } else if (kind < 0.8) {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.9, 10), junkMat2);
      mesh.position.y = 0.45;
    } else {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 10), rustMat);
      mesh.position.y = 0.25;
    }
    mesh.position.x = x; mesh.position.z = z;
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // A rough clump of scrap-metal "weed" — three or four flat leaf-shaped
  // planes fanned around a thin stem — pushing up between the junk, the
  // way real reclaimed lots always have green breaking through.
  function scatterPlant(x, z) {
    const group = new THREE.Group();
    const stemH = 0.35 + Math.random() * 0.35;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, stemH, 5), stemMat);
    stem.position.y = stemH / 2;
    group.add(stem);
    const leaves = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < leaves; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.38, 4), leafMat);
      const ang = (i / leaves) * Math.PI * 2 + Math.random() * 0.4;
      leaf.position.set(Math.cos(ang) * 0.05, stemH * (0.5 + Math.random() * 0.5), Math.sin(ang) * 0.05);
      leaf.rotation.z = Math.cos(ang) * 0.5;
      leaf.rotation.x = Math.sin(ang) * 0.5;
      group.add(leaf);
    }
    group.position.set(x, 0, z);
    group.castShadow = true;
    scene.add(group);
  }

  // Close ring — right at the physics leash radius, sells "that dark strip
  // IS the edge of the clearing" without any drawn wall at all.
  const CLOSE_R = 3.15;
  for (let i = 0; i < 22; i++) {
    const ang = (i / 22) * Math.PI * 2 + Math.random() * 0.15;
    const dist = CLOSE_R + Math.random() * 0.6;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    if (z > 0.4) continue; // keep the camera-facing near side clear so the pile stays fully visible
    if (Math.random() < 0.3) scatterPlant(x, z); else scatterPiece(x, z);
  }

  // Mid ring — bigger heaps and simple "machinery" silhouettes for depth.
  const ringR = 5.6;
  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2 + 0.2;
    const dist = ringR + Math.random() * 3.4;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    if (z > 2) continue; // keep the near camera-facing arc clear
    if (Math.random() < 0.22) {
      buildMachineSilhouette(x, z);
    } else {
      // a small heap: 3-5 overlapping pieces clustered together
      const n = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < n; j++) scatterPiece(x + (Math.random() - 0.5) * 1.1, z + (Math.random() - 0.5) * 1.1);
      if (Math.random() < 0.4) scatterPlant(x + (Math.random() - 0.5) * 1.3, z + (Math.random() - 0.5) * 1.3);
    }
  }
}

// A simple blocky "machine" — a crusher/press or old generator silhouette —
// dropped at a few points in the mid-ring for visible machinery beyond the
// crane, per the "various plant, machinery visible" brief.
function buildMachineSilhouette(x, z) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x35291a, roughness: 0.8, metalness: 0.4 });
  const hazardMat = new THREE.MeshStandardMaterial({ color: 0xb5651d, roughness: 0.6, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.5, 1.1), bodyMat);
  body.position.y = 0.75;
  group.add(body);
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.35, 0.9, 8), bodyMat);
  funnel.position.set(0, 1.9, 0);
  group.add(funnel);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.16, 1.12), hazardMat);
  stripe.position.y = 1.35;
  group.add(stripe);
  [[-0.55, -0.45], [0.55, -0.45], [-0.55, 0.45], [0.55, 0.45]].forEach(([lx, lz]) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 6), bodyMat);
    leg.position.set(lx, 0.15, lz);
    group.add(leg);
  });
  group.position.set(x, 0, z);
  group.rotation.y = Math.random() * Math.PI * 2;
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(group);
}
buildYardGround();

/* ---------------------------- Ambient dust motes ---------------------------
   A light drifting particle field for atmosphere — no interaction, just
   life in the scene so it never looks static. */
function buildDustField() {
  const COUNT = 90;
  const dotCanvas = document.createElement("canvas");
  dotCanvas.width = 16; dotCanvas.height = 16;
  const dctx = dotCanvas.getContext("2d");
  const g = dctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, "rgba(255,232,190,0.9)"); g.addColorStop(1, "rgba(255,232,190,0)");
  dctx.fillStyle = g; dctx.fillRect(0, 0, 16, 16);
  const dotTex = new THREE.CanvasTexture(dotCanvas);

  const positions = new Float32Array(COUNT * 3);
  const speeds = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 9;
    positions[i * 3 + 1] = Math.random() * 6;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 9;
    speeds[i] = 0.15 + Math.random() * 0.35;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ map: dotTex, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  return { points, positions, speeds, count: COUNT };
}
const dustField = buildDustField();

/* ---------------------------- Weld spark burst ----------------------------
   A quick expanding/fading burst of points at a successful weld, so the
   reward lands in the 3D scene instead of only ever showing up as a DOM
   toast bolted on top of it. Fired-and-forgotten: each burst removes
   itself from the scene once its lifetime is up. */
const WELD_FX_POINT = new THREE.Vector3(0, 0.9, 2.1); // front of the pit, near the weld control panel
const activeBursts = [];
function spawnWeldBurst() {
  const n = 22;
  const positions = new Float32Array(n * 3);
  const velocities = [];
  for (let i = 0; i < n; i++) {
    positions[i * 3] = WELD_FX_POINT.x; positions[i * 3 + 1] = WELD_FX_POINT.y; positions[i * 3 + 2] = WELD_FX_POINT.z;
    const ang = Math.random() * Math.PI * 2, spd = 1.2 + Math.random() * 2.2;
    velocities.push({ x: Math.cos(ang) * spd, y: 1.5 + Math.random() * 2, z: Math.sin(ang) * spd });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffcf7a, size: 0.11, transparent: true, opacity: 1, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  activeBursts.push({ points, velocities, age: 0, life: 0.6 });
}
function updateWeldBursts(dt) {
  for (let i = activeBursts.length - 1; i >= 0; i--) {
    const b = activeBursts[i];
    b.age += dt;
    const pos = b.points.geometry.attributes.position;
    for (let j = 0; j < b.velocities.length; j++) {
      const v = b.velocities[j];
      v.y -= 3.5 * dt;
      pos.setX(j, pos.getX(j) + v.x * dt);
      pos.setY(j, pos.getY(j) + v.y * dt);
      pos.setZ(j, pos.getZ(j) + v.z * dt);
    }
    pos.needsUpdate = true;
    b.points.material.opacity = Math.max(0, 1 - b.age / b.life);
    if (b.age >= b.life) {
      scene.remove(b.points);
      b.points.geometry.dispose(); b.points.material.dispose();
      activeBursts.splice(i, 1);
    }
  }
}
// A quick flash/spark burst at the crane's grab point when it releases a
// batch, so a drop reads as a deliberate event rather than tiles quietly
// appearing out of nowhere.
function spawnCraneBurst() {
  const n = 14;
  const positions = new Float32Array(n * 3);
  const velocities = [];
  for (let i = 0; i < n; i++) {
    positions[i * 3] = DROP_POINT.x; positions[i * 3 + 1] = DROP_POINT.y; positions[i * 3 + 2] = DROP_POINT.z;
    const ang = Math.random() * Math.PI * 2, spd = 0.4 + Math.random() * 1.1;
    velocities.push({ x: Math.cos(ang) * spd, y: -0.5 - Math.random() * 1.5, z: Math.sin(ang) * spd });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xf0a94e, size: 0.1, transparent: true, opacity: 1, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  activeBursts.push({ points, velocities, age: 0, life: 0.5 });
}
function updateDustField(dt) {
  const pos = dustField.points.geometry.attributes.position;
  for (let i = 0; i < dustField.count; i++) {
    let y = pos.getY(i) + dustField.speeds[i] * dt;
    if (y > 6) y = 0;
    pos.setY(i, y);
    pos.setX(i, pos.getX(i) + Math.sin(y * 2 + i) * dt * 0.05);
  }
  pos.needsUpdate = true;
}

const pileWorld = new PileWorld(THREE, RAPIER, scene, {
  radius: 3.0, wallHeight: 2.3, colourblindSafe: SAVE.settings.colourblind
});

/* ---------------------------- Crane rig (replaces the conveyor) -----------
   The belt is gone — letters now arrive the way the brief asked for: a
   crane swings a grab in from above and drops a handful of fresh tiles
   straight down into the pile at once, rather than a continuous single-file
   drip. This is a static crane silhouette (arm + cable + open grab) parked
   above the clearing; Game.prototype.spawnDripBatch (still driven by the
   same accumulator/interval fields as before) spawns 3-5 tiles at once at
   DROP_POINT with a little scatter and a real fall, and spawnWeldBurst-style
   sparks mark the drop so it reads as an event, not a random pop-in. */
const DROP_POINT = new THREE.Vector3(0.2, 9.4, -0.6);

function buildCraneRig() {
  const group = new THREE.Group();
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 0.6, metalness: 0.6 });
  const hazardMat = new THREE.MeshStandardMaterial({ color: 0xd4832f, roughness: 0.55, metalness: 0.4 });

  // Tower + horizontal jib, anchored back near the skyline and reaching out
  // over the clearing to DROP_POINT.
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.5, 10.5, 0.5), steelMat);
  tower.position.set(-2.6, 5.25, -6.4);
  tower.castShadow = true;
  group.add(tower);

  const jibLen = 8.4;
  const jib = new THREE.Mesh(new THREE.BoxGeometry(jibLen, 0.42, 0.42), steelMat);
  jib.position.set(-2.6 + jibLen * 0.42, 10.1, -6.4 + jibLen * 0.1);
  jib.rotation.y = -0.12;
  jib.castShadow = true;
  group.add(jib);

  const counterJib = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.4, 0.4), steelMat);
  counterJib.position.set(-3.6, 10.1, -6.9);
  group.add(counterJib);
  const counterweight = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), hazardMat);
  counterweight.position.set(-4.5, 9.7, -7.1);
  group.add(counterweight);

  // Cable + open grab hanging down to DROP_POINT.
  const cableMat = new THREE.MeshBasicMaterial({ color: 0x18120b, fog: false });
  const cableLen = 10.1 - DROP_POINT.y + 0.6;
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, cableLen, 6), cableMat);
  cable.position.set(DROP_POINT.x, DROP_POINT.y + cableLen / 2, DROP_POINT.z);
  group.add(cable);

  const grabMat = new THREE.MeshStandardMaterial({ color: 0x22190f, roughness: 0.7, metalness: 0.55 });
  const grabGroup = new THREE.Group();
  grabGroup.position.set(DROP_POINT.x, DROP_POINT.y + 0.3, DROP_POINT.z);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.2, 10), grabMat);
  grabGroup.add(hub);
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55, 6), grabMat);
    claw.position.set(Math.cos(ang) * 0.18, -0.32, Math.sin(ang) * 0.18);
    claw.rotation.x = Math.cos(ang) * 0.5;
    claw.rotation.z = Math.sin(ang) * -0.5;
    grabGroup.add(claw);
  }
  group.add(grabGroup);

  scene.add(group);
  return { group, grabGroup, jib };
}
const craneRig = buildCraneRig();

function applyGraphicsQuality() {
  const q = SAVE.settings.quality || "auto";
  const cap = q === "low" ? 1 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
  const shadowsOn = q !== "low";
  renderer.shadowMap.enabled = shadowsOn;
  dirLight.castShadow = shadowsOn;
}
function resize() {
  const rect = root.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();
applyGraphicsQuality();

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function toNDC(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  return ndc;
}

/* ---------------------- parking tiles that are on the belt --------------
   The belt itself is a DOM strip (see renderBelt below), not a 3D object —
   a tile "on the belt" is physically parked out of the way: frozen
   (kinematic, so it costs nothing and can't be shoved by falling pile
   tiles) and hidden, tucked below the drum. Bringing it back re-teleports
   it into the pile and switches it back to dynamic so gravity takes over.
--------------------------------------------------------------------------*/
function parkEntity(entity) {
  pileWorld.setHeld(entity, true);
  pileWorld.dragTo(entity, { x: 0, y: -25, z: 0 });
  entity.mesh.visible = false;
}
function unparkEntity(entity, rng) {
  const p = pileWorld.randomDropPoint(rng);
  entity.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
  entity.mesh.visible = true;
  pileWorld.setHeld(entity, false);
  entity.body.setLinvel({ x: (rng() - 0.5) * 2, y: 0, z: (rng() - 0.5) * 2 }, true);
}
function setHintVisual(entity, on) {
  if (!entity.mesh) return;
  const mats = Array.isArray(entity.mesh.material) ? entity.mesh.material : [entity.mesh.material];
  mats.forEach((m) => {
    if (!m.emissive) return;
    // Re-tuned a second time: 0.45 was "way too bright", but the follow-up
    // 0.14 dimmed it into invisibility ("no hints at all"). Settling on a
    // brighter warm amber at a still-modest intensity — noticeable as a
    // "this one glows a little" cue without lighting up the whole pit.
    m.emissive.setHex(on ? 0xd88a2e : 0x000000);
    m.emissiveIntensity = on ? 0.28 : 0;
  });
}
function retextureEntity(entity) {
  const tex = getLetterTexture(entity.letter, pileWorld.colourblindSafe, entity.variant);
  const mats = Array.isArray(entity.mesh.material) ? entity.mesh.material : [entity.mesh.material];
  mats.forEach((m) => { m.map = tex; m.needsUpdate = true; });
}
// Weighted pick of a "kind of scrap metal" for a newly-spawned tile —
// mostly ordinary steel/copper/aluminum/rusted-iron, with a rare (5%)
// chrome/gold tile as a little visual treat to notice in the pile.
function pickTileVariant() {
  const r = Math.random();
  if (r < 0.05) return TILE_VARIANTS.CHROME;
  if (r < 0.30) return TILE_VARIANTS.RUSTED_IRON;
  if (r < 0.55) return TILE_VARIANTS.ALUMINUM;
  if (r < 0.78) return TILE_VARIANTS.COPPER;
  return TILE_VARIANTS.STEEL;
}
function applyColourblindSetting() {
  pileWorld.colourblindSafe = SAVE.settings.colourblind;
  pileWorld.entities.forEach(retextureEntity);
}

/* ============================== GAME ===================================== */
function Game() {
  this.state = "title"; // title | playing | paused | levelcomplete | gameover
  this.mode = "haul";   // haul | endless
  this.rng = mulberry32(Date.now() >>> 0);
  this.level = 1;
  this.score = 0;
  this.integrity = 100;
  this.combo = 0; this.bestCombo = 0;
  this.magnets = 0;
  this.cfg = null;
  this.targets = [];
  this.belt = [];
  this.beltSlotCount = 8;
  this.timeLeft = null;
  this.shakeT = 0;
  // Sieve mechanic: every so often the crane drops a handful of filler
  // tiles into the pile, mostly irrelevant letters so there's always
  // something to dig through rather than the pit draining down to just
  // the letters you need.
  this.dripAccum = 0;
  this.dripInterval = 10 + Math.random() * 6;
  this.fillerCap = 24;
}
Game.prototype.startHaul = function (level, mode) {
  this.mode = mode || "haul";
  this.level = level || 1;
  // Score persists across levels within one run (both modes) — a fresh
  // Game() already starts at 0, so no reset happens here.
  this.integrity = 100;
  this.combo = 0; this.bestCombo = 0;
  this.rng = mulberry32(((Date.now() >>> 0) ^ (this.level * 2654435761)) >>> 0);
  this.cfg = levelConfig(this.level, SAVE.settings.startDiff);
  // One target word per level — the belt is sized to exactly its length,
  // so there's never a "maybe 4 or maybe 5 letters" ambiguity.
  this.targets = [{ word: chooseTargetWord(this.rng, this.cfg), done: false }];
  this.beltSlotCount = this.cfg.wordLen;
  this.belt = new Array(this.beltSlotCount).fill(null);
  this.magnets = (this.magnets || 0) + this.cfg.magnetsAwarded;
  if (this.level === 1 && this.mode === "haul") this.magnets = this.cfg.magnetsAwarded;
  this.timeLeft = this.cfg.timerSeconds;
  this.fillerCap = clamp(this.cfg.pileSize + 14, 24, 60);
  this.dripAccum = 0;
  this.dripInterval = 10 + Math.random() * 6;

  // clear last level's tiles out of the physics world before spawning new ones
  pileWorld.entities.slice().forEach((e) => pileWorld.removeTile(e));

  const letters = buildPileLetters(this.rng, this.cfg, this.targets.map((t) => t.word));
  letters.forEach((L) => {
    const p = pileWorld.randomDropPoint(this.rng);
    const vel = { x: (this.rng() - 0.5) * 1.5, y: -1 - this.rng(), z: (this.rng() - 0.5) * 1.5 };
    const variant = pickTileVariant();
    pileWorld.spawnTile(L, p, getLetterTexture, vel, variant, tileMaterialProps(variant));
  });

  this.applyHints();
  this.state = "playing";
  renderTargets(this);
  renderBelt(this);
  updateHUD(this);
  showOverlay(null);
};
Game.prototype.applyHints = function () {
  const need = {};
  this.targets.filter((t) => !t.done).forEach((t) => t.word.split("").forEach((ch) => (need[ch] = (need[ch] || 0) + 1)));
  const remaining = Object.assign({}, need);
  pileWorld.entities.forEach((e) => { e.hint = false; setHintVisual(e, false); });
  pileWorld.entities.forEach((e) => {
    if (e.onBelt) return;
    if (remaining[e.letter] > 0) { e.hint = true; remaining[e.letter]--; setHintVisual(e, true); }
  });
};
Game.prototype.tick = function (dt) {
  if (this.state !== "playing") return;
  pileWorld.step(dt);
  if (this.timeLeft != null) {
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.damageIntegrity(8, true); this.resetSoftTimer(); }
  }
  this.dripAccum += dt;
  if (this.dripAccum >= this.dripInterval) {
    this.dripAccum = 0;
    this.dripInterval = 10 + Math.random() * 6;
    this.spawnDripBatch();
  }
};
// The crane swings over and drops a HANDFUL of fresh tiles at once, rather
// than a continuous single-file drip — matches "a handful at a time" and
// reads as a real event (crane grab flash + a little scatter/thud) instead
// of a steady trickle nobody notices.
Game.prototype.spawnDripBatch = function () {
  const alive = pileWorld.entities.length;
  if (alive >= this.fillerCap) return;
  const batchSize = Math.min(3 + Math.floor(Math.random() * 3), this.fillerCap - alive);
  if (batchSize <= 0) return;
  const need = {};
  this.targets.filter((t) => !t.done).forEach((t) => t.word.split("").forEach((ch) => (need[ch] = (need[ch] || 0) + 1)));
  const needed = Object.keys(need).filter((ch) => need[ch] > 0);
  for (let i = 0; i < batchSize; i++) {
    // Mostly noise, but not ONLY noise — every so often the crane drops
    // something you actually need, so digging through the junk pays off.
    const letter = (Math.random() < 0.2 && needed.length)
      ? needed[Math.floor(Math.random() * needed.length)]
      : LETTER_FREQ[Math.floor(Math.random() * LETTER_FREQ.length)];
    const spawnP = {
      x: DROP_POINT.x + (Math.random() - 0.5) * 1.1,
      y: DROP_POINT.y + Math.random() * 0.6,
      z: DROP_POINT.z + (Math.random() - 0.5) * 1.1,
    };
    const vel = { x: (Math.random() - 0.5) * 0.6, y: -1 - Math.random(), z: (Math.random() - 0.5) * 0.6 };
    const variant = pickTileVariant();
    pileWorld.spawnTile(letter, spawnP, getLetterTexture, vel, variant, tileMaterialProps(variant));
  }
  spawnCraneBurst();
  this.applyHints();
};
Game.prototype.resetSoftTimer = function () { this.timeLeft = this.cfg.timerSeconds; };
Game.prototype.damageIntegrity = function (amount) {
  this.integrity = clamp(this.integrity - amount, 0, 100);
  updateHUD(this);
  if (this.integrity <= 0) this.onGameOver();
};
Game.prototype.onGameOver = function () {
  this.state = "gameover";
  SAVE.wordsWelded = SAVE.wordsWelded || 0;
  if (this.score > SAVE.bestScore) SAVE.bestScore = this.score;
  persist();
  document.getElementById("goScore").textContent = this.score;
  document.getElementById("goLevel").textContent = this.level;
  document.getElementById("goNewBest").textContent = SAVE.bestScore;
  showOverlay("overlay-gameover");
};
Game.prototype.pickupFromPile = function (entity) {
  entity.held = true;
  pileWorld.setHeld(entity, true);
  Sound.pickup();
};
Game.prototype.placeOnBelt = function (entity, slotIndex) {
  if (slotIndex == null || this.belt[slotIndex]) slotIndex = this.belt.findIndex((s) => s === null);
  if (slotIndex < 0) { this.returnToPile(entity); return; }
  entity.held = false; entity.onBelt = true;
  this.belt[slotIndex] = entity;
  parkEntity(entity);
  Sound.place();
  renderBelt(this);
};
Game.prototype.returnToPile = function (entity) {
  if (entity.onBelt) {
    const idx = this.belt.indexOf(entity);
    if (idx >= 0) this.belt[idx] = null;
    entity.onBelt = false;
  }
  entity.held = false;
  unparkEntity(entity, this.rng);
  renderBelt(this);
};
Game.prototype.currentBeltWord = function () {
  return this.belt.filter((e) => e !== null).map((e) => e.letter).join("");
};
Game.prototype.clearBelt = function () {
  this.belt.forEach((e) => { if (e) this.returnToPile(e); });
  this.belt = new Array(this.beltSlotCount).fill(null);
  renderBelt(this);
};
Game.prototype.attemptWeld = function () {
  const word = this.currentBeltWord();
  // An empty belt isn't a failed attempt, it's a non-attempt — no sound, no
  // toast, no integrity hit. (Previously this fell through to weldFail and
  // let the player grind their own integrity down by mashing an empty Weld.)
  if (word.length === 0) return;
  if (word.length < 3) { this.weldFail(pickFailMessage(TOO_SHORT_MESSAGES)); return; }
  // The target word's letters are shown only as hint-glows, not its exact
  // order — the player is meant to rearrange found letters into ANY valid
  // word from that letter set, not guess one specific permutation blind.
  // So a target "solve" is: same letters as the target (any order) AND a
  // real word. Matching only the one stored spelling meant a player could
  // weld a different, equally valid anagram of the right letters forever
  // and never progress — that's the bug just reported.
  const canon = (s) => s.split("").sort().join("");
  const wordCanon = canon(word);
  const isValid = ALL_WORDS.has(word);
  const targetMatch = this.targets.find((t) => !t.done && canon(t.word) === wordCanon && isValid);
  if (targetMatch) {
    targetMatch.done = true;
    this.combo++; this.bestCombo = Math.max(this.bestCombo, this.combo);
    const base = 10 * word.length;
    const comboBonus = Math.floor(base * 0.2 * (this.combo - 1));
    this.score += base + comboBonus;
    Sound.weldGood();
    spawnWeldBurst();
    showToast("WELDED!", "#9dffb0");
    if (comboBonus > 0) floatCombo(`+${this.combo} COMBO`);
    this.consumeBeltTiles();
    updateHUD(this);
    renderTargets(this);
    this.applyHints();
    if (this.targets.every((t) => t.done)) this.onLevelComplete();
  } else if (isValid) {
    const base = 4 * word.length;
    this.score += base;
    Sound.weldGood();
    spawnWeldBurst();
    showToast("NICE SALVAGE", "#f0a94e");
    this.consumeBeltTiles();
    updateHUD(this);
    this.applyHints();
  } else {
    this.weldFail(pickFailMessage(FAIL_MESSAGES));
  }
};
Game.prototype.weldFail = function (msg) {
  this.combo = 0;
  Sound.weldBad();
  showToast(msg || "FIZZLE", "#ff8b7a");
  if (SAVE.settings.shake) this.shakeT = 0.35;
  this.scatterBelt();
  this.damageIntegrity(this.cfg.badWeldDamage);
  updateHUD(this);
};
Game.prototype.consumeBeltTiles = function () {
  this.belt.forEach((e, i) => {
    if (e) { pileWorld.removeTile(e); this.belt[i] = null; }
  });
  SAVE.wordsWelded = (SAVE.wordsWelded || 0) + 1;
  renderBelt(this);
};
Game.prototype.scatterBelt = function () {
  this.belt.forEach((e) => {
    if (!e) return;
    e.onBelt = false; e.held = false;
    const p = pileWorld.randomDropPoint(this.rng);
    e.body.setTranslation({ x: p.x, y: p.y + 0.4, z: p.z }, true);
    e.mesh.visible = true;
    pileWorld.setHeld(e, false);
    e.body.setLinvel({ x: (this.rng() - 0.5) * 4, y: 2 + this.rng() * 2, z: (this.rng() - 0.5) * 4 }, true);
  });
  this.belt = new Array(this.beltSlotCount).fill(null);
  renderBelt(this);
};
Game.prototype.useMagnet = function () {
  if (this.magnets <= 0) return;
  const need = {};
  this.targets.filter((t) => !t.done).forEach((t) => t.word.split("").forEach((ch) => (need[ch] = (need[ch] || 0) + 1)));
  this.belt.forEach((e) => { if (e && need[e.letter]) need[e.letter]--; });
  const candidate = pileWorld.entities.find((e) => !e.held && !e.onBelt && need[e.letter] > 0);
  if (!candidate) return;
  this.magnets--;
  Sound.magnet();
  this.placeOnBelt(candidate, null);
  updateHUD(this);
};
Game.prototype.onLevelComplete = function () {
  this.state = "levelcomplete";
  document.getElementById("clearedTheme").textContent = this.cfg.theme.name.toUpperCase();
  document.getElementById("lcScore").textContent = this.score;
  document.getElementById("lcBestCombo").textContent = this.bestCombo;
  if (this.score > SAVE.bestScore) SAVE.bestScore = this.score;
  persist();
  Sound.levelUp();
  showOverlay("overlay-levelcomplete");
};
Game.prototype.nextLevel = function () {
  const banner = document.getElementById("levelUpBanner");
  this.startHaul(this.level + 1, this.mode);
  document.getElementById("levelUpSub").textContent = `Pile grew to ${this.cfg.pileSize} tiles · next word: ${this.cfg.wordLen} letters`;
  banner.classList.remove("show"); void banner.offsetWidth; banner.classList.add("show");
};

let game = new Game();

/* ---------------------------- Input handling (pointer events) ----------- */
let dragEntity = null, dragPlaneY = 1;
let lastInteractionAt = performance.now();
let lastIdleShakeAt = 0;
function markInteraction() { lastInteractionAt = performance.now(); }
function onPointerDown(e) {
  if (game.state !== "playing") return;
  const n = toNDC(e.clientX, e.clientY);
  const entity = pileWorld.raycastPick(n, camera, raycaster);
  if (entity) {
    e.preventDefault();
    markInteraction();
    dragEntity = entity;
    dragPlaneY = entity.mesh.position.y;
    game.pickupFromPile(entity);
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { } }
  }
}
const discardZoneEl = document.getElementById("discardZone");
function inRect(x, y, rect, pad) {
  return x > rect.left - pad && x < rect.right + pad && y > rect.top - pad && y < rect.bottom + pad;
}
function onPointerMove(e) {
  if (!dragEntity) return;
  e.preventDefault();
  const n = toNDC(e.clientX, e.clientY);
  const pt = pileWorld.raycastDragPlane(n, camera, raycaster, dragPlaneY);
  if (pt) pileWorld.dragTo(dragEntity, pt);
  if (discardZoneEl) {
    const over = inRect(e.clientX, e.clientY, discardZoneEl.getBoundingClientRect(), 12);
    discardZoneEl.classList.toggle("dragOver", over);
  }
}
function onPointerUp(e) {
  if (!dragEntity) return;
  const entity = dragEntity;
  dragEntity = null;

  // Discard zone takes priority — drag a tile there to scrap it out of the
  // pile entirely, freeing up room instead of it just piling up forever.
  if (discardZoneEl) {
    discardZoneEl.classList.remove("dragOver");
    if (inRect(e.clientX, e.clientY, discardZoneEl.getBoundingClientRect(), 12)) {
      pileWorld.setHeld(entity, false);
      pileWorld.removeTile(entity);
      Sound.click();
      showToast("SCRAPPED", "#ff8b7a");
      game.applyHints();
      return;
    }
  }

  const beltRect = document.getElementById("belt").getBoundingClientRect();
  const inBelt = inRect(e.clientX, e.clientY, beltRect, 10);
  if (inBelt) {
    // Drop it in the SPECIFIC slot under the pointer, not just "first empty
    // one" — line up which slot element the release point actually landed
    // over so the player can build the word in whatever order they want.
    let slotIndex = null;
    const slotEls = document.querySelectorAll("#belt .beltSlot");
    for (let i = 0; i < slotEls.length; i++) {
      if (inRect(e.clientX, e.clientY, slotEls[i].getBoundingClientRect(), 4)) { slotIndex = i; break; }
    }
    game.placeOnBelt(entity, slotIndex);
  } else {
    entity.held = false;
    pileWorld.setHeld(entity, false); // drop it where it was dragged, physics takes over
  }
}
canvas.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

// tapping a filled belt slot returns that tile to the pile
document.getElementById("belt").addEventListener("click", (e) => {
  const slotEl = e.target.closest(".beltSlot");
  if (!slotEl) return;
  const idx = parseInt(slotEl.dataset.idx, 10);
  const entity = game.belt[idx];
  if (entity) { markInteraction(); Sound.click(); game.returnToPile(entity); }
});

/* ---------------------------- UI renderers ------------------------------ */
function renderTargets(g) {
  const strip = document.getElementById("targetStrip");
  strip.innerHTML = "";
  g.targets.forEach((t) => {
    const chip = document.createElement("div");
    chip.className = "targetChip" + (t.done ? " done" : "");
    chip.innerHTML = `${t.done ? "✓ " : ""}${"•".repeat(t.word.length)} <span class="len">${t.word.length}</span>`;
    strip.appendChild(chip);
  });
}
function renderBelt(g) {
  const belt = document.getElementById("belt");
  belt.innerHTML = "";
  for (let i = 0; i < g.beltSlotCount; i++) {
    const slot = document.createElement("div");
    slot.className = "beltSlot" + (g.belt[i] ? " filled" : "");
    slot.dataset.idx = i;
    if (g.belt[i]) {
      // green LCD digit look — matches the console screen the tray now sits on
      slot.style.color = "#baffcf";
      slot.style.textShadow = "0 0 8px rgba(125,255,160,0.85), 0 0 2px rgba(125,255,160,1)";
      slot.style.fontWeight = "800";
      slot.style.fontFamily = '"Courier New", monospace';
      slot.style.fontSize = "20px";
      slot.textContent = g.belt[i].letter;
    }
    belt.appendChild(slot);
  }
}
function updateHUD(g) {
  document.getElementById("scoreVal").textContent = g.score;
  document.getElementById("levelVal").textContent = g.level;
  document.getElementById("integrityFill").style.width = fmtPct(g.integrity / 100);
  document.getElementById("integrityPct").textContent = fmtPct(g.integrity / 100);
  const fill = document.getElementById("integrityFill");
  fill.style.background = g.integrity > 50 ? "linear-gradient(90deg, var(--ok-500), var(--ok-glow))" :
    g.integrity > 25 ? "linear-gradient(90deg, #d99a3a, var(--amber-300))" : "linear-gradient(90deg, var(--bad-500), #ff8b7a)";
  document.getElementById("magnetCount").textContent = g.magnets;
  document.getElementById("magnetBtn").disabled = g.magnets <= 0;
}
function showToast(text, color) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.style.color = color || "#fff";
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
}
function floatCombo(text) {
  const el = document.createElement("div");
  el.className = "comboFloat";
  el.textContent = text;
  const beltRect = document.getElementById("belt").getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  el.style.position = "absolute";
  el.style.left = (beltRect.left - rootRect.left + beltRect.width / 2 - 30) + "px";
  el.style.top = (beltRect.top - rootRect.top - 10) + "px";
  root.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

/* ---------------------------- Shake-to-shuffle ---------------------------
   Jiggles the pile so buried letters get a chance to surface. Uses the
   devicemotion API's acceleration delta as a crude shake detector — good
   enough for a game-feel gesture, no permission needed on Android/desktop.
   iOS 13+ requires an explicit user-gesture permission prompt, so that's
   requested the first time the player taps a Play button (a genuine user
   gesture) rather than at page load, where Safari would silently refuse it.
--------------------------------------------------------------------------*/
let shakeReady = false, lastShakeAt = 0, lastAccel = null;
const SHAKE_COOLDOWN_MS = 1100;
const SHAKE_THRESHOLD = 16; // m/s^2 of combined delta — tuned to ignore normal handling

function onDeviceMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a || a.x == null) return;
  if (lastAccel) {
    const dx = a.x - lastAccel.x, dy = a.y - lastAccel.y, dz = a.z - lastAccel.z;
    const delta = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    const now = performance.now();
    if (delta > SHAKE_THRESHOLD && now - lastShakeAt > SHAKE_COOLDOWN_MS) {
      lastShakeAt = now;
      if (game.state === "playing") {
        markInteraction();
        pileWorld.shakePile(1);
        Sound.magnet();
        showToast("SHAKE!", "#f0a94e");
      }
    }
  }
  lastAccel = a;
}
function enableShakeDetection() {
  if (shakeReady || typeof DeviceMotionEvent === "undefined") return;
  shakeReady = true;
  const attach = () => window.addEventListener("devicemotion", onDeviceMotion);
  // iOS 13+: DeviceMotionEvent.requestPermission must be called from a real
  // user gesture (a click handler), which is exactly where this is invoked.
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    DeviceMotionEvent.requestPermission().then((res) => { if (res === "granted") attach(); }).catch(() => { });
  } else {
    attach();
  }
}

/* ---------------------------- Overlay management ------------------------ */
const overlays = ["overlay-title", "overlay-howto", "overlay-settings", "overlay-pause", "overlay-levelcomplete", "overlay-gameover"];
function showOverlay(id) {
  overlays.forEach((o) => document.getElementById(o).classList.toggle("hidden", o !== id));
}
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    Sound.click();
    document.getElementById(btn.dataset.close).classList.add("hidden");
  });
});

/* ---------------------------- Menu wiring -------------------------------- */
function refreshTitleStats() {
  document.getElementById("bestScoreVal").textContent = SAVE.bestScore;
  document.getElementById("streakVal").textContent = SAVE.streak;
  document.getElementById("wordsWeldedVal").textContent = SAVE.wordsWelded || 0;
}
function bumpDailyStreak() {
  const today = new Date().toDateString();
  if (SAVE.lastPlayDate === today) return;
  const y = new Date(); y.setDate(y.getDate() - 1);
  SAVE.streak = (SAVE.lastPlayDate === y.toDateString()) ? (SAVE.streak + 1) : 1;
  SAVE.lastPlayDate = today;
  persist();
}

document.getElementById("btnPlayHaul").addEventListener("click", () => {
  Sound.click(); bumpDailyStreak(); enableShakeDetection();
  game = new Game(); game.startHaul(1, "haul");
});
document.getElementById("btnPlayEndless").addEventListener("click", () => {
  Sound.click(); enableShakeDetection();
  game = new Game(); game.startHaul(1, "endless");
});
document.getElementById("btnHowTo").addEventListener("click", () => { Sound.click(); showOverlay("overlay-howto"); });
document.getElementById("btnSettingsFromTitle").addEventListener("click", () => { Sound.click(); showOverlay("overlay-settings"); });

document.getElementById("weldBtn").addEventListener("click", () => { if (game.state === "playing") { markInteraction(); game.attemptWeld(); } });
document.getElementById("clearBtn").addEventListener("click", () => { if (game.state === "playing") { markInteraction(); Sound.click(); game.clearBelt(); } });
document.getElementById("magnetBtn").addEventListener("click", () => { if (game.state === "playing") { markInteraction(); game.useMagnet(); } });

document.getElementById("pauseBtn").addEventListener("click", () => {
  if (game.state !== "playing") return;
  game.state = "paused"; showOverlay("overlay-pause");
});
document.getElementById("btnResume").addEventListener("click", () => { Sound.click(); game.state = "playing"; showOverlay(null); });
document.getElementById("btnPauseSettings").addEventListener("click", () => { Sound.click(); showOverlay("overlay-settings"); });
document.getElementById("btnPauseQuit").addEventListener("click", () => { Sound.click(); game.state = "title"; refreshTitleStats(); showOverlay("overlay-title"); });

document.getElementById("btnNextLevel").addEventListener("click", () => { Sound.click(); game.nextLevel(); });
document.getElementById("btnLcQuit").addEventListener("click", () => { Sound.click(); game.state = "title"; refreshTitleStats(); showOverlay("overlay-title"); });
document.getElementById("btnRetry").addEventListener("click", () => {
  Sound.click();
  const lvl = game.mode === "endless" ? 1 : game.level;
  game = new Game(); game.startHaul(game.mode === "endless" ? 1 : lvl, game.mode);
});
document.getElementById("btnGoQuit").addEventListener("click", () => { Sound.click(); refreshTitleStats(); showOverlay("overlay-title"); });

document.getElementById("soundBtn").addEventListener("click", () => {
  SAVE.settings.sfx = !SAVE.settings.sfx; SAVE.settings.music = SAVE.settings.sfx; persist();
  document.getElementById("soundIcon").style.opacity = SAVE.settings.sfx ? 1 : 0.4;
});

function wireSwitch(id, key, cb) {
  const el = document.getElementById(id);
  function sync() { el.classList.toggle("on", !!SAVE.settings[key]); }
  el.addEventListener("click", () => {
    SAVE.settings[key] = !SAVE.settings[key];
    sync(); persist(); Sound.click();
    if (cb) cb(SAVE.settings[key]);
  });
  sync();
}
wireSwitch("toggleSfx", "sfx");
wireSwitch("toggleMusic", "music");
wireSwitch("toggleShake", "shake");
wireSwitch("toggleReduceMotion", "reduceMotion");
wireSwitch("toggleColourblind", "colourblind", () => applyColourblindSetting());

const hintLabels = ["Low", "Medium", "High"];
const hintSlider = document.getElementById("hintSlider");
hintSlider.value = SAVE.settings.hintLevel;
document.getElementById("hintValLabel").textContent = hintLabels[SAVE.settings.hintLevel];
hintSlider.addEventListener("input", () => {
  SAVE.settings.hintLevel = parseInt(hintSlider.value, 10);
  document.getElementById("hintValLabel").textContent = hintLabels[SAVE.settings.hintLevel];
  persist();
});

document.querySelectorAll(".diffBtn[data-diff]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".diffBtn[data-diff]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    SAVE.settings.startDiff = btn.dataset.diff;
    persist(); Sound.click();
  });
});
document.querySelectorAll(".diffBtn[data-diff]").forEach((b) => { if (b.dataset.diff === SAVE.settings.startDiff) b.classList.add("active"); });

document.querySelectorAll(".diffBtn[data-quality]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".diffBtn[data-quality]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    SAVE.settings.quality = btn.dataset.quality;
    persist(); Sound.click();
    applyGraphicsQuality();
  });
});
document.querySelectorAll(".diffBtn[data-quality]").forEach((b) => { if (b.dataset.quality === (SAVE.settings.quality || "auto")) b.classList.add("active"); });

document.getElementById("btnResetProgress").addEventListener("click", () => {
  if (confirm("Reset all Word Skrap progress? This can't be undone.")) {
    SAVE = defaultSave(); persist(); refreshTitleStats();
  }
});

/* ---------------------------- Debug hook (dev/testing only) --------------
   Mirrors the 2D prototype's window.WS_DEBUG, adapted to the PileWorld
   entity model, for automated smoke-testing without simulating real drag
   gestures. Harmless to ship; strip before a closed store release if
   wanted. */
window.WS_DEBUG = {
  getGame: () => game,
  getPileWorld: () => pileWorld,
  forceBeltWord: (word) => {
    game.clearBelt();
    const letters = word.toUpperCase().split("");
    const used = new Set();
    let idx = 0;
    for (const ch of letters) {
      const free = pileWorld.entities.find((e) => !e.onBelt && !e.held && !used.has(e));
      if (!free) break;
      free.letter = ch; used.add(free);
      retextureEntity(free);
      game.placeOnBelt(free, idx++);
    }
  },
  weld: () => game.attemptWeld(),
  setIntegrity: (v) => { game.integrity = v; updateHUD(game); }
};

/* ---------------------------- Main loop ----------------------------------- */
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - lastFrame) / 1000);
  lastFrame = now;
  if (game.state === "playing") game.tick(dt);

  let ox = 0, oy = 0, oz = 0;
  if (game.shakeT > 0) {
    game.shakeT -= dt;
    const s = Math.max(0, game.shakeT) * 0.12;
    ox = (Math.random() - 0.5) * s; oy = (Math.random() - 0.5) * s; oz = (Math.random() - 0.5) * s;
  }
  camera.position.set(CAM_BASE.x + ox, CAM_BASE.y + oy, CAM_BASE.z + oz);
  camera.lookAt(CAM_LOOKAT);

  updateDustField(dt);
  updateWeldBursts(dt);

  // Idle pile animation — a gentle rumble if the pile's gone untouched for
  // a while, so it's never fully static even between plays.
  if (game.state === "playing") {
    const idleFor = now - lastInteractionAt;
    if (idleFor > 12000 && now - lastIdleShakeAt > 6000) {
      lastIdleShakeAt = now;
      pileWorld.shakePile(0.22);
    }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ---------------------------- Boot ---------------------------------------- */
refreshTitleStats();
document.getElementById("soundIcon").style.opacity = SAVE.settings.sfx ? 1 : 0.4;
showOverlay("overlay-title");
requestAnimationFrame(frame);

} // runGame()
