import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup, type EffectParam } from "./effect";
import { floorTuning } from "../scenarios/arena";
import { smashSlowMoTotal } from "../game/diveSmash";

/**
 * Ground impact debris for the mega lightning storm. On `mega-release` a
 * sparse, thin layer of small stone chunks is scattered around the blast
 * point — and ONLY there. Strikes always land within the storm radius of
 * that point, so instead of littering the whole 880-unit floor the layer
 * covers exactly the patch of ground the camera will see bolts hit.
 *
 * Each `mega-lightning` touchdown kicks the chunks under it into the air
 * (up + outward + tumble); they fall on the world clock, so debris launched
 * during the slow-mo tail hangs in bullet time with everything else. One
 * bounce, then they settle back into the layer. When the storm ends the
 * whole layer lingers long enough for stragglers to land, then shrinks away.
 *
 * All chunks live in a single InstancedMesh kept visible from init (dead
 * instances at scale 0) so the pipeline is warm before the first storm.
 */

const POOL = 420;
/** Strikes land 2..15 units from the storm center; cover that plus margin. */
const SCATTER_RADIUS = 16.5;
const GRAVITY = -22;
const GROW_TIME = 0.22;
/** After mega-end, seconds for airborne stragglers to land before the fade. */
const SETTLE_LINGER = 1.4;
const FADE_TIME = 0.6;
const TWO_PI = Math.PI * 2;

export const debrisTuning = {
  /** Chunks within this distance of a bolt touchdown go flying. */
  radius: 2.0,
  /** Launch velocity multiplier. */
  power: 1,
  /** Fraction of the pool scattered each storm. */
  density: 0.7,
};

const TUNING_PREFIX = "fabled-revolutions.debris.";
for (const key of Object.keys(debrisTuning) as Array<keyof typeof debrisTuning>) {
  try {
    const raw = localStorage.getItem(TUNING_PREFIX + key);
    if (raw === null) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) debrisTuning[key] = v;
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

export function setDebrisTuning(key: keyof typeof debrisTuning, value: number): void {
  debrisTuning[key] = value;
  try {
    localStorage.setItem(TUNING_PREFIX + key, String(value));
  } catch {
    // ignore
  }
}

type Phase = "idle" | "active" | "settling" | "fading";

export class StormDebrisEffect extends BaseEffect {
  readonly id = "storm-debris";
  readonly label = "Storm Debris";
  readonly description =
    "Lightning strikes kick chunks of the ground into the air from a thin debris layer around the blast.";
  readonly group: EffectGroup = "Reaction";

  readonly params: readonly EffectParam[] = [
    debrisParam("debris-radius", "blast radius", 0.8, 3.5, 0.1, "radius"),
    debrisParam("debris-power", "launch power", 0.4, 2.5, 0.05, "power"),
    debrisParam("debris-density", "layer density", 0.2, 1, 0.05, "density"),
  ];

  private mesh!: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly uTint = uniform(new THREE.Color(0x2a4d4f));

  // Structure-of-arrays chunk state (POOL entries, `active` of them live).
  private readonly posX = new Float32Array(POOL);
  private readonly posY = new Float32Array(POOL);
  private readonly posZ = new Float32Array(POOL);
  private readonly velX = new Float32Array(POOL);
  private readonly velY = new Float32Array(POOL);
  private readonly velZ = new Float32Array(POOL);
  private readonly rotX = new Float32Array(POOL);
  private readonly rotY = new Float32Array(POOL);
  private readonly rotZ = new Float32Array(POOL);
  private readonly spinX = new Float32Array(POOL);
  private readonly spinY = new Float32Array(POOL);
  private readonly spinZ = new Float32Array(POOL);
  private readonly sizeX = new Float32Array(POOL);
  private readonly sizeY = new Float32Array(POOL);
  private readonly sizeZ = new Float32Array(POOL);
  private readonly restY = new Float32Array(POOL);
  private readonly flying = new Uint8Array(POOL);
  private readonly bounced = new Uint8Array(POOL);

  private active = 0;
  private phase: Phase = "idle";
  private grow = 0;
  private phaseTimer = 0;
  /** Wall-clock seconds left in a mega-SMASH storm before it self-settles, or
   * -1 for the mega-release path (which settles on `mega-end` instead). */
  private smashStorm = -1;

  init(ctx: EffectContext): void {
    super.init(ctx);

    const material = new THREE.MeshStandardNodeMaterial();
    material.colorNode = this.uTint;
    material.roughness = 0.85;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, POOL);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.hideAll();
    ctx.scene.add(this.mesh);

    ctx.bus.on("mega-release", ({ origin }) => {
      if (!this.enabled) return;
      this.scatter(origin);
      this.smashStorm = -1; // sword release settles on mega-end
    });
    ctx.bus.on("mega-smash", ({ origin }) => {
      if (!this.enabled) return;
      this.scatter(origin);
      // No mega-end for the dive smash: settle on our own clock once the
      // bullet-time storm has run its course.
      this.smashStorm = smashSlowMoTotal();
    });
    ctx.bus.on("mega-lightning", ({ point }) => {
      if (!this.enabled || this.phase === "idle") return;
      this.blast(point);
    });
    ctx.bus.on("mega-end", () => {
      if (this.phase === "active") {
        this.phase = "settling";
        this.phaseTimer = SETTLE_LINGER;
      }
    });
  }

  /** Lay the resting layer around the blast point. */
  private scatter(origin: THREE.Vector3): void {
    // Chunk tint follows the current floor look, a shade lighter so the
    // layer reads against the slab.
    this.uTint.value.setHSL(
      floorTuning.hue,
      floorTuning.sat * 0.5,
      Math.min(0.5, floorTuning.light * 1.5),
    );

    this.active = Math.round(POOL * Math.min(1, Math.max(0, debrisTuning.density)));
    for (let i = 0; i < this.active; i++) {
      // pow < 1 biases toward the center, matching where strikes cluster.
      const r = SCATTER_RADIUS * Math.pow(Math.random(), 0.65);
      const a = Math.random() * TWO_PI;
      this.sizeX[i] = 0.07 + Math.random() * 0.1;
      this.sizeY[i] = 0.05 + Math.random() * 0.07;
      this.sizeZ[i] = 0.07 + Math.random() * 0.1;
      this.posX[i] = origin.x + Math.cos(a) * r;
      this.posZ[i] = origin.z + Math.sin(a) * r;
      this.restY[i] = this.sizeY[i] / 2 + 0.015;
      this.posY[i] = this.restY[i];
      this.rotX[i] = (Math.random() - 0.5) * 0.7;
      this.rotY[i] = Math.random() * TWO_PI;
      this.rotZ[i] = (Math.random() - 0.5) * 0.7;
      this.velX[i] = 0;
      this.velY[i] = 0;
      this.velZ[i] = 0;
      this.flying[i] = 0;
      this.bounced[i] = 0;
    }
    // Park the unused tail of the pool.
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.position.set(0, -100, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = this.active; i < POOL; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);

    this.phase = "active";
    this.grow = 0;
  }

  /** Launch every resting chunk near a bolt touchdown. */
  private blast(point: THREE.Vector3): void {
    const radius = debrisTuning.radius;
    const r2 = radius * radius;
    const power = debrisTuning.power;
    for (let i = 0; i < this.active; i++) {
      const dx = this.posX[i] - point.x;
      const dz = this.posZ[i] - point.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      // Outward from the strike column; random direction dead-center.
      const ox = d > 0.05 ? dx / d : Math.cos(i);
      const oz = d > 0.05 ? dz / d : Math.sin(i);
      // Chunks nearer the column fly harder.
      const falloff = 1 - (0.5 * d) / radius;
      const side = (1.2 + Math.random() * 2.6) * power * falloff;
      this.velX[i] = ox * side + (Math.random() - 0.5) * 1.2;
      this.velZ[i] = oz * side + (Math.random() - 0.5) * 1.2;
      this.velY[i] = (4.5 + Math.random() * 4) * power * falloff;
      this.spinX[i] = (Math.random() - 0.5) * 16;
      this.spinY[i] = (Math.random() - 0.5) * 16;
      this.spinZ[i] = (Math.random() - 0.5) * 16;
      this.flying[i] = 1;
      this.bounced[i] = 0;
    }
  }

  update(unscaledDt: number): void {
    if (!this.enabled || this.phase === "idle") return;

    // Mega-smash storm self-settles on wall-clock (no mega-end fires for it).
    if (this.smashStorm >= 0) {
      this.smashStorm -= unscaledDt;
      if (this.smashStorm < 0 && this.phase === "active") {
        this.phase = "settling";
        this.phaseTimer = SETTLE_LINGER;
      }
    }

    // World clock: debris hangs in bullet time and freezes with hit-stop.
    const dt = this.ctx.clock.scaledDt;

    let scaleK = 1;
    if (this.phase === "active") {
      this.grow = Math.min(1, this.grow + dt / GROW_TIME);
      scaleK = this.grow;
    } else {
      this.phaseTimer -= dt;
      if (this.phase === "settling" && this.phaseTimer <= 0) {
        this.phase = "fading";
        this.phaseTimer = FADE_TIME;
      }
      if (this.phase === "fading") {
        scaleK = Math.max(0, this.phaseTimer / FADE_TIME);
        if (this.phaseTimer <= 0) {
          this.phase = "idle";
          this.hideAll();
          return;
        }
      }
    }

    for (let i = 0; i < this.active; i++) {
      if (this.flying[i]) {
        this.velY[i] += GRAVITY * dt;
        this.posX[i] += this.velX[i] * dt;
        this.posY[i] += this.velY[i] * dt;
        this.posZ[i] += this.velZ[i] * dt;
        this.rotX[i] += this.spinX[i] * dt;
        this.rotY[i] += this.spinY[i] * dt;
        this.rotZ[i] += this.spinZ[i] * dt;
        if (this.posY[i] <= this.restY[i] && this.velY[i] < 0) {
          if (!this.bounced[i] && this.velY[i] < -2.2) {
            this.bounced[i] = 1;
            this.velY[i] *= -0.35;
            this.velX[i] *= 0.55;
            this.velZ[i] *= 0.55;
          } else {
            this.posY[i] = this.restY[i];
            this.velX[i] = 0;
            this.velY[i] = 0;
            this.velZ[i] = 0;
            this.flying[i] = 0;
          }
        }
      }
      this.dummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
      this.dummy.rotation.set(this.rotX[i], this.rotY[i], this.rotZ[i]);
      this.dummy.scale.set(this.sizeX[i] * scaleK, this.sizeY[i] * scaleK, this.sizeZ[i] * scaleK);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) {
      this.phase = "idle";
      this.smashStorm = -1;
      if (this.mesh) this.hideAll();
    }
  }

  /** Zero-scale every instance (kept visible so the pipeline stays warm). */
  private hideAll(): void {
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.position.set(0, -100, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < POOL; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.active = 0;
  }
}

/** Panel slider bound to one debrisTuning field (persisted). */
function debrisParam(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  field: keyof typeof debrisTuning,
): EffectParam {
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => debrisTuning[field],
    set: (v: number) => setDebrisTuning(field, Math.min(max, Math.max(min, v))),
  };
}
