import * as THREE from "three/webgpu";
import {
  cameraPosition,
  cameraViewMatrix,
  cos,
  dot,
  float,
  hash,
  mix,
  mx_noise_float,
  normalWorld,
  positionLocal,
  positionWorld,
  select,
  sin,
  time,
  vec3,
  vec4,
} from "three/tsl";
import { Category, type Body, type Physics } from "../core/physics";
import {
  buildingImpactGlowStrengthNode,
  buildingImpactNormalBend,
  buildingImpactPulse,
  buildingShockOffset,
  triggerBuildingImpactRipple,
} from "../effects/groundShockwave";

/**
 * Modular cube-block buildings lining the Revolutions corridor.
 *
 * The corridor runs forward-only from z=0 (player / camera side) toward −Z.
 * {@link BuildingConfig.length} is the total span the tuning slider labels;
 * only the forward half is built so the street extends in front of the player.
 *
 * Each building is a stack of world-grid-aligned cubes rendered as ONE
 * InstancedMesh; physics sees one static box per tower. The facade material
 * carries the whole look in the shader, after the interior-mapping technique
 * from the three.js city generator (webgpu_generator_city): every glass texel
 * casts the view ray into the world-grid cell behind it (slab intersection)
 * and shades a tiny procedural room at the hit point — no geometry, no
 * textures — so windows parallax honestly as the camera moves. Because the
 * cubes are axis-aligned AND snapped to a world grid of `cubeSize`, the room
 * box is simply `floor(positionWorld / cubeSize)` — the per-vertex roomCenter
 * plumbing of the original collapses to one line.
 *
 * The facades themselves are indestructible: the instance matrices are baked
 * once (static draw usage, one-time bounding sphere) and never touched again.
 * Hard impacts instead spray small decorative chunks — a purely visual debris
 * pool (SoA ballistic sim, no physics bodies) split across two instanced
 * meshes so the spray mixes cube-ish shards with irregular lumps.
 */

export interface BuildingConfig {
  /** Edge length of one cube module (m). World grid aligns to this. */
  cubeSize: number;
  /** Corridor half-width — inner facade planes sit at ±this (snapped to grid). */
  corridorHalf: number;
  /** Total corridor span along Z (snapped to whole cells). Only the forward
   * half (−Z from the player) is built. */
  length: number;
  /** Average tower height in cubes (±2 randomized per tower). */
  avgFloors: number;
  /** Fraction of rooms with the lights on. */
  litFraction: number;
  /** Debris pool size (chunks alive at once, across both shape pools). */
  maxDebris: number;
}

interface ImpactOptions {
  ripple?: boolean;
}

/** Impacts slower than this shed no chunks — only a genuinely hard slam does. */
const DEBRIS_MIN_SPEED = 9;
/** Speed at which an impact sprays the full per-impact chunk count. */
const DEBRIS_MAX_SPEED = 30;
/** Chunks sprayed by one impact at DEBRIS_MIN_SPEED / DEBRIS_MAX_SPEED. */
const DEBRIS_COUNT_MIN = 2;
const DEBRIS_COUNT_MAX = 7;
/** Per-frame spawn budget: wave sweeps fire many impacts in one frame and the
 * pool would otherwise churn every slot into a same-age flicker. */
const DEBRIS_FRAME_BUDGET = 24;
const DEBRIS_GRAVITY = -22;
/** Seconds a chunk rests on the ground before shrinking away. */
const DEBRIS_REST_LINGER = 1.6;
const DEBRIS_FADE_TIME = 0.45;
/** Hard ceiling on airborne time — a chunk that never finds the floor (spawned
 * over a roof, clipped through) still retires instead of falling forever. */
const DEBRIS_MAX_AIR_TIME = 6;
const TWO_PI = Math.PI * 2;

const tmpMat = new THREE.Matrix4();
const tmpImpactOrigin = new THREE.Vector3();
const tmpColor = new THREE.Color();

/** One shape pool: an InstancedMesh plus SoA state for its chunks. */
class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private readonly velX: Float32Array;
  private readonly velY: Float32Array;
  private readonly velZ: Float32Array;
  private readonly rotX: Float32Array;
  private readonly rotY: Float32Array;
  private readonly rotZ: Float32Array;
  private readonly spinX: Float32Array;
  private readonly spinY: Float32Array;
  private readonly spinZ: Float32Array;
  private readonly sizeX: Float32Array;
  private readonly sizeY: Float32Array;
  private readonly sizeZ: Float32Array;
  /** Seconds until retirement once resting (>0), or 0 while airborne. */
  private readonly restTimer: Float32Array;
  private readonly airTime: Float32Array;
  /** 0 = free slot, 1 = live. */
  private readonly live: Uint8Array;
  private cursor = 0;
  private liveCount = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    readonly capacity: number,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Allocate the per-instance color buffer up front so the shader compiles
    // WITH the instancing-color path. Created lazily on first setColorAt, the
    // buffer would arrive after the program is already cached without it and
    // every chunk would render as the white base color.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(1),
      3,
    );
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velY = new Float32Array(capacity);
    this.velZ = new Float32Array(capacity);
    this.rotX = new Float32Array(capacity);
    this.rotY = new Float32Array(capacity);
    this.rotZ = new Float32Array(capacity);
    this.spinX = new Float32Array(capacity);
    this.spinY = new Float32Array(capacity);
    this.spinZ = new Float32Array(capacity);
    this.sizeX = new Float32Array(capacity);
    this.sizeY = new Float32Array(capacity);
    this.sizeZ = new Float32Array(capacity);
    this.restTimer = new Float32Array(capacity);
    this.airTime = new Float32Array(capacity);
    this.live = new Uint8Array(capacity);
    this.hideAll();
  }

  /** Claim the next slot round-robin (recycling the oldest when full). */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    sx: number,
    sy: number,
    sz: number,
    tint: THREE.Color,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (!this.live[i]) {
      this.live[i] = 1;
      this.liveCount++;
    }
    this.posX[i] = x;
    this.posY[i] = y;
    this.posZ[i] = z;
    this.velX[i] = vx;
    this.velY[i] = vy;
    this.velZ[i] = vz;
    this.sizeX[i] = sx;
    this.sizeY[i] = sy;
    this.sizeZ[i] = sz;
    this.rotX[i] = Math.random() * TWO_PI;
    this.rotY[i] = Math.random() * TWO_PI;
    this.rotZ[i] = Math.random() * TWO_PI;
    this.spinX[i] = (Math.random() - 0.5) * 14;
    this.spinY[i] = (Math.random() - 0.5) * 14;
    this.spinZ[i] = (Math.random() - 0.5) * 14;
    this.restTimer[i] = 0;
    this.airTime[i] = 0;
    // setColorAt allocates the instance color buffer on first use.
    this.mesh.setColorAt(i, tint);
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** Ballistic step + matrix bake. Returns true if any instance is live. */
  update(dt: number): boolean {
    if (this.liveCount === 0) return false;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.live[i]) continue;
      let scale = 1;
      if (this.restTimer[i] > 0) {
        // Resting: run out the linger, then shrink away and free the slot.
        this.restTimer[i] -= dt;
        const t = this.restTimer[i];
        if (t <= 0) {
          this.retire(i);
          continue;
        }
        if (t < DEBRIS_FADE_TIME) scale = t / DEBRIS_FADE_TIME;
      } else {
        this.airTime[i] += dt;
        this.velY[i] += DEBRIS_GRAVITY * dt;
        this.posX[i] += this.velX[i] * dt;
        this.posY[i] += this.velY[i] * dt;
        this.posZ[i] += this.velZ[i] * dt;
        this.rotX[i] += this.spinX[i] * dt;
        this.rotY[i] += this.spinY[i] * dt;
        this.rotZ[i] += this.spinZ[i] * dt;
        const restY = this.sizeY[i] * 0.5;
        if (this.posY[i] <= restY && this.velY[i] < 0) {
          if (this.velY[i] < -3.5) {
            // One lively bounce, then it settles for good.
            this.posY[i] = restY;
            this.velY[i] *= -0.32;
            this.velX[i] *= 0.5;
            this.velZ[i] *= 0.5;
            this.spinX[i] *= 0.5;
            this.spinZ[i] *= 0.5;
          } else {
            this.posY[i] = restY;
            this.restTimer[i] = DEBRIS_REST_LINGER;
          }
        } else if (this.airTime[i] > DEBRIS_MAX_AIR_TIME) {
          this.retire(i);
          continue;
        }
      }
      this.dummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
      this.dummy.rotation.set(this.rotX[i], this.rotY[i], this.rotZ[i]);
      this.dummy.scale.set(
        this.sizeX[i] * scale,
        this.sizeY[i] * scale,
        this.sizeZ[i] * scale,
      );
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    return this.liveCount > 0;
  }

  private retire(i: number): void {
    this.live[i] = 0;
    this.liveCount--;
    this.dummy.position.set(0, -100, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
  }

  hideAll(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.live[i] = 0;
      this.retire(i);
      this.liveCount = 0;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class CubeBuildings {
  /** Inner facade plane |x| (post-snap) — the scenario's impact tests use it. */
  readonly wallX: number;
  /** Forward corridor depth from the player (z=0) to the far end (negative Z). */
  readonly halfLength: number;
  /** Near edge of the corridor (+Z side, behind the camera). */
  readonly nearZ = 0;
  /** Far edge of the corridor (negative Z). */
  readonly farZ: number;
  readonly cubeSize: number;

  private instanced!: THREE.InstancedMesh;
  private readonly bodies: Body[] = [];
  /** Per-tower roof metadata for the player's wall-climb top-out. */
  private readonly towers: { sign: number; zMin: number; zMax: number; top: number }[] = [];
  private readonly facadeMaterial: THREE.MeshStandardNodeMaterial;
  private readonly debrisMaterial: THREE.MeshStandardMaterial;
  private readonly cubePool: DebrisPool;
  private readonly lumpPool: DebrisPool;
  private frameBudget = DEBRIS_FRAME_BUDGET;

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
    private readonly config: BuildingConfig,
  ) {
    const s = config.cubeSize;
    // Cube boundaries must land on multiples of cubeSize for the world-grid
    // room lookup in the shader — snap the facade plane to the grid.
    this.cubeSize = s;
    this.wallX = Math.max(s, Math.round(config.corridorHalf / s) * s);
    // Forward-only: config.length is the full slider span; build the −Z half.
    const forwardLength = config.length / 2;
    const cellsZ = Math.max(4, Math.round(forwardLength / s));
    this.farZ = -(cellsZ * s);
    this.halfLength = -this.farZ;

    this.facadeMaterial = buildCubeMaterial(s, config.litFraction);

    // Decorative chunks: instance tint carries the per-chunk concrete shade.
    this.debrisMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
    });
    const cubeCap = Math.max(8, Math.round(config.maxDebris * 0.6));
    const lumpCap = Math.max(8, config.maxDebris - cubeCap);
    this.cubePool = new DebrisPool(
      new THREE.BoxGeometry(1, 1, 1),
      this.debrisMaterial,
      cubeCap,
    );
    this.lumpPool = new DebrisPool(
      new THREE.IcosahedronGeometry(0.62, 0),
      this.debrisMaterial,
      lumpCap,
    );
    scene.add(this.cubePool.mesh);
    scene.add(this.lumpPool.mesh);

    this.build(cellsZ);
  }

  private build(cellsZ: number): void {
    const s = this.cubeSize;
    const cfg = this.config;

    // Plan towers first (so the instance count is known), then bake matrices.
    // A tower is a run of 2–3 cells along Z, 2 cells deep, with a per-column
    // stepped height around the tower's own height — a blocky, uneven skyline.
    // Cells index from the near edge (z=0) toward −Z.
    interface Cell {
      ix: number;
      iy: number;
      /** Cell index from the near edge (0 = just ahead of the player). */
      iz: number;
    }
    const plan: Cell[] = [];

    // One row of towers along Z on one side. `depthBase` steps the row outward
    // from the wall (front row = 0; a back row sits behind a one-cell alley),
    // `heightScale` biases its skyline, and `collide` gates the static collider
    // + wall-climb roof (only the front row is reachable, so only it collides).
    const buildRow = (
      side: number,
      depthBase: number,
      heightScale: number,
      collide: boolean,
    ): void => {
      let iz = 0;
      while (iz < cellsZ) {
        const width = 2 + Math.floor(Math.random() * 2);
        // Wide spread around the average, plus rare tall spikes, for a jagged,
        // varied skyline rather than a uniform wall.
        let towerH = Math.round(cfg.avgFloors * heightScale * (0.6 + Math.random() * 0.85));
        if (Math.random() < 0.12) towerH = Math.round(towerH * (1.3 + Math.random() * 0.6));
        towerH = Math.max(2, towerH);
        const zEnd = Math.min(cellsZ, iz + width);
        let towerMaxH = 0;
        for (let z = iz; z < zEnd; z++) {
          const colH = Math.max(2, towerH - Math.floor(Math.random() * 3));
          towerMaxH = Math.max(towerMaxH, colH);
          for (let d = 0; d < 2; d++) {
            // Signed depth index: side +1 fills ix depthBase..+1; side -1 mirrors.
            const ix = side > 0 ? depthBase + d : -1 - depthBase - d;
            for (let iy = 0; iy < colH; iy++) {
              plan.push({ ix, iy, iz: z });
            }
          }
        }
        if (collide) {
          // One static collider spans the whole tower.
          const zNear = -iz * s;
          const zFar = -zEnd * s;
          const zc = (zNear + zFar) / 2;
          const hz = (zNear - zFar) / 2;
          this.bodies.push(
            this.physics.createBox({
              x: side * (this.wallX + s), // center of the 2-cube depth
              y: (towerMaxH * s) / 2,
              z: zc,
              hx: s,
              hy: (towerMaxH * s) / 2,
              hz,
              kind: "static",
              category: Category.Ground,
            }),
          );
          this.towers.push({ sign: side, zMin: zc - hz, zMax: zc + hz, top: towerMaxH * s });
        }
        iz = zEnd + (Math.random() < 0.35 ? 1 : 0);
      }
    };

    for (const side of [-1, 1]) {
      // Front row lines the corridor (collides, carries the climb roofs); a
      // taller back row sits behind a one-cell alley for depth. The back row is
      // purely decorative — same static instanced mesh, no physics.
      buildRow(side, 0, 1, true);
      buildRow(side, 3, 1.45, false);
    }

    const geometry = new THREE.BoxGeometry(s, s, s);
    this.instanced = new THREE.InstancedMesh(geometry, this.facadeMaterial, plan.length);
    this.instanced.castShadow = true;
    this.instanced.receiveShadow = true;

    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      const x = c.ix >= 0 ? this.wallX + (c.ix + 0.5) * s : -this.wallX + (c.ix + 0.5) * s;
      tmpMat.makeTranslation(x, (c.iy + 0.5) * s, -(c.iz + 0.5) * s);
      this.instanced.setMatrixAt(i, tmpMat);
    }
    // Matrices are baked once and never touched again: static buffer, and a
    // real bounding sphere so frustum culling sees the whole city rather than
    // the unit-cube geometry bounds.
    this.instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.instanced.instanceMatrix.needsUpdate = true;
    this.instanced.computeBoundingSphere();
    this.scene.add(this.instanced);
  }

  /**
   * A fast body slammed into a facade at (x, y, z) moving along (vx, vz):
   * the wall shrugs it off, but a hard enough hit (speed ≥ DEBRIS_MIN_SPEED)
   * sprays small decorative chunks back into the corridor.
   */
  registerImpact(
    x: number,
    y: number,
    z: number,
    vx: number,
    vz: number,
    speed: number,
    options: ImpactOptions = {},
  ): void {
    if (options.ripple !== false) {
      triggerBuildingImpactRipple(tmpImpactOrigin.set(x, y, z), speed);
    }
    if (speed < DEBRIS_MIN_SPEED || this.frameBudget <= 0) return;

    const s = this.cubeSize;
    const k = THREE.MathUtils.clamp(
      (speed - DEBRIS_MIN_SPEED) / (DEBRIS_MAX_SPEED - DEBRIS_MIN_SPEED),
      0,
      1,
    );
    let count = Math.round(THREE.MathUtils.lerp(DEBRIS_COUNT_MIN, DEBRIS_COUNT_MAX, k));
    count = Math.min(count, this.frameBudget);
    this.frameBudget -= count;

    // Chunks eject INTO the corridor (away from the facade), with a slice of
    // the striker's along-wall motion so glancing hits smear the spray.
    const out = x >= 0 ? -1 : 1;
    const burst = 2.5 + 6.5 * k;
    for (let i = 0; i < count; i++) {
      const pool = Math.random() < 0.6 ? this.cubePool : this.lumpPool;
      const sx = s * (0.06 + Math.random() * 0.16);
      const sy = s * (0.06 + Math.random() * 0.14);
      const sz = s * (0.06 + Math.random() * 0.16);
      // Concrete shade with per-chunk variation; a few read as glass glints.
      const shade = 0.7 + Math.random() * 0.5;
      if (Math.random() < 0.12) tmpColor.setRGB(0.35 * shade, 0.5 * shade, 0.45 * shade);
      else tmpColor.setRGB(0.16 * shade, 0.2 * shade, 0.19 * shade);
      pool.spawn(
        x + out * (0.1 + Math.random() * 0.3),
        Math.max(sy, y + (Math.random() - 0.5) * s),
        z + (Math.random() - 0.5) * s,
        out * burst * (0.5 + Math.random()) - vx * 0.1,
        burst * (0.5 + Math.random() * 0.7),
        vz * 0.2 + (Math.random() - 0.5) * burst * 0.8,
        sx,
        sy,
        sz,
        tmpColor,
      );
    }
  }

  /** Step the decorative debris. Call once per frame with the scaled dt. */
  update(dt: number): void {
    this.frameBudget = DEBRIS_FRAME_BUDGET;
    this.cubePool.update(dt);
    this.lumpPool.update(dt);
  }

  /**
   * Roof height of the tower on facade side `sign` (+1/-1) at world z, or 0 if
   * no tower covers that column. The player's climb tops out at this height.
   */
  topAt(sign: number, z: number): number {
    let top = 0;
    for (const t of this.towers) {
      if (t.sign !== sign || z < t.zMin || z > t.zMax) continue;
      if (t.top > top) top = t.top;
    }
    return top;
  }

  dispose(): void {
    this.scene.remove(this.instanced);
    this.instanced.geometry.dispose();
    this.instanced.dispose();
    for (const pool of [this.cubePool, this.lumpPool]) {
      this.scene.remove(pool.mesh);
      pool.mesh.geometry.dispose();
      pool.mesh.dispose();
    }
    this.debrisMaterial.dispose();
    for (const body of this.bodies) this.physics.removeBody(body);
    this.bodies.length = 0;
    this.facadeMaterial.dispose();
  }
}

/**
 * The facade cube look: dark concrete shell with wide ribbon windows (one bay
 * across, two up, per cube face).
 *
 * Window pattern and rooms are keyed off positionWorld, and each glass texel
 * ray-marches the interior of its world-grid cell for true parallax (interior
 * mapping, after the city generator). Facades never move, so world space is
 * always valid.
 */
function buildCubeMaterial(s: number, litFraction: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();

  const pos = positionWorld;
  const nrm = normalWorld;
  const impactPulse = buildingImpactPulse(positionWorld).toVar();
  m.positionNode = positionLocal.add(buildingShockOffset(positionWorld));
  const bentNormal = normalWorld.add(buildingImpactNormalBend(positionWorld)).normalize();
  m.normalNode = cameraViewMatrix.mul(vec4(bentNormal, 0)).xyz.normalize();

  // Face axis: X-facing and Z-facing sides carry windows; tops/bottoms are shell.
  const ax = nrm.abs();
  const sideX = ax.x.greaterThan(0.5);
  const isSide = sideX.or(ax.z.greaterThan(0.5));

  // Face-plane coordinates (u across, v up). One big window per cube face
  // (pitch s both ways), still a touch wider than tall, so each window is huge —
  // the room and its monitor read easily. Pitch = cube size, so a window never
  // straddles two cells (which would tear the interior mapping).
  const faceU = select(sideX, pos.z, pos.x);
  const bayW = s;
  const bayH = s;
  const wu = faceU.div(bayW).fract();
  const wv = pos.y.div(bayH).fract();
  const inWin = wu
    .greaterThan(0.08)
    .and(wu.lessThan(0.92))
    .and(wv.greaterThan(0.17))
    .and(wv.lessThan(0.83));
  const glass = isSide.and(inWin);

  // The cube cell this texel belongs to, nudged inward off the boundary plane.
  const cell = pos.sub(nrm.mul(0.02)).div(s).floor();
  const cellSeed = cell.x.mul(17.13).add(cell.y.mul(31.7)).add(cell.z.mul(9.31)).add(1000);

  // Per-ROOM identity: each window bay gets its own seed so neighbours differ.
  const bayU = faceU.div(bayW).floor();
  const bayV = pos.y.div(bayH).floor();
  const roomSeed = cellSeed.add(bayU.mul(3.7)).add(bayV.mul(11.9));
  const lit = hash(roomSeed).lessThan(litFraction);
  // Bulb temperature: Matrix-green cast — desaturated green-white with low red,
  // so rooms read as monitor-lit rather than incandescent yellow.
  const bulb = mix(vec3(0.42, 0.82, 0.5), vec3(0.55, 1.0, 0.72), hash(roomSeed.add(7.7)));

  // Interior mapping: slab-intersect the view ray with the far planes of
  // this texel's world-grid cell; shade the hit by which plane it landed on.
  const dir = pos.sub(cameraPosition).normalize();
  const roomMin = cell.mul(s);
  const roomMax = cell.add(1).mul(s);
  const tA = roomMin.sub(pos).div(dir);
  const tB = roomMax.sub(pos).div(dir);
  const tFar = tA.max(tB);
  const t = tFar.x.min(tFar.y).min(tFar.z);
  const hit = pos.add(dir.mul(t));
  const q = hit.sub(roomMin).div(s); // 0..1 inside the room

  // Plane shading: floor brightest, ceiling dark, walls graded by depth.
  const onFloor = q.y.lessThan(0.002);
  const onCeil = q.y.greaterThan(0.998);
  const depthFade = t.div(s * 1.6).oneMinus().clamp(0.25, 1);
  const wallTone = q.y.mul(0.5).add(0.3);
  const tone = select(onFloor, float(0.85), select(onCeil, float(0.18), wallTone));
  // Furniture-ish clutter: dark noise blobs breaking up the walls.
  const clutter = mx_noise_float(hit.mul(1.7).add(hash(roomSeed).mul(40)))
    .mul(0.5)
    .add(0.5)
    .clamp(0.35, 1);
  const litLevel = tone.mul(depthFade).mul(clutter);
  const roomEmit = select(
    lit,
    bulb.mul(litLevel).mul(1.4),
    // Dark rooms still get a whisper of interior so the parallax reads.
    bulb.mul(litLevel).mul(0.05),
  ).mul(vec3(0.82, 1.0, 0.86)); // global Matrix-green wash

  // ---- Stylized desk + monitor, ray-marched in-shader (no geometry) ----------
  // Roughly every other room gets a little monitor sitting on a desk, at a
  // per-room size/yaw/offset. It's a second pair of ray-vs-box intersections
  // against the same interior ray; the nearest of {far wall, desk, monitor}
  // wins. Fully analytic, no loops, no extra draws — the whole city is still one
  // static instanced mesh, so this stays cheap.
  const hasMon = hash(roomSeed.add(21.7)).greaterThan(0.55);

  // Room-local frame: depth points out toward the window (nrm), side runs along
  // the wall, up is world-up. nrm is axis-aligned so side/depth are too.
  const roomCenter = cell.add(0.5).mul(s);
  const sideAxis = vec3(nrm.z, float(0), nrm.x);
  const relO = pos.sub(roomCenter);
  // dot() is mistyped as returning the vector type; it's a float scalar at
  // runtime, so cast to keep the downstream scalar math from inferring vec3.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const Oa = dot(relO, sideAxis) as any;
  const Ob = relO.y as any;
  const Oc = dot(relO, nrm) as any;
  const Da = dot(dir, sideAxis) as any;
  const Db = dir.y as any;
  const Dc = dot(dir, nrm) as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const floorY = float(-s * 0.5);

  // Per-room monitor size / aspect / yaw / placement.
  const rSize = hash(roomSeed.add(4.2));
  const rAsp = hash(roomSeed.add(9.3));
  const rYaw = hash(roomSeed.add(8.9));
  const rPa = hash(roomSeed.add(2.3));
  const rPc = hash(roomSeed.add(5.6));
  const hw = float(s * 0.11).add(rSize.mul(s * 0.06)); // screen half-width
  const hh = hw.mul(rAsp.mul(0.14).add(0.6)); // aspect ~0.60..0.74
  const hd = float(s * 0.02); // thin panel
  const deskTop = floorY.add(float(s * 0.34));
  const ma = rPa.sub(0.5).mul(s * 0.4); // side offset
  const mc = rPc.mul(s * 0.25).sub(s * 0.1); // depth offset (~room centre)
  const mb = deskTop.add(hh).add(float(s * 0.005)); // sits on the desk

  // Slab test for a linear axis X(t)=X0+t*X1 against |X|<h → entry/exit t.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slab = (X0: any, X1: any, h: any) => {
    const inv = float(1).div(X1);
    const t1 = h.negate().sub(X0).mul(inv);
    const t2 = h.sub(X0).mul(inv);
    return { lo: t1.min(t2), hi: t1.max(t2) };
  };

  // Monitor: thin box yaw-rotated about up. Rotate the ray into the box frame
  // (only side/depth turn) — still linear in t, so the same slab test applies.
  const yaw = rYaw.sub(0.5).mul(1.1);
  const cy = cos(yaw);
  const sy = sin(yaw);
  const pa0 = Oa.sub(ma);
  const pc0 = Oc.sub(mc);
  const A0 = pa0.mul(cy).add(pc0.mul(sy));
  const A1 = Da.mul(cy).add(Dc.mul(sy));
  const C0 = pa0.mul(sy).negate().add(pc0.mul(cy));
  const C1 = Da.mul(sy).negate().add(Dc.mul(cy));
  const mAx = slab(A0, A1, hw);
  const mUp = slab(Ob.sub(mb), Db, hh);
  const mDe = slab(C0, C1, hd);
  const tMon = mAx.lo.max(mUp.lo).max(mDe.lo);
  const tMonExit = mAx.hi.min(mUp.hi).min(mDe.hi);
  const monHit = hasMon
    .and(tMonExit.greaterThan(tMon))
    .and(tMon.greaterThan(0))
    .and(tMon.lessThan(t));

  // Screen surface coords at the entry point → matrix rain glyph columns.
  const laHit = A0.add(A1.mul(tMon));
  const lbHit = Ob.sub(mb).add(Db.mul(tMon));
  const su = laHit.div(hw).mul(0.5).add(0.5);
  const sv = lbHit.div(hh).mul(0.5).add(0.5);
  const onScreen = su
    .greaterThan(0.08)
    .and(su.lessThan(0.92))
    .and(sv.greaterThan(0.1))
    .and(sv.lessThan(0.9));
  const csu = su.sub(0.08).div(0.84).clamp(0, 1);
  const csv = sv.sub(0.1).div(0.8).clamp(0, 1);
  const col = csu.mul(7).floor();
  const colRand = hash(col.mul(1.7).add(roomSeed.mul(0.13)).add(3.0));
  const fallSpeed = colRand.mul(0.8).add(0.35);
  // Bright head streams downward; trail fades upward behind it.
  const headV = time.mul(fallSpeed).add(colRand.mul(10)).fract().oneMinus();
  const above = csv.sub(headV);
  const trailLen = colRand.mul(0.4).add(0.35);
  const inTrail = above.greaterThan(0).and(above.lessThan(trailLen));
  const trailBright = above.div(trailLen).oneMinus().clamp(0, 1);
  // Discrete per-cell glyph flicker so the trail reads as characters.
  const rowCell = csv.mul(13).floor();
  const glyph = hash(rowCell.mul(1.9).add(col.mul(5.3)).add(time.mul(6).floor().mul(0.37)))
    .mul(0.6)
    .add(0.4);
  const headGlow = above.abs().mul(16).oneMinus().clamp(0, 1);
  const rainAmt = select(inTrail, trailBright.mul(glyph), float(0));
  const screenEmit = vec3(0.15, 1.0, 0.32)
    .mul(rainAmt)
    .add(vec3(0.7, 1.0, 0.8).mul(headGlow.mul(0.9)))
    .add(vec3(0.02, 0.14, 0.05)); // faint backlight
  const monitorEmit = select(onScreen, screenEmit.mul(1.7), vec3(0.008, 0.02, 0.014));

  // Desk: axis-aligned slab on the floor under the monitor.
  const dw = hw.add(float(s * 0.04));
  const dd = hd.add(float(s * 0.06));
  const dAx = slab(Oa.sub(ma), Da, dw);
  const dUp = slab(Ob.sub(floorY.add(deskTop).mul(0.5)), Db, deskTop.sub(floorY).mul(0.5));
  const dDe = slab(Oc.sub(mc), Dc, dd);
  const tDesk = dAx.lo.max(dUp.lo).max(dDe.lo);
  const tDeskExit = dAx.hi.min(dUp.hi).min(dDe.hi);
  const deskHit = hasMon
    .and(tDeskExit.greaterThan(tDesk))
    .and(tDesk.greaterThan(0))
    .and(tDesk.lessThan(t));
  const deskEmit = vec3(0.02, 0.05, 0.035);

  // Nearest surface wins (BIG sentinel for the misses).
  const BIG = float(1e9);
  const tMonSel = select(monHit, tMon, BIG);
  const tDeskSel = select(deskHit, tDesk, BIG);
  const monNear = tMonSel.lessThan(tDeskSel).and(tMonSel.lessThan(t));
  const deskNear = tDeskSel.lessThan(tMonSel).and(tDeskSel.lessThan(t));
  const interiorEmit = select(
    monNear,
    monitorEmit,
    select(deskNear, deskEmit, roomEmit),
  );

  // Concrete shell: cool dark blue-green block with per-cube tint variation
  // and soft mottling — sits in the arena's fog palette.
  const tint = hash(cellSeed.add(3.1)).mul(0.35).add(0.8);
  const mottle = mx_noise_float(pos.mul(0.6)).mul(0.08);
  const concrete = vec3(0.16, 0.2, 0.19).mul(tint).mul(float(1).add(mottle));
  const rippleGlow = vec3(0.62, 0.68, 0.66).mul(impactPulse).mul(buildingImpactGlowStrengthNode);

  m.colorNode = select(glass, vec3(0.012, 0.02, 0.016), concrete);
  m.emissiveNode = select(glass, interiorEmit.add(rippleGlow.mul(0.35)), rippleGlow.mul(0.18));
  m.roughnessNode = select(
    glass,
    float(0.12),
    float(0.88).sub(impactPulse.mul(0.018)).clamp(0.68, 0.88),
  );
  m.metalnessNode = float(0);
  return m;
}
