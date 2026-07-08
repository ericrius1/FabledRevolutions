import * as THREE from "three/webgpu"
import { standardNodeMaterial } from "../core/materials"

/**
 * Flight speed of a thrown knife (m/s). Fast enough to feel like a hurled blade
 * but slow enough that a moving player can strafe clear of it.
 */
const KNIFE_SPEED = 20
/** Gentle gravity so a rail toss arcs downward a little; aim compensates. */
const KNIFE_GRAVITY = 10
/** Seconds a knife lives before it gives up and retires. */
const KNIFE_LIFETIME = 2.6
/** End-over-end tumble rate (rad/s). */
const KNIFE_SPIN = 22
/** How much the throw leads the player's current velocity (0 = aim at feet). */
const LEAD_FACTOR = 0.6
/** Random angular spread added to each throw (rad) so snipers aren't pinpoint. */
const KNIFE_SPREAD = 0.06
/** A knife within this of the player centre counts as a hit. Generous enough to
 * threaten, tight enough that moving out of the line dodges it. */
const HIT_RADIUS = 0.85
/** Below this world Y a knife has hit the deck and is retired. */
const KNIFE_FLOOR_Y = -1
/** In-flight pool size. One draw call; capped so a wall of snipers can't spam
 * unbounded geometry — extra throw requests are dropped until a slot frees. */
const KNIFE_CAPACITY = 48

const KNIFE_COLOR = new THREE.Color(0xc9ced6)
const UP = new THREE.Vector3(0, 1, 0)
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)

interface Knife {
  active: boolean
  readonly pos: THREE.Vector3
  readonly vel: THREE.Vector3
  /** Fixed horizontal axis the blade tumbles around (perpendicular to flight). */
  readonly tumbleAxis: THREE.Vector3
  spin: number
  life: number
}

/**
 * Pooled thrown-knife system: enemies emit throw requests, this flies the
 * blades on a simple ballistic arc, tumbles them for looks, and reports the
 * frame a knife reaches the player so the caller can run the normal damage
 * pipeline. Purely presentational + a manual sphere hit-test — no physics
 * bodies, so a screenful of them stays cheap.
 */
export class KnifeSystem {
  private readonly mesh: THREE.InstancedMesh
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.MeshStandardNodeMaterial
  private readonly knives: Knife[] = []

  private readonly tmpQuat = new THREE.Quaternion()
  private readonly tmpMatrix = new THREE.Matrix4()
  private readonly tmpScale = new THREE.Vector3(1, 1, 1)
  private readonly tmpDir = new THREE.Vector3()
  private readonly tmpAim = new THREE.Vector3()

  constructor(private readonly scene: THREE.Scene) {
    // Slim double-taper blade: a 4-sided cone reads as a throwing knife at this
    // scale. Rotated so its long axis is +Z (the resting flight direction).
    this.geometry = new THREE.ConeGeometry(0.07, 0.5, 4)
    this.geometry.rotateX(Math.PI / 2)
    this.material = standardNodeMaterial(0xc9ced6, 0.32)
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      KNIFE_CAPACITY
    )
    this.mesh.name = "enemy-knives"
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    this.mesh.count = KNIFE_CAPACITY
    for (let i = 0; i < KNIFE_CAPACITY; i++) {
      this.knives.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        tumbleAxis: new THREE.Vector3(1, 0, 0),
        spin: 0,
        life: 0
      })
      this.mesh.setMatrixAt(i, ZERO_MATRIX)
      this.mesh.setColorAt(i, KNIFE_COLOR)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    scene.add(this.mesh)
  }

  /**
   * Launch a knife from `origin` toward the player, leading their motion and
   * aiming high to counter gravity droop. Dropped silently if the pool is full.
   */
  throw(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    targetVel: { x: number; y: number; z: number }
  ): void {
    const knife = this.knives.find((k) => !k.active)
    if (!knife) return

    // Lead the player, then aim above the lead point so the parabola drops back
    // onto it over the flight time.
    this.tmpAim.copy(target)
    const roughDist = this.tmpAim.distanceTo(origin)
    const flight = roughDist / KNIFE_SPEED
    this.tmpAim.x += targetVel.x * flight * LEAD_FACTOR
    this.tmpAim.z += targetVel.z * flight * LEAD_FACTOR
    this.tmpAim.y += 0.5 * KNIFE_GRAVITY * flight * flight

    this.tmpDir.copy(this.tmpAim).sub(origin)
    if (this.tmpDir.lengthSq() < 1e-6) this.tmpDir.set(0, 0, 1)
    this.tmpDir.normalize()
    // Cone of inaccuracy: nudge the aim by a small random yaw + pitch.
    this.tmpDir.x += (Math.random() - 0.5) * KNIFE_SPREAD
    this.tmpDir.y += (Math.random() - 0.5) * KNIFE_SPREAD
    this.tmpDir.z += (Math.random() - 0.5) * KNIFE_SPREAD
    this.tmpDir.normalize()

    knife.active = true
    knife.pos.copy(origin)
    knife.vel.copy(this.tmpDir).multiplyScalar(KNIFE_SPEED)
    knife.life = KNIFE_LIFETIME
    knife.spin = Math.random() * Math.PI * 2
    // Tumble around the horizontal axis across the line of flight.
    knife.tumbleAxis.copy(UP).cross(this.tmpDir)
    if (knife.tumbleAxis.lengthSq() < 1e-6) knife.tumbleAxis.set(1, 0, 0)
    knife.tumbleAxis.normalize()
  }

  /**
   * Advance every live knife, tumble it, and fire `onHitPlayer` the frame one
   * reaches `playerCenter` (the knife is retired on contact). `dt` is scaled so
   * knives crawl during bullet time along with everything else.
   */
  update(
    dt: number,
    playerCenter: THREE.Vector3,
    onHitPlayer: (knifePos: THREE.Vector3) => void
  ): void {
    const hitSq = HIT_RADIUS * HIT_RADIUS
    let dirty = false

    for (let i = 0; i < this.knives.length; i++) {
      const knife = this.knives[i]
      if (!knife.active) continue
      dirty = true

      knife.vel.y -= KNIFE_GRAVITY * dt
      knife.pos.addScaledVector(knife.vel, dt)
      knife.spin += KNIFE_SPIN * dt
      knife.life -= dt

      if (knife.pos.distanceToSquared(playerCenter) <= hitSq) {
        onHitPlayer(knife.pos)
        this.retire(knife, i)
        continue
      }
      if (knife.life <= 0 || knife.pos.y < KNIFE_FLOOR_Y) {
        this.retire(knife, i)
        continue
      }

      this.tmpQuat.setFromAxisAngle(knife.tumbleAxis, knife.spin)
      this.tmpMatrix.compose(knife.pos, this.tmpQuat, this.tmpScale)
      this.mesh.setMatrixAt(i, this.tmpMatrix)
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true
  }

  private retire(knife: Knife, index: number): void {
    knife.active = false
    this.mesh.setMatrixAt(index, ZERO_MATRIX)
  }

  /** Drop every in-flight knife (scenario switch / player death). */
  reset(): void {
    for (let i = 0; i < this.knives.length; i++) {
      if (!this.knives[i].active) continue
      this.knives[i].active = false
      this.mesh.setMatrixAt(i, ZERO_MATRIX)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.scene.remove(this.mesh)
    this.mesh.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}
