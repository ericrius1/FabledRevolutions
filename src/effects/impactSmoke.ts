import * as THREE from "three/webgpu";
import {
  float,
  instancedBufferAttribute,
  mix,
  mx_noise_float,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup, type EffectParam } from "./effect";

/**
 * Reusable impact smoke: a pooled set of camera-facing quads whose shape is
 * carved in the fragment shader — radial falloff eroded by two octaves of
 * animated noise, so each puff reads as a ragged, slowly-churning cloud
 * instead of a hard sphere. Puffs are shaded light-on-top / dark-underneath
 * and each one drifts, rolls, expands and fades on its own lifetime.
 *
 * Any system can raise dust through `burst(origin, opts)`; out of the box it
 * listens for `dive-impact` (a low ground-hugging ring of dust) and
 * `mega-lightning` (a small scorched wisp at the strike point). The pool is
 * kept warm (dead instances at scale 0) so the first burst never hitches on
 * a pipeline compile.
 */

const POOL = 96;
const TWO_PI = Math.PI * 2;

export const smokeTuning = {
  /** Global multiplier on puffs spawned per burst. */
  amount: 1,
  /** Global multiplier on puff size. */
  size: 1,
};

const TUNING_PREFIX = "fabled-revolutions.smoke.";
for (const key of Object.keys(smokeTuning) as Array<keyof typeof smokeTuning>) {
  try {
    const raw = localStorage.getItem(TUNING_PREFIX + key);
    if (raw === null) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) smokeTuning[key] = v;
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

export function setSmokeTuning(key: keyof typeof smokeTuning, value: number): void {
  smokeTuning[key] = value;
  try {
    localStorage.setItem(TUNING_PREFIX + key, String(value));
  } catch {
    // ignore
  }
}

export interface SmokeBurstOptions {
  /** Puff count before the tuning multiplier. Default 14. */
  count?: number;
  /** Overall scale on speed and size. Default 1. */
  power?: number;
  /** Horizontal spawn radius around the origin. Default 0.9. */
  radius?: number;
  /** Outward speed along the spawn direction. Default 2.2. */
  outward?: number;
  /** Upward speed. Default 1.4. */
  upward?: number;
  /** Base puff diameter (world units). Default 1.1. */
  size?: number;
  /** Seconds a puff lives (randomized ±35%). Default 1.1. */
  life?: number;
}

export class ImpactSmokeEffect extends BaseEffect {
  readonly id = "impact-smoke";
  readonly label = "Impact Smoke";
  readonly description =
    "Ragged dust clouds kicked up by dive smashes and lightning strikes; noise-carved billboards, not spheres.";
  readonly group: EffectGroup = "Reaction";

  readonly params: readonly EffectParam[] = [
    smokeParam("smoke-amount", "dust amount", 0.2, 2, 0.05, "amount"),
    smokeParam("smoke-size", "dust size", 0.4, 2.5, 0.05, "size"),
  ];

  private mesh!: THREE.InstancedMesh;
  private readonly mat = new THREE.MeshBasicNodeMaterial();
  private readonly dummy = new THREE.Object3D();
  private readonly uDark = uniform(new THREE.Color(0x4c5156));
  private readonly uLight = uniform(new THREE.Color(0xc9d1d6));

  // Structure-of-arrays particle state.
  private readonly px = new Float32Array(POOL);
  private readonly py = new Float32Array(POOL);
  private readonly pz = new Float32Array(POOL);
  private readonly vx = new Float32Array(POOL);
  private readonly vy = new Float32Array(POOL);
  private readonly vz = new Float32Array(POOL);
  private readonly age = new Float32Array(POOL);
  private readonly maxLife = new Float32Array(POOL);
  private readonly size0 = new Float32Array(POOL);
  private readonly grow = new Float32Array(POOL);
  private readonly curl = new Float32Array(POOL);
  private cursor = 0;
  private alive = 0;

  /** Per-instance fade written each frame; the shader multiplies it in. */
  private fadeAttr!: THREE.InstancedBufferAttribute;
  /** Per-instance random seed; drives the noise offset and roll. */
  private seedAttr!: THREE.InstancedBufferAttribute;

  init(ctx: EffectContext): void {
    super.init(ctx);

    const geo = new THREE.PlaneGeometry(1, 1);
    this.seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1);
    this.fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1);
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < POOL; i++) this.seedAttr.setX(i, Math.random());
    geo.setAttribute("smokeSeed", this.seedAttr);
    geo.setAttribute("smokeFade", this.fadeAttr);

    // instancedBufferAttribute's typings return an untyped Node; assert float.
    type FloatNode = ReturnType<typeof float>;
    const seed = instancedBufferAttribute(this.seedAttr, "float") as unknown as FloatNode;
    const fade = instancedBufferAttribute(this.fadeAttr, "float") as unknown as FloatNode;

    // Quad space: p in [-1,1], q is p slowly rolled per-puff so the cloud churns.
    const p = uv().sub(0.5).mul(2.0);
    const ang = seed.mul(TWO_PI).add(time.mul(seed.sub(0.5)).mul(0.9));
    const ca = ang.cos();
    const sa = ang.sin();
    const q = vec2(p.x.mul(ca).sub(p.y.mul(sa)), p.x.mul(sa).add(p.y.mul(ca)));

    // Two noise octaves erode the radial falloff into a ragged silhouette.
    const drift = time.mul(0.3).add(seed.mul(47.13));
    const n1 = mx_noise_float(vec3(q.mul(2.0), drift));
    const n2 = mx_noise_float(vec3(q.mul(4.9).add(vec2(7.3, 2.1)), drift.mul(1.6).add(13.7)));
    const n = n1.mul(0.62).add(n2.mul(0.3));

    const edge = q.length().add(n.mul(0.55));
    const shape = edge.smoothstep(0.3, 0.95).oneMinus().pow(1.35);
    this.mat.opacityNode = shape.mul(fade).mul(0.85);

    // Fake lighting: brighter toward the top of the quad and in noise crests.
    const shade = p.y.mul(0.22).add(n.mul(0.4)).add(float(0.45)).clamp(0, 1);
    this.mat.colorNode = mix(this.uDark, this.uLight, shade);

    this.mat.transparent = true;
    this.mat.depthWrite = false;
    this.mat.side = THREE.DoubleSide;

    this.mesh = new THREE.InstancedMesh(geo, this.mat, POOL);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.hideAll();
    ctx.scene.add(this.mesh);

    ctx.bus.on("dive-impact", ({ origin, power }) => {
      if (!this.enabled) return;
      // Low, wide dust ring hugging the ground. Count grows sub-linearly with
      // power: from the top-down camera every puff stacks over the same impact
      // zone, so the linear ~50-puff mega ring was pure additive overdraw —
      // the biggest GPU spike of the move — while ~30 read identically.
      this.burst(origin, {
        count: Math.round(12 + 8 * Math.sqrt(power)),
        power,
        radius: 1.1,
        outward: 3.2,
        upward: 1.6,
        size: 1.3,
        life: 1.15,
      });
    });

    ctx.bus.on("mega-lightning", ({ point }) => {
      if (!this.enabled) return;
      // Small, mostly-vertical wisp at the strike point.
      this.burst(point, {
        count: 6,
        radius: 0.35,
        outward: 0.9,
        upward: 2.6,
        size: 0.8,
        life: 0.9,
      });
    });
  }

  /** Raise a dust cloud at `origin`. Safe to call from any system. */
  burst(origin: THREE.Vector3, opts: SmokeBurstOptions = {}): void {
    if (!this.enabled) return;
    const power = opts.power ?? 1;
    const count = Math.min(
      POOL,
      Math.max(1, Math.round((opts.count ?? 14) * smokeTuning.amount)),
    );
    const radius = opts.radius ?? 0.9;
    const outward = (opts.outward ?? 2.2) * Math.sqrt(power);
    const upward = (opts.upward ?? 1.4) * Math.sqrt(power);
    // Size cap: fill cost is quad area × layer count, so past power 3 bigger
    // puffs only multiply overdraw the flash already hides.
    const size = (opts.size ?? 1.1) * (0.75 + Math.min(power, 3) * 0.35) * smokeTuning.size;
    const life = opts.life ?? 1.1;

    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % POOL;
      const a = Math.random() * TWO_PI;
      const r = radius * (0.3 + Math.random() * 0.7);
      this.px[i] = origin.x + Math.cos(a) * r;
      this.py[i] = Math.max(origin.y, 0) + 0.25 + Math.random() * 0.4;
      this.pz[i] = origin.z + Math.sin(a) * r;
      this.vx[i] = Math.cos(a) * outward * (0.55 + Math.random() * 0.9);
      this.vy[i] = upward * (0.6 + Math.random() * 0.8);
      this.vz[i] = Math.sin(a) * outward * (0.55 + Math.random() * 0.9);
      this.age[i] = 0;
      this.maxLife[i] = life * (0.65 + Math.random() * 0.7);
      this.size0[i] = size * (0.6 + Math.random() * 0.8);
      this.grow[i] = 1.6 + Math.random() * 1.2;
      this.curl[i] = (Math.random() - 0.5) * 2;
    }
    this.alive = POOL; // conservatively re-scan until everything settles
  }

  update(_unscaledDt: number): void {
    if (!this.enabled || this.alive === 0) return;
    // World clock, so smoke hangs correctly through slow-mo.
    const dt = this.ctx.clock.scaledDt;
    if (dt <= 0) return;

    const camQuat = this.ctx.camera.camera.quaternion;
    let anyAlive = false;

    for (let i = 0; i < POOL; i++) {
      if (this.age[i] >= this.maxLife[i]) continue;
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / this.maxLife[i]);

      if (t >= 1) {
        this.fadeAttr.setX(i, 0);
        this.dummy.position.set(0, -100, 0);
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      anyAlive = true;

      // Drag bleeds off the initial kick; buoyancy keeps it lazily rising,
      // and a per-puff curl gives the cloud a slow sideways waft.
      const drag = 1 - Math.min(1, 2.2 * dt);
      this.vx[i] = this.vx[i] * drag + Math.sin(this.curl[i] * 9 + this.age[i] * 2.1) * 0.5 * dt;
      this.vz[i] = this.vz[i] * drag + Math.cos(this.curl[i] * 7 + this.age[i] * 1.7) * 0.5 * dt;
      this.vy[i] = this.vy[i] * drag + 1.1 * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      // Fast ramp-in, long tail-out; expansion is quick at first then eases.
      const fadeIn = Math.min(1, t / 0.12);
      const fadeOut = (1 - t) ** 1.6;
      this.fadeAttr.setX(i, fadeIn * fadeOut);
      const scale = this.size0[i] * (0.45 + this.grow[i] * Math.pow(t, 0.55));

      this.dummy.position.set(this.px[i], this.py[i], this.pz[i]);
      this.dummy.quaternion.copy(camQuat);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
    if (!anyAlive) this.alive = 0;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled && this.mesh) this.hideAll();
  }

  private hideAll(): void {
    this.dummy.position.set(0, -100, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < POOL; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.fadeAttr.setX(i, 0);
      this.age[i] = this.maxLife[i] = 0;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
    this.alive = 0;
  }
}

/** Panel slider bound to one smokeTuning field (persisted). */
function smokeParam(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  field: keyof typeof smokeTuning,
): EffectParam {
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => smokeTuning[field],
    set: (v: number) => setSmokeTuning(field, Math.min(max, Math.max(min, v))),
  };
}
