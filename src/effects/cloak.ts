import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  attributeArray,
  color,
  float,
  instanceIndex,
  mix,
  smoothstep,
  uint,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import type ComputeNode from "three/src/nodes/gpgpu/ComputeNode.js";
import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

const COLS = 17;
const ROWS = 23;
const VERTS = COLS * ROWS;
const TOP_Y = 1.26;
const CLOAK_HEIGHT = 1.48;
const TOP_WIDTH = 0.92;
const BOTTOM_WIDTH = 1.82;
const TOP_Z = -0.54;
const BOTTOM_Z = -1.3;
const MAX_DT = 1 / 30;
const SHOCK_SPEED = 8.5;
const SHOCK_WIDTH = 1.15;
const SHOCK_LIFE = 1.35;

const CLOAK_DATA = buildCloakData();

/**
 * Black compute-cloth cloak anchored to the player's shoulders. The rendered
 * mesh reads vertex positions directly from a WebGPU/TSL storage buffer:
 * step writes into a next buffer, commit copies current->previous and
 * next->current, then the material renders current as its positionNode.
 */
export class CloakEffect extends BaseEffect {
  readonly id = "black-cloak";
  readonly label = "Black Cloak";
  readonly description =
    "Player cloak: GPU-compute cloth pinned to the shoulders, reacting to spins, jumps, and shockwaves.";
  readonly group: EffectGroup = "Reaction";

  private readonly restStorage = attributeArray(new Float32Array(CLOAK_DATA.positions), "vec3").toReadOnly();
  private readonly positionStorage = attributeArray(new Float32Array(CLOAK_DATA.positions), "vec3");
  private readonly previousStorage = attributeArray(new Float32Array(CLOAK_DATA.positions), "vec3");
  private readonly nextStorage = attributeArray(new Float32Array(CLOAK_DATA.positions), "vec3");

  private stepKernel!: ComputeNode;
  private commitKernel!: ComputeNode;
  private resetKernel!: ComputeNode;

  private cloak!: THREE.Mesh;
  private collar!: THREE.Mesh;

  private readonly uDt = uniform(0);
  private readonly uLocalVelocity = uniform(new THREE.Vector3());
  private readonly uYawVelocity = uniform(0);
  private readonly uSpin = uniform(0);
  private readonly uSpinPhase = uniform(0);
  private readonly uShockOrigin = uniform(new THREE.Vector3(0, -1000, 0));
  private readonly uShockAge = uniform(99);
  private readonly uShockPower = uniform(0);
  private readonly uShockRadius = uniform(1);

  private readonly prevWorldPos = new THREE.Vector3();
  private readonly worldPos = new THREE.Vector3();
  private readonly worldDelta = new THREE.Vector3();
  private readonly localVelocity = new THREE.Vector3();
  private readonly worldQuat = new THREE.Quaternion();
  private readonly invWorldQuat = new THREE.Quaternion();
  private readonly shockWorld = new THREE.Vector3(0, -1000, 0);
  private readonly shockLocal = new THREE.Vector3();
  private prevYaw = 0;
  private shockAge = 99;
  private shockPower = 0;
  private shockRadius = 1;
  private initializedMotion = false;

  init(ctx: EffectContext): void {
    super.init(ctx);
    this.buildKernels();
    this.cloak = this.buildMesh();
    this.collar = this.buildCollarMesh();
    this.cloak.visible = false;
    this.collar.visible = false;
    ctx.getPlayer().group.add(this.collar, this.cloak);

    ctx.bus.on("dive-impact", ({ origin, power }) => {
      this.triggerShock(origin, 3.6 * power, 9 * power);
    });
    ctx.bus.on("mega-release", ({ origin }) => {
      this.triggerShock(origin, 6.5, 12);
    });
  }

  update(_unscaledDt: number): void {
    if (!this.enabled || !this.cloak.visible) return;

    const dt = Math.min(this.ctx.clock.scaledDt, MAX_DT);
    if (dt <= 0) return;

    const player = this.ctx.getPlayer();
    player.group.getWorldPosition(this.worldPos);
    player.group.getWorldQuaternion(this.worldQuat);
    this.invWorldQuat.copy(this.worldQuat).invert();

    if (!this.initializedMotion) {
      this.prevWorldPos.copy(this.worldPos);
      this.prevYaw = player.group.rotation.y;
      this.initializedMotion = true;
    }

    this.worldDelta.copy(this.worldPos).sub(this.prevWorldPos);
    if (this.worldDelta.lengthSq() > 25) {
      this.resetCloth();
      this.worldDelta.set(0, 0, 0);
    }

    this.localVelocity.copy(this.worldDelta).multiplyScalar(1 / dt).applyQuaternion(this.invWorldQuat);
    this.uLocalVelocity.value.copy(this.localVelocity);
    this.uYawVelocity.value = wrapAngle(player.group.rotation.y - this.prevYaw) / dt;
    this.prevWorldPos.copy(this.worldPos);
    this.prevYaw = player.group.rotation.y;

    const combat = player.combat;
    this.uSpin.value = combat?.spinning ? (combat.spinMega ? 2.8 : 1.55) : 0;
    this.uSpinPhase.value = combat ? combat.spinProgress * Math.PI * 2 * (combat.spinMega ? 2.7 : 1.25) : 0;

    this.shockAge += dt;
    if (this.shockAge < SHOCK_LIFE) {
      this.shockLocal.copy(this.shockWorld);
      player.group.worldToLocal(this.shockLocal);
      this.uShockOrigin.value.copy(this.shockLocal);
      this.uShockAge.value = this.shockAge;
      this.uShockPower.value = this.shockPower * Math.max(0, 1 - this.shockAge / SHOCK_LIFE);
      this.uShockRadius.value = this.shockRadius;
    } else {
      this.uShockPower.value = 0;
    }

    this.uDt.value = dt;
    this.ctx.renderer.compute(this.stepKernel);
    this.ctx.renderer.compute(this.commitKernel);
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!this.cloak) return;
    this.cloak.visible = enabled;
    this.collar.visible = enabled;
    if (enabled) {
      this.initializedMotion = false;
      this.resetCloth();
    }
  }

  private buildKernels(): void {
    this.stepKernel = Fn(() => {
      const fi = float(instanceIndex);
      const row = fi.div(COLS).floor();
      const col = fi.mod(COLS);
      const rowK = row.div(ROWS - 1);
      const colK = col.div(COLS - 1);
      const loose = rowK.pow(0.82);

      const rest = this.restStorage.element(instanceIndex);
      const pos = this.positionStorage.element(instanceIndex).toVar();
      const prev = this.previousStorage.element(instanceIndex);
      const next = pos.toVar();

      If(row.lessThan(0.5), () => {
        next.assign(rest);
      }).Else(() => {
        const vel = pos.sub(prev).mul(0.972).toVar();
        const force = vec3(
          rest.x.sub(pos.x).mul(18),
          rest.y.sub(pos.y).mul(10),
          rest.z.sub(pos.z).mul(15),
        ).toVar();

        const neighborSum = vec3(0, 0, 0).toVar();
        const neighborCount = float(0).toVar();
        If(col.greaterThan(0), () => {
          neighborSum.addAssign(this.positionStorage.element(instanceIndex.sub(uint(1))));
          neighborCount.addAssign(1);
        });
        If(col.lessThan(COLS - 1), () => {
          neighborSum.addAssign(this.positionStorage.element(instanceIndex.add(uint(1))));
          neighborCount.addAssign(1);
        });
        If(row.greaterThan(0), () => {
          neighborSum.addAssign(this.positionStorage.element(instanceIndex.sub(uint(COLS))));
          neighborCount.addAssign(1);
        });
        If(row.lessThan(ROWS - 1), () => {
          neighborSum.addAssign(this.positionStorage.element(instanceIndex.add(uint(COLS))));
          neighborCount.addAssign(1);
        });
        force.addAssign(neighborSum.div(neighborCount.max(1)).sub(pos).mul(42).mul(loose));

        force.x.addAssign(this.uLocalVelocity.x.negate().mul(0.62).mul(loose));
        force.y.addAssign(this.uLocalVelocity.y.negate().mul(0.34).mul(loose));
        force.z.addAssign(this.uLocalVelocity.z.negate().mul(0.72).mul(loose));
        const fallLift = this.uLocalVelocity.y.negate().max(0).mul(loose.pow(1.18));
        force.y.addAssign(fallLift.mul(1.35));
        force.z.addAssign(fallLift.mul(-0.78));
        force.x.addAssign(this.uYawVelocity.mul(rest.z.abs().add(0.28)).mul(0.52).mul(loose));
        force.z.addAssign(this.uYawVelocity.abs().mul(-0.18).mul(loose));

        const spinWave = rowK.mul(11.0).add(colK.mul(5.2)).add(this.uSpinPhase).sin();
        force.x.addAssign(spinWave.mul(this.uSpin).mul(1.25).mul(loose));
        force.y.addAssign(spinWave.abs().mul(this.uSpin).mul(0.24).mul(loose));
        force.z.addAssign(this.uSpin.mul(-0.7).mul(loose));

        const toShock = pos.sub(this.uShockOrigin).toVar();
        const shockDist = toShock.x.mul(toShock.x).add(toShock.z.mul(toShock.z)).sqrt();
        const shockFront = this.uShockAge.mul(SHOCK_SPEED);
        const shockRing = smoothstep(0, SHOCK_WIDTH, shockDist.sub(shockFront).abs()).oneMinus();
        const shockFalloff = smoothstep(0, this.uShockRadius, shockDist).oneMinus();
        const shockDir = vec3(toShock.x, toShock.y.mul(0.24).add(0.55), toShock.z).normalize();
        force.addAssign(shockDir.mul(shockRing).mul(shockFalloff).mul(this.uShockPower).mul(loose));

        next.assign(pos.add(vel).add(force.mul(this.uDt.mul(this.uDt))));
        next.x.assign(next.x.clamp(-1.35, 1.35));
        next.y.assign(next.y.clamp(-0.44, TOP_Y + 0.18));
        next.z.assign(next.z.clamp(-2.18, -0.1));
      });

      this.nextStorage.element(instanceIndex).assign(next);
    })().compute(VERTS, [64]);

    this.commitKernel = Fn(() => {
      this.previousStorage.element(instanceIndex).assign(this.positionStorage.element(instanceIndex));
      this.positionStorage.element(instanceIndex).assign(this.nextStorage.element(instanceIndex));
    })().compute(VERTS, [64]);

    this.resetKernel = Fn(() => {
      const rest = this.restStorage.element(instanceIndex);
      this.positionStorage.element(instanceIndex).assign(rest);
      this.previousStorage.element(instanceIndex).assign(rest);
      this.nextStorage.element(instanceIndex).assign(rest);
    })().compute(VERTS, [64]);
  }

  private buildMesh(): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(CLOAK_DATA.positions), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(CLOAK_DATA.uvs), 2));
    geometry.setIndex(Array.from(CLOAK_DATA.indices));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      roughness: 0.94,
      metalness: 0,
    });
    const sideFade = smoothstep(0.34, 0.5, uv().x.sub(0.5).abs());
    const bottomFade = uv().y.oneMinus();
    material.colorNode = mix(color(0x010101), color(0x11141b), sideFade.mul(0.32).add(bottomFade.mul(0.18)));
    material.emissiveNode = color(0x020406).mul(0.18);
    material.positionNode = this.positionStorage.toAttribute();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  private buildCollarMesh(): THREE.Mesh {
    const arcSteps = 18;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= arcSteps; i++) {
      const t = i / arcSteps;
      // Wraps from front-left around the back to front-right, leaving the face open.
      const theta = -Math.PI * 0.78 + t * Math.PI * 1.56;
      const x = Math.sin(theta);
      const z = -Math.cos(theta);
      const flare = Math.sin(t * Math.PI);
      const upperR = 0.49 + flare * 0.035;
      const lowerR = 0.58 + flare * 0.075;
      const upperY = 1.36 - flare * 0.035;
      const lowerY = 1.14 - flare * 0.055;

      positions.push(x * upperR, upperY, z * upperR - 0.03);
      positions.push(x * lowerR, lowerY, z * lowerR - 0.02);
      normals.push(x, 0.35, z, x, 0.15, z);
      uvs.push(t, 1, t, 0);
    }

    for (let i = 0; i < arcSteps; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, c, b, d);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    });
    material.colorNode = color(0x020202);
    material.emissiveNode = color(0x020406).mul(0.12);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  private triggerShock(origin: THREE.Vector3, power: number, radius: number): void {
    if (!this.enabled) return;
    this.shockWorld.copy(origin);
    this.shockAge = 0;
    this.shockPower = power;
    this.shockRadius = radius;
  }

  private resetCloth(): void {
    this.ctx.renderer.compute(this.resetKernel);
    this.shockAge = SHOCK_LIFE;
    this.uShockPower.value = 0;
  }
}

function buildCloakData(): {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
} {
  const positions = new Float32Array(VERTS * 3);
  const uvs = new Float32Array(VERTS * 2);
  let p = 0;
  let t = 0;

  for (let r = 0; r < ROWS; r++) {
    const rowK = r / (ROWS - 1);
    const flare = smooth01(rowK);
    const mantle = Math.sin(Math.PI * Math.min(rowK, 0.42) / 0.42) * 0.12;
    const width = TOP_WIDTH + (BOTTOM_WIDTH - TOP_WIDTH) * Math.pow(flare, 0.86) + mantle;
    const yBase = TOP_Y - rowK * CLOAK_HEIGHT;
    const zBase = TOP_Z + (BOTTOM_Z - TOP_Z) * Math.pow(rowK, 0.9);
    for (let c = 0; c < COLS; c++) {
      const colK = c / (COLS - 1);
      const side = (colK - 0.5) * 2;
      const sideAbs = Math.abs(side);
      const center = 1 - sideAbs;
      const topBand = Math.pow(1 - rowK, 3.2);
      const shoulderPeak = Math.max(0, sideAbs - 0.38) * 0.16 * topBand;
      const neckScoop = Math.max(0, 1 - sideAbs / 0.58) * 0.14 * topBand;
      const sideLift = Math.pow(sideAbs, 1.7) * Math.pow(rowK, 2.2) * 0.2;
      const centerTail = Math.pow(center, 1.45) * Math.pow(rowK, 3.0) * 0.18;
      const scallop = Math.sin(colK * Math.PI * 7) * 0.045 * Math.pow(rowK, 4.0);
      const pleat = Math.sin(side * Math.PI * 4.5 + rowK * 1.4) * 0.055 * (0.15 + rowK);
      const rib = Math.sin(side * Math.PI * 8) * 0.018 * rowK;
      const wrap = side * Math.sin(rowK * Math.PI) * 0.08;
      const sweepBack = Math.pow(center, 1.8) * Math.pow(rowK, 1.8) * 0.25;
      const sideForward = Math.pow(sideAbs, 1.4) * rowK * 0.18;

      positions[p++] = side * width * 0.5;
      positions[p - 1] += wrap;
      positions[p++] = yBase + shoulderPeak - neckScoop + sideLift - centerTail + scallop;
      positions[p++] = zBase - sweepBack + sideForward + pleat + rib;
      uvs[t++] = colK;
      uvs[t++] = 1 - rowK;
    }
  }

  const indices = new Uint16Array((COLS - 1) * (ROWS - 1) * 6);
  let i = 0;
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      const b = a + 1;
      const d = a + COLS;
      const e = d + 1;
      indices[i++] = a;
      indices[i++] = d;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = d;
      indices[i++] = e;
    }
  }

  return { positions, uvs, indices };
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}
