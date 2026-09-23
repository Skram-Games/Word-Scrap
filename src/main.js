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

let THREE, RAPIER, getLetterTexture, PileWorld;

async function loadEngine() {
  bootLabel.textContent = "Loading 3D engine…";
  THREE = await import("three");

  bootLabel.textContent = "Loading physics engine…";
  const RapierMod = await import("rapier3d-compat");
  RAPIER = RapierMod.default || RapierMod;
  await RAPIER.init();

  bootLabel.textContent = "Building world…";
  ({ getLetterTexture } = await import("./tileTexture.js"));
  ({ PileWorld } = await import("./pileWorld.js"));

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
function levelConfig(level, startDiff) {
  const diffOffset = startDiff === "relaxed" ? -1 : startDiff === "scrapper" ? 1 : 0;
  const L = Math.max(1, level + diffOffset);
  const theme = THEMES[(level - 1) % THEMES.length];
  const targetCount = clamp(2 + Math.floor(L / 3), 2, 7);
  // Levels open at a strict 3-5 letter range and only widen/raise the floor
  // gradually — minLen climbs slower than maxLen, so short words are always
  // still in the mix even once the game is asking for longer ones too.
  const minLen = clamp(3 + Math.floor((L - 1) / 4), 3, 6);
  const maxLen = clamp(5 + Math.floor((L - 1) / 3), 5, 9);
  const pileSize = clamp(10 + L * 2, 10, 32);
  const badWeldDamage = clamp(14 + Math.floor(L / 3) * 2, 14, 26);
  const timerSeconds = L >= 4 ? clamp(70 - L * 2, 30, 70) : null;
  const magnetsAwarded = level === 1 ? 3 : (level % 3 === 0 ? 1 : 0);
  return { level, theme, targetCount, minLen, maxLen, pileSize, badWeldDamage, timerSeconds, magnetsAwarded };
}
function chooseTargetWords(rng, cfg) {
  const candidates = [];
  for (let len = cfg.minLen; len <= cfg.maxLen; len++) if (WORD_BANK[len]) candidates.push(...WORD_BANK[len]);
  const pool = shuffle(rng, candidates);
  const targets = []; const seen = new Set();
  for (const w of pool) {
    if (targets.length >= cfg.targetCount) break;
    if (seen.has(w)) continue;
    seen.add(w); targets.push(w);
  }
  while (targets.length < cfg.targetCount) {
    const len = cfg.minLen + (targets.length % (cfg.maxLen - cfg.minLen + 1));
    const w = pick(rng, WORD_BANK[len] || WORD_BANK[4]);
    if (!seen.has(w)) { seen.add(w); targets.push(w); }
  }
  return targets;
}
function buildPileLetters(rng, cfg, targetWords) {
  const FREQ = "EEEEEEEEEAAAAAAAARRRRRRRIIIIIIIOOOOOOOTTTTTTTNNNNNNSSSSSSLLLLLCCCCUUUUDDDDPPPMMMHHHGGBBFFYYWWKVXZJQ";
  const letters = [];
  targetWords.forEach((w) => letters.push(...w.split("")));
  while (letters.length < cfg.pileSize) letters.push(FREQ[Math.floor(rng() * FREQ.length)]);
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
scene.fog = new THREE.Fog(0xc97a3f, 9, 24);

const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
// Pulled back and raised from the first pass — too close meant the target
// chips (a DOM overlay near the top of the screen) covered too much of the
// pile. Wider framing also gives the feed conveyor below room to read.
const CAM_BASE = new THREE.Vector3(0, 8.6, 9.4);
const CAM_LOOKAT = new THREE.Vector3(0, 0.6, 0);
camera.position.copy(CAM_BASE);
camera.lookAt(CAM_LOOKAT);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const hemi = new THREE.HemisphereLight(0xfff2d8, 0x2a1810, 0.7);
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

const pileWorld = new PileWorld(THREE, RAPIER, scene, {
  radius: 3.0, wallHeight: 2.3, colourblindSafe: SAVE.settings.colourblind
});

/* ---------------------------- Feed conveyor (decorative) -----------------
   A tilted belt mounted on the rim, angled down into the pit, with a
   scrolling hazard-stripe texture — sells the "junkyard feed" read the
   pile alone doesn't give. Purely visual: new tiles still spawn via
   pileWorld.spawnTile/randomDropPoint as before, timed to look like they're
   dropping off the belt's low end. */
function buildFeedConveyor() {
  const stripeCanvas = document.createElement("canvas");
  stripeCanvas.width = 64; stripeCanvas.height = 64;
  const sctx = stripeCanvas.getContext("2d");
  sctx.fillStyle = "#20180f"; sctx.fillRect(0, 0, 64, 64);
  sctx.fillStyle = "#caa23a";
  for (let i = -1; i < 5; i++) { sctx.save(); sctx.translate(i * 16, 0); sctx.rotate(Math.PI / 4); sctx.fillRect(-40, -40, 8, 160); sctx.restore(); }
  const stripeTex = new THREE.CanvasTexture(stripeCanvas);
  stripeTex.wrapS = THREE.RepeatWrapping; stripeTex.wrapT = THREE.RepeatWrapping;
  stripeTex.repeat.set(3, 1);

  const group = new THREE.Group();
  const bedLen = 3.4, bedW = 1.05;
  const bedGeo = new THREE.BoxGeometry(bedW, 0.16, bedLen);
  const bedMat = new THREE.MeshStandardMaterial({ color: 0x33261a, roughness: 0.8, metalness: 0.3 });
  const beltMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.9, metalness: 0.1 });
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.castShadow = true; bed.receiveShadow = true;
  group.add(bed);
  const beltSurface = new THREE.Mesh(new THREE.BoxGeometry(bedW * 0.86, 0.02, bedLen * 0.94), beltMat);
  beltSurface.position.y = 0.09;
  group.add(beltSurface);

  // simple support legs
  const legMat = new THREE.MeshStandardMaterial({ color: 0x241a10, roughness: 0.85, metalness: 0.4 });
  [[-bedW * 0.35, bedLen * 0.4], [bedW * 0.35, bedLen * 0.4]].forEach(([lx, lz]) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 8), legMat);
    leg.position.set(lx, -0.7, lz);
    group.add(leg);
  });

  group.position.set(-0.4, 3.1, -3.6);
  group.rotation.x = -0.55; // tips down toward the pit
  group.rotation.y = 0.12;
  scene.add(group);
  return { group, beltSurface, stripeTex };
}
const feedConveyor = buildFeedConveyor();

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
    // Subtle — a faint warm glow, not a neon highlight. Dialled down from
    // an earlier pass that ran far too bright against the dark metal.
    m.emissive.setHex(on ? 0xb5651d : 0x000000);
    m.emissiveIntensity = on ? 0.14 : 0;
  });
}
function retextureEntity(entity) {
  const tex = getLetterTexture(entity.letter, pileWorld.colourblindSafe);
  const mats = Array.isArray(entity.mesh.material) ? entity.mesh.material : [entity.mesh.material];
  mats.forEach((m) => { m.map = tex; m.needsUpdate = true; });
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
  this.targets = chooseTargetWords(this.rng, this.cfg).map((w) => ({ word: w, done: false }));
  this.beltSlotCount = Math.max(6, this.cfg.maxLen);
  this.belt = new Array(this.beltSlotCount).fill(null);
  this.magnets = (this.magnets || 0) + this.cfg.magnetsAwarded;
  if (this.level === 1 && this.mode === "haul") this.magnets = this.cfg.magnetsAwarded;
  this.timeLeft = this.cfg.timerSeconds;

  // clear last level's tiles out of the physics world before spawning new ones
  pileWorld.entities.slice().forEach((e) => pileWorld.removeTile(e));

  const letters = buildPileLetters(this.rng, this.cfg, this.targets.map((t) => t.word));
  letters.forEach((L) => {
    const p = pileWorld.randomDropPoint(this.rng);
    const vel = { x: (this.rng() - 0.5) * 1.5, y: -1 - this.rng(), z: (this.rng() - 0.5) * 1.5 };
    pileWorld.spawnTile(L, p, getLetterTexture, vel);
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
  if (word.length < 3) { this.weldFail(pickFailMessage(TOO_SHORT_MESSAGES)); return; }
  const targetMatch = this.targets.find((t) => !t.done && t.word === word);
  const isValid = ALL_WORDS.has(word);
  if (targetMatch) {
    targetMatch.done = true;
    this.combo++; this.bestCombo = Math.max(this.bestCombo, this.combo);
    const base = 10 * word.length;
    const comboBonus = Math.floor(base * 0.2 * (this.combo - 1));
    this.score += base + comboBonus;
    Sound.weldGood();
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
  document.getElementById("levelUpSub").textContent = `Pile grew to ${this.cfg.pileSize} tiles · ${this.cfg.targetCount} targets`;
  banner.classList.remove("show"); void banner.offsetWidth; banner.classList.add("show");
};

let game = new Game();

/* ---------------------------- Input handling (pointer events) ----------- */
let dragEntity = null, dragPlaneY = 1;
function onPointerDown(e) {
  if (game.state !== "playing") return;
  const n = toNDC(e.clientX, e.clientY);
  const entity = pileWorld.raycastPick(n, camera, raycaster);
  if (entity) {
    e.preventDefault();
    dragEntity = entity;
    dragPlaneY = entity.mesh.position.y;
    game.pickupFromPile(entity);
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { } }
  }
}
function onPointerMove(e) {
  if (!dragEntity) return;
  e.preventDefault();
  const n = toNDC(e.clientX, e.clientY);
  const pt = pileWorld.raycastDragPlane(n, camera, raycaster, dragPlaneY);
  if (pt) pileWorld.dragTo(dragEntity, pt);
}
function onPointerUp(e) {
  if (!dragEntity) return;
  const beltRect = document.getElementById("belt").getBoundingClientRect();
  const inBelt = e.clientX > beltRect.left - 10 && e.clientX < beltRect.right + 10 &&
                 e.clientY > beltRect.top - 16 && e.clientY < beltRect.bottom + 16;
  const entity = dragEntity;
  dragEntity = null;
  if (inBelt) {
    game.placeOnBelt(entity, null);
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
  if (entity) { Sound.click(); game.returnToPile(entity); }
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
      slot.style.background = "linear-gradient(180deg, var(--copper-400), var(--copper-500))";
      slot.style.color = "#2a1810";
      slot.style.fontWeight = "800";
      slot.style.fontSize = "18px";
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

document.getElementById("weldBtn").addEventListener("click", () => { if (game.state === "playing") game.attemptWeld(); });
document.getElementById("clearBtn").addEventListener("click", () => { if (game.state === "playing") { Sound.click(); game.clearBelt(); } });
document.getElementById("magnetBtn").addEventListener("click", () => { if (game.state === "playing") game.useMagnet(); });

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

  feedConveyor.stripeTex.offset.y -= dt * 0.9;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ---------------------------- Boot ---------------------------------------- */
refreshTitleStats();
document.getElementById("soundIcon").style.opacity = SAVE.settings.sfx ? 1 : 0.4;
showOverlay("overlay-title");
requestAnimationFrame(frame);

} // runGame()
