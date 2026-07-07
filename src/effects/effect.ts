import type * as THREE from "three/webgpu";
import type { EventBus } from "../core/events";
import type { GameClock } from "../core/time";
import type { FollowCamera } from "../core/camera";
import type { Physics } from "../core/physics";
import type { Player } from "../game/player";
import type { Hud } from "../ui/hud";

/** Grouping shown in the UI panel. */
export type EffectGroup = "Attack" | "Reaction" | "Camera" | "UI" | "Audio";

/** Shared services an effect may touch. Passed once at init. */
export interface EffectContext {
  bus: EventBus;
  clock: GameClock;
  scene: THREE.Scene;
  camera: FollowCamera;
  physics: Physics;
  /** The HUD, so ui-feedback can trigger heart/bar/vignette animations. */
  hud: Hud;
  /** WebGPU renderer, so GPU-driven effects can dispatch TSL compute kernels. */
  renderer: THREE.WebGPURenderer;
  /** Live player ref; may change on scenario reset (effects re-read each frame). */
  getPlayer: () => Player;
}

/** A tunable number an effect exposes as a slider in the panel. */
export interface EffectParam {
  /** Stable key, also the localStorage suffix for persistence. */
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  get(): number;
  set(value: number): void;
}

/**
 * One toggleable juice effect. In M1 these are no-op stubs; M2 fills them in.
 * When `enabled` is false the effect must do nothing and leave the game fully
 * functional (just flat-feeling).
 */
export interface Effect {
  /** Stable id, also the localStorage key suffix. */
  readonly id: string;
  /** Human label for the UI toggle. */
  readonly label: string;
  /** One-line description (shown as a tooltip). */
  readonly description: string;
  /** UI grouping. */
  readonly group: EffectGroup;
  /** Optional tunables rendered as sliders under the toggle row. */
  readonly params?: readonly EffectParam[];

  /** Called once with shared services. Subscribe to bus events here. */
  init(ctx: EffectContext): void;
  /** Per-frame update. `unscaledDt` runs even during hit-stop. */
  update(unscaledDt: number): void;
  /** Called when the toggle flips. */
  setEnabled(enabled: boolean): void;
}

/** Convenience base implementing enabled-state + no-op lifecycle. */
export abstract class BaseEffect implements Effect {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly description: string;
  abstract readonly group: EffectGroup;

  protected enabled = false;
  protected ctx!: EffectContext;

  init(ctx: EffectContext): void {
    this.ctx = ctx;
  }

  update(_unscaledDt: number): void {
    // Override in subclasses that need per-frame work.
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}
