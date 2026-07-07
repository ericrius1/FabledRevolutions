import * as THREE from "three/webgpu";
import type { Scenario, ScenarioContext } from "./scenario";
import { Enemy } from "../game/enemy";
import { PropField } from "../game/props";
import { buildArenaEnvironment, disposeArenaEnvironment } from "./arena";
import type { Body } from "../core/physics";

/**
 * Crate Yard: dense stacks of dynamic box bodies plus a handful of enemies.
 * Because crates are real rigid bodies (no motion locks), knocked-down agents
 * and the player barrel through them — the physics showcase. Prop plumbing
 * (mesh/body sync, geometry sharing, disposal) lives in PropField now that
 * every scenario has crates; this one just asks for a much denser layout.
 */

const ENEMY_COUNT = 4;

// Stack layouts: [centerX, centerZ, columns, rows-high].
const STACKS: Array<[number, number, number, number]> = [
  [-7, -6, 2, 3],
  [7, -7, 3, 2],
  [8, 6, 2, 3],
  [-8, 7, 2, 2],
  [0, -11, 3, 2],
];

export class CrateYardScenario implements Scenario {
  readonly id = "crate-yard";
  readonly label = "Crate Yard";
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
    for (const [cx, cz, cols, high] of STACKS) this.props.addStack(cx, cz, cols, high);
    this.props.addScatter(0, 8, 5, 4);
    this.props.addScatter(-12, 0, 4, 3);
    this.props.addScatter(12, -1, 4, 3);

    for (let i = 0; i < ENEMY_COUNT; i++) {
      const angle = (i / ENEMY_COUNT) * Math.PI * 2;
      const r = 13;
      const spawn = new THREE.Vector2(Math.cos(angle) * r, Math.sin(angle) * r);
      const enemy = new Enemy(ctx.physics, spawn, { scene: ctx.scene });
      ctx.scene.add(enemy.group);
      this.liveEnemies.push(enemy);
    }
  }

  update(_scaledDt: number): void {
    this.props.update();
  }

  dispose(): void {
    for (const enemy of this.liveEnemies) {
      this.ctx.scene.remove(enemy.group);
      this.ctx.physics.removeBody(enemy.body);
      enemy.dispose();
    }
    this.liveEnemies.length = 0;
    this.props.dispose();
    disposeArenaEnvironment(this.ctx, this.env);
  }
}
