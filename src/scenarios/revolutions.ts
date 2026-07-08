import * as THREE from "three/webgpu"
import type { Scenario, ScenarioContext } from "./scenario"
import { Enemy } from "../game/enemy"
import { CubeBuildings } from "../game/buildings"
import {
  buildArenaEnvironment,
  disposeArenaEnvironment,
  type ArenaCorridorBounds
} from "./arena"
import { type Body } from "../core/physics"
import { standardNodeMaterial } from "../core/materials"
import {
  setBuildingImpactGlowStrength,
  type ShockFrontSnapshot
} from "../effects/groundShockwave"

/**
 * Revolutions: the Super Burly Brawl street. Modular cube skyscrapers wall in
 * a rain-slick corridor ahead of the player and agents stream in ranks along
 * both facades toward the fog line. The follow camera sits behind the player
 * on +Z, so the street is forward-only — nothing is built or filled behind.
 * Bodies blasted hard into the buildings spray decorative debris chunks (see
 * CubeBuildings); the facades themselves are static and indestructible. The
 * cube windows fake lit interiors with parallax interior-mapping in the
 * material — no post chain, so it renders on the plain path and stays fast.
 */

const DEFAULT_TARGET = 500
const MIN_TARGET = 12
/** Must stay ≤ ENEMY_BATCH_CAPACITY (enemy.ts): the shared BatchedMesh
 * buckets are sized to it and cannot grow after the first enemy spawns. */
const MAX_TARGET = 1000
/** Base stream rate (agents/sec); scaled by the fly-in speed knob. */
const SPAWN_RATE = 60
const MAX_SPAWNS_PER_FRAME = 32
/** The scene opens by staging most agents into ranked facade slots. */
const OPENING_PRESSER_RESERVE = 4
/** Bodies must be moving at least this fast to shatter cubes off a facade. */
const IMPACT_SPEED = 7
const IMPACT_COOLDOWN = 0.4
const PLAYER_BUILDING_SHOCK_SCALE = 5
const LIGHTNING_BUILDING_POWER = 0.5
// Wider spacing than before: each agent covers more street, so the ranks read
// as full lines to the fog line without needing as many bodies to fill them.
// Bumped 1.5× (was 1.7) so each line is sparser — trades line density for an
// extra vertical stack without inflating the total body count.
const SLOT_SPACING = 2.55
const FACADE_INSET = 1.05
/** Hard ceiling on vertical stacks (ground + ledges); the slider clamps here. */
const MAX_STACKS = 5
const UPPER_STACK_TUCK = 0.75
const UPPER_STACK_Z_STAGGER = SLOT_SPACING * 0.58
/** Minimum balcony deck depth (m). */
const LEDGE_DEPTH = 0.82
const LEDGE_THICKNESS = 0.18
/** Balcony railing along each deck's street-facing edge: bar + spaced posts. */
const RAIL_HEIGHT = 1.05
const RAIL_BAR_THICKNESS = 0.09
const RAIL_POST_SIZE = 0.11
const RAIL_POST_SPACING = 4
/** Deck extends this far past the outermost row toward the street. */
const DECK_OUTER_MARGIN = 0.55
const LEDGE_MIN_HEIGHT = 4.1
const LEDGE_FLOOR_HEIGHT = 1.45
const FLY_IN_HEIGHT = 55
const FLY_IN_RANDOM_HEIGHT = 12
const FLY_IN_DURATION = 0.8
const PRESSER_FLY_IN_DURATION = 0.45
const OPENING_ROW_DELAY = 0.035
const OPENING_STACK_DELAY = 0.18
/** Hold every staged agent off-screen before the first rank row drops. */
const OPENING_START_DELAY = 0.75
const ACTIVE_PRESSER_MIN = 18
const ACTIVE_PRESSER_MAX = 64
const ACTIVE_PRESSER_TARGET_FRACTION = 0.13
const PRESSER_RELEASE_RATE = 10
const MAX_PRESSER_RELEASES_PER_FRAME = 6
const PRESSER_RINGS = [
  { count: 10, standoff: 1.05 },
  { count: 14, standoff: 2.2 },
  { count: 18, standoff: 3.4 }
]
const PRESSER_RING_TOTAL = PRESSER_RINGS.reduce(
  (sum, ring) => sum + ring.count,
  0
)
/** Ranks stop at the far building end — no lane continues past into open fog. */
const ROW_OVERRUN = 0
/**
 * The follow camera sits on +Z looking toward −Z. Agent ranks and facades run
 * from just ahead of the player (z≈0) into the distance — nothing behind.
 */
const RANK_NEAR_Z = 0
/** Opening fill band reaches a little ahead of spawn so the first rows read. */
const OPENING_NEAR_Z = 6
/** Below this Y an agent has cleared the floor edge and is falling into the
 * void — a permanent kill. The floor slab bottoms out at y=-4. */
const FALL_KILL_Y = -8

const PREFIX = "fabled-revolutions.revolutions."
const SETTINGS_SCHEMA_KEY = `${PREFIX}settings-schema`
const TARGET_KEY = PREFIX + "target"

/** Panel-tunable corridor construction (persisted). */
const TUNING_DEFAULTS = {
  /** Cube module edge (m) — the balance knob between perf and detail. */
  cubeSize: 3,
  corridorHalf: 20,
  /**
   * Total corridor span along Z. Only the forward half (−Z from the player) is
   * built, so this sets how far the buildings AND the agent ranks reach ahead.
   * Bumped 1.5× (was 210) so there's more city and more crowd in front.
   */
  length: 444,
  /** Metres of road kept BEHIND the player spawn (+Z). Also moves the near
   * end-cap wall off the spawn so the player doesn't get shoved into a float. */
  behindMargin: 50,
  avgFloors: 16,
  litFraction: 0.28,
  /** Vertical stacks per facade: 1 = road only, 2+ add ledge tiers up the wall. */
  stacks: 4,
  /** Fly-in speed multiplier: scales stream rate and entrance timing. */
  flyInSpeed: 2,
  /** Subtle neutral emissive amount on building impact ripples. */
  rippleGlow: 0.006,
  /** Mass multiplier for knocked-loose facade chunks. Swing impulse is fixed,
   *  so lower = lighter = chunks really fly when you swing through them. */
  chunkMass: 1.0
}

const SETTINGS_SCHEMA = JSON.stringify({
  target: { default: DEFAULT_TARGET, min: MIN_TARGET, max: MAX_TARGET },
  tuning: TUNING_DEFAULTS
})
const tuning: typeof TUNING_DEFAULTS = { ...TUNING_DEFAULTS }
const tuningKeys = Object.keys(TUNING_DEFAULTS) as Array<keyof typeof tuning>

try {
  if (localStorage.getItem(SETTINGS_SCHEMA_KEY) !== SETTINGS_SCHEMA) {
    localStorage.removeItem(TARGET_KEY)
    for (const key of tuningKeys) localStorage.removeItem(PREFIX + key)
    localStorage.setItem(SETTINGS_SCHEMA_KEY, SETTINGS_SCHEMA)
  }
  for (const key of tuningKeys) {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) continue
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 0) tuning[key] = v
  }
} catch {
  // localStorage unavailable; keep defaults.
}
setBuildingImpactGlowStrength(tuning.rippleGlow)

function saveTuning(key: keyof typeof tuning, value: number): void {
  tuning[key] = value
  try {
    localStorage.setItem(SETTINGS_SCHEMA_KEY, SETTINGS_SCHEMA)
    localStorage.setItem(PREFIX + key, String(value))
  } catch {
    // ignore
  }
}

interface Slot {
  x: number
  z: number
  y: number
  /** Vertical stack, 0 = road level; 1 = first ledge level. */
  stack: number
  /** Row level, 0 = closest to the facade. */
  level: number
  /** Z-row index used to stagger the opening drop. */
  wave: number
  /** Reserve ranks hold here until the scenario promotes them into the fight. */
  holdPosition: boolean
  enemy: Enemy | null
}

interface Arrival {
  enemy: Enemy
  targetY: number
  startY: number
  delay: number
  duration: number
  holdAfter: boolean
  elapsed: number
}

export class RevolutionsScenario implements Scenario {
  readonly id = "revolutions"
  readonly label = "Revolutions"
  readonly playerSpawn = new THREE.Vector2(0, 0)

  private ctx!: ScenarioContext
  private env!: { objects: THREE.Object3D[]; bodies: Body[] }
  private buildings!: CubeBuildings
  private readonly liveEnemies: Enemy[] = []
  private readonly impactCooldown = new Map<number, number>()
  /** Last frame's pre-step velocity per flying enemy (see the impact scan). */
  private readonly prevVel = new Map<
    number,
    { x: number; z: number; s: number }
  >()
  private readonly arrivals = new Map<Enemy, Arrival>()
  private readonly ledges: THREE.Mesh[] = []
  private readonly activePressers = new Set<Enemy>()
  private readonly velScratch = { x: 0, y: 0, z: 0 }
  private readonly arrivalImpactPoint = new THREE.Vector3()
  /** Geometries owned by the balcony build (deck, rail bar, posts) — disposed on rebuild. */
  private ledgeGeometries: THREE.BufferGeometry[] = []
  private ledgeMaterial: THREE.MeshStandardNodeMaterial | null = null
  private slots: Slot[] = []

  private target = loadTarget()
  private spawnBudget = 0
  private releaseBudget = 0
  private releaseSerial = 0
  private openingPresserReserve = 0
  private openingPressersSpawned = 0
  /** Cumulative agents ever spawned this round. Spawning stops once this hits
   * the target, so knocked-off agents are NOT replaced — the roster depletes. */
  private spawnedTotal = 0
  /** Agents knocked off the arena (permanent kills). Win when this hits target. */
  private eliminatedTotal = 0
  private won = false
  private control!: HTMLDivElement
  private countLabel!: HTMLSpanElement
  private shownCount = -1
  private winOverlay!: HTMLDivElement
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null

  get enemies(): readonly Enemy[] {
    return this.liveEnemies
  }

  get controlElement(): HTMLElement {
    return this.control
  }

  setup(ctx: ScenarioContext): void {
    this.ctx = ctx
    this.buildCity()
    this.env = buildArenaEnvironment(ctx, this.corridorBounds())
    this.preloadOpeningRanks()
    this.syncAllEnemyPresentation()
    this.buildControl()
    this.buildWinOverlay()

    // The travelling ground shockwave rakes the facades as its crest reaches
    // them: each frame the newly swept band of wall sprays debris chunks, so
    // buildings shed dust progressively — a wave rolling down the street —
    // instead of one instant swath.
    ctx.bus.on("shock-front", (front) => this.shockBuildingsBand(front))
  }

  /**
   * Translate one frame of the travelling wave into facade dust: for each
   * wall the crest touches, spray debris from only the z-columns the front
   * newly covered this frame (the band between prevFront and front), at a
   * power-scaled height. Called every frame while a wave is live.
   */
  private shockBuildingsBand(front: ShockFrontSnapshot): void {
    if (!this.buildings) return
    const power =
      front.kind === "lightning"
        ? front.power * LIGHTNING_BUILDING_POWER
        : front.power
    const mega = front.mega
    const s = this.buildings.cubeSize
    const wall = this.buildings.wallX
    const effectivePower = power * PLAYER_BUILDING_SHOCK_SCALE
    const reach = (mega ? 12 : 7) * effectivePower // max dives cross the road into both facades
    const heightScale = Math.min(2.8, 0.75 + effectivePower * 0.45)
    const maxHeight = (mega ? 11 : 5) * s * heightScale

    for (const side of [-1, 1]) {
      const wallDist = Math.abs(side * wall - front.originX)
      if (wallDist >= reach) continue // wave never reaches this facade
      const fr = Math.min(front.front, reach)
      if (fr <= wallDist) continue // crest hasn't arrived yet
      const pf = Math.min(front.prevFront, reach)
      if (pf >= fr) continue // this facade's share is already done
      // Half-spans (z) the crest covered before and after this frame's advance.
      const zSpanNow = Math.sqrt(fr * fr - wallDist * wallDist)
      const zSpanPrev =
        pf > wallDist ? Math.sqrt(pf * pf - wallDist * wallDist) : 0
      const strength = 1 - wallDist / reach // weaker the farther the wall is
      const speed = (10 + 26 * effectivePower) * (0.4 + 0.6 * strength)
      // Step cell centers so per-frame bands tile the wall without gaps. Each
      // column is shattered in one exact-cell pass (CubeBuildings.shockColumn).
      const zStart = Math.floor((front.originZ - zSpanNow) / s) * s + s * 0.5
      for (let z = zStart; z <= front.originZ + zSpanNow; z += s) {
        if (Math.abs(z - front.originZ) <= zSpanPrev) continue // already swept
        if (z < this.buildings.farZ || z > this.buildings.nearZ) continue
        // One debris burst per column, somewhere in the wave's damage band —
        // the facade itself no longer breaks, so no per-cube-row sweep needed.
        const y = s * 0.5 + Math.random() * Math.max(s, maxHeight - s)
        this.buildings.registerImpact(
          side * wall,
          y,
          z,
          side * speed,
          0,
          speed,
          {
            ripple: false
          }
        )
      }
    }
  }

  private buildCity(): void {
    this.disposeLedges()
    this.buildings = new CubeBuildings(this.ctx.physics, this.ctx.scene, {
      cubeSize: tuning.cubeSize,
      corridorHalf: tuning.corridorHalf,
      length: tuning.length,
      avgFloors: Math.round(tuning.avgFloors),
      litFraction: tuning.litFraction,
      maxDebris: 160
    })
    this.buildLedges()
    this.buildSlots()
    this.registerWallSurfaces()
  }

  /** Road footprint aligned to the built facades. The near edge is pushed back
   * behind the player so there's floor to stand on behind the spawn — and, just
   * as important, so the near end-cap wall doesn't sit on top of the spawn and
   * shove the player up into a permanent float. */
  private corridorBounds(): ArenaCorridorBounds {
    const s = this.buildings.cubeSize
    return {
      halfWidth: this.buildings.wallX + s * 2,
      nearZ: this.buildings.nearZ + tuning.behindMargin,
      farZ: this.buildings.farZ
    }
  }

  private rebuildEnvironment(): void {
    disposeArenaEnvironment(this.ctx, this.env)
    this.env = buildArenaEnvironment(this.ctx, this.corridorBounds())
  }

  /** Let the player wall-kick off both facades: planes at |x| = wallX, capped
   * at each tower's roof. Re-registered whenever the city rebuilds. */
  private registerWallSurfaces(): void {
    const wall = this.buildings.wallX
    this.ctx.player.setWallSurfaces(
      [-1, 1].map((sign) => ({
        sign,
        plane: wall,
        zMin: this.buildings.farZ,
        zMax: this.buildings.nearZ,
        topAt: (z: number) => this.buildings.topAt(sign, z)
      }))
    )
  }

  /**
   * Agent ranks: one row per vertical stack per facade. The ground stack occupies
   * road lanes; upper stacks ride shallow ledges and are offset in X/Z so they
   * read as separate lines from the top-down camera.
   */
  private buildSlots(): void {
    // Preserve living assignments across a rebuild by respawn: simplest is to
    // rebuild the slot list and let update() refill — existing lined enemies
    // just become unslotted extras that stand where they are.
    this.slots = []

    // Ranks run from just ahead of the player to the far corridor end, beside
    // the facades so the street reads as parallel lines vanishing into the fog.
    const zBack = RANK_NEAR_Z
    const zFront = -(this.buildings.halfLength + ROW_OVERRUN)
    const stacks = this.stackCount()
    for (const side of [-1, 1]) {
      for (let stack = 0; stack < stacks; stack++) {
        const y = this.stackTargetY(stack)
        const holdPosition = true
        const x = side * (this.buildings.wallX - this.stackInset(stack))
        let wave = 0
        for (let z = zBack; z >= zFront; z -= SLOT_SPACING) {
          const stackZ = z + stack * UPPER_STACK_Z_STAGGER
          const jz = stackZ + (Math.random() - 0.5) * 0.22
          this.slots.push({
            x,
            z: jz,
            y,
            stack,
            level: 0,
            wave,
            holdPosition,
            enemy: null
          })
          wave++
        }
      }
    }
    // Stream near-to-far and lower stacks first when the target changes/refills.
    this.slots.sort((a, b) => {
      return b.z - a.z || a.stack - b.stack || Math.abs(b.x) - Math.abs(a.x)
    })
  }

  /** Panel-driven vertical stack count, clamped to a sane ceiling. */
  private stackCount(): number {
    return Math.min(MAX_STACKS, Math.max(1, Math.round(tuning.stacks)))
  }

  private stackTargetY(stack: number): number {
    if (stack === 0) return 0
    return Math.max(
      LEDGE_MIN_HEIGHT,
      this.buildings.cubeSize * LEDGE_FLOOR_HEIGHT * stack
    )
  }

  private stackInset(stack: number): number {
    if (stack === 0) return FACADE_INSET
    return Math.max(0.42, FACADE_INSET - UPPER_STACK_TUCK)
  }

  /**
   * Balconies for every upper tier the `stacks` slider selects. One modular
   * unit per tier per facade — a continuous deck plus a
   * street-facing railing (bar + evenly spaced posts) — baked into three
   * InstancedMeshes (decks, rails, posts) so the whole system, however many
   * tiers, costs three draw calls. Purely visual: the agents are lifted by a
   * presentation offset, so the balconies just give them something to stand on.
   */
  private buildLedges(): void {
    this.disposeLedges()
    const stacks = this.stackCount()
    if (stacks < 2) return

    const wall = this.buildings.wallX
    const zBack = RANK_NEAR_Z
    const zFront = -(this.buildings.halfLength + ROW_OVERRUN)
    const zLength = zBack - zFront + SLOT_SPACING * 2
    const zCenter = (zBack + zFront) * 0.5

    // Deck reaches from the facade out past the rank; the inset is the same for
    // every upper tier, so one deck depth/geometry serves them all.
    const deckDepth = Math.max(
      LEDGE_DEPTH,
      this.stackInset(1) + DECK_OUTER_MARGIN
    )
    const deckCenterInset = deckDepth / 2 // |x| offset from the wall to deck center
    const railInset = deckDepth // railing rides the outer (street) edge

    const tiers = stacks - 1
    const units = tiers * 2 // one deck + one rail per tier per facade
    const postsPerRun = Math.max(2, Math.floor(zLength / RAIL_POST_SPACING) + 1)

    const deckGeo = new THREE.BoxGeometry(deckDepth, LEDGE_THICKNESS, zLength)
    const railGeo = new THREE.BoxGeometry(
      RAIL_BAR_THICKNESS,
      RAIL_BAR_THICKNESS,
      zLength
    )
    const postGeo = new THREE.BoxGeometry(
      RAIL_POST_SIZE,
      RAIL_HEIGHT,
      RAIL_POST_SIZE
    )
    this.ledgeGeometries = [deckGeo, railGeo, postGeo]
    this.ledgeMaterial = standardNodeMaterial(0x24282c, 0.78)

    const deckMesh = new THREE.InstancedMesh(deckGeo, this.ledgeMaterial, units)
    const railMesh = new THREE.InstancedMesh(railGeo, this.ledgeMaterial, units)
    const postMesh = new THREE.InstancedMesh(
      postGeo,
      this.ledgeMaterial,
      units * postsPerRun
    )
    for (const m of [deckMesh, railMesh, postMesh]) {
      m.castShadow = true
      m.receiveShadow = true
    }

    const mat = new THREE.Matrix4()
    let di = 0
    let ri = 0
    let pi = 0
    const zStart = zCenter - zLength / 2
    for (const side of [-1, 1]) {
      for (let stack = 1; stack < stacks; stack++) {
        const y = this.stackTargetY(stack)
        const deckX = side * (wall - deckCenterInset)
        const railX = side * (wall - railInset)
        mat.makeTranslation(deckX, y - LEDGE_THICKNESS * 0.5, zCenter)
        deckMesh.setMatrixAt(di++, mat)
        mat.makeTranslation(railX, y + RAIL_HEIGHT, zCenter)
        railMesh.setMatrixAt(ri++, mat)

        // Decks + rails are pure decoration: no colliders at all, so the player
        // sails straight through them from any side. The perched crowd up here
        // is likewise presentation-only, never a physical obstacle.
        for (let p = 0; p < postsPerRun; p++) {
          const z = zStart + (p / (postsPerRun - 1)) * zLength
          mat.makeTranslation(railX, y + RAIL_HEIGHT / 2, z)
          postMesh.setMatrixAt(pi++, mat)
        }
      }
    }
    deckMesh.instanceMatrix.needsUpdate = true
    railMesh.instanceMatrix.needsUpdate = true
    postMesh.instanceMatrix.needsUpdate = true

    this.ctx.scene.add(deckMesh, railMesh, postMesh)
    this.ledges.push(deckMesh, railMesh, postMesh)
  }

  /**
   * Matrix-Revolutions opener: before the first update tick, assign ranked
   * agents to facade slots, then let each z-row fall in from above the camera
   * with a staggered delay. A small live reserve peels out during the pre-roll.
   */
  private preloadOpeningRanks(): void {
    const openingTarget = Math.min(
      this.slots.length,
      Math.max(0, this.target - OPENING_PRESSER_RESERVE)
    )
    if (openingTarget <= 0) {
      this.openingPresserReserve = this.target
      this.openingPressersSpawned = 0
      return
    }

    // Fill the whole visible street: ranks reach the far corridor end so the
    // lines vanish into the fog instead of stopping mid-road.
    const openingFarZ = -this.buildings.halfLength
    const openingBand = this.slots.filter(
      (s) => s.enemy === null && s.z <= OPENING_NEAR_Z && s.z >= openingFarZ
    )
    const picked: Slot[] = []
    const openingCount = Math.min(openingTarget, openingBand.length)
    picked.push(...this.pickEvenly(openingBand, openingCount))

    const remaining = openingTarget - picked.length
    if (remaining > 0) {
      const used = new Set(picked)
      const overflow = this.slots.filter(
        (s) => !used.has(s) && s.enemy === null
      )
      picked.push(...this.pickEvenly(overflow, remaining))
    }

    for (const slot of picked) {
      this.spawnRanked(slot, true)
    }

    this.openingPresserReserve = Math.max(0, this.target - picked.length)
    this.openingPressersSpawned = 0
  }

  private pickEvenly(slots: Slot[], count: number): Slot[] {
    const picked: Slot[] = []
    const n = Math.min(count, slots.length)
    for (let i = 0; i < n; i++) {
      const idx = Math.min(
        slots.length - 1,
        Math.floor(((i + 0.5) * slots.length) / n)
      )
      picked.push(slots[idx])
    }
    return picked
  }

  update(scaledDt: number): void {
    this.buildings.update(scaledDt)
    this.updateArrivals(scaledDt)

    // Facade impacts: any launched slider or flying corpse moving fast enough
    // that has reached a facade plane shatters the cubes it hit.
    for (const [id, t] of this.impactCooldown) {
      const left = t - scaledDt
      if (left <= 0) this.impactCooldown.delete(id)
      else this.impactCooldown.set(id, left)
    }
    // Post-step snapshots never catch the hit itself — a launched body covers
    // the last metre AND resolves the wall contact inside one CCD step, so it
    // always snapshots already-stopped at the facade. Instead, read each
    // flyer's PRE-step velocity here (before physics runs this frame) and
    // remember it; when a body shows up pressed against a facade, last
    // frame's velocity is the speed it actually arrived with.
    const wall = this.buildings.wallX
    for (const enemy of this.liveEnemies) {
      if (!(enemy.launched || enemy.dead) || enemy.parked) continue
      const id = enemy.id
      enemy.body.getLinearVelocity(this.velScratch)
      const fx = this.velScratch.x
      const fz = this.velScratch.z
      const fs = Math.hypot(fx, fz)
      const p = enemy.position
      if (
        Math.abs(p.x) >= wall - 1.2 &&
        p.z <= this.buildings.nearZ &&
        p.z >= this.buildings.farZ &&
        !this.impactCooldown.has(id)
      ) {
        // Whichever reading is faster is the arrival velocity: the fresh one
        // if the hit is still ahead this frame, last frame's if the contact
        // already drained it.
        const prev = this.prevVel.get(id)
        const useFresh = fs >= (prev?.s ?? 0)
        const vx = useFresh ? fx : prev!.x
        const vz = useFresh ? fz : prev!.z
        const sp = useFresh ? fs : prev!.s
        // Must actually be moving INTO the wall, not scraping along it.
        if (sp >= IMPACT_SPEED && vx * Math.sign(p.x) > sp * 0.35) {
          this.impactCooldown.set(id, IMPACT_COOLDOWN)
          this.buildings.registerImpact(
            Math.sign(p.x) * wall,
            Math.max(1, p.y + 0.9),
            p.z,
            vx,
            vz,
            sp
          )
        }
      }
      let rec = this.prevVel.get(id)
      if (!rec) {
        rec = { x: 0, z: 0, s: 0 }
        this.prevVel.set(id, rec)
      }
      rec.x = fx
      rec.z = fz
      rec.s = fs
    }

    // Cull agents knocked off the arena edge before anything else this frame.
    this.cullFallenEnemies()

    // Stream the roster in ONCE. Gating on cumulative spawns (not the live
    // count) means a knocked-off agent is never replaced — the roster only
    // depletes, so the round can actually be won.
    const deficit = this.target - this.spawnedTotal
    if (deficit > 0) {
      const rate = SPAWN_RATE * tuning.flyInSpeed
      this.spawnBudget = Math.min(
        this.spawnBudget + rate * scaledDt,
        MAX_SPAWNS_PER_FRAME
      )
      let spawns = Math.min(Math.floor(this.spawnBudget), deficit)
      this.spawnBudget -= spawns
      while (spawns-- > 0) this.spawnOne()
    } else {
      this.spawnBudget = 0
    }
    this.updatePresserRelease(scaledDt)

    // "Enemies left" = how many still have to be knocked off to win.
    const remaining = Math.max(0, this.target - this.eliminatedTotal)
    if (remaining !== this.shownCount) {
      this.shownCount = remaining
      this.countLabel.textContent = `${remaining}`
    }

    // Win: every agent spawned AND every one knocked off the arena.
    if (!this.won && this.spawnedTotal >= this.target && remaining === 0) {
      this.won = true
      this.winOverlay.style.display = "flex"
    }
  }

  private spawnOne(): void {
    // Fill the facade ranks first; only the opener is allowed to create
    // immediate mid-street pressure, and even that respects the active cap.
    const needsOpeningPresser =
      this.openingPressersSpawned < this.openingPresserReserve
    const activeCount = this.pruneActivePressers()
    if (needsOpeningPresser && activeCount < this.desiredActivePressers()) {
      this.spawnPresser(
        undefined,
        undefined,
        5.4,
        undefined,
        "crowd",
        OPENING_START_DELAY
      )
      this.openingPressersSpawned++
      return
    }

    const slot = this.nextOpenSlot()
    if (slot) this.spawnRanked(slot)
  }

  /**
   * Retire every agent that has dropped past the floor edge into the void.
   * These are the only real kills: removed for good (no respawn), counted
   * toward the win. Iterates back-to-front so splices don't skip entries.
   */
  private cullFallenEnemies(): void {
    let fell = false
    for (let i = this.liveEnemies.length - 1; i >= 0; i--) {
      const enemy = this.liveEnemies[i]
      enemy.body.getPosition(this.velScratch)
      if (this.velScratch.y > FALL_KILL_Y) continue
      this.eliminatedTotal++
      this.liveEnemies.splice(i, 1)
      this.ctx.scene.remove(enemy.group)
      enemy.dispose()
      this.ctx.physics.removeBody(enemy.body)
      this.activePressers.delete(enemy)
      this.arrivals.delete(enemy)
      this.impactCooldown.delete(enemy.id)
      this.prevVel.delete(enemy.id)
      fell = true
    }
    // Null out slot references to culled bodies so a rank slot never tries to
    // release a removed enemy.
    if (fell) {
      const live = new Set(this.liveEnemies)
      for (const slot of this.slots) {
        if (slot.enemy && !live.has(slot.enemy)) slot.enemy = null
      }
    }
  }

  private spawnRanked(slot: Slot, opening = false): void {
    const enemy = new Enemy(
      this.ctx.physics,
      new THREE.Vector2(slot.x, slot.z),
      {
        scene: this.ctx.scene,
        seekSpeed: 4.4 + Math.random() * 0.6,
        hp: 1,
        separation: 1.1,
        standoff: 4.5,
        visualDetail: "crowd"
      }
    )
    slot.enemy = enemy
    this.ctx.scene.add(enemy.group)
    this.liveEnemies.push(enemy)
    this.spawnedTotal++
    this.beginArrival(
      enemy,
      slot.y,
      opening ? this.openingArrivalDelay(slot) : 0,
      slot.holdPosition,
      FLY_IN_DURATION
    )
    this.syncEnemyPresentation(enemy)
  }

  /** Showcase helper: place a one-hit presser at exact coordinates. */
  spawnNear(x: number, z: number): void {
    this.spawnPresser(x, z, 5.2, 1.1, "full")
  }

  private spawnPresser(
    x?: number,
    z?: number,
    speed = 5.4,
    standoff?: number,
    visualDetail: "full" | "crowd" = "crowd",
    arrivalDelay = 0
  ): void {
    // Presser: walks in from the mid-corridor, straight up the street to the
    // player — not ringed around him, so it reads as a line-breaker leaving the
    // facade ranks rather than a swarm closing from all sides. Organic pressers
    // stop outside touch range so pre-roll pressure does not shove the player
    // out of the reference framing; the staged duelist can still be close.
    const spawnZ =
      z ?? -(6 + Math.random() * Math.min(24, this.buildings.halfLength * 0.35))
    const spawnX = x ?? (Math.random() - 0.5) * (this.buildings.wallX - 6) * 0.7
    const enemy = new Enemy(
      this.ctx.physics,
      new THREE.Vector2(spawnX, spawnZ),
      {
        scene: this.ctx.scene,
        seekSpeed: speed + Math.random() * 0.4,
        hp: 1,
        separation: 1.4,
        standoff: standoff ?? this.nextPresserStandoff(),
        visualDetail
      }
    )
    this.ctx.scene.add(enemy.group)
    this.liveEnemies.push(enemy)
    this.spawnedTotal++
    this.activePressers.add(enemy)
    this.beginArrival(
      enemy,
      0,
      arrivalDelay,
      false,
      PRESSER_FLY_IN_DURATION,
      FLY_IN_HEIGHT
    )
    this.syncEnemyPresentation(enemy)
  }

  private updatePresserRelease(dt: number): void {
    const desired = this.desiredActivePressers()
    const active = this.pruneActivePressers()
    const missing = desired - active
    if (missing <= 0) {
      this.releaseBudget = 0
      return
    }

    const rate =
      PRESSER_RELEASE_RATE * Math.sqrt(Math.max(0.5, tuning.flyInSpeed))
    this.releaseBudget = Math.min(
      this.releaseBudget + rate * dt,
      MAX_PRESSER_RELEASES_PER_FRAME
    )
    let releases = Math.min(
      Math.floor(this.releaseBudget),
      missing,
      MAX_PRESSER_RELEASES_PER_FRAME
    )
    this.releaseBudget -= releases

    while (releases-- > 0) {
      if (!this.releaseNextRankedPresser()) {
        this.releaseBudget = 0
        break
      }
    }
  }

  private desiredActivePressers(): number {
    return Math.min(
      ACTIVE_PRESSER_MAX,
      Math.max(
        ACTIVE_PRESSER_MIN,
        Math.floor(this.target * ACTIVE_PRESSER_TARGET_FRACTION)
      )
    )
  }

  private pruneActivePressers(): number {
    let active = 0
    for (const enemy of this.activePressers) {
      if (enemy.parked) {
        this.activePressers.delete(enemy)
      } else {
        active++
      }
    }
    return active
  }

  private releaseNextRankedPresser(): boolean {
    const slot = this.nextReleaseSlot()
    if (!slot?.enemy) return false

    const enemy = slot.enemy
    slot.enemy = null
    this.activePressers.add(enemy)
    enemy.setStandoff(this.nextPresserStandoff())
    enemy.setPresentationYOffset(0)
    enemy.setMovementLocked(false)
    return true
  }

  private nextReleaseSlot(): Slot | null {
    const playerZ = this.ctx.player.position.z
    const preferredSide = this.releaseSerial % 2 === 0 ? -1 : 1
    let best: Slot | null = null
    let bestScore = Infinity

    for (const slot of this.slots) {
      const enemy = slot.enemy
      if (
        slot.stack !== 0 ||
        !enemy ||
        enemy.dead ||
        enemy.parked ||
        this.arrivals.has(enemy)
      ) {
        continue
      }

      const sidePenalty = Math.sign(slot.x) === preferredSide ? 0 : 0.35
      const score = Math.abs(slot.z - playerZ) + sidePenalty
      if (score < bestScore) {
        best = slot
        bestScore = score
      }
    }

    return best
  }

  private nextOpenSlot(): Slot | null {
    return this.slots.find((s) => s.enemy === null) ?? null
  }

  private nextPresserStandoff(): number {
    let ringIndex = this.releaseSerial % PRESSER_RING_TOTAL
    this.releaseSerial++
    for (const ring of PRESSER_RINGS) {
      if (ringIndex < ring.count) {
        return ring.standoff + (Math.random() - 0.5) * 0.35
      }
      ringIndex -= ring.count
    }
    return PRESSER_RINGS[PRESSER_RINGS.length - 1].standoff
  }

  private beginArrival(
    enemy: Enemy,
    targetY: number,
    delay: number,
    holdAfter: boolean,
    baseDuration: number,
    dropHeight = FLY_IN_HEIGHT
  ): void {
    const speed = Math.max(0.5, tuning.flyInSpeed)
    // Start well above the slot so staged ranks sit off-screen during the
    // opening stagger, then slam down fast into formation.
    const startY = targetY + dropHeight + Math.random() * FLY_IN_RANDOM_HEIGHT
    enemy.setMovementLocked(true)
    enemy.setPresentationYOffset(startY)
    this.arrivals.set(enemy, {
      enemy,
      targetY,
      startY,
      delay,
      duration: baseDuration / Math.sqrt(speed),
      holdAfter,
      elapsed: 0
    })
  }

  private openingArrivalDelay(slot: Slot): number {
    const speed = Math.max(0.5, tuning.flyInSpeed)
    const delay =
      OPENING_START_DELAY +
      slot.wave * OPENING_ROW_DELAY +
      slot.stack * OPENING_STACK_DELAY +
      Math.random() * 0.04
    return delay / Math.sqrt(speed)
  }

  /** Push staged presentation offsets into meshes before the first render tick. */
  private syncEnemyPresentation(enemy: Enemy): void {
    enemy.syncMesh()
    enemy.syncVisuals()
  }

  private syncAllEnemyPresentation(): void {
    for (const enemy of this.liveEnemies) this.syncEnemyPresentation(enemy)
  }

  private updateArrivals(dt: number): void {
    if (this.arrivals.size === 0) return
    let landingCount = 0
    let landingX = 0
    let landingY = 0
    let landingZ = 0
    let maxDropHeight = 0

    for (const [enemy, arrival] of this.arrivals) {
      // `launched`: knocked loose mid-arrival (shock front, billiard, hit).
      // Abandon the staged entrance entirely — re-locking it every frame here
      // would override the launch and leave the agent hovering at its offset.
      if (enemy.dead || enemy.parked || enemy.launched) {
        enemy.setMovementLocked(false)
        enemy.setPresentationYOffset(0)
        this.arrivals.delete(enemy)
        continue
      }

      arrival.elapsed += dt
      const localT = (arrival.elapsed - arrival.delay) / arrival.duration
      if (localT <= 0) {
        enemy.setMovementLocked(true)
        enemy.setPresentationYOffset(arrival.startY)
        continue
      }

      const t = Math.min(1, localT)
      const eased = 1 - Math.pow(1 - t, 3)
      enemy.setPresentationYOffset(
        THREE.MathUtils.lerp(arrival.startY, arrival.targetY, eased)
      )

      if (t >= 1) {
        enemy.setPresentationYOffset(arrival.targetY)
        enemy.setMovementLocked(arrival.holdAfter)
        this.arrivals.delete(enemy)
        landingCount++
        landingX += enemy.position.x
        landingY += arrival.targetY
        landingZ += enemy.position.z
        maxDropHeight = Math.max(maxDropHeight, arrival.startY - arrival.targetY)
      }
    }

    if (landingCount > 0) {
      const inv = 1 / landingCount
      this.arrivalImpactPoint.set(
        landingX * inv,
        landingY * inv,
        landingZ * inv
      )
      this.ctx.bus.emit("enemy-arrival-impact", {
        point: this.arrivalImpactPoint,
        count: landingCount,
        dropHeight: maxDropHeight
      })
    }
  }

  /** Debounced full city rebuild after a construction slider settles. */
  private scheduleRebuild(): void {
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      this.buildings.dispose()
      this.buildCity()
      this.rebuildEnvironment()
    }, 350)
  }

  /** Debounced floor/road rebuild only — the buildings are untouched, so this
   * skips the (heavier) city regen. Used by the behind-margin slider. */
  private scheduleEnvRebuild(): void {
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      this.rebuildEnvironment()
    }, 350)
  }

  dispose(): void {
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer)
    for (const enemy of this.liveEnemies) {
      this.ctx.scene.remove(enemy.group)
      enemy.dispose()
      this.ctx.physics.removeBody(enemy.body)
    }
    this.liveEnemies.length = 0
    this.arrivals.clear()
    this.activePressers.clear()
    this.impactCooldown.clear()
    this.control.remove()
    this.winOverlay.remove()
    this.disposeLedges()
    this.buildings.dispose()
    disposeArenaEnvironment(this.ctx, this.env)
  }

  /** Full-screen victory banner, hidden until the last agent is knocked off. */
  private buildWinOverlay(): void {
    this.winOverlay = document.createElement("div")
    this.winOverlay.className = "win-overlay"
    const s = this.winOverlay.style
    s.position = "fixed"
    s.inset = "0"
    s.display = "none"
    s.flexDirection = "column"
    s.alignItems = "center"
    s.justifyContent = "center"
    s.gap = "0.4em"
    s.zIndex = "50"
    s.pointerEvents = "none"
    s.background = "radial-gradient(closest-side, rgba(0,0,0,0.55), rgba(0,0,0,0.82))"
    s.color = "#eafff2"
    s.fontFamily = "system-ui, sans-serif"
    s.fontWeight = "800"
    s.letterSpacing = "0.12em"
    s.textShadow = "0 0 24px rgba(120,255,190,0.55)"

    const title = document.createElement("div")
    title.textContent = "YOU WIN"
    title.style.fontSize = "clamp(48px, 12vw, 160px)"
    const sub = document.createElement("div")
    sub.textContent = "every agent knocked off the arena"
    sub.style.fontSize = "clamp(13px, 2vw, 22px)"
    sub.style.fontWeight = "500"
    sub.style.opacity = "0.85"
    sub.style.letterSpacing = "0.18em"
    sub.style.textTransform = "uppercase"

    this.winOverlay.append(title, sub)
    document.body.appendChild(this.winOverlay)
  }

  private disposeLedges(): void {
    for (const ledge of this.ledges) {
      this.ctx?.scene.remove(ledge)
      if (ledge instanceof THREE.InstancedMesh) ledge.dispose()
    }
    this.ledges.length = 0
    for (const geo of this.ledgeGeometries) geo.dispose()
    this.ledgeGeometries = []
    this.ledgeMaterial?.dispose()
    this.ledgeMaterial = null
  }

  /** Bottom-center control strip: horde size + city tuning sliders. */
  private buildControl(): void {
    this.control = document.createElement("div")
    this.control.className = "horde-control rev-control"

    const top = document.createElement("div")
    top.className = "rev-row"
    const title = document.createElement("span")
    title.className = "title"
    title.textContent = "AGENTS"
    this.countLabel = document.createElement("span")
    this.countLabel.className = "count"
    this.countLabel.textContent = "0"
    const value = document.createElement("span")
    value.className = "target"
    value.textContent = `/ ${this.target}`
    const slider = document.createElement("input")
    slider.type = "range"
    slider.min = String(MIN_TARGET)
    slider.max = String(MAX_TARGET)
    slider.step = "25"
    slider.value = String(this.target)
    slider.addEventListener("input", () => {
      this.target = Number(slider.value)
      value.textContent = `/ ${this.target}`
      saveTarget(this.target)
    })
    top.append(title, this.countLabel, value, slider)
    this.control.appendChild(top)

    const addRow = (
      label: string,
      key: keyof typeof tuning,
      min: number,
      max: number,
      step: number,
      onChange: (v: number) => void
    ): void => {
      const row = document.createElement("div")
      row.className = "rev-row"
      const name = document.createElement("span")
      name.className = "target"
      name.textContent = label
      const val = document.createElement("span")
      val.className = "count"
      val.textContent = String(tuning[key])
      const input = document.createElement("input")
      input.type = "range"
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(tuning[key])
      input.addEventListener("input", () => {
        const v = Number(input.value)
        saveTuning(key, v)
        val.textContent = String(v)
        onChange(v)
      })
      row.append(name, val, input)
      this.control.appendChild(row)
    }

    // Rank layout: vertical stack count (road + ledge tiers up the wall, one row
    // per tier). Existing agents keep their bodies; newly streamed agents use
    // the rebuilt layout.
    const rebuildRanks = (): void => {
      this.disposeLedges()
      this.buildLedges()
      this.buildSlots()
    }
    addRow("stacks", "stacks", 1, MAX_STACKS, 1, rebuildRanks)

    // Construction sliders rebuild the city (debounced).
    addRow("cube", "cubeSize", 1.5, 6, 0.5, () => this.scheduleRebuild())
    addRow("width", "corridorHalf", 8, 22, 1, () => this.scheduleRebuild())
    // Forward depth: how far the buildings + agent ranks reach ahead.
    addRow("forward", "length", 120, 450, 15, () => this.scheduleRebuild())
    // Behind margin: floor/road kept behind the spawn. Only the corridor
    // footprint changes, so an environment-only rebuild suffices.
    addRow("behind", "behindMargin", 0, 40, 2, () => this.scheduleEnvRebuild())
    addRow("floors", "avgFloors", 4, 30, 1, () => this.scheduleRebuild())
    addRow("lit", "litFraction", 0, 1, 0.05, () => this.scheduleRebuild())
    // Live: no rebuild needed, the streamer reads tuning.flyInSpeed each frame.
    addRow("fly-in", "flyInSpeed", 0.5, 6, 0.5, () => {})
    addRow(
      "ripple glow",
      "rippleGlow",
      0,
      0.08,
      0.002,
      setBuildingImpactGlowStrength
    )
  }
}

function loadTarget(): number {
  try {
    const raw = localStorage.getItem(TARGET_KEY)
    const n = raw === null ? NaN : Number(raw)
    if (Number.isFinite(n)) return Math.min(MAX_TARGET, Math.max(MIN_TARGET, n))
  } catch {
    // fall through
  }
  return DEFAULT_TARGET
}

function saveTarget(target: number): void {
  try {
    localStorage.setItem(SETTINGS_SCHEMA_KEY, SETTINGS_SCHEMA)
    localStorage.setItem(TARGET_KEY, String(target))
  } catch {
    // ignore
  }
}
