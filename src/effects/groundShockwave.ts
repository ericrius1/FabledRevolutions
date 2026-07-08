import * as THREE from "three/webgpu";
import { float, mx_noise_float, uniform, vec3 } from "three/tsl";

const MAX_STORED_AGE = 999;
const PLAYER_FORCE_SCALE = 0.9;
const PLAYER_RADIUS_SCALE = 2;
const LIGHTNING_FORCE_RATIO = 0.5;
const SMASH_RADIUS_CAP = 62;
const LIGHTNING_RADIUS_CAP = 16;
const BUILDING_IMPACT_SLOTS = 6;
const BUILDING_IMPACT_RADIUS_CAP = 28;
export const buildingImpactGlowStrengthNode = uniform(0.006);

function createShockSlot() {
  return {
    origin: uniform(new THREE.Vector3(0, -1000, 0)),
    age: uniform(MAX_STORED_AGE),
    life: uniform(1),
    power: uniform(0),
    radius: uniform(1),
    speed: uniform(26),
    width: uniform(1.8),
    active: false,
    /** Front radius before this frame's advance (CPU wavefront tracking). */
    prevFront: 0,
    /** Unscaled power as passed to triggerGroundShockwave (for gameplay hits). */
    rawPower: 0,
    mega: false,
  };
}

function createBuildingImpactSlot() {
  return {
    ...createShockSlot(),
    normalDir: uniform(new THREE.Vector3(1, 0, 0)),
  };
}

const smashShock = createShockSlot();
const lightningShock = createShockSlot();
const buildingImpactShocks = Array.from(
  { length: BUILDING_IMPACT_SLOTS },
  createBuildingImpactSlot,
);
type ShockSlot = typeof smashShock;
type BuildingImpactSlot = (typeof buildingImpactShocks)[number];
export type GroundShockwaveKind = "smash" | "lightning";

/**
 * CPU-side snapshot of one live wave front for gameplay: the band swept this
 * frame is (prevFront, front]. Enemies and building cubes inside that band get
 * hit exactly when the visible geometry crest reaches them.
 */
export interface ShockFrontSnapshot {
  kind: GroundShockwaveKind;
  originX: number;
  originZ: number;
  prevFront: number;
  front: number;
  radius: number;
  /** The unscaled power passed to triggerGroundShockwave. */
  power: number;
  mega: boolean;
}

const frontScratch: ShockFrontSnapshot[] = [
  { kind: "smash", originX: 0, originZ: 0, prevFront: 0, front: 0, radius: 1, power: 0, mega: false },
  { kind: "lightning", originX: 0, originZ: 0, prevFront: 0, front: 0, radius: 1, power: 0, mega: false },
];

/**
 * Collect the wave fronts that advanced this frame (call once per frame,
 * after advanceGroundShockwave). Returns a reused scratch array — consume
 * immediately, do not hold.
 */
const activeFronts: ShockFrontSnapshot[] = [];

export function collectShockFronts(): readonly ShockFrontSnapshot[] {
  activeFronts.length = 0;
  for (const slot of [smashShock, lightningShock]) {
    if (!slot.active) continue;
    const front = Math.min(slot.age.value * slot.speed.value, slot.radius.value);
    if (front <= slot.prevFront) continue;
    const snap = frontScratch[slot === smashShock ? 0 : 1];
    snap.kind = slot === smashShock ? "smash" : "lightning";
    snap.originX = slot.origin.value.x;
    snap.originZ = slot.origin.value.z;
    snap.prevFront = slot.prevFront;
    snap.front = front;
    snap.radius = slot.radius.value;
    snap.power = slot.rawPower;
    snap.mega = slot.mega;
    activeFronts.push(snap);
  }
  return activeFronts;
}

/**
 * Two global impact waves shared by road, buildings, and enemies: one durable
 * player-smash crest and one shorter lightning crest. They are CPU timed, but
 * every visible response is TSL vertex/material work.
 */
export function triggerGroundShockwave(
  origin: THREE.Vector3,
  power: number,
  mega: boolean,
  kind: GroundShockwaveKind = "smash",
): void {
  if (kind === "lightning") {
    const scaledPower = power * 0.82 * PLAYER_FORCE_SCALE * LIGHTNING_FORCE_RATIO;
    const radius = Math.min(
      LIGHTNING_RADIUS_CAP,
      power * 10 * PLAYER_RADIUS_SCALE * LIGHTNING_FORCE_RATIO,
    );
    const speed = 46;
    activateShock(lightningShock, origin, scaledPower, radius, speed, radius / speed + 0.32, 3.6);
    lightningShock.rawPower = power;
    lightningShock.mega = false;
    return;
  }

  const scaledPower = power * (mega ? 1.45 : 0.82) * PLAYER_FORCE_SCALE;
  // Mega ripples travel ~2x as far (radius cap and reach both doubled) so the
  // wave — visible crest and CPU flinging front alike — sweeps twice the ground.
  const radiusCap = mega ? SMASH_RADIUS_CAP * 2 : SMASH_RADIUS_CAP;
  const radius = Math.min(radiusCap, power * (mega ? 36 : 10) * PLAYER_RADIUS_SCALE);
  const speed = mega ? 58 : 48;
  const width = (mega ? 4.6 : 3.2) * Math.min(1.15, Math.sqrt(Math.max(1, power)));
  activateShock(smashShock, origin, scaledPower, radius, speed, radius / speed + 0.46, width);
  smashShock.rawPower = power;
  smashShock.mega = mega;
}

export function advanceGroundShockwave(dt: number): void {
  advanceShock(smashShock, dt);
  advanceShock(lightningShock, dt);
  for (const slot of buildingImpactShocks) advanceShock(slot, dt);
}

export function triggerBuildingImpactRipple(origin: THREE.Vector3, impactSpeed: number): void {
  const speed = Math.max(0, impactSpeed);
  const slot =
    buildingImpactShocks.find((s) => !s.active) ??
    buildingImpactShocks.reduce((oldest, s) =>
      s.age.value > oldest.age.value ? s : oldest,
    );
  const radius = Math.min(BUILDING_IMPACT_RADIUS_CAP, 7 + speed * 0.9);
  const waveSpeed = 42 + Math.min(18, speed * 0.8);
  const power = Math.min(1.4, 0.22 + speed * 0.035);
  const width = Math.min(2.8, 1.0 + speed * 0.045);

  slot.origin.value.copy(origin);
  slot.age.value = 0;
  slot.life.value = radius / waveSpeed + 0.5;
  slot.power.value = power;
  slot.radius.value = radius;
  slot.speed.value = waveSpeed;
  slot.width.value = width;
  slot.normalDir.value.set(origin.x >= 0 ? 1 : -1, 0, 0);
  slot.active = true;
}

export function setBuildingImpactGlowStrength(value: number): void {
  buildingImpactGlowStrengthNode.value = Math.max(0, value);
}

function activateShock(
  slot: ShockSlot,
  origin: THREE.Vector3,
  power: number,
  radius: number,
  speed: number,
  life: number,
  width: number,
): void {
  slot.origin.value.copy(origin);
  slot.origin.value.y = 0;
  slot.age.value = 0;
  slot.life.value = life;
  slot.power.value = power;
  slot.radius.value = radius;
  slot.speed.value = speed;
  slot.width.value = width;
  slot.prevFront = 0;
  slot.active = true;
}

function advanceShock(slot: ShockSlot, dt: number): void {
  if (!slot.active) return;
  slot.prevFront = Math.min(slot.age.value * slot.speed.value, slot.radius.value);
  slot.age.value += dt;
  if (slot.age.value >= slot.life.value) {
    slot.active = false;
    slot.age.value = MAX_STORED_AGE;
    slot.power.value = 0;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs defeat the typings */
function shockShape(worldXZ: any, slot: ShockSlot): any {
  const dist = worldXZ.sub(slot.origin.xz).length();
  const age = slot.age;
  const front = age.mul(slot.speed);
  const lifeFade = age.div(slot.life).smoothstep(0.72, 1.0).oneMinus();
  const radiusFade = dist.smoothstep(slot.radius.mul(0.88), slot.radius).oneMinus();
  const ring = dist.sub(front).abs().smoothstep(0.0, slot.width).oneMinus();
  const strength = ring.mul(lifeFade).mul(radiusFade).mul(slot.power);

  return { dist, age, lifeFade, radiusFade, ring, strength };
}

function shockHeightWithFracture(worldXZ: any, slot: ShockSlot, fracture: any): any {
  const s = shockShape(worldXZ, slot);
  // Sub-linear height: strength scales linearly with power (mega dives pass
  // power 5), but the crest compresses toward sqrt so a normal dive raises a
  // readable ~0.6m roll and a mega raises a ~2m road wave, not a mountain.
  const crest = s.strength.mul(0.9).div(slot.power.max(1).sqrt()).mul(fracture);

  const craterLife = s.age
    .smoothstep(0.0, 0.12)
    .mul(s.age.smoothstep(slot.life.mul(0.56), slot.life).oneMinus());
  const crater = s.dist
    .smoothstep(0.0, slot.power.mul(0.75).add(2.4))
    .oneMinus()
    .mul(-0.09)
    .mul(slot.power)
    .mul(craterLife);

  return crest.add(crater);
}

function shockHeight(worldXZ: any, slot: ShockSlot): any {
  const fracture = mx_noise_float(worldXZ.mul(1.08).add(slot.age.mul(2.35)))
    .mul(0.5)
    .add(0.5);
  return shockHeightWithFracture(worldXZ, slot, fracture.mul(0.42).add(0.78));
}

/** Fracture-free silhouette at the mean of the fracture band (0.78..1.2), so
 * it tracks the displaced crest without paying mx_noise per evaluation. The
 * floor differences this three times per fragment for its normal — the slope
 * that catches the light is the ring shape; differencing the noisy field cost
 * 6 extra noise evaluations for sub-visible sparkle. */
function shockHeightSmooth(worldXZ: any, slot: ShockSlot): any {
  return shockHeightWithFracture(worldXZ, slot, float(0.99));
}

export function groundShockHeight(worldXZ: any): any {
  return shockHeight(worldXZ, smashShock).add(shockHeight(worldXZ, lightningShock));
}

export function groundShockHeightSmooth(worldXZ: any): any {
  return shockHeightSmooth(worldXZ, smashShock).add(
    shockHeightSmooth(worldXZ, lightningShock),
  );
}

export function groundShockGlow(worldXZ: any): any {
  return shockGlow(worldXZ, smashShock).add(shockGlow(worldXZ, lightningShock).mul(0.82));
}

function shockGlow(worldXZ: any, slot: ShockSlot): any {
  const s = shockShape(worldXZ, slot);
  return s.strength.mul(0.16);
}

export function buildingShockOffset(worldPos: any): any {
  let offset = buildingShockVector(worldPos, smashShock).add(
    buildingShockVector(worldPos, lightningShock),
  );
  for (const slot of buildingImpactShocks) offset = offset.add(buildingImpactVector(worldPos, slot));
  return offset;
}

function buildingShockVector(worldPos: any, slot: ShockSlot): any {
  const rel = worldPos.xz.sub(slot.origin.xz);
  const dist = rel.length().max(0.001);
  const front = slot.age.mul(slot.speed);
  const ring = dist.sub(front).abs().smoothstep(0.0, slot.width.mul(1.45)).oneMinus();
  const lifeFade = slot.age.div(slot.life).smoothstep(0.64, 1.0).oneMinus();
  const radiusFade = dist.smoothstep(slot.radius.mul(0.9), slot.radius).oneMinus();
  const heightFade = worldPos.y.smoothstep(0.0, 28.0).oneMinus().mul(0.78).add(0.22);
  const strength = ring.mul(lifeFade).mul(radiusFade).mul(heightFade).mul(slot.power);
  const shove = strength.mul(0.14);
  const lift = strength.mul(0.035);

  return vec3(rel.x.div(dist).mul(shove), lift, rel.y.div(dist).mul(shove));
}

export function buildingImpactPulse(worldPos: any): any {
  let pulse = buildingImpactPulseForSlot(worldPos, buildingImpactShocks[0]);
  for (let i = 1; i < buildingImpactShocks.length; i++) {
    pulse = pulse.add(buildingImpactPulseForSlot(worldPos, buildingImpactShocks[i]));
  }
  return pulse;
}

export function buildingImpactNormalBend(worldPos: any): any {
  let bend = buildingImpactNormalBendForSlot(worldPos, buildingImpactShocks[0]);
  for (let i = 1; i < buildingImpactShocks.length; i++) {
    bend = bend.add(buildingImpactNormalBendForSlot(worldPos, buildingImpactShocks[i]));
  }
  return bend;
}

function buildingImpactShape(worldPos: any, slot: BuildingImpactSlot): any {
  const rel = worldPos.yz.sub(slot.origin.yz);
  const dist = rel.length().max(0.001);
  const front = slot.age.mul(slot.speed);
  const primary = dist.sub(front).abs().smoothstep(0.0, slot.width).oneMinus();
  const wakeWindow = dist
    .smoothstep(front.sub(slot.width.mul(6.5)), front)
    .oneMinus()
    .mul(dist.smoothstep(0.0, slot.width.mul(2.0)));
  const scan = dist
    .mul(5.6)
    .sub(slot.age.mul(48))
    .sin()
    .mul(0.5)
    .add(0.5)
    .pow(2.2);
  const matrixNoise = mx_noise_float(worldPos.mul(1.35).add(slot.age.mul(5.5)))
    .mul(0.5)
    .add(0.5);
  const lifeFade = slot.age.div(slot.life).smoothstep(0.58, 1.0).oneMinus();
  const radiusFade = dist.smoothstep(slot.radius.mul(0.88), slot.radius).oneMinus();
  const depthFade = worldPos.x.sub(slot.origin.x).abs().smoothstep(0.0, 7.5).oneMinus();
  const strength = primary
    .mul(1.08)
    .add(scan.mul(wakeWindow).mul(0.28))
    .mul(matrixNoise.mul(0.26).add(0.88))
    .mul(lifeFade)
    .mul(radiusFade)
    .mul(depthFade)
    .mul(slot.power);

  return { rel, dist, scan, strength };
}

function buildingImpactVector(worldPos: any, slot: BuildingImpactSlot): any {
  const s = buildingImpactShape(worldPos, slot);
  const phase = s.dist.mul(8.5).sub(slot.age.mul(64)).sin();
  const shove = s.strength.mul(0.12).mul(phase.mul(0.12).add(1.0));
  const shear = s.strength.mul(0.012).mul(phase);

  const normal = slot.normalDir.mul(shove);
  const ripple = vec3(0, s.rel.x.div(s.dist).mul(shear), s.rel.y.div(s.dist).mul(shear));
  return normal.add(ripple);
}

function buildingImpactPulseForSlot(worldPos: any, slot: BuildingImpactSlot): any {
  const s = buildingImpactShape(worldPos, slot);
  return s.strength.mul(s.scan.mul(0.35).add(0.65)).mul(0.42);
}

function buildingImpactNormalBendForSlot(worldPos: any, slot: BuildingImpactSlot): any {
  const s = buildingImpactShape(worldPos, slot);
  const phase = s.dist.mul(8.5).sub(slot.age.mul(64)).sin();
  const slope = s.strength.mul(0.05).mul(phase);
  return vec3(0, s.rel.x.div(s.dist).mul(slope), s.rel.y.div(s.dist).mul(slope));
}

export function enemyShockOffset(worldPos: any, strengthScale = 1): any {
  return enemyShockVector(worldPos, smashShock, strengthScale).add(
    enemyShockVector(worldPos, lightningShock, strengthScale),
  );
}

function enemyShockVector(worldPos: any, slot: ShockSlot, strengthScale: number): any {
  const rel = worldPos.xz.sub(slot.origin.xz);
  const dist = rel.length().max(0.001);
  const front = slot.age.mul(slot.speed);
  const ring = dist.sub(front).abs().smoothstep(0.0, slot.width.mul(1.25)).oneMinus();
  const lifeFade = slot.age.div(slot.life).smoothstep(0.64, 1.0).oneMinus();
  const radiusFade = dist.smoothstep(slot.radius.mul(0.9), slot.radius).oneMinus();
  const strength = ring.mul(lifeFade).mul(radiusFade).mul(slot.power).mul(strengthScale);
  const hop = strength.mul(0.22);
  const shove = strength.mul(0.082);

  return vec3(rel.x.div(dist).mul(shove), hop, rel.y.div(dist).mul(shove));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
