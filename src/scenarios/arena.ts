import * as THREE from "three/webgpu";
import {
  cameraPosition,
  cameraViewMatrix,
  float,
  hash,
  mix,
  mx_noise_float,
  positionLocal,
  positionWorld,
  refract,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Scenario, ScenarioContext } from "./scenario";
import { Enemy } from "../game/enemy";
import { PropField } from "../game/props";
import { Category, type Body } from "../core/physics";
import { groundShockHeight, groundShockHeightSmooth } from "../effects/groundShockwave";

export const ARENA_HALF = 44;
/**
 * The visible/physical floor extends far past the play space so mega launches
 * slide hundreds of units toward the horizon and dissolve into the fog line
 * instead of slamming an invisible wall at the arena edge.
 */
export const FLOOR_HALF = 440;
/**
 * The floor is split in two: a densely tessellated inner plane covering the
 * whole play space (shock radius cap + the longest corridor), so the ground
 * shockwave has real vertices to displace — the Matrix road-buckle — and a
 * cheap outer apron (a ShapeGeometry with a matching hole) running to the fog
 * line, where the wave can never reach.
 */
/**
 * Sized to the farthest a shock crest can actually reach: an impact at the
 * arena edge (ARENA_HALF 44) plus the smash radius cap (62) ≈ 106, with
 * margin. At ~0.75 verts/m the 3.2–4.6 m crest still crosses 2–3 vertices;
 * the old 224-half/1-vert-per-m plane was ~200k verts (~5× this one) running
 * the shock displacement for ground the wave could never touch.
 */
const FLOOR_DETAIL_HALF = 128;
const FLOOR_DETAIL_SEGMENTS = 192;

/**
 * Floor look: Matrix-wet blacktop. A cold, nearly black road skin carries fine
 * cyan aggregate glints, with a dimmer fixed-depth subsurface layer underneath:
 * the shader refracts the view ray through the skin, intersects a virtual layer
 * below the floor, and projects a cellular teal pattern there so camera motion
 * produces visible parallax without broad, low-scale blotches.
 */
export const floorTuning = {
  hue: 0.5, // cold cyan cast in the dark road skin
  sat: 0.16,
  light: 0.032,
  /** Hue of the buried cellular layer and wet aggregate glints. */
  glowHue: 0.48,
  /** Strength of the buried layer's glow rising through the skin. */
  glow: 1.25,
  /** Wet/glass amount on the surface (0 = matte, 1 = glossy translucent skin). */
  depth: 0.78,
  /** Parallax depth of the subsurface layer, in metres below the skin. */
  subDepth: 1.45,
  /** How clearly the buried plane shows through the surface skin. */
  subVisibility: 0.58,
  /** Frequency multiplier for asphalt aggregate, glints, and subsurface detail. */
  detailScale: 1.7,
};

// New prefix: this floor has a different palette, ranges, and exposed controls;
// stale saved values would hide the new fixed-depth layer.
const FLOOR_PREFIX = "fabled-revolutions.floor6.";
for (const key of Object.keys(floorTuning) as Array<keyof typeof floorTuning>) {
  try {
    const raw = localStorage.getItem(FLOOR_PREFIX + key);
    if (raw === null) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) floorTuning[key] = v;
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

// Uniform-driven so panel sliders re-tint the floor live, no rebuild.
const uFloorCenter = uniform(new THREE.Color()); // dark skin near the player
const uFloorEdge = uniform(new THREE.Color()); // darker skin toward the horizon
// Buried-layer tones: bright cellular layer, deeper scattered echo, and the
// dark absorption tint the glossy skin falls toward.
const uGlowShallow = uniform(new THREE.Color());
const uGlowDeep = uniform(new THREE.Color());
const uAbyss = uniform(new THREE.Color());
const uGlowStrength = uniform(1);
const uTranslucency = uniform(0.5); // reused as wet-sheen amount
/** Parallax depth (m) of the buried layer under the floor skin. */
const uSubDepth = uniform(1.7);
/** Visibility/exposure of the buried plane through the surface skin. */
const uSubVisibility = uniform(0.86);
/** Frequency multiplier for road aggregate, glints, and buried pattern scale. */
const uRoadDetailScale = uniform(1.7);
/** 0..1 mega envelope: floods the street wetter/darker (megaFx). */
const uFloorDepth = uniform(0);
/**
 * Game-clock seconds driving the floor's liquid drift. A uniform fed from
 * the main loop (not TSL's `time`, which doesn't tick in this setup) — and
 * because it advances on SCALED dt, the subsurface flow slows down with
 * bullet time, which reads great during the mega orbit.
 */
const uFloorTime = uniform(0);

export function advanceFloorTime(dt: number): void {
  uFloorTime.value += dt;
}

function applyFloorColors(): void {
  // Dark glossy skin: near-black teal with a tunable cast, darker at range.
  uFloorCenter.value.setHSL(floorTuning.hue, floorTuning.sat, floorTuning.light);
  uFloorEdge.value.setHSL(floorTuning.hue, floorTuning.sat, floorTuning.light * 0.6);
  // Buried layer: cyan-green cells and wet micro glints fading into a darker echo.
  uGlowShallow.value.setHSL(floorTuning.glowHue, Math.min(1, floorTuning.sat + 0.58), 0.46);
  uGlowDeep.value.setHSL(
    (floorTuning.glowHue + 0.015) % 1,
    Math.min(1, floorTuning.sat + 0.48),
    0.055,
  );
  // Deep tint the glossy skin darkens toward.
  uAbyss.value.setHSL(floorTuning.glowHue, Math.min(1, floorTuning.sat + 0.45), 0.014);
  uGlowStrength.value = floorTuning.glow;
  uTranslucency.value = floorTuning.depth;
  uSubDepth.value = floorTuning.subDepth;
  uSubVisibility.value = floorTuning.subVisibility;
  uRoadDetailScale.value = floorTuning.detailScale;
}
applyFloorColors();

/** Mega-mode floor envelope (0..1): deeper, darker, more translucent. */
export function setFloorDepth(v: number): void {
  uFloorDepth.value = Math.min(1, Math.max(0, v));
}

export function setFloorTuning(key: keyof typeof floorTuning, value: number): void {
  floorTuning[key] = value;
  applyFloorColors();
  try {
    localStorage.setItem(FLOOR_PREFIX + key, String(value));
  } catch {
    // ignore
  }
}

/** Optional axis-aligned corridor footprint for scenarios that don't need the full apron. */
export interface ArenaCorridorBounds {
  /** Half-width along X (centre to outer facade edge). */
  halfWidth: number;
  /** Near edge along +Z (player / camera side). */
  nearZ: number;
  /** Far edge along −Z. */
  farZ: number;
}

/**
 * Builds the subsurface floor, subtle grid, and invisible physics walls shared by
 * every scenario. Returns the meshes/bodies so the scenario can dispose them.
 * Pass {@link ArenaCorridorBounds} to clip the road to a forward corridor.
 */
export function buildArenaEnvironment(
  ctx: ScenarioContext,
  corridor?: ArenaCorridorBounds,
): {
  objects: THREE.Object3D[];
  bodies: Body[];
} {
  const objects: THREE.Object3D[] = [];
  const bodies: Body[] = [];

  // Floor mesh (visual). Physics ground is a separate static box.
  //
  // Glossy translucent skin over a fixed-depth subsurface. The view ray is
  // refracted and intersected with virtual planes below the floor; the sampled
  // cellular pattern shifts as the camera moves, which makes the second layer
  // read as metres under the surface instead of a decal painted on top.
  const floorMaterial = new THREE.MeshStandardNodeMaterial();
  const xz = positionWorld.xz;
  const radial = xz.length().div(ARENA_HALF).clamp(0, 1);

  const view = positionWorld.sub(cameraPosition).normalize();
  const wetSheen = uTranslucency.add(uFloorDepth.mul(0.3)).clamp(0, 1);

  // Crack mask (1 inside a crack): the zero-crossings of a low-frequency field.
  // Drives both the surface relief and the subsurface visibility.
  /* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs defeat the typings */
  const crackAt = (p: any) =>
    mx_noise_float(p.mul(uRoadDetailScale.mul(0.45)).add(21.7))
      .abs()
      .smoothstep(0.0, 0.055)
      .oneMinus();
  const crackMask = crackAt(xz).toVar();

  // Analytic surface height → normal map, sampled at the texel and two
  // neighbours for the finite-difference gradient. Pebble + crack only: the
  // old grain (0.35 m) and grit (0.15 m) octaves sit at/under the 0.35 m tap
  // spacing, so their contribution to the normal was aliasing noise costing 6
  // mx_noise evaluations per fragment; speck/micro below keep the fine grain
  // in the albedo/roughness instead.
  const heightAt = (p: any, crack: any) => {
    const d = p.mul(uRoadDetailScale);
    const pebble = mx_noise_float(d.mul(2.2))
      .mul(0.5)
      .add(mx_noise_float(d.mul(7.4).add(9.1)).mul(0.22));
    return pebble.sub(crack.mul(0.38));
  };

  const subsurfaceLayerAt = (p: any, scale: any, seed: number) => {
    const q = p.mul(scale).add(seed);
    const cell = q.floor();
    const f = q.fract().sub(0.5).abs();
    const cellSeed = hash(cell.x.mul(17.13).add(cell.y.mul(41.71)).add(seed));

    // Cell borders plus higher-frequency scratches/stipple keep the road detail
    // closer to the Matrix reference and avoid broad, low-scale patches.
    const wall = f.x.max(f.y).smoothstep(0.4, 0.495);
    const cross = f.x.min(f.y).smoothstep(0.0, 0.032).oneMinus().mul(0.22);
    const knot = f.length().smoothstep(0.035, 0.11).oneMinus().mul(0.18);
    const scratch = mx_noise_float(p.mul(scale.mul(2.35)).add(cellSeed.mul(18)))
      .abs()
      .smoothstep(0.0, 0.075)
      .oneMinus()
      .mul(0.24);
    const stipple = mx_noise_float(p.mul(scale.mul(6.5)).add(cellSeed.mul(31)))
      .mul(0.5)
      .add(0.5)
      .smoothstep(0.58, 0.94)
      .mul(0.22);

    return wall
      .mul(0.48)
      .add(cross)
      .add(knot)
      .add(scratch)
      .add(stipple)
      .mul(cellSeed.mul(0.5).add(0.75))
      .clamp(0, 1);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const EPS = 0.35;
  const shockVisualScale = float(1.0);
  const shockHeight = groundShockHeight(xz).mul(shockVisualScale).toVar();
  // Shock gradient at FULL strength, separate from the micro-relief: the
  // crest's slopes must catch the light hard or the moving geometry reads
  // flat from the game's high camera. Differenced from the fracture-free
  // silhouette — the lit slope is the ring shape, and the smooth variant
  // drops 6 mx_noise evaluations per fragment versus the displaced field.
  const shockSmooth = groundShockHeightSmooth(xz).mul(shockVisualScale).toVar();
  const sgx = groundShockHeightSmooth(xz.add(vec2(EPS, 0)))
    .mul(shockVisualScale)
    .sub(shockSmooth)
    .div(EPS);
  const sgz = groundShockHeightSmooth(xz.add(vec2(0, EPS)))
    .mul(shockVisualScale)
    .sub(shockSmooth)
    .div(EPS);
  const h0 = heightAt(xz, crackMask).toVar();
  const gx = heightAt(xz.add(vec2(EPS, 0)), crackAt(xz.add(vec2(EPS, 0)))).sub(h0).div(EPS);
  const gz = heightAt(xz.add(vec2(0, EPS)), crackAt(xz.add(vec2(0, EPS)))).sub(h0).div(EPS);

  // Real road displacement: the mesh is subdivided below so this crest, crater,
  // and wake move vertices instead of only painting a screen-space ripple.
  floorMaterial.positionNode = positionLocal.add(vec3(0, 0, shockHeight));

  // World-space surface normal (micro relief eased a touch under heavier wet,
  // shock slopes at full strength), then into view space for the lighting;
  // also drives the subsurface refraction.
  const bump = mix(float(0.5), float(0.32), wetSheen);
  const nWorld = vec3(
    gx.mul(bump).add(sgx).negate(),
    1,
    gz.mul(bump).add(sgz).negate(),
  )
    .normalize()
    .toVar();
  floorMaterial.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();

  // --- Subsurface: refract the view ray into the slab and walk it to two
  // depth planes. The main plane sits at uSubDepth metres; the secondary plane
  // adds a deeper, blurrier echo so the buried material has thickness.
  // Shock slopes bend the refraction too, so the buried layer visibly warps
  // under the passing crest — parallax, not paint.
  const nRefr = vec3(gx.mul(-0.8).sub(sgx), 1, gz.mul(-0.8).sub(sgz)).normalize();
  const refr = refract(view, nRefr, float(1 / 1.33));
  const sink = refr.y.negate().max(0.1);
  const flow = vec2(uFloorTime.mul(0.02), uFloorTime.mul(0.013));
  const p1 = xz.add(refr.xz.mul(uSubDepth.div(sink)));
  const p2 = xz.add(refr.xz.mul(uSubDepth.add(0.85).div(sink)));
  const rayDepth = uSubDepth.div(sink);

  const cellular = subsurfaceLayerAt(p1.add(flow.mul(1.8)), uRoadDetailScale.mul(0.56), 11.7);
  const deepCells = subsurfaceLayerAt(p2.sub(flow), uRoadDetailScale.mul(0.28), 43.1).mul(0.5);
  const blur = mx_noise_float(
    vec3(p1.mul(uRoadDetailScale.mul(0.07)).add(flow.mul(0.3)), uFloorTime.mul(0.025)),
  )
    .mul(0.5)
    .add(0.5);
  const scatter = rayDepth.smoothstep(1.0, 5.0);
  const crispLayer = cellular.add(deepCells).clamp(0, 1);
  const scatteredLayer = blur.mul(0.16).add(deepCells.mul(0.42));
  const layerMask = mix(crispLayer, scatteredLayer, scatter.mul(0.35))
    .clamp(0, 1)
    .pow(1.45);

  // Visibility of the depth layer: broad translucent skin plus extra crack
  // exposure, stronger when viewed from above and absorbed at very long paths.
  const facing = view.y.negate().clamp(0, 1).pow(0.6);
  const skinWindow = wetSheen.mul(0.45).add(facing.mul(0.36)).add(uFloorDepth.mul(0.22)).clamp(0, 1);
  const crackWindow = crackMask.mul(0.5).add(0.5);
  const absorption = rayDepth.smoothstep(4.5, 12.0).oneMinus().mul(0.75).add(0.25);
  const openness = uSubVisibility.mul(skinWindow).mul(crackWindow).mul(absorption).clamp(0, 1);
  const horizon = radial.oneMinus().mul(0.85).add(0.15);
  const layerAlpha = openness.mul(layerMask.mul(0.95).add(0.05)).mul(horizon).clamp(0, 1);
  const deepGlow = mix(uGlowShallow, uGlowDeep, radial.mul(0.45).add(scatter.mul(0.35)))
    .mul(layerMask)
    .add(uGlowDeep.mul(deepCells));

  // Albedo: dark glossy skin with aggregate speckle; the bright buried pattern
  // contributes mostly through emissive so it feels under the surface.
  const dry = mix(uFloorCenter, uFloorEdge, radial.pow(1.2));
  const speck = mx_noise_float(xz.mul(uRoadDetailScale.mul(9.0))).mul(0.5).add(0.5);
  const micro = mx_noise_float(xz.mul(uRoadDetailScale.mul(34.0)).add(73.4)).mul(0.5).add(0.5);
  const microGlint = micro.smoothstep(0.62, 0.96).mul(wetSheen).mul(horizon);
  const dryAlbedo = dry
    .mul(float(0.58).add(speck.mul(0.34)).add(micro.mul(0.12)))
    .add(h0.mul(0.012));
  const glassSkin = mix(
    dryAlbedo.mul(0.62),
    uAbyss,
    wetSheen.mul(0.22).add(crackMask.mul(0.18)).clamp(0, 0.55),
  );
  // No shock tint here: the ripple is pure displaced geometry — the crest
  // reads through lighting and the bent normals alone, never a color change.
  floorMaterial.colorNode = glassSkin
    .add(deepGlow.mul(layerAlpha).mul(0.04))
    .add(uGlowShallow.mul(microGlint.mul(0.035)));

  // Roughness: a rain-slick sheen across the whole street (dialed by wetness),
  // with speckle roughening the grains so the sun highlight breaks up; the
  // crack channels hold a little more water and read glossier.
  floorMaterial.roughnessNode = mix(float(0.82), float(0.3), wetSheen)
    .sub(layerAlpha.mul(0.1))
    .add(speck.mul(0.06))
    .add(micro.mul(0.04))
    .clamp(0.08, 0.95);

  // The buried cellular layer is emissive so it glows from within, gated by the
  // refracted visibility mask and faded to the horizon.
  floorMaterial.emissiveNode = deepGlow
    .mul(uGlowStrength)
    .mul(layerAlpha)
    .mul(0.72)
    .add(uGlowShallow.mul(microGlint.mul(0.12)));

  // Inner floor: dense grid (one vertex per metre) so the shock crest moves
  // real geometry instead of dying between vertices.
  const floorWidth = corridor ? corridor.halfWidth * 2 : FLOOR_DETAIL_HALF * 2;
  const floorDepth = corridor ? corridor.nearZ - corridor.farZ : FLOOR_DETAIL_HALF * 2;
  const floorCenterZ = corridor ? (corridor.nearZ + corridor.farZ) / 2 : 0;
  const segX = corridor
    ? Math.min(FLOOR_DETAIL_SEGMENTS, Math.max(16, Math.round(floorWidth)))
    : FLOOR_DETAIL_SEGMENTS;
  const segZ = corridor
    ? Math.min(FLOOR_DETAIL_SEGMENTS, Math.max(16, Math.round(floorDepth)))
    : FLOOR_DETAIL_SEGMENTS;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorWidth, floorDepth, segX, segZ),
    floorMaterial,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = floorCenterZ;
  floor.receiveShadow = true;
  ctx.scene.add(floor);
  objects.push(floor);

  if (!corridor) {
    // Outer apron: same material, giant square with a hole matching the inner
    // plane. Shocks never reach it, so it needs no tessellation at all.
    const apronShape = new THREE.Shape([
      new THREE.Vector2(-FLOOR_HALF, -FLOOR_HALF),
      new THREE.Vector2(FLOOR_HALF, -FLOOR_HALF),
      new THREE.Vector2(FLOOR_HALF, FLOOR_HALF),
      new THREE.Vector2(-FLOOR_HALF, FLOOR_HALF),
    ]);
    apronShape.holes.push(
      new THREE.Path([
        new THREE.Vector2(-FLOOR_DETAIL_HALF, -FLOOR_DETAIL_HALF),
        new THREE.Vector2(-FLOOR_DETAIL_HALF, FLOOR_DETAIL_HALF),
        new THREE.Vector2(FLOOR_DETAIL_HALF, FLOOR_DETAIL_HALF),
        new THREE.Vector2(FLOOR_DETAIL_HALF, -FLOOR_DETAIL_HALF),
      ]),
    );
    const apron = new THREE.Mesh(new THREE.ShapeGeometry(apronShape), floorMaterial);
    apron.rotation.x = -Math.PI / 2;
    apron.receiveShadow = true;
    ctx.scene.add(apron);
    objects.push(apron);
  }

  const gridSpan = corridor ? Math.max(floorWidth, floorDepth) : ARENA_HALF * 2;
  const gridDivisions = corridor ? Math.round(gridSpan) : ARENA_HALF;
  const grid = new THREE.GridHelper(gridSpan, gridDivisions, 0x808080, 0x8f8f8f);
  if (corridor) grid.position.z = floorCenterZ;
  (grid.material as THREE.Material).transparent = true;
  // Faint — the subsurface floor carries the visual now; the grid is just a
  // movement/scale cue.
  (grid.material as THREE.Material).opacity = 0.12;
  ctx.scene.add(grid);
  objects.push(grid);

  // Physics ground slab — full arena or corridor footprint.
  if (corridor) {
    bodies.push(
      ctx.physics.createBox({
        x: 0,
        y: -2,
        z: floorCenterZ,
        hx: corridor.halfWidth,
        hy: 2,
        hz: floorDepth / 2,
        kind: "static",
        category: Category.Ground,
      }),
    );
  } else {
    bodies.push(ctx.physics.createGround(FLOOR_HALF));
  }

  // No invisible perimeter walls: anything that leaves the physical slab,
  // including the player, falls into the void and is handled by gameplay.

  return { objects, bodies };
}

/** Removes scenario-owned meshes and bodies. */
export function disposeArenaEnvironment(
  ctx: ScenarioContext,
  built: { objects: THREE.Object3D[]; bodies: Body[] },
): void {
  for (const obj of built.objects) {
    ctx.scene.remove(obj);
    // The dense inner floor is ~200k vertices per build — release it.
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  }
  for (const body of built.bodies) ctx.physics.removeBody(body);
  built.objects.length = 0;
  built.bodies.length = 0;
}

const ENEMY_COUNT = 6;
const SPAWN_RADIUS = 12;

/**
 * The reference-video arena: 6 persistent enemies encircling the player. A
 * finishing hit knocks an agent down, but the same body gets back up and keeps
 * the pressure on.
 */
export class ArenaScenario implements Scenario {
  readonly id = "arena";
  readonly label = "Arena";
  readonly playerSpawn = new THREE.Vector2(0, 0);

  private ctx!: ScenarioContext;
  private env!: { objects: THREE.Object3D[]; bodies: Body[] };
  private props!: PropField;
  private readonly liveEnemies: Enemy[] = [];

  get enemies(): readonly Enemy[] {
    return this.liveEnemies;
  }

  setup(ctx: ScenarioContext): void {
    this.ctx = ctx;
    this.env = buildArenaEnvironment(ctx);
    this.props = new PropField(ctx.physics, ctx.scene, ctx.bus);
    this.props.addArenaDressing();
    for (let i = 0; i < ENEMY_COUNT; i++) this.spawnAtRing(i, ENEMY_COUNT);
  }

  update(_scaledDt: number): void {
    this.props.update();
  }

  dispose(): void {
    for (const enemy of this.liveEnemies) {
      this.ctx.scene.remove(enemy.group);
      enemy.dispose();
      this.ctx.physics.removeBody(enemy.body);
    }
    this.liveEnemies.length = 0;
    this.props.dispose();
    disposeArenaEnvironment(this.ctx, this.env);
  }

  private spawnAtRing(index: number, total: number): void {
    const angle = (index / total) * Math.PI * 2 + Math.random() * 0.4;
    const r = SPAWN_RADIUS + Math.random() * 3;
    const spawn = new THREE.Vector2(Math.cos(angle) * r, Math.sin(angle) * r);
    const enemy = new Enemy(this.ctx.physics, spawn, { scene: this.ctx.scene });
    this.ctx.scene.add(enemy.group);
    this.liveEnemies.push(enemy);
  }
}
