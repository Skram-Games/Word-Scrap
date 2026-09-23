/* pileWorld.js — the junk pile: a real Rapier physics simulation (gravity,
   collisions, a drum-shaped container built from static wall segments)
   rendered as Three.js meshes. This is the module that replaces the old
   2D-canvas PileSim from the alpha prototype — everything else in the game
   (UI, word logic, scoring, difficulty curve) is engine-agnostic and lives
   in main.js unchanged in spirit.

   Design notes for whoever maintains this next:
   - The container is a "drum": a flat static floor collider plus a ring of
     N static box colliders standing on end, angled to face inward. Rapier
     doesn't have a hollow-cylinder primitive, so this segmented-wall
     approach is the standard, reliable way to build an open-top bin. Bump
     WALL_SEGMENTS for a smoother wall at the cost of a few more colliders
     (cheap — they're static, so they cost nothing per physics step beyond
     broad-phase bookkeeping).
   - Tiles are boxes, not the CylinderGeometry-per-letter you might expect
     from the concept art — a box gives every letter texture a flat face to
     sit on, which reads far better at this scale than a coin-shaped tile
     would.
   - A "held" (dragged) tile becomes a kinematic-position-based body rather
     than being removed from the simulation. That means it still collides
     with and pushes the rest of the pile as you drag it through — the
     "scooping" feel the design doc asked for comes from this, not from any
     scripted animation.
*/

const WALL_SEGMENTS = 20;
const TILE_SIZE = 0.62; // half-extent * 2, in world units
const TILE_HALF = TILE_SIZE / 2;

export class PileWorld {
  /**
   * @param {typeof import("three")} THREE
   * @param {*} RAPIER already-initialized RAPIER module (await RAPIER.init() done by caller)
   * @param {import("three").Scene} scene
   * @param {{radius:number, wallHeight:number, colourblindSafe:boolean}} opts
   */
  constructor(THREE, RAPIER, scene, opts) {
    this.THREE = THREE;
    this.RAPIER = RAPIER;
    this.scene = scene;
    this.radius = opts.radius ?? 3.2;
    this.wallHeight = opts.wallHeight ?? 2.4;
    this.colourblindSafe = !!opts.colourblindSafe;

    this.world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    this.entities = []; // live TileEntity-like plain objects
    this._group = new THREE.Group();
    scene.add(this._group);

    this._buildContainer();

    // fixed-timestep accumulator for stable stepping regardless of frame rate
    this._accumulator = 0;
    this._fixedDt = 1 / 60;
    this.world.timestep = this._fixedDt;
  }

  _buildContainer() {
    const { THREE, RAPIER, world, radius, wallHeight } = this;
    const floorThickness = 0.4;

    // --- physics: floor ---
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -floorThickness / 2, 0));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(radius + 0.3, floorThickness / 2, radius + 0.3)
        .setFriction(0.9)
        .setRestitution(0.05),
      floorBody
    );

    // --- physics: ring of static wall segments forming an open-top drum ---
    const segLen = (2 * Math.PI * radius) / WALL_SEGMENTS;
    for (let i = 0; i < WALL_SEGMENTS; i++) {
      const theta = (i / WALL_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      // quaternion for rotation about Y so the segment's local +Z faces the
      // drum center (inward normal), matching how BoxGeometry is authored below
      const qy = Math.sin(theta / 2 + Math.PI / 4);
      const qw = Math.cos(theta / 2 + Math.PI / 4);
      const wallBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(x, wallHeight / 2, z).setRotation({ x: 0, y: qy, z: 0, w: qw })
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(segLen / 2 + 0.02, wallHeight / 2, 0.15)
          .setFriction(0.7)
          .setRestitution(0.15),
        wallBody
      );
    }

    // --- visuals: a simple metal drum (floor disc + open-top tube) ---
    const drumMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1f, roughness: 0.85, metalness: 0.35, side: THREE.DoubleSide });
    const floorMesh = new THREE.Mesh(new THREE.CylinderGeometry(radius + 0.3, radius + 0.3, floorThickness, 40), drumMat);
    floorMesh.position.set(0, -floorThickness / 2, 0);
    floorMesh.receiveShadow = true;
    this._group.add(floorMesh);

    const wallGeo = new THREE.CylinderGeometry(radius + 0.02, radius + 0.02, wallHeight, 40, 1, true);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2e2114, roughness: 0.9, metalness: 0.25, side: THREE.BackSide });
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);
    wallMesh.position.set(0, wallHeight / 2, 0);
    this._group.add(wallMesh);

    // rim highlight so the open top edge reads clearly against the pile
    const rimGeo = new THREE.TorusGeometry(radius + 0.02, 0.05, 8, 48);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xd4832f, roughness: 0.5, metalness: 0.6 });
    const rimMesh = new THREE.Mesh(rimGeo, rimMat);
    rimMesh.rotation.x = Math.PI / 2;
    rimMesh.position.set(0, wallHeight, 0);
    this._group.add(rimMesh);
  }

  /** Random point near the top-center of the drum, for spawning/scattering. */
  randomDropPoint(rand) {
    const r = (rand() * 0.6) * this.radius;
    const a = rand() * Math.PI * 2;
    return {
      x: Math.cos(a) * r,
      y: this.wallHeight + 0.4 + rand() * 1.2,
      z: Math.sin(a) * r,
    };
  }

  /**
   * Spawns a physical tile with the given letter and returns a plain entity
   * object: { letter, mesh, body, collider, held, onBelt, hint }.
   */
  spawnTile(letter, pos, getLetterTexture, initialVel) {
    const { THREE, RAPIER, world } = this;
    const tex = getLetterTexture(letter, this.colourblindSafe);
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x5a4a38, roughness: 0.75, metalness: 0.3 });
    const faceMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.25 });
    // Box material order in three.js: +x,-x,+y,-y,+z,-z. Letter on every
    // face so it's always readable regardless of which way the tile lands.
    const materials = [faceMat, faceMat, faceMat, faceMat, faceMat, faceMat];
    const geo = new THREE.BoxGeometry(TILE_SIZE, TILE_SIZE, TILE_SIZE);
    const mesh = new THREE.Mesh(geo, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this._group.add(mesh);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setLinearDamping(0.15)
        .setAngularDamping(0.35)
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(TILE_HALF, TILE_HALF, TILE_HALF).setFriction(0.6).setRestitution(0.25).setDensity(1.4),
      body
    );
    if (initialVel) body.setLinvel(initialVel, true);
    body.setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);

    const entity = { letter, mesh, body, collider, held: false, onBelt: false, hint: false, id: Math.random() };
    mesh.userData.entity = entity;
    this.entities.push(entity);
    return entity;
  }

  /** Fully removes a tile from both physics and the scene graph. */
  removeTile(entity) {
    const idx = this.entities.indexOf(entity);
    if (idx >= 0) this.entities.splice(idx, 1);
    if (entity.body) this.world.removeRigidBody(entity.body);
    if (entity.mesh) {
      this._group.remove(entity.mesh);
      entity.mesh.geometry.dispose();
      // materials reference cached, shared textures — dispose the material
      // wrapper only, never the texture itself (other tiles still use it)
      const mats = Array.isArray(entity.mesh.material) ? entity.mesh.material : [entity.mesh.material];
      mats.forEach((m) => m.dispose());
    }
    entity.body = null;
    entity.mesh = null;
  }

  /** Switches a tile between normal falling physics and a hand-held drag state. */
  setHeld(entity, held) {
    entity.held = held;
    const { RAPIER } = this;
    entity.body.setBodyType(
      held ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
      true
    );
    if (!held) {
      // give it a tiny nudge so it doesn't sit in a perfectly stacked, inert
      // state after being released — reads as "dropped", not "placed"
      entity.body.setAngvel({ x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 3, z: (Math.random() - 0.5) * 3 }, true);
    }
  }

  /** Queues a kinematic tile's next position (applied on the next step()). */
  dragTo(entity, worldPos) {
    entity.body.setNextKinematicTranslation({ x: worldPos.x, y: worldPos.y, z: worldPos.z });
  }

  /** Advances physics by real dt (seconds) using a fixed-step accumulator. */
  step(dt) {
    this._accumulator += Math.min(dt, 0.1); // clamp huge pauses (tab switch) to avoid a spiral of steps
    let steps = 0;
    while (this._accumulator >= this._fixedDt && steps < 5) {
      this.world.step();
      this._accumulator -= this._fixedDt;
      steps++;
    }
    // sync every live mesh to its physics body
    for (const e of this.entities) {
      if (!e.body || !e.mesh) continue;
      const t = e.body.translation();
      const r = e.body.rotation();
      e.mesh.position.set(t.x, t.y, t.z);
      e.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Ray-picks the nearest non-held tile mesh under the given NDC coords. */
  raycastPick(ndc, camera, raycaster) {
    raycaster.setFromCamera(ndc, camera);
    const meshes = this.entities.filter((e) => !e.held && e.mesh).map((e) => e.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    return hits[0].object.userData.entity;
  }

  /** Intersects the drag plane (a horizontal plane at fixed height) for smooth dragging. */
  raycastDragPlane(ndc, camera, raycaster, planeY) {
    raycaster.setFromCamera(ndc, camera);
    const plane = new this.THREE.Plane(new this.THREE.Vector3(0, 1, 0), -planeY);
    const out = new this.THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(plane, out);
    return hit ? out : null;
  }

  dispose() {
    this.entities.slice().forEach((e) => this.removeTile(e));
    this.scene.remove(this._group);
  }
}
