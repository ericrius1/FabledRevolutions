import * as THREE from "three/webgpu";
import { Category, type Body, type Physics } from "../core/physics";
import { standardNodeMaterial } from "../core/materials";
import type { EventBus } from "../core/events";

/**
 * Shared physics-prop scatter: free dynamic crate bodies whose meshes mirror
 * the full box3d transform each frame. Every scenario sprinkles these around
 * so launched enemies (and the mega blast) have furniture to plow through.
 * Geometry is shared per size-class; materials are shared per palette color.
 */

interface Prop {
  mesh: THREE.Mesh;
  body: Body;
  /** Half-extent (box radius) — folded into the reach test for hit detection. */
  half: number;
}

// ---- Sword-hit response (mirrors Combat's sector geometry) ----
/** Crate reach for a normal swing; matches Combat.ATTACK_RANGE. */
const SWING_RANGE = 2.8;
/** Half-angle of the swing sector, radians (~130° total arc). */
const SWING_HALF_ANGLE = (Math.PI / 180) * 65;
/** Impulse a swing shoves a crate with, scaled by hit `power`. */
const SWING_IMPULSE = 6;
/** Upward kick so struck crates hop rather than only slide. */
const SWING_LIFT = 2;
/** Radial impulse a release spin gives each crate in range. */
const SPIN_IMPULSE = 5;

const CRATE_COLORS = [0xb98a4e, 0xa87b42, 0x8f6a3c, 0xc49a5f];
/** [half-extent, density] size classes — a few small light ones mixed in. */
const SIZE_CLASSES: Array<[number, number]> = [
  [0.55, 0.4],
  [0.42, 0.3],
  [0.34, 0.25],
];

export class PropField {
  private readonly props: Prop[] = [];
  private readonly geometries: THREE.BoxGeometry[];
  private readonly materials: THREE.MeshStandardNodeMaterial[];
  private readonly pos = { x: 0, y: 0, z: 0 };
  private readonly quat = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
    bus?: EventBus,
  ) {
    this.geometries = SIZE_CLASSES.map(([h]) => new THREE.BoxGeometry(h * 2, h * 2, h * 2));
    this.materials = CRATE_COLORS.map((c) => standardNodeMaterial(c, 0.85));

    // Sword swings/spins only test enemies in Combat; crates react here so a
    // hit shoves nearby boxes with the same sector geometry the swing uses.
    if (bus) {
      bus.on("attack-swing-contact", ({ origin, facing }) =>
        this.hitSector(origin, facing, SWING_RANGE, SWING_HALF_ANGLE, SWING_IMPULSE, 1, SWING_LIFT),
      );
      bus.on("spin-attack", ({ origin, power, range }) =>
        this.hitSector(origin, null, range, Math.PI, SPIN_IMPULSE, power, SWING_LIFT),
      );
    }
  }

  /**
   * Push every crate inside a range/sector away from `origin`. `facing` null =
   * full circle (spins); otherwise only crates within `halfAngle` of facing are
   * struck (swings). Impulse scales with `power` and the crate's own mass stays
   * in box3d's hands, so light crates fly and heavy ones barely budge.
   */
  private hitSector(
    origin: THREE.Vector3,
    facing: THREE.Vector3 | null,
    range: number,
    halfAngle: number,
    impulse: number,
    power: number,
    lift: number,
  ): void {
    const s = impulse * (0.5 + 0.5 * power);
    for (const prop of this.props) {
      prop.body.getPosition(this.pos);
      const dx = this.pos.x - origin.x;
      const dz = this.pos.z - origin.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range + prop.half || dist < 0.0001) continue;
      const nx = dx / dist;
      const nz = dz / dist;
      if (halfAngle < Math.PI && facing) {
        const dot = THREE.MathUtils.clamp(nx * facing.x + nz * facing.z, -1, 1);
        if (Math.acos(dot) > halfAngle) continue;
      }
      prop.body.applyLinearImpulseToCenter(nx * s, lift, nz * s);
    }
  }

  /** Column stack of crates (cols wide × high tall), with a little jitter. */
  addStack(cx: number, cz: number, cols: number, high: number, sizeClass = 0): void {
    const [half] = SIZE_CLASSES[sizeClass];
    const size = half * 2;
    const span = (cols - 1) * size;
    for (let row = 0; row < high; row++) {
      for (let c = 0; c < cols; c++) {
        // Tiny jitter so stacks aren't perfectly aligned (reads more physical).
        const x = cx - span / 2 + c * size + (Math.random() - 0.5) * 0.04;
        const z = cz + (Math.random() - 0.5) * 0.04;
        this.spawn(x, half + row * size, z, sizeClass);
      }
    }
  }

  /** Loose ring of mixed-size crates scattered around (cx, cz). */
  addScatter(cx: number, cz: number, count: number, radius: number): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = radius * (0.3 + Math.random() * 0.7);
      const sizeClass = Math.floor(Math.random() * SIZE_CLASSES.length);
      const [half] = SIZE_CLASSES[sizeClass];
      this.spawn(cx + Math.cos(ang) * r, half, cz + Math.sin(ang) * r, sizeClass);
    }
  }

  /**
   * Default dressing shared by the combat scenarios: a few stacks near the
   * corners plus loose scatter, all outside the immediate spawn circle so the
   * opening seconds stay readable. Spread for the doubled arena, with a few
   * far-field clusters so the space doesn't read empty.
   */
  addArenaDressing(): void {
    this.addStack(-11, -9, 2, 3);
    this.addStack(11, -11, 3, 2);
    this.addStack(12, 10, 2, 3);
    this.addStack(-12, 11, 2, 2);
    this.addScatter(0, -15, 4, 3.5);
    this.addScatter(15, 0, 3, 3);
    this.addScatter(-15, 2, 3, 3);
    this.addScatter(2, 15, 4, 3.5);
    this.addStack(-24, -20, 2, 2);
    this.addStack(25, 22, 2, 2);
    this.addScatter(26, -22, 4, 4);
    this.addScatter(-26, 20, 4, 4);
  }

  /** Mirror body transforms onto the meshes. Call after physics.step. */
  update(): void {
    for (const prop of this.props) {
      prop.body.getPosition(this.pos);
      prop.body.getQuaternion(this.quat);
      prop.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
      prop.mesh.quaternion.set(this.quat.x, this.quat.y, this.quat.z, this.quat.w);
    }
  }

  dispose(): void {
    for (const prop of this.props) {
      this.scene.remove(prop.mesh);
      this.physics.removeBody(prop.body);
    }
    this.props.length = 0;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  private spawn(x: number, y: number, z: number, sizeClass: number): void {
    const [half, density] = SIZE_CLASSES[sizeClass];
    const body = this.physics.createBox({
      x,
      y,
      z,
      hx: half,
      hy: half,
      hz: half,
      density,
      category: Category.Prop,
      mask: Category.Prop | Category.Ground | Category.Player | Category.Enemy,
    });
    const mesh = new THREE.Mesh(
      this.geometries[sizeClass],
      this.materials[Math.floor(Math.random() * this.materials.length)],
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.props.push({ mesh, body, half });
  }
}
