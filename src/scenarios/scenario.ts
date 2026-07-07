import type * as THREE from "three/webgpu";
import type { Physics } from "../core/physics";
import type { EventBus } from "../core/events";
import type { Player } from "../game/player";
import type { Enemy } from "../game/enemy";

/** Services a scenario needs to build and drive its world. */
export interface ScenarioContext {
  physics: Physics;
  scene: THREE.Scene;
  bus: EventBus;
  player: Player;
}

/**
 * A self-contained level. `setup` builds the arena + initial enemies, `update`
 * runs per-frame spawning/respawn logic, `dispose` tears everything down for a
 * clean switch. The live enemy list is owned by the scenario.
 */
export interface Scenario {
  readonly id: string;
  readonly label: string;
  /** Where the player spawns/respawns (XZ). */
  readonly playerSpawn: THREE.Vector2;

  setup(ctx: ScenarioContext): void;
  /** Advance scenario logic. `scaledDt` freezes with hit-stop. */
  update(scaledDt: number): void;
  /** Current scenario enemies, including temporarily downed agents. */
  readonly enemies: readonly Enemy[];
  dispose(): void;
  /**
   * Optional scenario-specific tuning controls (horde size, city construction
   * sliders, ...). When present, the panel mounts this inside a collapsed-by-
   * default fold rather than the scenario floating its own fixed element.
   */
  readonly controlElement?: HTMLElement;
}

/** Registry entry for the UI scenario `<select>`. */
export interface ScenarioEntry {
  id: string;
  label: string;
  create: () => Scenario;
}
