import * as THREE from "three/webgpu";
import type { Scenario, ScenarioContext } from "./scenario";
import { Enemy } from "../game/enemy";
import { PropField } from "../game/props";
import { buildArenaEnvironment, disposeArenaEnvironment, ARENA_HALF } from "./arena";
import type { Body } from "../core/physics";

/**
 * Mega Horde: a pure stress test. No waves, no intermissions — enemies stream
 * in from the arena edges continuously, holding the live count at a target the
 * player tunes with an on-screen slider (hundreds if you dare).
 *
 * Enemies are one-hit knockdowns. The target controls persistent crowd size:
 * downed agents slide, recover, and rejoin instead of being removed.
 */

const DEFAULT_TARGET = 150;
const MIN_TARGET = 25;
const MAX_TARGET = 500;
/** Refill pacing: spawns per second, and a per-frame cap so a slider jump from
 * 50 → 500 streams in over a couple of seconds instead of hitching one frame. */
const SPAWN_RATE = 60;
const MAX_SPAWNS_PER_FRAME = 8;
const SPAWN_INSET = 2;

const TARGET_KEY = "fabled-revolutions.mega-horde.target";

export class MegaHordeScenario implements Scenario {
  readonly id = "mega-horde";
  readonly label = "Mega Horde";
  readonly playerSpawn = new THREE.Vector2(0, 0);

  private ctx!: ScenarioContext;
  private env!: { objects: THREE.Object3D[]; bodies: Body[] };
  private props!: PropField;
  private readonly liveEnemies: Enemy[] = [];

  private target = loadTarget();
  private spawnBudget = 0;
  private control!: HTMLDivElement;
  private countLabel!: HTMLSpanElement;
  private shownCount = -1;

  get enemies(): readonly Enemy[] {
    return this.liveEnemies;
  }

  get controlElement(): HTMLElement {
    return this.control;
  }

  setup(ctx: ScenarioContext): void {
    this.ctx = ctx;
    this.env = buildArenaEnvironment(ctx);
    // Lighter dressing than the other scenarios: this one runs hundreds of
    // enemy bodies, so keep the prop count modest.
    this.props = new PropField(ctx.physics, ctx.scene, ctx.bus);
    this.props.addStack(-10, -9, 2, 2);
    this.props.addStack(10, 10, 2, 2);
    this.props.addScatter(13, -10, 4, 3.5);
    this.props.addScatter(-13, 10, 4, 3.5);
    this.props.addScatter(0, 17, 3, 3);
    this.props.addScatter(-18, -14, 3, 3);
    this.buildControl();
  }

  update(scaledDt: number): void {
    this.props.update();

    // Stream spawns toward the target at a bounded rate.
    const alive = this.liveEnemies.length;
    const deficit = this.target - alive;
    if (deficit > 0) {
      this.spawnBudget = Math.min(this.spawnBudget + SPAWN_RATE * scaledDt, MAX_SPAWNS_PER_FRAME);
      let spawns = Math.min(Math.floor(this.spawnBudget), deficit);
      this.spawnBudget -= spawns;
      while (spawns-- > 0) this.spawnFromEdge();
    } else {
      this.spawnBudget = 0;
    }

    // DOM write only when the number actually changes.
    if (alive !== this.shownCount) {
      this.shownCount = alive;
      this.countLabel.textContent = `${alive}`;
    }
  }

  dispose(): void {
    for (const enemy of this.liveEnemies) {
      this.ctx.scene.remove(enemy.group);
      this.ctx.physics.removeBody(enemy.body);
      enemy.dispose();
    }
    this.liveEnemies.length = 0;
    this.control.remove();
    this.props.dispose();
    disposeArenaEnvironment(this.ctx, this.env);
  }

  /** Bottom-center slider that live-tunes the target horde size. */
  private buildControl(): void {
    this.control = document.createElement("div");
    this.control.className = "horde-control";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "HORDE";

    this.countLabel = document.createElement("span");
    this.countLabel.className = "count";
    this.countLabel.textContent = "0";

    const value = document.createElement("span");
    value.className = "target";
    value.textContent = `/ ${this.target}`;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(MIN_TARGET);
    slider.max = String(MAX_TARGET);
    slider.step = "25";
    slider.value = String(this.target);
    slider.addEventListener("input", () => {
      this.target = Number(slider.value);
      value.textContent = `/ ${this.target}`;
      saveTarget(this.target);
    });

    this.control.append(title, this.countLabel, value, slider);
  }

  /**
   * Showcase helper: drop a single presser at exact coordinates (the record
   * script uses this to stage an on-camera first hit right beside the player).
   */
  spawnNear(x: number, z: number): void {
    const enemy = new Enemy(this.ctx.physics, new THREE.Vector2(x, z), {
      scene: this.ctx.scene,
      seekSpeed: 4.8,
      hp: 1,
      separation: 1.4,
      standoff: 1.05,
    });
    this.ctx.scene.add(enemy.group);
    this.liveEnemies.push(enemy);
  }

  private spawnFromEdge(): void {
    // Radial mid-field spawns: just beyond the immediate brawl, close enough
    // that the pressure refreshes quickly when downed agents are recovering.
    const ang = Math.random() * Math.PI * 2;
    const r = Math.min(12 + Math.random() * 13, ARENA_HALF - SPAWN_INSET);
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    // A bigger presser share keeps the player under contact threat while the
    // outer bodies still form visible crowd depth.
    const presser = Math.random() < 0.38;
    const enemy = new Enemy(this.ctx.physics, new THREE.Vector2(x, z), {
      scene: this.ctx.scene,
      seekSpeed: 4.6 + Math.random() * 2.0,
      hp: 1,
      separation: 1.4,
      standoff: presser ? 1.05 : 2.0 + Math.random() * 3.6,
      visualDetail: "crowd",
    });
    this.ctx.scene.add(enemy.group);
    this.liveEnemies.push(enemy);
  }
}

function loadTarget(): number {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) return Math.min(MAX_TARGET, Math.max(MIN_TARGET, n));
  } catch {
    // fall through
  }
  return DEFAULT_TARGET;
}

function saveTarget(target: number): void {
  try {
    localStorage.setItem(TARGET_KEY, String(target));
  } catch {
    // localStorage unavailable; ignore.
  }
}
