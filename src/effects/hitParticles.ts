import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  instancedArray,
  instanceIndex,
  uniform,
  vec3,
  vec4,
  float,
  color,
  cos,
  sin,
  atan,
  hash,
  mix,
  smoothstep,
  uv,
  vec2,
  cameraViewMatrix,
} from "three/tsl";
import type ComputeNode from "three/src/nodes/gpgpu/ComputeNode.js";
import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * Additive spark burst at each impact point, simulated entirely on the GPU. A
 * pool of sparks lives in storage buffers (position/velocity/life/size); each
 * hit dispatches a spawn compute kernel that revives a slice of the pool with
 * radial velocity, gravity-fed motion, and a shrinking lifetime. A killing blow
 * spawns a bigger, brighter burst plus an expanding ring flash (a thin additive
 * torus that grows and fades on the CPU).
 *
 * The particle sim never touches JS per frame: an update kernel integrates every
 * spark, and a SpriteNodeMaterial renders them straight from the storage
 * buffers. Disabling dispatches a kill-all kernel so no live particle survives
 * to leak into the next enable.
 *
 * Both meshes stay `visible = true` from init: dead sparks render at scale 0
 * (life drives the size) and the idle ring sits at scale 0 / opacity 0. That
 * warms their pipelines on the first frame instead of stuttering on the first
 * hit or kill.
 */

const POOL = 220;
const GRAVITY = -14;
const HIT_COUNT = 14;
const KILL_COUNT = 34;
const TWO_PI = Math.PI * 2;
// Velocity streaking: how much screen-space speed elongates a spark, the cap,
// and how much the cross axis thins to keep streaks razor-like.
const STRETCH_PER_SPEED = 0.45;
const MAX_STRETCH = 5;
const CROSS_THIN = 0.35;

export class HitParticlesEffect extends BaseEffect {
  readonly id = "hit-particles";
  readonly label = "Hit Particles";
  readonly description = "Additive spark burst at impact, with a ring flash on kill.";
  readonly group: EffectGroup = "Reaction";

  private sprites!: THREE.Sprite;

  // GPU storage buffers over the pool. Types inferred from the concrete
  // instancedArray overloads (vec3 for position/velocity, float otherwise).
  private positionStorage = instancedArray(POOL, "vec3");
  private velocityStorage = instancedArray(POOL, "vec3");
  private lifeStorage = instancedArray(POOL, "float");
  private maxLifeStorage = instancedArray(POOL, "float");
  private sizeStorage = instancedArray(POOL, "float");

  // Compute kernels.
  private updateKernel!: ComputeNode;
  private spawnKernel!: ComputeNode;
  private killKernel!: ComputeNode;

  // Update-kernel uniform.
  private readonly uDt = uniform(0);
  // Spawn-kernel uniforms.
  private readonly uOrigin = uniform(new THREE.Vector3());
  private readonly uStart = uniform(0);
  private readonly uCount = uniform(0);
  private readonly uBig = uniform(0);
  private readonly uSeed = uniform(0);

  private cursor = 0;
  /**
   * Spawn dispatches issued since the last update. Each burst is a full
   * compute pass; during a mass-kill spin dozens of hits can land per frame,
   * and past a few bursts the pool wraps anyway — extra dispatches are pure
   * overhead on an already-saturated frame. Reset each update().
   */
  private spawnsThisFrame = 0;

  // Kill ring flash (CPU-driven).
  private ring!: THREE.Mesh;
  private readonly ringOpacity = uniform(0);
  private ringLife = 0;
  private ringMaxLife = 0.35;

  init(ctx: EffectContext): void {
    super.init(ctx);

    this.buildKernels();

    // Sprite render material reads position/size/life straight from storage.
    const material = new THREE.SpriteNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;

    const life = this.lifeStorage.toAttribute();
    const maxLife = this.maxLifeStorage.toAttribute();
    const lifeK = life.div(maxLife.max(0.001)).clamp(0, 1);

    material.positionNode = this.positionStorage.toAttribute();

    // Stretch each spark along its velocity so fast sparks read as streaks.
    // Velocity is rotated into view space; the billboard is then rotated to the
    // screen-space direction of motion and scaled up along that axis by speed,
    // while the cross axis thins, keeping roughly constant energy per spark.
    // Note: the storage attribute arrives vec4-padded, so the vec4 is built
    // from explicit components rather than vec4(vec3, w).
    const vel = this.velocityStorage.toAttribute();
    const velView = cameraViewMatrix.mul(vec4(vel.x, vel.y, vel.z, 0)).xyz;
    const screenSpeed = velView.xy.length();
    const stretch = screenSpeed.mul(STRETCH_PER_SPEED).add(1).min(MAX_STRETCH);
    const base = this.sizeStorage.toAttribute().mul(lifeK);
    material.rotationNode = atan(velView.y, velView.x);
    material.scaleNode = vec2(base.mul(stretch), base.mul(CROSS_THIN));

    material.colorNode = color(0xffb347);
    // Soft round core in UV space — the velocity stretch above elongates it
    // into a tapered streak.
    material.opacityNode = smoothstep(0.0, 0.5, uv().distance(vec2(0.5))).oneMinus();

    this.sprites = new THREE.Sprite(material);
    this.sprites.count = POOL;
    this.sprites.frustumCulled = false;
    ctx.scene.add(this.sprites);

    // Kill ring flash.
    const ringMat = new THREE.MeshBasicNodeMaterial();
    ringMat.colorNode = color(0xffe08a);
    ringMat.opacityNode = this.ringOpacity;
    ringMat.transparent = true;
    ringMat.depthWrite = false;
    ringMat.blending = THREE.AdditiveBlending;
    ringMat.side = THREE.DoubleSide;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 32), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.scale.setScalar(0);
    this.ring.frustumCulled = false;
    ctx.scene.add(this.ring);

    ctx.bus.on("attack-hit", ({ point, killed }) => {
      if (!this.enabled) return;
      this.burst(point, killed ? KILL_COUNT : HIT_COUNT, killed);
      if (killed) this.spawnRing(point);
    });
  }

  private buildKernels(): void {
    // Integrate every live spark: decay life, gravity, advance position.
    this.updateKernel = Fn(() => {
      const life = this.lifeStorage.element(instanceIndex);
      const vel = this.velocityStorage.element(instanceIndex);
      const pos = this.positionStorage.element(instanceIndex);
      If(life.greaterThan(0), () => {
        life.subAssign(this.uDt);
        vel.y.addAssign(float(GRAVITY).mul(this.uDt));
        pos.addAssign(vel.mul(this.uDt));
      });
    })().compute(POOL);

    // Revive a contiguous slice [uStart, uStart+uCount) of the ring.
    this.spawnKernel = Fn(() => {
      const rel = float(instanceIndex).sub(this.uStart).add(POOL).mod(POOL);
      If(rel.lessThan(this.uCount), () => {
        const idx = float(instanceIndex);
        const theta = hash(idx.add(this.uSeed)).mul(TWO_PI);
        const speedBase = mix(float(3.5), float(5.0), this.uBig);
        const upBase = mix(float(2.5), float(3.5), this.uBig);
        const sizeBase = mix(float(0.2), float(0.28), this.uBig);

        const speed = speedBase.mul(hash(idx.add(this.uSeed).add(91)).add(0.4));
        const up = upBase.mul(hash(idx.add(this.uSeed).add(173)).mul(0.7).add(0.3));
        const maxLifeV = hash(idx.add(this.uSeed).add(251)).mul(0.22).add(0.28);
        const sizeV = sizeBase.mul(hash(idx.add(this.uSeed).add(331)).mul(0.6).add(0.7));

        this.positionStorage.element(instanceIndex).assign(this.uOrigin);
        this.velocityStorage
          .element(instanceIndex)
          .assign(vec3(cos(theta).mul(speed), up, sin(theta).mul(speed)));
        this.maxLifeStorage.element(instanceIndex).assign(maxLifeV);
        this.lifeStorage.element(instanceIndex).assign(maxLifeV);
        this.sizeStorage.element(instanceIndex).assign(sizeV);
      });
    })().compute(POOL);

    // Kill every spark (used on disable so nothing lingers).
    this.killKernel = Fn(() => {
      this.lifeStorage.element(instanceIndex).assign(0);
    })().compute(POOL);
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return;
    this.spawnsThisFrame = 0;
    this.uDt.value = unscaledDt;
    this.ctx.renderer.compute(this.updateKernel);
    this.stepRing(unscaledDt);
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  private burst(point: THREE.Vector3, count: number, big: boolean): void {
    if (this.spawnsThisFrame >= 3) return;
    this.spawnsThisFrame++;
    this.uOrigin.value.copy(point);
    this.uStart.value = this.cursor;
    this.uCount.value = count;
    this.uBig.value = big ? 1 : 0;
    this.uSeed.value = Math.random() * 1000;
    this.cursor = (this.cursor + count) % POOL;
    this.ctx.renderer.compute(this.spawnKernel);
  }

  private spawnRing(point: THREE.Vector3): void {
    this.ring.position.set(point.x, 0.05, point.z);
    this.ring.scale.setScalar(1);
    this.ringLife = this.ringMaxLife;
  }

  private stepRing(dt: number): void {
    if (this.ringLife <= 0) return;
    this.ringLife -= dt;
    const k = Math.max(0, this.ringLife / this.ringMaxLife);
    this.ring.scale.setScalar(1 + (1 - k) * 5);
    this.ringOpacity.value = k * 0.8;
    if (this.ringLife <= 0) {
      this.ring.scale.setScalar(0);
      this.ringOpacity.value = 0;
    }
  }

  private clear(): void {
    this.ringLife = 0;
    // Kill-all kernel zeroes every spark's life, which zeroes its render scale.
    if (this.sprites) this.ctx.renderer.compute(this.killKernel);
    if (this.ring) {
      this.ring.scale.setScalar(0);
      this.ringOpacity.value = 0;
    }
  }
}
