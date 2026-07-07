import * as THREE from "three/webgpu";
import { attribute, color, float, uniform } from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * Anime-style crescent shockwave arcs bursting out of each impact point,
 * alongside the spark burst. A small pool of crescent meshes (a shared lune
 * geometry — an arc strip whose width swells in the middle and tapers to
 * points at both tips) is revived per hit: each arc gets a random orientation,
 * expands outward with an ease-out curve, and fades additively. Kills spawn
 * more and bigger arcs than plain hits.
 *
 * All meshes share one geometry; each has its own material so opacity can be
 * driven per-arc via a TSL uniform. Disabling zeroes every arc immediately.
 *
 * Pool meshes stay `visible = true` forever: idle arcs are collapsed to scale 0
 * with opacity 0 (zero fragments, negligible vertex cost). This keeps their
 * pipelines warm from the first frame instead of compiling on the first hit,
 * and avoids per-hit visibility churn.
 */

const POOL = 10;
// Arc shape: angular span, peak crescent width (fraction of radius), strip segments.
const THETA = 2.6;
const WIDTH = 0.32;
const SEG = 28;
// Per-spawn counts and base scales.
const HIT_ARCS = 2;
const KILL_ARCS = 4;
const HIT_SCALE = 1.0;
const KILL_SCALE = 1.8;
const LIFE = 0.38;
const MAX_ALPHA = 0.85;

// Inferred float-uniform node type (uniform()'s generic can't be named directly
// with @types/three 0.185).
const floatUniform = (v: number) => uniform(v);
type FloatUniform = ReturnType<typeof floatUniform>;

interface Arc {
  mesh: THREE.Mesh;
  opacity: FloatUniform;
  life: number;
  baseScale: number;
}

export class ImpactArcsEffect extends BaseEffect {
  readonly id = "impact-arcs";
  readonly label = "Impact Arcs";
  readonly description = "Crescent shockwave arcs burst outward from each hit.";
  readonly group: EffectGroup = "Reaction";

  private readonly arcs: Arc[] = [];
  private cursor = 0;
  /** Spawn calls this frame; past 2 the 10-slot pool just thrashes. */
  private spawnsThisFrame = 0;
  private readonly tmpQuat = new THREE.Quaternion();

  init(ctx: EffectContext): void {
    super.init(ctx);
    const geometry = buildCrescentGeometry();

    for (let i = 0; i < POOL; i++) {
      const opacity = floatUniform(0);
      const material = new THREE.MeshBasicNodeMaterial();
      material.colorNode = color(0xfff3dd);
      // Vertex alpha tapers the tips; the uniform drives the lifetime fade.
      material.opacityNode = float(0).add(attribute("alpha", "float")).mul(opacity);
      material.transparent = true;
      material.depthWrite = false;
      material.blending = THREE.AdditiveBlending;
      material.side = THREE.DoubleSide;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.setScalar(0);
      mesh.frustumCulled = false;
      ctx.scene.add(mesh);
      this.arcs.push({ mesh, opacity, life: 0, baseScale: 1 });
    }

    ctx.bus.on("attack-hit", ({ point, killed }) => {
      if (!this.enabled) return;
      this.spawn(point, killed ? KILL_ARCS : HIT_ARCS, killed ? KILL_SCALE : HIT_SCALE);
    });
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return;
    this.spawnsThisFrame = 0;
    for (const arc of this.arcs) {
      if (arc.life <= 0) continue;
      arc.life -= unscaledDt;
      if (arc.life <= 0) {
        arc.mesh.scale.setScalar(0);
        arc.opacity.value = 0;
        continue;
      }
      const k = arc.life / LIFE; // 1 -> 0 over the arc's life
      // Ease-out expansion: fast at birth, settling as it fades.
      const p = 1 - k;
      const grow = 1 - (1 - p) * (1 - p);
      arc.mesh.scale.setScalar(arc.baseScale * (0.35 + grow * 1.5));
      arc.opacity.value = Math.pow(k, 1.3) * MAX_ALPHA;
    }
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  private spawn(point: THREE.Vector3, count: number, baseScale: number): void {
    if (this.spawnsThisFrame >= 2) return;
    this.spawnsThisFrame++;
    for (let i = 0; i < count; i++) {
      const arc = this.arcs[this.cursor];
      this.cursor = (this.cursor + 1) % POOL;
      arc.mesh.position.set(point.x, Math.max(point.y, 0.6), point.z);
      arc.mesh.quaternion.copy(randomQuaternion(this.tmpQuat));
      arc.baseScale = baseScale * (0.8 + Math.random() * 0.5);
      arc.life = LIFE * (0.8 + Math.random() * 0.4);
      // Scale + opacity are written by update() this same frame, before render.
    }
  }

  private clear(): void {
    for (const arc of this.arcs) {
      arc.life = 0;
      arc.opacity.value = 0;
      if (arc.mesh) arc.mesh.scale.setScalar(0);
    }
  }
}

/** Uniformly random orientation (Shoemake's method, same as Quaternion.random). */
function randomQuaternion(out: THREE.Quaternion): THREE.Quaternion {
  const u1 = Math.random();
  const u2 = Math.random() * Math.PI * 2;
  const u3 = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u1);
  const t = Math.sqrt(u1);
  return out.set(s * Math.sin(u2), s * Math.cos(u2), t * Math.sin(u3), t * Math.cos(u3));
}

/**
 * Lune-shaped arc strip in the XY plane around the origin, radius 1. The outer
 * edge is a circular arc; the inner edge bulges toward the center mid-arc, so
 * both tips converge to points. A per-vertex alpha softens the tips further.
 */
function buildCrescentGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array((SEG + 1) * 2 * 3);
  const alphas = new Float32Array((SEG + 1) * 2);
  const indices: number[] = [];

  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const ang = (t - 0.5) * THETA;
    const bulge = WIDTH * Math.pow(Math.sin(Math.PI * t), 0.8);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const p = i * 6;
    // Inner vertex (bulged toward center), then outer vertex on the arc.
    positions[p] = cos * (1 - bulge);
    positions[p + 1] = sin * (1 - bulge);
    positions[p + 2] = 0;
    positions[p + 3] = cos;
    positions[p + 4] = sin;
    positions[p + 5] = 0;
    const a = Math.pow(Math.sin(Math.PI * t), 0.5);
    alphas[i * 2] = a;
    alphas[i * 2 + 1] = a;
    if (i < SEG) {
      const v = i * 2;
      indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));
  geometry.setIndex(indices);
  return geometry;
}
