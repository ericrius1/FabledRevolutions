import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * Hit-stop: the single most impactful piece of melee juice. On a landed hit we
 * slam the clock's `timeScale` to 0, freezing gameplay + physics for a few dozen
 * milliseconds so the impact registers, then snap it back to 1. A killing blow
 * freezes for twice as long.
 *
 * The freeze timer counts down on UNSCALED dt (wall-clock) — if it used scaled
 * dt it would never advance while the world is frozen and lock up forever.
 * On disable the timeScale is restored immediately so no residue remains.
 */

const HIT_FREEZE = 0.07; // ~70 ms
const KILL_FREEZE = 0.14; // ~140 ms

export class HitStopEffect extends BaseEffect {
  readonly id = "hit-stop";
  readonly label = "Hit Stop";
  readonly description = "Freezes game time ~70ms on hit, ~140ms on a killing blow.";
  readonly group: EffectGroup = "Camera";

  private freezeTimer = 0;

  init(ctx: EffectContext): void {
    super.init(ctx);
    ctx.bus.on("attack-hit", ({ killed }) => {
      if (!this.enabled) return;
      // Take the longer of any in-progress and new freeze.
      this.freezeTimer = Math.max(this.freezeTimer, killed ? KILL_FREEZE : HIT_FREEZE);
      this.ctx.clock.timeScale = 0;
    });
  }

  update(unscaledDt: number): void {
    if (this.freezeTimer <= 0) return;
    this.freezeTimer -= unscaledDt;
    if (this.freezeTimer <= 0) {
      this.freezeTimer = 0;
      if (!this.ctx.clock.paused) this.ctx.clock.timeScale = 1;
    }
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    // Un-freeze instantly when turned off mid-stop.
    if (!enabled) {
      this.freezeTimer = 0;
      if (this.ctx && !this.ctx.clock.paused) this.ctx.clock.timeScale = 1;
    }
  }
}
