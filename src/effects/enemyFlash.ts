import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";
import type { Enemy } from "../game/enemy";

/**
 * Brief white emissive flash on a hurt enemy — the cheapest, highest-read hit
 * confirmation. On `attack-hit` we push the enemy's body material emissive to
 * white and decay it back to black over ~100 ms. Multiple enemies can flash at
 * once, so active flashes are tracked in a map keyed by enemy.
 *
 * The material's original emissive is captured lazily and always restored, so
 * disabling mid-flash (or an enemy dying mid-flash) leaves the material clean.
 */

const FLASH_TIME = 0.1;

export class EnemyFlashEffect extends BaseEffect {
  readonly id = "enemy-flash";
  readonly label = "Enemy Flash";
  readonly description = "Hurt enemy flashes white/emissive briefly on hit.";
  readonly group: EffectGroup = "Reaction";

  private readonly active = new Map<Enemy, number>();

  init(ctx: EffectContext): void {
    super.init(ctx);
    ctx.bus.on("attack-hit", ({ enemy }) => {
      if (!this.enabled) return;
      this.active.set(enemy, FLASH_TIME);
    });
  }

  update(unscaledDt: number): void {
    if (this.active.size === 0) return;
    for (const [enemy, timer] of this.active) {
      const remaining = timer - unscaledDt;
      const k = Math.max(0, remaining / FLASH_TIME);
      enemy.setFlash(k);
      if (remaining <= 0) {
        enemy.setFlash(0);
        this.active.delete(enemy);
      } else {
        this.active.set(enemy, remaining);
      }
    }
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  private clear(): void {
    for (const enemy of this.active.keys()) enemy.setFlash(0);
    this.active.clear();
  }
}
