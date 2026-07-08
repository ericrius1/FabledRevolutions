import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * Makes the HUD react to combat. On player damage the hearts row pulses/shakes
 * and a red vignette flashes; on an enemy taking a hit its floating health bar
 * shakes. All motion lives in CSS animations on the HUD; this effect just fires
 * the triggers on the right events.
 *
 * OFF: no triggers fire, so hearts and bars stay visible but perfectly static
 * (they still track HP — only the juice motion is gone). Nothing to clean up on
 * disable since the animations are transient.
 */
export class UiFeedbackEffect extends BaseEffect {
  readonly id = "ui-feedback";
  readonly label = "UI Feedback";
  readonly description = "Hearts pulse, enemy bars shake, red vignette on player damage.";
  readonly group: EffectGroup = "UI";

  init(ctx: EffectContext): void {
    super.init(ctx);

    ctx.bus.on("player-hurt", () => {
      if (!this.enabled) return;
      ctx.hud.pulseHearts();
      ctx.hud.flashVignette();
    });

    ctx.bus.on("player-shielded", () => {
      if (!this.enabled) return;
      ctx.hud.pulseShield();
    });

    ctx.bus.on("enemy-hurt", ({ enemy }) => {
      if (!this.enabled) return;
      ctx.hud.shakeEnemyBar(enemy.id);
    });
  }
}
