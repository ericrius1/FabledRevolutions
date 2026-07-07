import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";
import type { Enemy } from "../game/enemy";

/**
 * Squash & stretch on hit. A hurt enemy gets a quick vertical squash + lateral
 * stretch that springs back to rest (a damped bounce); a killing blow instead
 * pops the whole body up in scale before it launches. Both animate `group.scale`
 * around the enemy's `baseScale`, driven by a per-enemy phase timer.
 *
 * Enemies not currently animating are untouched, and on disable every tracked
 * enemy is snapped back to its base scale so nothing is left deformed.
 */

const HURT_TIME = 0.26;
const KILL_TIME = 0.22;

interface Anim {
  t: number;
  duration: number;
  kill: boolean;
}

export class EnemySquashEffect extends BaseEffect {
  readonly id = "enemy-squash";
  readonly label = "Enemy Squash";
  readonly description = "Squash & stretch scale punch on hurt, springing back; pop on death.";
  readonly group: EffectGroup = "Reaction";

  private readonly active = new Map<Enemy, Anim>();

  init(ctx: EffectContext): void {
    super.init(ctx);
    ctx.bus.on("attack-hit", ({ enemy, killed }) => {
      if (!this.enabled) return;
      this.active.set(enemy, {
        t: 0,
        duration: killed ? KILL_TIME : HURT_TIME,
        kill: killed,
      });
    });
  }

  update(unscaledDt: number): void {
    if (this.active.size === 0) return;
    for (const [enemy, anim] of this.active) {
      anim.t += unscaledDt;
      const p = Math.min(1, anim.t / anim.duration);
      const b = enemy.baseScale;
      if (anim.kill) {
        // Death pop: swell then settle.
        const s = 1 + Math.sin(p * Math.PI) * 0.4;
        enemy.group.scale.set(b.x * s, b.y * s, b.z * s);
      } else {
        // Damped bounce: squash short + wide, spring back through the rest pose.
        const bounce = Math.sin(p * Math.PI * 2) * (1 - p);
        enemy.group.scale.set(
          b.x * (1 + bounce * 0.28),
          b.y * (1 - bounce * 0.35),
          b.z * (1 + bounce * 0.28),
        );
      }
      if (p >= 1) {
        enemy.group.scale.copy(b);
        this.active.delete(enemy);
      }
    }
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  private clear(): void {
    for (const enemy of this.active.keys()) enemy.group.scale.copy(enemy.baseScale);
    this.active.clear();
  }
}
