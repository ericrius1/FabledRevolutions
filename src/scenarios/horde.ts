import * as THREE from "three/webgpu";
import type { Scenario, ScenarioContext } from "./scenario";
import { Enemy } from "../game/enemy";
import { PropField } from "../game/props";
import { buildArenaEnvironment, disposeArenaEnvironment, ARENA_HALF } from "./arena";
import type { Body } from "../core/physics";

/**
 * Horde: a persistent wave of fast, fragile enemies that streams in from the
 * arena edges. Finishing hits knock agents down, but they recover from the
 * same physics body instead of being reclaimed, keeping pressure continuous.
 *
 * This scenario tests how the juice holds up under crowd chaos.
 */

const WAVE_SIZE = 14;
const SPAWN_INSET = 2; // spawn just inside the walls

export class HordeScenario implements Scenario {
  readonly id = "horde";
  readonly label = "Horde";
  readonly playerSpawn = new THREE.Vector2(0, 0);

  private ctx!: ScenarioContext;
  private env!: { objects: THREE.Object3D[]; bodies: Body[] };
  private props!: PropField;
  private readonly liveEnemies: Enemy[] = [];

  private wave = 0;
  private overlay!: HTMLDivElement;
  private waveLabel!: HTMLSpanElement;

  get enemies(): readonly Enemy[] {
    return this.liveEnemies;
  }

  setup(ctx: ScenarioContext): void {
    this.ctx = ctx;
    this.env = buildArenaEnvironment(ctx);
    this.props = new PropField(ctx.physics, ctx.scene, ctx.bus);
    this.props.addArenaDressing();

    this.overlay = document.createElement("div");
    this.overlay.className = "wave-overlay";
    this.waveLabel = document.createElement("span");
    this.overlay.appendChild(this.waveLabel);
    document.body.appendChild(this.overlay);

    this.startWave();
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
    this.overlay.remove();
    this.props.dispose();
    disposeArenaEnvironment(this.ctx, this.env);
  }

  private startWave(): void {
    this.wave++;
    const seekSpeed = 8.8;
    for (let i = 0; i < WAVE_SIZE; i++) this.spawnFromEdge(seekSpeed);

    this.waveLabel.textContent = `WAVE ${this.wave}`;
    // Re-trigger the announce animation.
    this.overlay.classList.remove("show");
    void this.overlay.offsetWidth;
    this.overlay.classList.add("show");
  }

  /** Spawn an enemy just inside a random arena edge. */
  private spawnFromEdge(seekSpeed: number): void {
    const edge = Math.floor(Math.random() * 4);
    const along = (Math.random() * 2 - 1) * (ARENA_HALF - SPAWN_INSET);
    const inset = ARENA_HALF - SPAWN_INSET;
    let x = 0;
    let z = 0;
    switch (edge) {
      case 0: x = along; z = -inset; break;
      case 1: x = along; z = inset; break;
      case 2: x = -inset; z = along; break;
      default: x = inset; z = along; break;
    }
    const enemy = new Enemy(this.ctx.physics, new THREE.Vector2(x, z), {
      scene: this.ctx.scene,
      seekSpeed,
      hp: 2, // weaker than the arena's 3-hit enemies
      separation: 1.2,
      standoff: 0.95 + Math.pow(Math.random(), 2) * 1.8,
    });
    this.ctx.scene.add(enemy.group);
    this.liveEnemies.push(enemy);
  }
}
