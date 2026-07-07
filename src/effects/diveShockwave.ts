import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup, type EffectParam } from "./effect";
import { floorTuning } from "../scenarios/arena";

/**
 * The dive-smash debris layer (visual half; the physics blast + bullet time
 * live in the DiveSmash system).
 *
 * On `dive-impact` a layer of stone CHUNKS is scattered around the point and
 * kicked into the air ONLY as the ground shockwave's crest sweeps over them —
 * so the debris lifts progressively from the center out, and the launch
 * weakens with distance as the wave dissipates. The travelling wave itself is
 * the real displaced floor geometry (see groundShockwave/arena); there is no
 * flat overlay ring anymore.
 * (The dust cloud at the impact is raised by the ImpactSmokeEffect, which
 * also serves lightning strikes and other collisions.)
 *
 * Everything advances on the world clock, so it hangs correctly through the
 * dive's slow-mo tail as time surges back to normal. Chunks live in a pooled
 * InstancedMesh kept warm (dead instances at scale 0) so the first dive never
 * hitches on a pipeline compile.
 */

const CHUNKS = 300;
const CHUNK_GRAVITY = -26;
const TWO_PI = Math.PI * 2;
/** Wave-front speeds matching triggerGroundShockwave, so chunks pop exactly
 * as the visible floor crest reaches them. */
const WAVE_SPEED = 48;
const WAVE_SPEED_MEGA = 58;

export const diveTuning = {
  /** Max reach of the shockwave / debris scatter (world units) at power 1. */
  radius: 34,
  /** Launch velocity multiplier for kicked-up chunks. */
  power: 2.6,
  /** Fraction of the chunk pool laid down each dive. */
  density: 0.8,
};

const TUNING_PREFIX = "fabled-revolutions.dive.";
const TUNING_SCHEMA_KEY = `${TUNING_PREFIX}schema`;
const TUNING_SCHEMA = "restrained-ripple-v1";
for (const key of Object.keys(diveTuning) as Array<keyof typeof diveTuning>) {
  try {
    const schema = localStorage.getItem(TUNING_SCHEMA_KEY);
    if (schema !== TUNING_SCHEMA) {
      for (const staleKey of Object.keys(diveTuning)) {
        localStorage.removeItem(TUNING_PREFIX + staleKey);
      }
      localStorage.setItem(TUNING_SCHEMA_KEY, TUNING_SCHEMA);
      break;
    }
    const raw = localStorage.getItem(TUNING_PREFIX + key);
    if (raw === null) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) diveTuning[key] = v;
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

export function setDiveTuning(key: keyof typeof diveTuning, value: number): void {
  diveTuning[key] = value;
  try {
    localStorage.setItem(TUNING_PREFIX + key, String(value));
  } catch {
    // ignore
  }
}

export class DiveShockwaveEffect extends BaseEffect {
  readonly id = "dive-shockwave";
  readonly label = "Dive Shockwave";
  readonly description =
    "Air-dive impact: the floor wave races outward, kicking up chunks as it passes, then dissipates.";
  readonly group: EffectGroup = "Reaction";

  readonly params: readonly EffectParam[] = [
    diveParam("dive-radius", "shock radius", 10, 54, 1, "radius"),
    diveParam("dive-power", "launch power", 0.8, 6, 0.1, "power"),
    diveParam("dive-density", "debris density", 0.2, 1, 0.05, "density"),
  ];

  // ---- Chunks (structure-of-arrays) ----
  private chunkMesh!: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly uChunkTint = uniform(new THREE.Color(0x2a4d4f));
  private readonly cx = new Float32Array(CHUNKS);
  private readonly cy = new Float32Array(CHUNKS);
  private readonly cz = new Float32Array(CHUNKS);
  private readonly cvx = new Float32Array(CHUNKS);
  private readonly cvy = new Float32Array(CHUNKS);
  private readonly cvz = new Float32Array(CHUNKS);
  private readonly crx = new Float32Array(CHUNKS);
  private readonly cry = new Float32Array(CHUNKS);
  private readonly crz = new Float32Array(CHUNKS);
  private readonly cspin = new Float32Array(CHUNKS * 3);
  private readonly csx = new Float32Array(CHUNKS);
  private readonly csy = new Float32Array(CHUNKS);
  private readonly csz = new Float32Array(CHUNKS);
  private readonly crestY = new Float32Array(CHUNKS);
  private readonly cdist = new Float32Array(CHUNKS); // radial distance from impact
  private readonly cflying = new Uint8Array(CHUNKS);
  private readonly claunched = new Uint8Array(CHUNKS); // ring already passed it
  private readonly cbounced = new Uint8Array(CHUNKS);
  private chunkActive = 0;

  // ---- Shockwave state (tracks the displaced-geometry wave front) ----
  private originX = 0;
  private originZ = 0;
  private ringRadius = 0;
  private ringMax = 0;
  private ringSpeed = WAVE_SPEED;
  private active = false;

  init(ctx: EffectContext): void {
    super.init(ctx);

    // Chunks: same look as the storm debris layer, a shade lighter than the floor.
    const chunkMat = new THREE.MeshStandardNodeMaterial();
    chunkMat.colorNode = this.uChunkTint;
    chunkMat.roughness = 0.85;
    this.chunkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), chunkMat, CHUNKS);
    this.chunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chunkMesh.frustumCulled = false;
    this.chunkMesh.castShadow = true;

    this.hideChunks();
    ctx.scene.add(this.chunkMesh);

    ctx.bus.on("dive-impact", ({ origin, power, mega }) => {
      if (!this.enabled) return;
      this.trigger(origin, power, mega);
    });
  }

  private trigger(origin: THREE.Vector3, power: number, mega: boolean): void {
    // Match the storm-debris tint logic so chunks read against the slab.
    this.uChunkTint.value.setHSL(
      floorTuning.hue,
      floorTuning.sat * 0.5,
      Math.min(0.5, floorTuning.light * 1.5),
    );

    const maxR = diveTuning.radius * Math.sqrt(power);
    this.ringMax = maxR;
    this.ringRadius = 0;
    this.ringSpeed = mega ? WAVE_SPEED_MEGA : WAVE_SPEED;
    this.originX = origin.x;
    this.originZ = origin.z;
    this.active = true;

    // Lay the resting chunk layer, biased toward the center (pow < 1).
    this.chunkActive = Math.round(CHUNKS * Math.min(1, Math.max(0, diveTuning.density)));
    for (let i = 0; i < this.chunkActive; i++) {
      const r = maxR * Math.pow(Math.random(), 0.7);
      const a = Math.random() * TWO_PI;
      this.csx[i] = 0.08 + Math.random() * 0.12;
      this.csy[i] = 0.06 + Math.random() * 0.09;
      this.csz[i] = 0.08 + Math.random() * 0.12;
      this.cx[i] = origin.x + Math.cos(a) * r;
      this.cz[i] = origin.z + Math.sin(a) * r;
      this.cdist[i] = r;
      this.crestY[i] = this.csy[i] / 2 + 0.02;
      this.cy[i] = this.crestY[i];
      this.crx[i] = (Math.random() - 0.5) * 0.7;
      this.cry[i] = Math.random() * TWO_PI;
      this.crz[i] = (Math.random() - 0.5) * 0.7;
      this.cvx[i] = this.cvy[i] = this.cvz[i] = 0;
      this.cflying[i] = 0;
      this.claunched[i] = 0;
      this.cbounced[i] = 0;
    }
    // Park the unused tail.
    this.dummy.position.set(0, -100, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = this.chunkActive; i < CHUNKS; i++) this.chunkMesh.setMatrixAt(i, this.dummy.matrix);
    this.chunkMesh.instanceMatrix.needsUpdate = true;
  }

  update(_unscaledDt: number): void {
    if (!this.enabled || !this.active) return;
    // World clock: the debris/ring hang through the dive's slow-mo tail.
    const dt = this.ctx.clock.scaledDt;
    if (dt <= 0) return;

    // ---- Wave front expands and kicks up chunks it crosses ----
    this.ringRadius += this.ringSpeed * dt;
    const ringT = Math.min(1, this.ringRadius / this.ringMax);

    for (let i = 0; i < this.chunkActive; i++) {
      // Launch a resting chunk the frame the wave front reaches it. Strength
      // falls with distance so the wave visibly weakens as it spreads.
      if (!this.claunched[i] && this.ringRadius >= this.cdist[i]) {
        this.claunched[i] = 1;
        this.cflying[i] = 1;
        this.cbounced[i] = 0;
        const falloff = Math.max(0.15, 1 - this.cdist[i] / this.ringMax);
        const p = diveTuning.power * falloff;
        const dx = this.cx[i] - this.originX;
        const dz = this.cz[i] - this.originZ;
        const d = Math.hypot(dx, dz) || 1;
        const ox = dx / d;
        const oz = dz / d;
        this.cvy[i] = (4 + Math.random() * 4) * p + 3;
        this.cvx[i] = ox * (1.5 + Math.random() * 2.5) * p + (Math.random() - 0.5);
        this.cvz[i] = oz * (1.5 + Math.random() * 2.5) * p + (Math.random() - 0.5);
        this.cspin[i * 3] = (Math.random() - 0.5) * 18;
        this.cspin[i * 3 + 1] = (Math.random() - 0.5) * 18;
        this.cspin[i * 3 + 2] = (Math.random() - 0.5) * 18;
      }

      if (this.cflying[i]) {
        this.cvy[i] += CHUNK_GRAVITY * dt;
        this.cx[i] += this.cvx[i] * dt;
        this.cy[i] += this.cvy[i] * dt;
        this.cz[i] += this.cvz[i] * dt;
        this.crx[i] += this.cspin[i * 3] * dt;
        this.cry[i] += this.cspin[i * 3 + 1] * dt;
        this.crz[i] += this.cspin[i * 3 + 2] * dt;
        if (this.cy[i] <= this.crestY[i] && this.cvy[i] < 0) {
          if (!this.cbounced[i] && this.cvy[i] < -2.5) {
            this.cbounced[i] = 1;
            this.cvy[i] *= -0.32;
            this.cvx[i] *= 0.5;
            this.cvz[i] *= 0.5;
          } else {
            this.cy[i] = this.crestY[i];
            this.cvx[i] = this.cvy[i] = this.cvz[i] = 0;
            this.cflying[i] = 0;
          }
        }
      }

      this.dummy.position.set(this.cx[i], this.cy[i], this.cz[i]);
      this.dummy.rotation.set(this.crx[i], this.cry[i], this.crz[i]);
      this.dummy.scale.set(this.csx[i], this.csy[i], this.csz[i]);
      this.dummy.updateMatrix();
      this.chunkMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.chunkMesh.instanceMatrix.needsUpdate = true;

    // Retire once the wave is done and every chunk has settled.
    if (ringT >= 1) {
      let anyFlying = false;
      for (let i = 0; i < this.chunkActive; i++) {
        if (this.cflying[i]) {
          anyFlying = true;
          break;
        }
      }
      if (!anyFlying) this.active = false;
    }
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) {
      this.active = false;
      if (this.chunkMesh) this.hideChunks();
    }
  }

  private hideChunks(): void {
    this.dummy.position.set(0, -100, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < CHUNKS; i++) this.chunkMesh.setMatrixAt(i, this.dummy.matrix);
    this.chunkMesh.instanceMatrix.needsUpdate = true;
    this.chunkActive = 0;
  }
}

/** Panel slider bound to one diveTuning field (persisted). */
function diveParam(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  field: keyof typeof diveTuning,
): EffectParam {
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => diveTuning[field],
    set: (v: number) => setDiveTuning(field, Math.min(max, Math.max(min, v))),
  };
}
