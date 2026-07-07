import * as THREE from "three/webgpu";
import { attribute, color, float } from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * Stylized slash arcs trailing the sword through a swing. Each frame we sample
 * the tip (and a point near the hilt) in world space and push the pair onto a
 * fixed-length ring of key samples, then resample those keys into a denser
 * Catmull-Rom strip for rendering. The ribbon itself is invisible; a TSL mask
 * carves it into layered crescent arcs — a broad cyan glow, a white-hot tip
 * edge, plus shorter inner slash bands — with both arc tips tapered to points.
 *
 * The strip is a single BufferGeometry with pre-allocated attributes updated in
 * place — no per-frame allocation. The mesh stays `visible = true` from init
 * (an empty trail just draws zero indices via setDrawRange) so its pipeline
 * compiles on the first frame, not with a hitch on the first swing. When
 * disabled the draw range is zeroed and the samples cleared, so re-enabling
 * starts fresh with no ghost.
 */

const MAX_KEY_SAMPLES = 22;
const RENDER_SUBDIVISIONS = 7;
const MAX_RENDER_SAMPLES = (MAX_KEY_SAMPLES - 1) * RENDER_SUBDIVISIONS + 1;
// Key samples closer than this (world units) refresh sample 0 in place instead
// of pushing a new pair. Slow frames at swing start/end otherwise pile up
// near-duplicate keys, and Catmull-Rom through a cluster kinks — the scrunch.
const MIN_SAMPLE_DIST_SQ = 0.06 * 0.06;
// Blade endpoints in the sword mesh's own local space. The blade is a
// BoxGeometry of depth 1.4 along local +Z, so it spans z ∈ [-0.7, 0.7].
// The trail extends a little past the metal to read as a supernatural slash.
const TRAIL_TIP_LOCAL = new THREE.Vector3(0, 0, 0.92);
const TRAIL_HILT_LOCAL = new THREE.Vector3(0, 0, -0.58);
// Peak arc opacity. Ends taper to zero via sin(pi * age).
const MAX_ALPHA = 1.0;
// Radial ridge centers across the ribbon (0 = hilt edge, 1 = tip edge). Each
// arc rises to its center then feathers back to zero on both shoulders, so the
// bands melt out instead of sitting flat and hard-cutting at the tip edge.
const OUTER_ARC = { halo: 0.66, edge: 0.82, core: 0.9 };
const INNER_ARC = { center: 0.5, ageFrom: 0.12, ageTo: 0.68, gain: 0.78 };
const SPARK_ARC = { center: 0.25, ageFrom: 0.2, ageTo: 0.52, gain: 0.42 };

export class WeaponTrailEffect extends BaseEffect {
  readonly id = "weapon-trail";
  readonly label = "Weapon Trail";
  readonly description = "Additive ribbon trail follows the sword tip, fading out.";
  readonly group: EffectGroup = "Attack";

  private mesh!: THREE.Mesh;
  private geometry!: THREE.BufferGeometry;
  private positions!: Float32Array;
  private alphas!: Float32Array;
  private ages!: Float32Array;

  // Ring buffer of (tip, hilt) world-space sample pairs.
  private readonly tips: THREE.Vector3[] = [];
  private readonly hilts: THREE.Vector3[] = [];
  private count = 0;
  /** True once the buffers are collapsed to the degenerate warm-up quad. */
  private idle = false;

  private readonly tmpTip = new THREE.Vector3();
  private readonly tmpHilt = new THREE.Vector3();

  init(ctx: EffectContext): void {
    super.init(ctx);
    for (let i = 0; i < MAX_KEY_SAMPLES; i++) {
      this.tips.push(new THREE.Vector3());
      this.hilts.push(new THREE.Vector3());
    }

    this.geometry = new THREE.BufferGeometry();
    // Two verts per rendered sample; (MAX_RENDER_SAMPLES - 1) quads.
    this.positions = new Float32Array(MAX_RENDER_SAMPLES * 2 * 3);
    this.alphas = new Float32Array(MAX_RENDER_SAMPLES * 2);
    this.ages = new Float32Array(MAX_RENDER_SAMPLES * 2);
    // Fixed 0/1 coordinate across the ribbon: even verts hug the hilt edge,
    // odd verts the tip edge. The arc mask is carved along this axis.
    const across = new Float32Array(MAX_RENDER_SAMPLES * 2);
    for (let i = 0; i < MAX_RENDER_SAMPLES; i++) across[i * 2 + 1] = 1;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("alpha", new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute("age", new THREE.BufferAttribute(this.ages, 1));
    this.geometry.setAttribute("across", new THREE.BufferAttribute(across, 1));
    const indices: number[] = [];
    for (let i = 0; i < MAX_RENDER_SAMPLES - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setIndex(indices);

    const material = new THREE.MeshBasicNodeMaterial();
    // Carve the ribbon into the two slash arcs. `across` runs hilt->tip,
    // `age` runs newest->oldest sample, `alpha` carries the tapered fade.
    // float(0).add(...) lifts the raw AttributeNodes into chainable shader
    // nodes — @types/three 0.185 types attribute() too loosely to chain on.
    const across01 = float(0).add(attribute("across", "float"));
    const age = float(0).add(attribute("age", "float"));
    const fade = float(0).add(attribute("alpha", "float"));
    // Smooth ridge across the ribbon: rises to `center`, then falls past it, so
    // each band peaks and feathers to zero on BOTH shoulders — no flat plateau,
    // and nothing hard-cuts at the tip edge (across01 = 1). Wider rise/fall =
    // softer, glowier band; tight = a sharp bright line.
    const ridge = (center: number, rise: number, fall: number) =>
      across01
        .smoothstep(center - rise, center)
        .mul(across01.smoothstep(center + fall, center));
    // Broad cyan halo: wide, soft, dissolves well before the tip edge.
    const outerHalo = ridge(OUTER_ARC.halo, 0.32, 0.34).mul(0.6);
    // White-hot edge line: a thin bright ridge on the outer third.
    const outerEdge = ridge(OUTER_ARC.edge, 0.13, 0.12);
    // White-hot core near the tip, feathered back so the tip melts out.
    const outerCore = ridge(OUTER_ARC.core, 0.1, 0.11).mul(1.1);
    const inner = ridge(INNER_ARC.center, 0.11, 0.11)
      // The inner arc is angularly shorter: only the middle of the swing.
      .mul(age.smoothstep(INNER_ARC.ageFrom, INNER_ARC.ageFrom + 0.1))
      .mul(age.smoothstep(INNER_ARC.ageTo, INNER_ARC.ageTo + 0.1).oneMinus())
      .mul(INNER_ARC.gain);
    const spark = ridge(SPARK_ARC.center, 0.08, 0.08)
      .mul(age.smoothstep(SPARK_ARC.ageFrom, SPARK_ARC.ageFrom + 0.08))
      .mul(age.smoothstep(SPARK_ARC.ageTo, SPARK_ARC.ageTo + 0.08).oneMinus())
      .mul(SPARK_ARC.gain);
    const rim = outerHalo.add(outerEdge.mul(0.7)).min(1);
    const core = outerCore.add(inner.mul(0.8)).min(1);
    material.colorNode = color(0x66d8ff)
      .mul(rim)
      .add(color(0xffffff).mul(core))
      .add(color(0xffd88a).mul(inner.add(spark).mul(0.5)));
    material.opacityNode = fade.mul(outerHalo.add(outerEdge).add(inner).add(spark).min(1));
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.side = THREE.DoubleSide;

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.collapse();
    this.ctx.scene.add(this.mesh);
  }

  update(_unscaledDt: number): void {
    if (!this.enabled) return;
    const combat = this.ctx.getPlayer().combat;
    // Spins trail too — the full-circle ribbon is half the spectacle.
    const active = (combat?.swinging || combat?.spinning) ?? false;

    if (active) this.pushSample();
    else if (this.count > 0) this.shrink();

    this.rebuild();
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  /** Sample the sword tip + hilt in world space and prepend to the ring. */
  private pushSample(): void {
    const sword = this.ctx.getPlayer().swordMesh;
    sword.updateWorldMatrix(true, false);
    this.tmpTip.copy(TRAIL_TIP_LOCAL).applyMatrix4(sword.matrixWorld);
    this.tmpHilt.copy(TRAIL_HILT_LOCAL).applyMatrix4(sword.matrixWorld);

    // Barely moved since the last key: refresh sample 0 in place rather than
    // pushing a near-duplicate. Clustered keys make the spline kink.
    if (this.count > 1 && this.tmpTip.distanceToSquared(this.tips[0]) < MIN_SAMPLE_DIST_SQ) {
      this.tips[0].copy(this.tmpTip);
      this.hilts[0].copy(this.tmpHilt);
      return;
    }

    // Shift the ring down by one and write the newest pair at index 0.
    const n = Math.min(this.count + 1, MAX_KEY_SAMPLES);
    for (let i = n - 1; i > 0; i--) {
      this.tips[i].copy(this.tips[i - 1]);
      this.hilts[i].copy(this.hilts[i - 1]);
    }
    this.tips[0].copy(this.tmpTip);
    this.hilts[0].copy(this.tmpHilt);
    this.count = n;
  }

  /** Post-swing: drop the oldest sample each frame so the trail dissolves. */
  private shrink(): void {
    this.count = Math.max(0, this.count - 1);
  }

  /** Write the current ring into the buffer geometry, fading with age. */
  private rebuild(): void {
    if (this.count < 2) {
      this.collapse();
      return;
    }
    this.idle = false;
    const renderCount = (this.count - 1) * RENDER_SUBDIVISIONS + 1;
    for (let i = 0; i < renderCount; i++) {
      const p = i * 6;
      const sample = (i / (renderCount - 1)) * (this.count - 1);
      const base = Math.min(Math.floor(sample), this.count - 2);
      const t = sample - base;
      const i0 = Math.max(0, base - 1);
      const i1 = base;
      const i2 = base + 1;
      const i3 = Math.min(this.count - 1, base + 2);
      const h0 = this.hilts[i0];
      const h1 = this.hilts[i1];
      const h2 = this.hilts[i2];
      const h3 = this.hilts[i3];
      const tip0 = this.tips[i0];
      const tip1 = this.tips[i1];
      const tip2 = this.tips[i2];
      const tip3 = this.tips[i3];
      const hx = catmullRom(h0.x, h1.x, h2.x, h3.x, t);
      const hy = catmullRom(h0.y, h1.y, h2.y, h3.y, t);
      const hz = catmullRom(h0.z, h1.z, h2.z, h3.z, t);
      const tx = catmullRom(tip0.x, tip1.x, tip2.x, tip3.x, t);
      const ty = catmullRom(tip0.y, tip1.y, tip2.y, tip3.y, t);
      const tz = catmullRom(tip0.z, tip1.z, tip2.z, tip3.z, t);
      // Crescent taper: the ribbon's real width follows a sine bump over age,
      // so both ends geometrically pinch to points at the tip-edge path — no
      // rectangle read. The tip edge also bulges slightly outward mid-arc,
      // giving the classic crescent-slash silhouette.
      const age = i / (renderCount - 1);
      const arc = Math.sin(Math.PI * age);
      const width = Math.pow(arc, 0.7);
      const bulge = 0.14 * arc * arc;
      const dx = tx - hx;
      const dy = ty - hy;
      const dz = tz - hz;
      this.positions[p] = tx - dx * width;
      this.positions[p + 1] = ty - dy * width;
      this.positions[p + 2] = tz - dz * width;
      this.positions[p + 3] = tx + dx * bulge;
      this.positions[p + 4] = ty + dy * bulge;
      this.positions[p + 5] = tz + dz * bulge;
      // Opacity follows the same bump so the pinched ends also melt out.
      const a = arc * MAX_ALPHA;
      this.alphas[i * 2] = a;
      this.alphas[i * 2 + 1] = a;
      this.ages[i * 2] = age;
      this.ages[i * 2 + 1] = age;
    }
    this.geometry.setDrawRange(0, (renderCount - 1) * 6);
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("alpha") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("age") as THREE.BufferAttribute).needsUpdate = true;
    // No computeBoundingSphere: the mesh is never frustum-culled, so paying a
    // full CPU pass over the strip every frame bought nothing.
  }

  /**
   * Idle state: draw one quad of all-zero positions with zero alpha. Zero area
   * means zero fragments, but the mesh is still submitted every frame, so its
   * pipeline compiles at boot and stays warm — no hitch on the first swing
   * (toggling visibility or drawing nothing would skip the compile).
   */
  private collapse(): void {
    if (this.idle) return;
    this.idle = true;
    this.positions.fill(0, 0, 12);
    this.alphas.fill(0, 0, 4);
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("alpha") as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, 6);
  }

  private clear(): void {
    this.count = 0;
    if (this.mesh) this.collapse();
  }
}

function catmullRom(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * b +
      (c - a) * t +
      (2 * a - 5 * b + 4 * c - d) * t2 +
      (-a + 3 * b - 3 * c + d) * t3)
  );
}
