import * as THREE from "three/webgpu"
import {
  Fn,
  If,
  instancedArray,
  instanceIndex,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  color,
  hash,
  smoothstep,
  uv,
  atan,
  cameraViewMatrix
} from "three/tsl"
import type ComputeNode from "three/src/nodes/gpgpu/ComputeNode.js"
import {
  BaseEffect,
  type EffectContext,
  type EffectGroup,
  type EffectParam
} from "./effect"

/**
 * GPU-compute rain, in the mold of the official webgpu_compute_particles_rain
 * example but tuned to this arena's cool blue-green fog. A pool of drops lives
 * in storage buffers and is advanced by ONE compute kernel per frame: fall +
 * wind drift, XZ-wrap around the player (the 70x70 spawn box follows the
 * action), and on ground impact the drop lights its paired splash slot and
 * respawns up top, re-centered on the player.
 *
 * Splashes are the example's ripple idea simplified: each drop owns one splash
 * element (same index — no scatter writes, so the kernel also runs on the
 * WebGL2 transform-feedback fallback). A splash is a squashed additive ring
 * billboard that expands and fades over ~0.3s; the squash reads as a ground
 * ripple from the game's low chase camera.
 *
 * Everything advances on clock.scaledDt, so hit-stop freezes the rain and the
 * mega bullet time slows drops and splashes for free. Streak length is scaled
 * by the live scaled/unscaled ratio, so slow-mo also collapses the motion-blur
 * streaks toward round droplets — speed reads honestly.
 *
 * Both sprites stay `visible = true` from init (warm pipelines, no first-frame
 * hitch): dead/parked elements render at zero alpha. Disabling dispatches a
 * kill-all kernel that parks every drop and zeroes every splash, leaving no
 * residue; per-frame JS work is a handful of uniform writes — zero allocation.
 */

const POOL = 3000
/** Drop spawn box (XZ) centered on the player. */
const BOX_SIZE = 70
const BOX_HALF = BOX_SIZE / 2
const SPAWN_HEIGHT = 25
/** Parked drops sit far below the floor and render at zero alpha. */
const PARKED_Y = -1000
const SPLASH_LIFE = 0.3
const SPLASH_Y = 0.06
// Streak look: world-units of stretch per unit of apparent speed, plus the
// cross-axis width. Kept thin so 1000 drops read as drizzle, not lasers.
const STREAK_PER_SPEED = 0.055
const DROP_WIDTH = 0.035
const DROP_ALPHA = 0.32
const SPLASH_SIZE = 0.7
const SPLASH_ALPHA = 0.5

const PARAM_PREFIX = "fabled-revolutions.effect.rain.param."
const PARAM_SCHEMA_KEY = `${PARAM_PREFIX}schema`

type RainParamKey = "rainfall" | "density" | "wind"

interface RainParamMeta {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly defaultValue: number
}

const RAIN_PARAM_META: Record<RainParamKey, RainParamMeta> = {
  rainfall: {
    label: "rainfall",
    min: 6,
    max: 30,
    step: 0.5,
    defaultValue: 22
  },
  density: {
    label: "density",
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 0.55
  },
  wind: {
    label: "wind",
    min: -6,
    max: 10,
    step: 0.25,
    defaultValue: 5.5
  }
}

const PARAM_SCHEMA = JSON.stringify(RAIN_PARAM_META)

export class RainEffect extends BaseEffect {
  readonly id = "rain"
  readonly label = "Rain"
  readonly description =
    "GPU-compute rain that follows the player: streaked drops and ground splashes, all on scaled time so bullet time slows the storm."
  readonly group: EffectGroup = "Camera"

  // Tunables (persisted; see buildParam).
  private readonly uRainfall = uniform(RAIN_PARAM_META.rainfall.defaultValue)
  private readonly uDensity = uniform(RAIN_PARAM_META.density.defaultValue)
  private readonly uWind = uniform(RAIN_PARAM_META.wind.defaultValue)
  private storageSchemaChecked = false

  readonly params: readonly EffectParam[] = [
    this.buildParam("rainfall", this.uRainfall),
    this.buildParam("density", this.uDensity),
    this.buildParam("wind", this.uWind)
  ]

  // GPU storage over the pool. Splash buffers share the drop's index (drop i
  // owns splash i) so the step kernel never writes another thread's element.
  private readonly dropPos = instancedArray(POOL, "vec3")
  private readonly splashPos = instancedArray(POOL, "vec3")
  private readonly splashLife = instancedArray(POOL, "float")

  private stepKernel!: ComputeNode
  private killKernel!: ComputeNode

  // Step-kernel uniforms.
  private readonly uDt = uniform(0)
  private readonly uCenter = uniform(new THREE.Vector3())
  private readonly uSeed = uniform(0)
  /** scaledDt / unscaledDt — apparent-speed factor for streak stretching. */
  private readonly uTimeK = uniform(1)

  private drops!: THREE.Sprite
  private splashes!: THREE.Sprite
  /** True once the first step ran (gates the disable-time kill dispatch). */
  private hasRun = false

  init(ctx: EffectContext): void {
    super.init(ctx)
    this.buildKernels()

    this.drops = this.buildDrops()
    ctx.scene.add(this.drops)

    this.splashes = this.buildSplashes()
    ctx.scene.add(this.splashes)
  }

  private buildKernels(): void {
    this.stepKernel = Fn(() => {
      const fi = float(instanceIndex)
      const pos = this.dropPos.element(instanceIndex)
      const sPos = this.splashPos.element(instanceIndex)
      const sLife = this.splashLife.element(instanceIndex)

      // Age this drop's paired splash.
      sLife.assign(sLife.sub(this.uDt).max(0))

      If(fi.greaterThanEqual(this.uDensity.mul(POOL)), () => {
        // Density-culled: park under the floor (renders at zero alpha).
        pos.y.assign(PARKED_Y)
      }).Else(() => {
        If(pos.y.lessThan(PARKED_Y + 100), () => {
          // Re-entry from parked (enable / density raise): random column spot
          // at a random height, so the sheet fills in instantly with no
          // "falling front" and no splash burst.
          pos.x.assign(
            hash(fi.add(this.uSeed)).sub(0.5).mul(BOX_SIZE).add(this.uCenter.x)
          )
          pos.z.assign(
            hash(fi.add(this.uSeed).add(49.7))
              .sub(0.5)
              .mul(BOX_SIZE)
              .add(this.uCenter.z)
          )
          pos.y.assign(hash(fi.add(this.uSeed).add(151.3)).mul(SPAWN_HEIGHT))
        }).Else(() => {
          // Must match the render material's speed hash so streaks align.
          const speedF = hash(fi.add(11.1)).mul(0.5).add(0.75)
          pos.y.subAssign(this.uRainfall.mul(speedF).mul(this.uDt))
          pos.x.addAssign(this.uWind.mul(this.uDt))

          If(pos.y.lessThanEqual(0), () => {
            // Impact: light the splash at the impact point, then respawn up
            // top re-centered on the player. addAssign keeps the sub-frame
            // overshoot so the column stays evenly distributed in y.
            sPos.assign(vec3(pos.x, SPLASH_Y, pos.z))
            sLife.assign(SPLASH_LIFE)
            pos.x.assign(
              hash(fi.add(this.uSeed).add(211.9))
                .sub(0.5)
                .mul(BOX_SIZE)
                .add(this.uCenter.x)
            )
            pos.z.assign(
              hash(fi.add(this.uSeed).add(313.7))
                .sub(0.5)
                .mul(BOX_SIZE)
                .add(this.uCenter.z)
            )
            pos.y.addAssign(SPAWN_HEIGHT)
          }).Else(() => {
            // Wrap XZ around the player so wind drift and sprinting never
            // leave the sheet behind. The large positive bias keeps the mod
            // input positive whatever the backend's mod semantics.
            const bias = BOX_HALF + BOX_SIZE * 32
            pos.x.assign(
              pos.x
                .sub(this.uCenter.x)
                .add(bias)
                .mod(BOX_SIZE)
                .sub(BOX_HALF)
                .add(this.uCenter.x)
            )
            pos.z.assign(
              pos.z
                .sub(this.uCenter.z)
                .add(bias)
                .mod(BOX_SIZE)
                .sub(BOX_HALF)
                .add(this.uCenter.z)
            )
          })
        })
      })
    })().compute(POOL)

    // Park every drop + kill every splash (disable, and first-frame init so
    // the zero-initialized pool re-enters staggered instead of all impacting
    // y=0 on frame one).
    this.killKernel = Fn(() => {
      this.dropPos.element(instanceIndex).y.assign(PARKED_Y)
      this.splashLife.element(instanceIndex).assign(0)
    })().compute(POOL)
  }

  /** Thin velocity-stretched streaks, cool blue-white, additive but faint. */
  private buildDrops(): THREE.Sprite {
    const material = new THREE.SpriteNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.blending = THREE.AdditiveBlending

    const fi = float(instanceIndex)
    const speedF = hash(fi.add(11.1)).mul(0.5).add(0.75) // matches step kernel
    const sizeF = hash(fi.add(23.3)).mul(0.6).add(0.7)
    const alphaF = hash(fi.add(41.7)).mul(0.5).add(0.55)

    const pos = this.dropPos.toAttribute()
    material.positionNode = pos

    // Rotate the billboard into the screen-space fall direction and stretch
    // by apparent speed (fall + wind, scaled by the live slow-mo ratio so
    // bullet time collapses streaks toward droplets).
    const vel = vec3(this.uWind, this.uRainfall.mul(speedF).negate(), 0).mul(
      this.uTimeK
    )
    const velView = cameraViewMatrix.mul(vec4(vel.x, vel.y, vel.z, 0)).xyz
    material.rotationNode = atan(velView.y, velView.x)
    const len = velView.xy.length().mul(STREAK_PER_SPEED).clamp(0.06, 1.3)
    material.scaleNode = vec2(len.mul(sizeF), float(DROP_WIDTH).mul(sizeF))

    material.colorNode = color(0xbcd8e6)

    // Soft round core stretched into a tapered streak, faded near the ground
    // (hand-off to the splash), near the spawn ceiling, and at the edge of
    // the follow box so wraps/respawns never pop. Parked (y<0) drops and the
    // zero-initialized (y=0) state land at zero alpha.
    const core = smoothstep(0.0, 0.5, uv().distance(vec2(0.5))).oneMinus()
    const heightGate = smoothstep(0.05, 0.9, pos.y).mul(
      smoothstep(SPAWN_HEIGHT - 4, SPAWN_HEIGHT, pos.y).oneMinus()
    )
    const rel = pos.x
      .sub(this.uCenter.x)
      .abs()
      .max(pos.z.sub(this.uCenter.z).abs())
    const edgeGate = smoothstep(BOX_HALF - 8, BOX_HALF, rel).oneMinus()
    material.opacityNode = core
      .mul(alphaF)
      .mul(DROP_ALPHA)
      .mul(heightGate)
      .mul(edgeGate)

    const drops = new THREE.Sprite(material)
    drops.count = POOL
    drops.frustumCulled = false
    return drops
  }

  /** Squashed expanding ring + impact glint; life=0 renders invisible. */
  private buildSplashes(): THREE.Sprite {
    const material = new THREE.SpriteNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.blending = THREE.AdditiveBlending

    const fi = float(instanceIndex)
    const sizeF = hash(fi.add(67.3)).mul(0.5).add(0.75)

    material.positionNode = this.splashPos.toAttribute()

    const lifeK = this.splashLife.toAttribute().div(SPLASH_LIFE).clamp(0, 1) // 1 fresh → 0 dead
    const k = lifeK.oneMinus() // normalized age
    const grow = k.mul(float(2).sub(k)) // ease-out expansion
    const w = float(SPLASH_SIZE).mul(sizeF).mul(grow.mul(0.85).add(0.15))
    // Vertical squash sells the billboard as a ground ripple from the low cam.
    material.scaleNode = vec2(w, w.mul(0.38))

    material.colorNode = color(0xcfeef0)

    const d = uv().distance(vec2(0.5)).mul(2) // 0 center → 1 sprite edge
    const ring = smoothstep(0.0, 0.28, d.sub(0.68).abs()).oneMinus()
    const glint = smoothstep(0.0, 0.4, d).oneMinus().mul(lifeK)
    material.opacityNode = ring
      .mul(0.7)
      .add(glint.mul(0.6))
      .mul(lifeK)
      .mul(SPLASH_ALPHA)

    const splashes = new THREE.Sprite(material)
    splashes.count = POOL
    splashes.frustumCulled = false
    return splashes
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return
    // SCALED time: hit-stop freezes the rain, mega bullet time slows it.
    const dt = this.ctx.clock.scaledDt
    const p = this.ctx.getPlayer().position
    this.uCenter.value.set(p.x, 0, p.z)
    this.uDt.value = dt
    this.uTimeK.value = unscaledDt > 0 ? dt / unscaledDt : 1
    // Churn the respawn seed a little each frame (irrational-ish step) so
    // respawn columns never repeat visibly. No Math.random, no allocation.
    this.uSeed.value = (this.uSeed.value + 9.173) % 8192

    if (!this.hasRun) {
      this.hasRun = true
      this.ctx.renderer.compute(this.killKernel)
    }
    this.ctx.renderer.compute(this.stepKernel)
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled)
    if (!enabled) this.clear()
  }

  /** Kill-all kernel: parks every drop and zeroes every splash. */
  private clear(): void {
    // Never stepped → buffers are still zero-initialized, which already
    // renders invisible (and the renderer may not be warm yet).
    if (!this.hasRun) return
    this.ctx.renderer.compute(this.killKernel)
  }

  private ensureParamSchema(): void {
    if (this.storageSchemaChecked) return
    this.storageSchemaChecked = true
    try {
      if (localStorage.getItem(PARAM_SCHEMA_KEY) === PARAM_SCHEMA) return
      for (const key of Object.keys(RAIN_PARAM_META)) {
        localStorage.removeItem(PARAM_PREFIX + key)
      }
      localStorage.setItem(PARAM_SCHEMA_KEY, PARAM_SCHEMA)
    } catch {
      // localStorage unavailable; keep defaults.
    }
  }

  /** Slider bound to a float uniform, persisted like crt.ts params. */
  private buildParam(key: RainParamKey, u: { value: number }): EffectParam {
    const meta = RAIN_PARAM_META[key]
    this.ensureParamSchema()
    // Restore persisted value before first render.
    try {
      const raw = localStorage.getItem(PARAM_PREFIX + key)
      if (raw !== null) {
        const v = Number(raw)
        if (Number.isFinite(v))
          u.value = Math.min(meta.max, Math.max(meta.min, v))
      }
    } catch {
      // localStorage unavailable; keep default.
    }
    return {
      key,
      label: meta.label,
      min: meta.min,
      max: meta.max,
      step: meta.step,
      get: () => u.value,
      set: (value: number) => {
        u.value = Math.min(meta.max, Math.max(meta.min, value))
        try {
          localStorage.setItem(PARAM_SCHEMA_KEY, PARAM_SCHEMA)
          localStorage.setItem(PARAM_PREFIX + key, String(u.value))
        } catch {
          // ignore
        }
      }
    }
  }
}
