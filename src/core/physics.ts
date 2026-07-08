import Box3DFactory from "box3d.js/inline";
import type {
  Box3DModule,
  b3WorldId,
  b3BodyId,
  b3Vec3,
} from "box3d.js";

/**
 * Thin typed wrapper over the box3d C-style WASM API. box3d exposes flat
 * functions (b3CreateWorld, b3CreateBody, b3World_Step, ...) operating on opaque
 * id structs. We keep those ids internal and expose a small object-oriented
 * surface so the rest of the game never touches `any` from the wasm layer.
 *
 * Coordinates: box3d is a full 3D engine. We use it as effectively 2.5D — bodies
 * live on the XZ plane at a fixed height, with rotation locked on X/Z so capsules
 * stay upright (gameplay yaw is handled purely on the three.js mesh).
 */

const FIXED_DT = 1 / 60;
const SUB_STEPS = 4;

export type BodyKind = "dynamic" | "static";

export interface CapsuleOptions {
  x: number;
  z: number;
  /** Total height of the capsule (tip to tip). */
  height: number;
  radius: number;
  kind?: BodyKind;
  /** Linear damping — high values make velocity-driven movement feel snappy. */
  linearDamping?: number;
  density?: number;
  /** Collision filter category (bitmask). */
  category?: number;
  /** Which categories this body collides with. */
  mask?: number;
  /** Allow vertical translation (for jumping/falling). Default false keeps a
   * capsule locked to the ground plane in the 2.5D sim. */
  verticalMotion?: boolean;
}

export interface BoxOptions {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  kind?: BodyKind;
  density?: number;
  category?: number;
  mask?: number;
}

/** Handle to one physics body, wrapping the opaque b3BodyId. */
export class Body {
  private destroyed = false;

  constructor(
    private readonly b3: Box3DModule,
    readonly id: b3BodyId,
  ) {}

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  getPosition(out: { x: number; y: number; z: number }): void {
    const p = this.b3.b3Body_GetPosition(this.id);
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
  }

  /** Full orientation quaternion (x,y,z,w) — used to render tumbling corpses. */
  getQuaternion(out: { x: number; y: number; z: number; w: number }): void {
    const q = this.b3.b3Body_GetRotation(this.id);
    out.x = q.v.x;
    out.y = q.v.y;
    out.z = q.v.z;
    out.w = q.s;
  }

  /** Yaw of the body around +Y (radians), derived from the rotation quat. */
  getYaw(): number {
    const q = this.b3.b3Body_GetRotation(this.id);
    // Yaw from a quaternion (Y-up): atan2 over the y/w and cross terms.
    const siny = 2 * (q.s * q.v.y + q.v.x * q.v.z);
    const cosy = 1 - 2 * (q.v.y * q.v.y + q.v.z * q.v.z);
    return Math.atan2(siny, cosy);
  }

  setLinearVelocity(x: number, y: number, z: number): void {
    this.b3.b3Body_SetLinearVelocity(this.id, { x, y, z });
  }

  setAngularVelocity(x: number, y: number, z: number): void {
    this.b3.b3Body_SetAngularVelocity(this.id, { x, y, z });
  }

  getLinearVelocity(out: { x: number; y: number; z: number }): void {
    const v = this.b3.b3Body_GetLinearVelocity(this.id);
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
  }

  applyLinearImpulseToCenter(x: number, y: number, z: number): void {
    this.b3.b3Body_ApplyLinearImpulseToCenter(this.id, { x, y, z }, true);
  }

  applyAngularImpulse(x: number, y: number, z: number): void {
    this.b3.b3Body_ApplyAngularImpulse(this.id, { x, y, z }, true);
  }

  setPosition(x: number, y: number, z: number): void {
    const q = this.b3.b3Body_GetRotation(this.id);
    this.b3.b3Body_SetTransform(this.id, { x, y, z }, q);
  }

  /**
   * Teleport with identity rotation and zeroed velocities — recycling a pooled
   * dynamic body (loose building cubes) without a destroy/create round trip.
   */
  resetTransform(x: number, y: number, z: number): void {
    this.b3.b3Body_SetTransform(
      this.id,
      { x, y, z },
      { v: { x: 0, y: 0, z: 0 }, s: 1 },
    );
    this.setLinearVelocity(0, 0, 0);
    this.setAngularVelocity(0, 0, 0);
    this.b3.b3Body_SetAwake(this.id, true);
  }

  /**
   * Live-tune linear damping. Enemies drop theirs while launched so knockback
   * reads as a long slide across the floor instead of dying in half a metre.
   */
  setLinearDamping(damping: number): void {
    this.b3.b3Body_SetLinearDamping(this.id, damping);
  }

  setAngularDamping(damping: number): void {
    this.b3.b3Body_SetAngularDamping(this.id, damping);
  }

  /**
   * Live-update the collision mask on every shape of this body — e.g. an enemy
   * swapping between its active, held, and decorative filters.
   */
  setCollisionMask(mask: number): void {
    const shapes = this.b3.b3Body_GetShapes(this.id);
    for (let i = 0; i < shapes.size(); i++) {
      const shapeId = shapes.get(i);
      if (!shapeId) continue;
      const filter = this.b3.b3Shape_GetFilter(shapeId);
      filter.maskBits = BigInt(mask);
      this.b3.b3Shape_SetFilter(shapeId, filter, true);
    }
    shapes.delete();
  }

  /**
   * Continuous collision (swept) for this body. Launched enemies and corpses
   * turn this on so a big impulse can never step them through the ground slab
   * or a wall in one substep.
   */
  setBullet(flag: boolean): void {
    this.b3.b3Body_SetBullet(this.id, flag);
  }

  /** Free the angular locks so a corpse can tumble (knockback effect, M2). */
  unlockRotation(): void {
    this.b3.b3Body_SetMotionLocks(this.id, {
      linearX: false,
      linearY: false,
      linearZ: false,
      angularX: false,
      angularY: false,
      angularZ: false,
    });
  }

  /** Restore the usual enemy/player capsule locks after a tumble recovery. */
  lockUprightAt(x: number, y: number, z: number, verticalMotion = true): void {
    this.b3.b3Body_SetMotionLocks(this.id, {
      linearX: false,
      linearY: !verticalMotion,
      linearZ: false,
      angularX: true,
      angularY: true,
      angularZ: true,
    });
    this.b3.b3Body_SetTransform(
      this.id,
      { x, y, z },
      { v: { x: 0, y: 0, z: 0 }, s: 1 },
    );
    this.setLinearVelocity(0, 0, 0);
    this.setAngularVelocity(0, 0, 0);
    this.b3.b3Body_SetAwake(this.id, true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.b3.b3DestroyBody(this.id);
  }
}

/**
 * The physics world plus a fixed-timestep accumulator. Meshes read body
 * positions after each frame via Body.getPosition; box3d owns the truth.
 */
export class Physics {
  /** Solver substeps per fixed tick. The mega bullet time halves this — 150
   * simultaneous ragdolls in one island is the release-frame cost spike, and
   * at 5×-slow the fidelity difference is invisible. */
  subSteps = SUB_STEPS;

  private accumulator = 0;
  private readonly bodies = new Set<Body>();

  private constructor(
    readonly b3: Box3DModule,
    private readonly worldId: b3WorldId,
  ) {}

  static async create(): Promise<Physics> {
    const b3 = await Box3DFactory();
    const worldDef = b3.b3DefaultWorldDef();
    worldDef.gravity = { x: 0, y: -20, z: 0 } as b3Vec3;
    // Swept (continuous) collision for bullet bodies — knockback launches are
    // fast enough to tunnel a discrete step through the ground slab.
    worldDef.enableContinuous = true;
    const worldId = b3.b3CreateWorld(worldDef);
    return new Physics(b3, worldId);
  }

  createGround(halfExtent: number): Body {
    const b3 = this.b3;
    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type = b3.b3BodyType.b3_staticBody;
    bodyDef.position = { x: 0, y: -2, z: 0 };
    const body = new Body(b3, b3.b3CreateBody(this.worldId, bodyDef));
    const shapeDef = b3.b3DefaultShapeDef();
    // Deep slab (half-height 2, top surface at y=0): even if a swept contact
    // is missed, a body has 4 metres of overlap to get pushed back out of.
    b3.b3CreateBoxShape(body.id, shapeDef, halfExtent, 2, halfExtent);
    this.bodies.add(body);
    return body;
  }

  createCapsule(opts: CapsuleOptions): Body {
    const b3 = this.b3;
    const kind = opts.kind ?? "dynamic";
    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type =
      kind === "static" ? b3.b3BodyType.b3_staticBody : b3.b3BodyType.b3_dynamicBody;
    // Rest so the capsule bottom sits on the ground (y=0).
    const restY = opts.height / 2;
    bodyDef.position = { x: opts.x, y: restY, z: opts.z };
    bodyDef.linearDamping = opts.linearDamping ?? 8;
    // Keep capsules upright: lock all rotation and vertical translation.
    bodyDef.motionLocks = {
      linearX: false,
      linearY: !(opts.verticalMotion ?? false),
      linearZ: false,
      angularX: true,
      angularY: true,
      angularZ: true,
    };
    bodyDef.enableSleep = false;
    const body = new Body(b3, b3.b3CreateBody(this.worldId, bodyDef));

    const shapeDef = b3.b3DefaultShapeDef();
    shapeDef.density = opts.density ?? 1;
    if (opts.category !== undefined || opts.mask !== undefined) {
      const filter = b3.b3DefaultFilter();
      if (opts.category !== undefined) filter.categoryBits = BigInt(opts.category);
      if (opts.mask !== undefined) filter.maskBits = BigInt(opts.mask);
      shapeDef.filter = filter;
    }
    // Capsule endpoints are the centers of the two hemisphere caps.
    const capHalf = Math.max(opts.height / 2 - opts.radius, 0.01);
    b3.b3CreateCapsuleShape(body.id, shapeDef, {
      center1: { x: 0, y: -capHalf, z: 0 },
      center2: { x: 0, y: capHalf, z: 0 },
      radius: opts.radius,
    });
    this.bodies.add(body);
    return body;
  }

  createBox(opts: BoxOptions): Body {
    const b3 = this.b3;
    const kind = opts.kind ?? "dynamic";
    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type =
      kind === "static" ? b3.b3BodyType.b3_staticBody : b3.b3BodyType.b3_dynamicBody;
    bodyDef.position = { x: opts.x, y: opts.y, z: opts.z };
    const body = new Body(b3, b3.b3CreateBody(this.worldId, bodyDef));
    const shapeDef = b3.b3DefaultShapeDef();
    shapeDef.density = opts.density ?? 1;
    if (opts.category !== undefined || opts.mask !== undefined) {
      const filter = b3.b3DefaultFilter();
      if (opts.category !== undefined) filter.categoryBits = BigInt(opts.category);
      if (opts.mask !== undefined) filter.maskBits = BigInt(opts.mask);
      shapeDef.filter = filter;
    }
    b3.b3CreateBoxShape(body.id, shapeDef, opts.hx, opts.hy, opts.hz);
    this.bodies.add(body);
    return body;
  }

  removeBody(body: Body): void {
    if (this.bodies.delete(body)) body.destroy();
  }

  /**
   * Radial impulse blast (box3d's native explosion): every shape whose category
   * is in `mask` inside `radius` takes an outward impulse. The mega release uses
   * this so crates, corpses, and stragglers all get shoved by one real shockwave
   * instead of per-body scripted impulses.
   */
  explode(x: number, y: number, z: number, radius: number, impulsePerArea: number, mask: number): void {
    const def = this.b3.b3DefaultExplosionDef();
    def.position = { x, y, z };
    def.radius = radius;
    def.falloff = radius * 0.5;
    def.impulsePerArea = impulsePerArea;
    def.maskBits = BigInt(mask);
    this.b3.b3World_Explode(this.worldId, def);
  }

  /** Number of live bodies (player, enemies, crates, ground/walls). */
  get bodyCount(): number {
    return this.bodies.size;
  }

  /**
   * Advance physics by `dt` seconds using a fixed 60 Hz accumulator so the
   * simulation is deterministic regardless of frame rate. `dt` is the SCALED
   * dt from GameClock, so a timeScale of 0 (hit-stop) freezes physics.
   */
  step(dt: number): void {
    this.accumulator += dt;
    // Cap iterations to avoid a spiral of death after a long stall.
    let iterations = 0;
    while (this.accumulator >= FIXED_DT && iterations < 5) {
      this.b3.b3World_Step(this.worldId, FIXED_DT, this.subSteps);
      this.accumulator -= FIXED_DT;
      iterations++;
    }
  }

  /** Destroy every tracked body and the world. */
  dispose(): void {
    for (const body of this.bodies) body.destroy();
    this.bodies.clear();
    this.b3.b3DestroyWorld(this.worldId);
  }
}

/** Collision filter categories (bitmask). */
export const Category = {
  Ground: 1 << 0,
  Player: 1 << 1,
  Enemy: 1 << 2,
  Prop: 1 << 3,
} as const;
