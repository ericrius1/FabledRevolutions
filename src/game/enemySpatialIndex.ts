import type { Enemy } from "./enemy";

/**
 * Frame-local XZ spatial grid for enemy queries. Buckets are pooled so rebuilding
 * the index every frame does not allocate a fresh set of arrays.
 */
export class EnemySpatialIndex {
  private readonly invCellSize: number;
  private readonly cells = new Map<number, Enemy[]>();
  private readonly activeBuckets: Enemy[][] = [];
  private readonly bucketPool: Enemy[][] = [];

  constructor(cellSize = 2) {
    this.invCellSize = 1 / cellSize;
  }

  rebuild(enemies: readonly Enemy[]): void {
    for (const bucket of this.activeBuckets) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.activeBuckets.length = 0;
    this.cells.clear();

    for (const enemy of enemies) {
      if (enemy.parked) continue;
      const ix = this.cell(enemy.position.x);
      const iz = this.cell(enemy.position.z);
      const key = this.key(ix, iz);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = this.bucketPool.pop() ?? [];
        this.cells.set(key, bucket);
        this.activeBuckets.push(bucket);
      }
      bucket.push(enemy);
    }
  }

  collectCircle(x: number, z: number, radius: number, out: Enemy[]): Enemy[] {
    out.length = 0;
    const minX = this.cell(x - radius);
    const maxX = this.cell(x + radius);
    const minZ = this.cell(z - radius);
    const maxZ = this.cell(z + radius);
    const radiusSq = radius * radius;

    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const bucket = this.cells.get(this.key(ix, iz));
        if (!bucket) continue;
        for (const enemy of bucket) {
          const dx = enemy.position.x - x;
          const dz = enemy.position.z - z;
          if (dx * dx + dz * dz <= radiusSq) out.push(enemy);
        }
      }
    }

    return out;
  }

  private cell(v: number): number {
    return Math.floor(v * this.invCellSize);
  }

  private key(ix: number, iz: number): number {
    // Signed integer pair -> stable numeric key. Arena coordinates are tiny
    // relative to this range, and the result stays well below Number's safe int.
    return (ix + 32768) * 65536 + (iz + 32768);
  }
}
