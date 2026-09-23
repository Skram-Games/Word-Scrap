# Word Skrap — 3D build (Three.js + Rapier)

Scoop scrap. Sort letters. Weld words. This is the real-physics version of
Word Skrap: a tumbling junk-pile of letter tiles rendered in WebGL
(Three.js) and simulated with actual rigid-body physics (Rapier, via WASM).

## Running it

**This needs a real HTTP(S) server — it will NOT work if you just
double-click `index.html`.** The game loads Three.js and Rapier as ES
modules, and browsers block ES module imports under `file://` for security
reasons (CORS). This is a hard requirement of the module system, not a bug.

Locally, either of these works from this folder:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed `localhost` URL.

**GitHub Pages** works out of the box with no build step: push this folder
to a repo, enable Pages (Settings → Pages → deploy from branch, root), and
it will serve correctly since Pages is already HTTP(S).

## File structure

```
index.html          Page shell: DOM/HUD/menus, import map, boot overlay
style.css            All styling (rust/amber/copper theme, unchanged from the 2D alpha)
wordskrap-data.js    Word dictionary — two tiers, ~690 curated target words +
                      ~41k-word full dictionary for bonus-word scoring.
                      Generated offline from the system's en_US dictionary,
                      passed through a profanity/slur blocklist.
src/main.js          Game glue: boot sequence, Game state machine (word
                      selection, difficulty curve, scoring, menus), input
                      handling (3D raycasting for drag-and-drop)
src/pileWorld.js      The physics world: a Rapier "drum" (static floor +
                      segmented walls) holding dynamic tile bodies, plus
                      their Three.js mesh representations
src/tileTexture.js    Procedural canvas-drawn scrap-metal letter textures
                      (no image assets — 26 textures generated once, cached
                      and reused across every tile)
```

## Why the CDN versions are pinned

`index.html`'s import map pins exact versions:

```
three@0.169.0
@dimforge/rapier3d-compat@0.14.0
```

Don't change these to `@latest`. An unpinned import is the kind of thing
that silently breaks in a shipped build months later when upstream cuts a
breaking release. Bump versions deliberately, test locally, and commit the
version bump as its own change.

## What's been tested, and what hasn't

I built and wrote this entirely in a sandboxed environment with **no
network access** — every CDN (jsDelivr, cdnjs, unpkg, npm, GitHub raw) was
blocked at the proxy level. That means:

- **Tested and verified:** the game logic itself (word selection, the
  difficulty curve, scoring, weld/scatter/magnet mechanics, save/settings
  persistence) — this is a direct, careful port of the 2D canvas prototype,
  which *was* fully tested with automated Playwright runs, including a
  regression fix for a score-reset bug.
- **Not tested — needs a real browser + real network:** anything that
  depends on Three.js or Rapier actually loading and running — the physics
  simulation itself, the 3D raycasting/drag-and-drop, rendering, shadows,
  and the boot sequence's error handling. I wrote this as carefully and
  conservatively as I could against both libraries' documented APIs, but I
  could not execute a single frame of it before handing it to you.

**If something breaks on your first run**, the most likely trouble spots
(in order of likelihood) are:
1. An exact method/property name mismatch against the pinned Rapier
   version (`src/pileWorld.js` — body types, collider builders).
2. The drag/raycasting math in `src/main.js` (`toNDC`, `raycastDragPlane`)
   — screen-to-world conversion is the fiddliest part of any 3D UI port.
3. Timing in the boot sequence (`src/main.js` → `loadEngine()`) if a CDN
   response is slow rather than outright failing.

Send me whatever the browser console shows and I'll fix it fast — none of
that should take more than a targeted patch once I can see a real error.

## Debug hook

`window.WS_DEBUG` is exposed in the console for testing without simulating
real drag gestures:

```js
WS_DEBUG.forceBeltWord("SCRAP")  // places tiles spelling SCRAP onto the belt
WS_DEBUG.weld()                  // attempts a weld with whatever's on the belt
WS_DEBUG.setIntegrity(10)        // sets integrity directly
WS_DEBUG.getGame()               // the live Game instance
WS_DEBUG.getPileWorld()          // the live PileWorld instance
```

Safe to leave in for now; strip it before a closed store release if you
want a fully closed surface.
