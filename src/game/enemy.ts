import * as THREE from "three/webgpu"
import { color, float, positionLocal, positionWorld, uniform } from "three/tsl"
import { Physics, Body, Category } from "../core/physics"
import { glossyLensMaterial, standardNodeMaterial } from "../core/materials"
import { Health } from "./health"
import type { Player } from "./player"
import { enemyShockOffset } from "../effects/groundShockwave"
import type { EnemySpatialIndex } from "./enemySpatialIndex"

const ENEMY_HEIGHT = 1.7
const ENEMY_RADIUS = 0.5
const ENEMY_HP = 3
const TOUCH_DAMAGE_RANGE = 1.3
const STUN_DURATION = 0.25
/** Extra stun per point of hit power — launched enemies stay ragdolled longer. */
const STUN_PER_POWER = 0.2
/** Damping while steering (snappy) vs while launched/dead (long slides). */
const STEER_DAMPING = 6
const LAUNCH_DAMPING = 0.55
/**
 * Minimum launch power that warrants continuous collision (CCD "bullet" mode).
 * CCD exists so a huge impulse can't tunnel a body through the 4 m-deep ground
 * slab (see createGround in core/physics.ts) or a ≥6 m-thick wall in one
 * substep. Only genuinely huge launches reach tunneling speeds; weak shoves
 * (shock-front staggers with power ≤ 3, billiard transfers ~≤1.5) never do, so
 * gating here keeps a mega blast from spawning 100+ concurrent CCD bodies in
 * one physics island. Mega spin ≈ 10 and full-charge spins (3.2–5.4) still get
 * CCD; normal swings (≈0.85) and crowd-wide staggers do not.
 */
const BULLET_MIN_POWER = 4
/**
 * Hard cap on simultaneously-CCD bodies. A mega dive/spin kills ~9 enemies per
 * frame across its hit window, every one launched hard enough to qualify for
 * CCD — dozens of concurrent swept bodies plowing through the crate field is
 * the post-slow-mo physics hitch. Beyond this many, extra launches fall back
 * to discrete stepping: per 1/120 s substep they travel ~2 m against a 4 m
 * ground slab, so tunneling stays unlikely.
 */
const MAX_CONCURRENT_BULLETS = 14
const CORPSE_DAMPING = 0.6
const CORPSE_ANGULAR_DAMPING = 1.4
const DOWNED_MIN_RECOVERY_TIME = 0.9
const DOWNED_SETTLE_TIME = 0.35
const DOWNED_MAX_RECOVERY_TIME = 4.2
const DOWNED_STOP_SPEED = 0.55
const DOWNED_STOP_Y_SPEED = 0.8
/**
 * Billiard transfer: a launched body (stunned slider or flying corpse) moving
 * at least this fast that presses into a live enemy shoves that enemy along
 * its velocity. This runs before enemy AI so the victim is stunned before it
 * can steer against the shove.
 */
const BILLIARD_MIN_SPEED = 5
/** Fraction of the incoming speed handed to the struck enemy as an impulse. */
const BILLIARD_TRANSFER = 0.78
/** Each row keeps less force, so chains punch partway through instead of forever. */
const BILLIARD_CHAIN_DECAY = 0.72
/** Counter-impulse on the source to spend some momentum on the hit. */
const BILLIARD_SOURCE_DRAIN = 0.28
/** Maximum same-frame row-to-row transfers from one shove. */
const BILLIARD_MAX_WAVES = 5
/** Contact slack beyond the two body radii. */
const BILLIARD_SLACK = 0.45
/**
 * Baseline death physics (always on, effects or not): enough impulse to tip
 * the corpse over so kills read even with every juice toggle off. The
 * knockback effect layers a much bigger launch + spin on top of this.
 */
const DEATH_TIP_IMPULSE = 2.5
const DEATH_TIP_SPIN = 2.5
/** Ledge offset above which leaving a perch becomes a real falling drop
 * instead of an instant snap to the floor; below it the conversion is a no-op. */
const PERCH_DROP_MIN = 0.4
/** Small leap given to an agent stepping off a ledge so it reads as jumping
 * down (up + a nudge toward the player) rather than teleporting. */
const PERCH_HOP_UP = 2.4
const PERCH_HOP_OUT = 2.2
/**
 * Movement variety: a slice of every crowd spawns as "flankers" that circle
 * the player on a personal orbit ring and dart in on a timer, instead of
 * pressing straight in. The rest ("chasers") keep the old seek behavior but
 * weave sideways on approach so the mob arrives on curves, not rails.
 */
const FLANKER_FRACTION = 0.45
const ORBIT_RADIUS_MIN = 3.5
const ORBIT_RADIUS_MAX = 7.5
/** How hard a flanker corrects toward its preferred ring (per meter of error). */
const ORBIT_RADIAL_GAIN = 0.6
const LUNGE_INTERVAL_MIN = 2
const LUNGE_INTERVAL_MAX = 5.5
const LUNGE_DURATION = 1.1
const LUNGE_SPEED_MULT = 1.5
/** Chance a flanker reverses orbit direction after each lunge. */
const ORBIT_FLIP_CHANCE = 0.35
/** Sideways drift mixed into a chaser's approach (fraction of forward). */
const WEAVE_STRENGTH = 0.45
const WEAVE_FREQ_MIN = 1.2
const WEAVE_FREQ_MAX = 2.6
/** Per-enemy speed jitter so ranks drift apart instead of marching in step. */
const SPEED_JITTER = 0.18
/**
 * Batches are built once per scene and never resized, so this must cover the
 * largest crowd any scenario can field: Revolutions' MAX_TARGET (1000) — its
 * deficit counting includes corpses, so the list never overshoots the target.
 * Keep it snug: the BatchedMesh matrices textures re-upload in full every
 * frame any instance moves, so each 1000 of unused capacity is ~0.6 MB/frame
 * of dead upload across the five buckets.
 */
const ENEMY_BATCH_CAPACITY = 1024
const BODY_COLOR = new THREE.Color(0x15191e)
const LAPEL_COLOR = new THREE.Color(0x2b3036)
const HEAD_COLOR = new THREE.Color(0xd4a18f)
const NOSE_COLOR = new THREE.Color(0xc88676)
const SHIRT_COLOR = new THREE.Color(0xe7ece8)
const TIE_COLOR = new THREE.Color(0x0a0a0c)
const FLASH_COLOR = new THREE.Color(0xffffff)

let nextEnemyId = 0

// Scratch for corpse mesh sync (avoids per-frame allocation).
const tmpQuat = new THREE.Quaternion()
const tmpOffset = new THREE.Vector3()
const tmpImpactVel = { x: 0, y: 0, z: 0 }
// Scratch for the steering write-back (preserves gravity's y velocity).
const steerVel = { x: 0, y: 0, z: 0 }
const tmpRootMatrix = new THREE.Matrix4()
const tmpPartMatrix = new THREE.Matrix4()
const tmpColor = new THREE.Color()

interface BilliardSource {
  enemy: Enemy
  x: number
  z: number
  speed: number
}

const billiardWaveA: BilliardSource[] = []
const billiardWaveB: BilliardSource[] = []
const billiardTouched = new Set<number>()
const billiardCandidates: Enemy[] = []

// Geometry and most materials are identical for every enemy, so they are built
// once and shared. Horde-style scenarios spawn hundreds of enemies; the scene
// batches below keep the full suit/tie silhouette without per-enemy child
// meshes. The legacy child-mesh path remains only for tests/fallback callers
// that do not provide a scene.
const BODY_GEOMETRY = new THREE.CapsuleGeometry(
  ENEMY_RADIUS,
  ENEMY_HEIGHT - 2 * ENEMY_RADIUS,
  6,
  12
)
const HEAD_GEOMETRY = new THREE.SphereGeometry(0.34, 12, 12)
const HEAD_MATERIAL = enemyPartMaterial(0xd4a18f, 0.7, 0.34)
const NOSE_GEOMETRY = new THREE.SphereGeometry(0.085, 8, 8)
const NOSE_MATERIAL = enemyPartMaterial(0xc88676, 0.75, 0.34)
// Anonymous-agent sunglasses: one thin wraparound bar across the face. Shared
// geometry + material (like the head) because crowds put hundreds on screen.
const GLASSES_GEOMETRY = new THREE.BoxGeometry(0.52, 0.11, 0.08)
const GLASSES_MATERIAL = enemyGlossyLensMaterial(0.34)
const SHIRT_GEOMETRY = new THREE.BoxGeometry(0.34, 0.72, 0.045)
const SHIRT_MATERIAL = enemyPartMaterial(0xe7ece8, 0.55, 0.46)
const TIE_GEOMETRY = new THREE.BoxGeometry(0.1, 0.58, 0.06)
const TIE_MATERIAL = enemyPartMaterial(0x0a0a0c, 0.5, 0.5)
const TIE_KNOT_GEOMETRY = new THREE.BoxGeometry(0.16, 0.16, 0.065)
const LAPEL_GEOMETRY = new THREE.BoxGeometry(0.11, 0.58, 0.045)
const LAPEL_MATERIAL = enemyPartMaterial(0x2b3036, 0.62, 0.42)
const BODY_LOCAL = localMatrix(0, ENEMY_HEIGHT / 2, 0)
const HEAD_LOCAL = localMatrix(0, ENEMY_HEIGHT * 0.82, 0.08)
const NOSE_LOCAL = localMatrix(0, ENEMY_HEIGHT * 0.83, 0.42)
const GLASSES_LOCAL = localMatrix(0, ENEMY_HEIGHT * 0.9, 0.39)
const SHIRT_LOCAL = localMatrix(0, ENEMY_HEIGHT * 0.52, ENEMY_RADIUS + 0.025)
const TIE_LOCAL = localMatrix(0, ENEMY_HEIGHT * 0.44, ENEMY_RADIUS + 0.055)
const TIE_KNOT_LOCAL = localMatrix(
  0,
  ENEMY_HEIGHT * 0.66,
  ENEMY_RADIUS + 0.06,
  Math.PI / 4
)
const LAPEL_LEFT_LOCAL = localMatrix(
  -0.18,
  ENEMY_HEIGHT * 0.55,
  ENEMY_RADIUS + 0.04,
  -0.28
)
const LAPEL_RIGHT_LOCAL = localMatrix(
  0.18,
  ENEMY_HEIGHT * 0.55,
  ENEMY_RADIUS + 0.04,
  0.28
)

function enemyPartMaterial(
  hex: number,
  roughness: number,
  shockStrength: number
): THREE.MeshStandardNodeMaterial {
  const material = standardNodeMaterial(hex, roughness)
  material.positionNode = positionLocal.add(
    enemyShockOffset(positionWorld, shockStrength)
  )
  return material
}

function enemyGlossyLensMaterial(
  shockStrength: number
): THREE.MeshPhysicalNodeMaterial {
  const material = glossyLensMaterial(0x101722)
  material.positionNode = positionLocal.add(
    enemyShockOffset(positionWorld, shockStrength)
  )
  return material
}

function enemyBatchMaterial(
  roughness: number,
  shockStrength: number
): THREE.MeshStandardNodeMaterial {
  const material = enemyPartMaterial(0xffffff, roughness, shockStrength)
  return material
}

function localMatrix(
  x: number,
  y: number,
  z: number,
  rotationZ = 0
): THREE.Matrix4 {
  const position = new THREE.Vector3(x, y, z)
  const quaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, 0, rotationZ)
  )
  return new THREE.Matrix4().compose(
    position,
    quaternion,
    new THREE.Vector3(1, 1, 1)
  )
}

function vertexCount(geometry: THREE.BufferGeometry): number {
  return geometry.getAttribute("position").count
}

function indexCount(geometry: THREE.BufferGeometry): number {
  return geometry.getIndex()?.count ?? vertexCount(geometry)
}

class EnemyVisualBucket<TGeometry extends string> {
  readonly mesh: THREE.BatchedMesh
  readonly geometryIds: Record<TGeometry, number>

  constructor(
    name: string,
    scene: THREE.Scene,
    material: THREE.Material,
    capacity: number,
    geometries: Record<TGeometry, THREE.BufferGeometry>,
    castShadow: boolean
  ) {
    const values = Object.values(geometries) as THREE.BufferGeometry[]
    const maxVertexCount = values.reduce(
      (sum, geometry) => sum + vertexCount(geometry),
      0
    )
    const maxIndexCount = values.reduce(
      (sum, geometry) => sum + indexCount(geometry),
      0
    )
    this.mesh = new THREE.BatchedMesh(
      capacity,
      maxVertexCount,
      maxIndexCount,
      material
    )
    this.mesh.name = name
    this.mesh.frustumCulled = false
    this.mesh.perObjectFrustumCulled = true
    this.mesh.sortObjects = false
    this.mesh.castShadow = castShadow
    this.mesh.receiveShadow = false
    this.geometryIds = {} as Record<TGeometry, number>

    for (const [key, geometry] of Object.entries(geometries) as Array<
      [TGeometry, THREE.BufferGeometry]
    >) {
      this.geometryIds[key] = this.mesh.addGeometry(geometry)
    }

    scene.add(this.mesh)
  }

  add(geometry: TGeometry): number {
    return this.mesh.addInstance(this.geometryIds[geometry])
  }

  delete(instanceId: number): void {
    this.mesh.deleteInstance(instanceId)
  }

  setColor(instanceId: number, colorValue: THREE.Color): void {
    this.mesh.setColorAt(instanceId, colorValue)
  }

  setMatrix(
    instanceId: number,
    rootMatrix: THREE.Matrix4,
    local: THREE.Matrix4
  ): void {
    this.mesh.setMatrixAt(
      instanceId,
      tmpPartMatrix.multiplyMatrices(rootMatrix, local)
    )
  }
}

interface EnemyVisualHandle {
  body: number
  leftLapel: number
  rightLapel: number
  head: number
  nose: number
  glasses: number
  shirt: number
  tie: number
  knot: number
}

class EnemyBatchedVisual {
  constructor(
    private readonly batches: EnemyVisualBatches,
    private readonly handle: EnemyVisualHandle
  ) {}

  setFlash(amount: number): void {
    this.batches.setFlash(this.handle, amount)
  }

  sync(group: THREE.Object3D): void {
    this.batches.sync(this.handle, group)
  }

  dispose(): void {
    this.batches.delete(this.handle)
  }
}

class EnemyVisualBatches {
  private static readonly byScene = new WeakMap<
    THREE.Scene,
    EnemyVisualBatches
  >()

  static forScene(scene: THREE.Scene): EnemyVisualBatches {
    let batches = this.byScene.get(scene)
    if (!batches) {
      batches = new EnemyVisualBatches(scene)
      this.byScene.set(scene, batches)
    }
    return batches
  }

  private readonly suit: EnemyVisualBucket<"body" | "lapel">
  private readonly skin: EnemyVisualBucket<"head" | "nose">
  private readonly glasses: EnemyVisualBucket<"glasses">
  private readonly shirt: EnemyVisualBucket<"shirt">
  private readonly tie: EnemyVisualBucket<"tie" | "knot">

  private constructor(scene: THREE.Scene) {
    this.suit = new EnemyVisualBucket(
      "enemy-suit-batch",
      scene,
      enemyBatchMaterial(0.66, 0.66),
      ENEMY_BATCH_CAPACITY * 3,
      { body: BODY_GEOMETRY, lapel: LAPEL_GEOMETRY },
      true
    )
    this.skin = new EnemyVisualBucket(
      "enemy-skin-batch",
      scene,
      enemyBatchMaterial(0.7, 0.34),
      ENEMY_BATCH_CAPACITY * 2,
      { head: HEAD_GEOMETRY, nose: NOSE_GEOMETRY },
      false
    )
    this.glasses = new EnemyVisualBucket(
      "enemy-glasses-batch",
      scene,
      enemyGlossyLensMaterial(0.34),
      ENEMY_BATCH_CAPACITY,
      { glasses: GLASSES_GEOMETRY },
      false
    )
    this.shirt = new EnemyVisualBucket(
      "enemy-shirt-batch",
      scene,
      enemyBatchMaterial(0.55, 0.46),
      ENEMY_BATCH_CAPACITY,
      { shirt: SHIRT_GEOMETRY },
      false
    )
    this.tie = new EnemyVisualBucket(
      "enemy-tie-batch",
      scene,
      enemyBatchMaterial(0.5, 0.5),
      ENEMY_BATCH_CAPACITY * 2,
      { tie: TIE_GEOMETRY, knot: TIE_KNOT_GEOMETRY },
      false
    )
  }

  addEnemy(): EnemyBatchedVisual {
    const handle: EnemyVisualHandle = {
      body: this.suit.add("body"),
      leftLapel: this.suit.add("lapel"),
      rightLapel: this.suit.add("lapel"),
      head: this.skin.add("head"),
      nose: this.skin.add("nose"),
      glasses: this.glasses.add("glasses"),
      shirt: this.shirt.add("shirt"),
      tie: this.tie.add("tie"),
      knot: this.tie.add("knot")
    }
    this.suit.setColor(handle.body, BODY_COLOR)
    this.suit.setColor(handle.leftLapel, LAPEL_COLOR)
    this.suit.setColor(handle.rightLapel, LAPEL_COLOR)
    this.skin.setColor(handle.head, HEAD_COLOR)
    this.skin.setColor(handle.nose, NOSE_COLOR)
    this.shirt.setColor(handle.shirt, SHIRT_COLOR)
    this.tie.setColor(handle.tie, TIE_COLOR)
    this.tie.setColor(handle.knot, TIE_COLOR)
    return new EnemyBatchedVisual(this, handle)
  }

  setFlash(handle: EnemyVisualHandle, amount: number): void {
    tmpColor
      .copy(BODY_COLOR)
      .lerp(FLASH_COLOR, THREE.MathUtils.clamp(amount, 0, 1))
    this.suit.setColor(handle.body, tmpColor)
  }

  sync(handle: EnemyVisualHandle, group: THREE.Object3D): void {
    group.updateWorldMatrix(true, false)
    tmpRootMatrix.copy(group.matrixWorld)
    this.suit.setMatrix(handle.body, tmpRootMatrix, BODY_LOCAL)
    this.suit.setMatrix(handle.leftLapel, tmpRootMatrix, LAPEL_LEFT_LOCAL)
    this.suit.setMatrix(handle.rightLapel, tmpRootMatrix, LAPEL_RIGHT_LOCAL)
    this.skin.setMatrix(handle.head, tmpRootMatrix, HEAD_LOCAL)
    this.skin.setMatrix(handle.nose, tmpRootMatrix, NOSE_LOCAL)
    this.glasses.setMatrix(handle.glasses, tmpRootMatrix, GLASSES_LOCAL)
    this.shirt.setMatrix(handle.shirt, tmpRootMatrix, SHIRT_LOCAL)
    this.tie.setMatrix(handle.tie, tmpRootMatrix, TIE_LOCAL)
    this.tie.setMatrix(handle.knot, tmpRootMatrix, TIE_KNOT_LOCAL)
  }

  delete(handle: EnemyVisualHandle): void {
    this.suit.delete(handle.body)
    this.suit.delete(handle.leftLapel)
    this.suit.delete(handle.rightLapel)
    this.skin.delete(handle.head)
    this.skin.delete(handle.nose)
    this.glasses.delete(handle.glasses)
    this.shirt.delete(handle.shirt)
    this.tie.delete(handle.tie)
    this.tie.delete(handle.knot)
  }
}

export interface EnemyConfig {
  seekSpeed?: number
  separation?: number
  hp?: number
  /** Scene used to attach shared BatchedMesh buckets for horde-scale rendering. */
  scene?: THREE.Scene
  /** Retained as spawn intent; scene-batched enemies always render the complete suit. */
  visualDetail?: "full" | "crowd"
  /**
   * Preferred engagement distance: the enemy stops advancing once this close
   * and holds its ring (separation still applies). Randomizing it across a
   * crowd staggers the mob into loose shells instead of one dense clump —
   * both easier on the physics broadphase and better-looking on release.
   */
  standoff?: number
}

/**
 * A stylized suited agent that seeks the player. Physics owns its XZ position;
 * the mesh follows. `baseScale` is the rest scale the squash effect springs
 * back to.
 */
export class Enemy {
  readonly id = nextEnemyId++
  readonly group = new THREE.Group()
  readonly body: Body
  readonly health: Health
  readonly material: THREE.MeshStandardNodeMaterial | null

  /** Emissive flash strength driven by the enemy-flash effect (0 = none). */
  readonly flash = uniform(0)

  /** Rest scale; the enemy-squash effect (M2) modulates group.scale around this. */
  readonly baseScale = new THREE.Vector3(1, 1, 1)
  /** True while knocked down/tumbling after a finishing hit. */
  dead = false

  /** True while damping is lowered for a knockback slide (read by billiard). */
  launched = false
  /** XZ velocity cached once per frame in syncMesh (avoids O(n²) wasm reads). */
  readonly vel = { x: 0, y: 0, z: 0 }
  /** Cached XZ speed matching `vel`. */
  speedXZ = 0

  private readonly seekSpeed: number
  private readonly separation: number
  private standoff: number
  /** Role assigned at spawn: flankers orbit and dart in; chasers press in. */
  private readonly flanker = Math.random() < FLANKER_FRACTION
  private orbitDir = Math.random() < 0.5 ? 1 : -1
  private readonly orbitRadius =
    ORBIT_RADIUS_MIN + Math.random() * (ORBIT_RADIUS_MAX - ORBIT_RADIUS_MIN)
  private readonly speedScale = 1 + (Math.random() * 2 - 1) * SPEED_JITTER
  private readonly weavePhase = Math.random() * Math.PI * 2
  private readonly weaveFreq =
    WEAVE_FREQ_MIN + Math.random() * (WEAVE_FREQ_MAX - WEAVE_FREQ_MIN)
  private aiTime = Math.random() * 100
  private lungeCooldown =
    LUNGE_INTERVAL_MIN +
    Math.random() * (LUNGE_INTERVAL_MAX - LUNGE_INTERVAL_MIN)
  private lungeTime = 0
  private stunTimer = 0
  private downedTimer = 0
  private downedSettledTimer = 0
  private presentationYOffset = 0
  private movementLocked = false
  private holdLane: { x: number; z: number } | null = null
  /** Presentation-only balcony ranks: no physics contacts at all. */
  private rankDecorative = false
  private readonly activeMask =
    Category.Player | Category.Enemy | Category.Ground | Category.Prop
  private readonly heldMask = Category.Player | Category.Ground | Category.Prop
  /** Mirrors the wasm body's bullet flag so we never issue redundant calls. */
  private bulletOn = false

  private readonly pos = { x: 0, y: 0, z: 0 }
  private readonly quat = { x: 0, y: 0, z: 0, w: 1 }
  private readonly toPlayer = new THREE.Vector3()
  private readonly nearby: Enemy[] = []
  private readonly batchedVisual: EnemyBatchedVisual | null = null

  constructor(
    physics: Physics,
    spawn: THREE.Vector2,
    config: EnemyConfig = {}
  ) {
    this.seekSpeed = config.seekSpeed ?? 6.4
    this.separation = config.separation ?? 1.4
    this.standoff = config.standoff ?? 0
    this.health = new Health(config.hp ?? ENEMY_HP)
    const fullDetail = (config.visualDetail ?? "full") === "full"

    this.body = physics.createCapsule({
      x: spawn.x,
      z: spawn.y,
      height: ENEMY_HEIGHT,
      radius: ENEMY_RADIUS,
      linearDamping: 6,
      kind: "dynamic",
      category: Category.Enemy,
      mask: Category.Player | Category.Enemy | Category.Ground | Category.Prop,
      verticalMotion: true
    })

    if (config.scene) {
      this.material = null
      this.batchedVisual = EnemyVisualBatches.forScene(config.scene).addEnemy()
      return
    }

    this.material = new THREE.MeshStandardNodeMaterial()
    this.material.colorNode = color(0x15191e)
    this.material.roughnessNode = float(0.68)
    this.material.emissiveNode = color(0xffffff).mul(this.flash)
    this.material.positionNode = positionLocal.add(
      enemyShockOffset(positionWorld, 0.66)
    )
    const bodyMesh = new THREE.Mesh(BODY_GEOMETRY, this.material)
    bodyMesh.position.y = ENEMY_HEIGHT / 2
    bodyMesh.castShadow = true
    this.group.add(bodyMesh)

    // Oversized simple head and face markers keep the agent readable at horde
    // scale while the dark capsule reads as the abstract suit silhouette.
    const head = new THREE.Mesh(HEAD_GEOMETRY, HEAD_MATERIAL)
    head.position.set(0, ENEMY_HEIGHT * 0.82, 0.08)
    head.castShadow = fullDetail
    this.group.add(head)

    // Small nose sphere marking facing.
    const nose = new THREE.Mesh(NOSE_GEOMETRY, NOSE_MATERIAL)
    nose.position.set(0, ENEMY_HEIGHT * 0.83, 0.42)
    nose.castShadow = false
    this.group.add(nose)

    // Dark shades at eye height, just proud of the capsule surface.
    const glasses = new THREE.Mesh(GLASSES_GEOMETRY, GLASSES_MATERIAL)
    glasses.position.set(0, ENEMY_HEIGHT * 0.9, 0.39)
    this.group.add(glasses)

    const shirt = new THREE.Mesh(SHIRT_GEOMETRY, SHIRT_MATERIAL)
    shirt.position.set(0, ENEMY_HEIGHT * 0.52, ENEMY_RADIUS + 0.025)
    shirt.castShadow = false
    this.group.add(shirt)

    const tie = new THREE.Mesh(TIE_GEOMETRY, TIE_MATERIAL)
    tie.position.set(0, ENEMY_HEIGHT * 0.44, ENEMY_RADIUS + 0.055)
    tie.castShadow = false
    this.group.add(tie)

    const knot = new THREE.Mesh(TIE_KNOT_GEOMETRY, TIE_MATERIAL)
    knot.position.set(0, ENEMY_HEIGHT * 0.66, ENEMY_RADIUS + 0.06)
    knot.rotation.z = Math.PI / 4
    knot.castShadow = false
    this.group.add(knot)

    for (const side of [-1, 1]) {
      const lapel = new THREE.Mesh(LAPEL_GEOMETRY, LAPEL_MATERIAL)
      lapel.position.set(side * 0.18, ENEMY_HEIGHT * 0.55, ENEMY_RADIUS + 0.04)
      lapel.rotation.z = side * 0.28
      lapel.castShadow = false
      this.group.add(lapel)
    }
  }

  get position(): THREE.Vector3 {
    return this.group.position
  }

  /** Body radius, so hit tests can register on the surface, not the center. */
  get radius(): number {
    return ENEMY_RADIUS
  }

  get isStunned(): boolean {
    return this.stunTimer > 0
  }

  /** Brief stun applied when hurt so hits read clearly. */
  stun(): void {
    this.stunTimer = STUN_DURATION
  }

  /** Update both the legacy material uniform and the batched body color flash. */
  setFlash(amount: number): void {
    this.flash.value = amount
    this.batchedVisual?.setFlash(amount)
  }

  /**
   * Visual-only vertical offset used by staged scenario entrances. Physics and
   * combat stay on the XZ lane while the mesh rides in from above or on a ledge.
   */
  setPresentationYOffset(offset: number): void {
    this.presentationYOffset = offset
  }

  /** Pin a scenario-held rank agent to its facade slot on the XZ plane. */
  anchorHoldLane(x: number, z: number): void {
    this.holdLane = { x, z }
  }

  /** Upper-ledge crowd: presentation only, never a dynamic obstacle. */
  setRankDecorative(decorative: boolean): void {
    this.rankDecorative = decorative
    if (this.movementLocked) this.applyHoldCollisionMask()
  }

  /** Temporarily holds an enemy in place during a scenario entrance. */
  setMovementLocked(locked: boolean): void {
    this.movementLocked = locked
    if (locked) {
      if (!this.holdLane) {
        this.body.getPosition(this.pos)
        this.holdLane = { x: this.pos.x, z: this.pos.z }
      }
      this.applyHoldCollisionMask()
      this.snapHoldLane()
    } else {
      this.holdLane = null
      this.rankDecorative = false
      this.body.setCollisionMask(this.activeMask)
    }
  }

  private applyHoldCollisionMask(): void {
    this.body.setCollisionMask(this.rankDecorative ? 0 : this.heldMask)
  }

  private snapHoldLane(): void {
    if (!this.holdLane) return
    this.body.setLinearVelocity(0, 0, 0)
    this.body.lockUprightAt(this.holdLane.x, ENEMY_HEIGHT / 2, this.holdLane.z, true)
  }

  /** Retune the engagement shell when a scenario promotes a reserve into the fight. */
  setStandoff(standoff: number): void {
    this.standoff = Math.max(0, standoff)
  }

  /**
   * Convert a ledge-perched agent's visual height into a real physical drop.
   * While perched the body rests on the ground (y = H/2) and the mesh is floated
   * up by presentationYOffset; leaving the perch used to just zero that offset,
   * snapping the mesh straight to the floor. Instead lift the body to the mesh's
   * current height, clear the offset, and give it a small leap so gravity carries
   * it down in an arc — it jumps off the ledge rather than teleporting. Since each
   * one drops from its own slot on its own arc, a row knocked loose together comes
   * down as individual falls, not one synchronized snap.
   */
  private dropFromPerch(): void {
    const offset = this.presentationYOffset
    if (offset <= PERCH_DROP_MIN) return
    this.body.getPosition(this.pos)
    this.presentationYOffset = 0
    // resetTransform leaves the motion locks untouched (linearY already free for
    // these bodies), so gravity takes over from the elevated position.
    this.body.resetTransform(this.pos.x, this.pos.y + offset, this.pos.z)
    this.body.applyLinearImpulseToCenter(
      this.toPlayer.x * PERCH_HOP_OUT,
      PERCH_HOP_UP,
      this.toPlayer.z * PERCH_HOP_OUT
    )
  }

  /**
   * Hit reaction scaled by power: longer stun and low damping so a knockback
   * impulse sends the body skidding across the floor instead of stopping dead.
   * While stunned the AI never overwrites velocity, so physics owns the slide;
   * damping snaps back to the steering value when the stun ends (see update).
   */
  stagger(power: number): void {
    this.stunTimer = STUN_DURATION + power * STUN_PER_POWER
    if (!this.launched) {
      this.launched = true
      // Turn a ledge perch into a real fall before anything else clears the
      // offset, so the body drops from rail height instead of the mesh
      // teleporting to the floor.
      this.dropFromPerch()
      // Release any staged-entrance hold: a rail-perched agent rides on a
      // visual Y offset with movement locked, so without this it would freeze
      // its velocity every frame and hover at rail height instead of falling.
      this.movementLocked = false
      this.holdLane = null
      this.rankDecorative = false
      this.presentationYOffset = 0
      this.body.setCollisionMask(this.activeMask)
      this.body.setLinearDamping(LAUNCH_DAMPING)
      // Swept collision only for launches fast enough to tunnel; crowd-wide
      // weak staggers skip CCD so a mega blast doesn't spawn 100+ bullet bodies.
      if (power >= BULLET_MIN_POWER) this.setBullet(true)
    }
  }

  /** Live CCD bodies across all enemies (see MAX_CONCURRENT_BULLETS). */
  private static bulletCount = 0

  /** Toggle the body's CCD bullet flag, skipping redundant wasm calls and
   * refusing new bullets once the global budget is spent. */
  private setBullet(on: boolean): void {
    if (this.bulletOn === on) return
    if (on && Enemy.bulletCount >= MAX_CONCURRENT_BULLETS) return
    Enemy.bulletCount += on ? 1 : -1
    this.bulletOn = on
    this.body.setBullet(on)
  }

  /**
   * Core-gameplay death: mark dead, free the rotation locks, and tip the body
   * over in the hit direction. This lives here (not in an effect) so enemies
   * still visibly fall over when every juice effect is toggled off. Corpse
   * damping drops low so launches slide and tumble a long way.
   */
  die(dir: THREE.Vector3, power = 10): void {
    this.dead = true
    this.launched = true
    this.downedTimer = 0
    this.downedSettledTimer = 0
    // A killed perch agent should fall from the ledge too (no-op if stagger
    // already dropped it this frame).
    this.dropFromPerch()
    this.presentationYOffset = 0
    this.movementLocked = false
    this.holdLane = null
    this.rankDecorative = false
    this.body.setCollisionMask(this.activeMask)
    this.body.unlockRotation()
    // Only heavy launches need CCD; weak-shove corpses can't tunnel out.
    if (power >= BULLET_MIN_POWER) this.setBullet(true)
    this.body.setLinearDamping(CORPSE_DAMPING)
    this.body.setAngularDamping(CORPSE_ANGULAR_DAMPING)
    this.body.applyLinearImpulseToCenter(
      dir.x * DEATH_TIP_IMPULSE,
      0,
      dir.z * DEATH_TIP_IMPULSE
    )
    // Topple around the horizontal axis perpendicular to the hit direction.
    this.body.applyAngularImpulse(
      -dir.z * DEATH_TIP_SPIN,
      0,
      dir.x * DEATH_TIP_SPIN
    )
  }

  /**
   * Propagate fresh knockback through touching rows. This is intentionally
   * gameplay-level transfer on top of box3d contacts: dense dynamic crowds can
   * spend all momentum against the front row before the rear rows visibly move.
   */
  static resolveBilliardTransfers(
    enemies: readonly Enemy[],
    index?: EnemySpatialIndex
  ): void {
    let current = billiardWaveA
    let next = billiardWaveB
    current.length = 0
    next.length = 0
    billiardTouched.clear()

    for (const enemy of enemies) {
      if (enemy.parked || (!enemy.launched && !enemy.dead)) continue
      enemy.body.getLinearVelocity(tmpImpactVel)
      const speed = Math.hypot(tmpImpactVel.x, tmpImpactVel.z)
      enemy.vel.x = tmpImpactVel.x
      enemy.vel.y = tmpImpactVel.y
      enemy.vel.z = tmpImpactVel.z
      enemy.speedXZ = speed
      if (speed < BILLIARD_MIN_SPEED) continue
      current.push({
        enemy,
        x: tmpImpactVel.x / speed,
        z: tmpImpactVel.z / speed,
        speed
      })
    }
    if (current.length === 0) return

    for (let i = 0; i < BILLIARD_MAX_WAVES && current.length > 0; i++) {
      next.length = 0
      for (const source of current) {
        if (source.speed < BILLIARD_MIN_SPEED) continue
        const victim = Enemy.findBilliardVictim(
          source,
          enemies,
          billiardTouched,
          index
        )
        if (!victim) continue

        const impulse = source.speed * BILLIARD_TRANSFER
        victim.stagger(source.speed / 7)
        victim.body.applyLinearImpulseToCenter(
          source.x * impulse,
          0,
          source.z * impulse
        )
        victim.vel.x = source.x * impulse
        victim.vel.y = 0
        victim.vel.z = source.z * impulse
        victim.speedXZ = impulse
        billiardTouched.add(victim.id)

        source.enemy.body.applyLinearImpulseToCenter(
          -source.x * impulse * BILLIARD_SOURCE_DRAIN,
          0,
          -source.z * impulse * BILLIARD_SOURCE_DRAIN
        )

        const nextSpeed = source.speed * BILLIARD_CHAIN_DECAY
        if (nextSpeed >= BILLIARD_MIN_SPEED) {
          next.push({
            enemy: victim,
            x: source.x,
            z: source.z,
            speed: nextSpeed
          })
        }
      }
      const swap = current
      current = next
      next = swap
    }
  }

  private static findBilliardVictim(
    source: BilliardSource,
    enemies: readonly Enemy[],
    touched: ReadonlySet<number>,
    index?: EnemySpatialIndex
  ): Enemy | null {
    const contact = ENEMY_RADIUS * 2 + BILLIARD_SLACK
    const contactSq = contact * contact
    const sx = source.enemy.position.x
    const sz = source.enemy.position.z
    let best: Enemy | null = null
    let bestAhead = Infinity
    const candidates = index
      ? index.collectCircle(sx, sz, contact, billiardCandidates)
      : enemies

    for (const enemy of candidates) {
      if (
        enemy === source.enemy ||
        enemy.dead ||
        enemy.launched ||
        enemy.parked ||
        touched.has(enemy.id)
      ) {
        continue
      }
      const dx = enemy.position.x - sx
      const dz = enemy.position.z - sz
      const dSq = dx * dx + dz * dz
      if (dSq >= contactSq || dSq < 1e-8) continue
      const ahead = dx * source.x + dz * source.z
      if (ahead <= 0 || ahead >= bestAhead) continue
      best = enemy
      bestAhead = ahead
    }

    return best
  }

  /** True once a scenario has parked the enemy out of sight pending removal. */
  parked = false

  /**
   * Phase one of enemy removal: yank the group far under the floor for one
   * final rendered frame. The WebGPU shadow pass holds an object's last
   * uploaded matrix; removing an enemy outright would freeze its shadow at the
   * death pose, so we give the cache a harmless offscreen matrix first.
   */
  park(): void {
    this.parked = true
    this.group.position.set(0, -1000, 0)
  }

  /**
   * Release GPU resources. Must be called when the enemy leaves the scene for
   * good — the WebGPU renderer keeps shadow/render caches keyed on live
   * geometry+material, so an undisposed enemy leaves a ghost in the shadow map.
   * Only the per-enemy body material is disposed; geometry and the nose
   * material are module-shared across all enemies.
   */
  dispose(): void {
    // Return this body's CCD slot to the global budget — scenario switches
    // dispose enemies mid-flight, and a leaked count would starve future launches.
    this.setBullet(false)
    this.batchedVisual?.dispose()
    this.material?.dispose()
  }

  /** Distance from a point to this enemy on the XZ plane. */
  distanceTo(point: THREE.Vector3): number {
    const dx = point.x - this.position.x
    const dz = point.z - this.position.z
    return Math.hypot(dx, dz)
  }

  /**
   * Seek AI: steer toward the player with a little separation, unless dead or
   * stunned. Returns true if it is currently within touch-damage range.
   * `dt` is scaled dt (freezes with hit-stop). Others is the live enemy list.
   */
  update(
    dt: number,
    player: Player,
    others: readonly Enemy[],
    index?: EnemySpatialIndex
  ): boolean {
    if (this.dead) {
      this.updateDowned(dt, player)
      return false
    }

    if (this.movementLocked) {
      this.snapHoldLane()
      this.toPlayer.copy(player.position).sub(this.position)
      this.toPlayer.y = 0
      if (this.toPlayer.lengthSq() > 0.0001) this.toPlayer.normalize()
      return false
    }

    if (this.stunTimer > 0) {
      this.stunTimer = Math.max(0, this.stunTimer - dt)
      // Slide over: restore snappy steering damping and resume the chase.
      if (this.stunTimer === 0 && this.launched) {
        this.launched = false
        this.body.setLinearDamping(STEER_DAMPING)
        this.setBullet(false)
      }
    }

    // Face and move toward the player.
    this.toPlayer.copy(player.position).sub(this.position)
    this.toPlayer.y = 0
    const dist = this.toPlayer.length()
    if (dist > 0.0001) this.toPlayer.normalize()

    if (!this.isStunned) {
      this.aiTime += dt
      const speed = this.seekSpeed * this.speedScale
      const px = this.toPlayer.x
      const pz = this.toPlayer.z
      // Tangent around the player in this enemy's orbit direction.
      const tx = -pz * this.orbitDir
      const tz = px * this.orbitDir
      let vx = 0
      let vz = 0

      if (this.flanker && this.lungeTime > 0) {
        // Dart straight in, faster than a normal chase; break off on contact.
        this.lungeTime -= dt
        vx = px * speed * LUNGE_SPEED_MULT
        vz = pz * speed * LUNGE_SPEED_MULT
        if (dist <= TOUCH_DAMAGE_RANGE) this.lungeTime = 0
      } else if (this.flanker) {
        this.lungeCooldown -= dt
        if (this.lungeCooldown <= 0) {
          this.lungeTime = LUNGE_DURATION
          this.lungeCooldown =
            LUNGE_INTERVAL_MIN +
            Math.random() * (LUNGE_INTERVAL_MAX - LUNGE_INTERVAL_MIN)
          if (Math.random() < ORBIT_FLIP_CHANCE) this.orbitDir *= -1
        }
        // Circle the player: mostly tangent motion with a radial correction
        // toward the preferred ring. Far away this blends into a curved,
        // spiraling approach instead of a beeline.
        const radial = THREE.MathUtils.clamp(
          (dist - this.orbitRadius) * ORBIT_RADIAL_GAIN,
          -1,
          1
        )
        const dx = px * radial + tx
        const dz = pz * radial + tz
        const len = Math.hypot(dx, dz) || 1
        vx = (dx / len) * speed
        vz = (dz / len) * speed
      } else if (dist > this.standoff) {
        // Chaser: advance only while outside the preferred ring; inside it,
        // hold and let separation shuffle the line. Weave sideways on the way
        // in so the pack converges on curves rather than straight rails.
        const weave =
          dist > 2.5
            ? Math.sin(this.aiTime * this.weaveFreq + this.weavePhase) *
              WEAVE_STRENGTH
            : 0
        const dx = px + tx * weave
        const dz = pz + tz * weave
        const len = Math.hypot(dx, dz) || 1
        vx = (dx / len) * speed
        vz = (dz / len) * speed
      }
      // Separation only needs local neighbors. The optional frame grid keeps
      // horde-scale crowds from scanning almost every far-away pair.
      const sepSq = this.separation * this.separation
      const candidates = index
        ? index.collectCircle(
            this.position.x,
            this.position.z,
            this.separation,
            this.nearby
          )
        : others
      for (const other of candidates) {
        if (other === this) continue
        const dx = this.position.x - other.position.x
        const dz = this.position.z - other.position.z
        const dSq = dx * dx + dz * dz

        if (other.dead) continue
        if (dSq >= sepSq || dSq < 1e-8) continue
        const d = Math.sqrt(dSq)
        const push = (this.separation - d) / this.separation
        vx += (dx / d) * push * this.seekSpeed
        vz += (dz / d) * push * this.seekSpeed
      }
      // Preserve vertical velocity: steering only owns the XZ plane. Writing
      // y=0 here cancelled gravity every frame, so an agent knocked airborne
      // whose stun expired mid-air would hover and walk on nothing forever.
      this.body.getLinearVelocity(steerVel)
      this.body.setLinearVelocity(vx, steerVel.y, vz)
    }

    return dist <= TOUCH_DAMAGE_RANGE
  }

  private updateDowned(dt: number, player: Player): void {
    this.downedTimer += dt
    const stopped =
      this.speedXZ <= DOWNED_STOP_SPEED &&
      Math.abs(this.vel.y) <= DOWNED_STOP_Y_SPEED

    if (this.downedTimer >= DOWNED_MIN_RECOVERY_TIME && stopped) {
      this.downedSettledTimer += dt
    } else if (!stopped) {
      this.downedSettledTimer = 0
    }

    if (
      this.downedSettledTimer >= DOWNED_SETTLE_TIME ||
      this.downedTimer >= DOWNED_MAX_RECOVERY_TIME
    ) {
      this.recoverFromDowned(player)
    }
  }

  private recoverFromDowned(player: Player): void {
    this.body.getPosition(this.pos)
    this.body.lockUprightAt(this.pos.x, ENEMY_HEIGHT / 2, this.pos.z, true)
    this.body.setLinearDamping(STEER_DAMPING)
    this.body.setAngularDamping(0)
    this.setBullet(false)

    this.dead = false
    this.launched = false
    this.stunTimer = 0
    this.downedTimer = 0
    this.downedSettledTimer = 0
    this.health.reset()
    this.presentationYOffset = 0
    this.movementLocked = false
    this.holdLane = null
    this.rankDecorative = false
    this.body.setCollisionMask(this.activeMask)
    this.vel.x = 0
    this.vel.y = 0
    this.vel.z = 0
    this.speedXZ = 0
    this.group.position.set(this.pos.x, 0, this.pos.z)
    this.group.quaternion.identity()
    this.group.scale.copy(this.baseScale)
    this.setFlash(0)

    this.toPlayer.copy(player.position).sub(this.position)
    this.toPlayer.y = 0
    if (this.toPlayer.lengthSq() > 0.0001) {
      this.toPlayer.normalize()
      this.group.rotation.y = Math.atan2(this.toPlayer.x, this.toPlayer.z)
    }
  }

  /**
   * Sync mesh from physics body. While active the mesh stays upright facing the
   * player; while downed (knockback frees the rotation locks) it renders the
   * body's full 3D transform so the agent can tumble.
   */
  syncMesh(): void {
    if (this.parked) {
      // Parked enemies are inert — never a billiard source.
      this.speedXZ = 0
      return // stay hidden under the floor until removed
    }
    // Cache velocity for the billiard pass: one wasm read per enemy per frame
    // here beats one per *pair* inside the O(n²) crowd loop.
    this.body.getLinearVelocity(this.vel)
    this.speedXZ = Math.hypot(this.vel.x, this.vel.z)
    this.body.getPosition(this.pos)
    if (this.dead) {
      // The visual capsule is a child offset +H/2 up the group's local Y, so
      // the group origin must sit at (bodyCenter - rotatedHalfHeight). Using
      // the unrotated offset here made lying agents render sunk halfway into
      // the floor — the "tunneling" look — while physics rested them fine.
      this.body.getQuaternion(this.quat)
      tmpQuat.set(this.quat.x, this.quat.y, this.quat.z, this.quat.w)
      tmpOffset.set(0, ENEMY_HEIGHT / 2, 0).applyQuaternion(tmpQuat)
      this.group.position.set(
        this.pos.x - tmpOffset.x,
        this.pos.y - tmpOffset.y,
        this.pos.z - tmpOffset.z
      )
      this.group.quaternion.copy(tmpQuat)
      return
    }
    this.group.position.set(
      this.pos.x,
      this.pos.y - ENEMY_HEIGHT / 2 + this.presentationYOffset,
      this.pos.z
    )
    // Face the player-ward direction computed last update.
    if (this.toPlayer.lengthSq() > 0.0001) {
      this.group.rotation.y = Math.atan2(this.toPlayer.x, this.toPlayer.z)
    }
  }

  /** Upload batched visual matrices after late-frame scale effects have run. */
  syncVisuals(): void {
    this.batchedVisual?.sync(this.group)
  }
}
