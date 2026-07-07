import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * The box3d showcase effect: hits shove enemies with real rigid-body impulses
 * instead of just decrementing HP. A living enemy takes a horizontal impulse
 * away from the player (`dir` in the payload is player→enemy). A killing blow
 * additionally frees rotation locks and launches the downed agent with an
 * upward, outward impulse plus an angular impulse, so bodies tumble and — in
 * the crate yard — plow through stacked boxes.
 *
 * OFF: neither handler runs, so a hurt enemy simply loses HP standing still and
 * downed agents just tip over from the baseline Enemy.die() topple (core gameplay —
 * kills must read with every effect off). There is no residue to clean up.
 */

const HURT_IMPULSE = 20;
const KILL_IMPULSE = 24;
const KILL_LIFT = 5;
const KILL_SPIN = 5;
/** Lift is capped so mega launches skid across the floor, not into orbit. */
const MAX_LIFT_SCALE = 2.2;

/** Sub-linear power ramp: power 1 → 1×, spin ~2.4×, mega 5 → 3×. */
function powerScale(power: number): number {
  return 0.5 + 0.5 * power;
}

export class KnockbackEffect extends BaseEffect {
  readonly id = "knockback";
  readonly label = "Knockback";
  readonly description = "Applies a physics impulse away from the player; corpses spin on kill.";
  readonly group: EffectGroup = "Reaction";

  init(ctx: EffectContext): void {
    super.init(ctx);

    ctx.bus.on("enemy-hurt", ({ enemy, dir, power }) => {
      if (!this.enabled) return;
      // Living enemies keep their Y lock, so this reads as a hard skid across
      // the floor — Combat's stagger() already dropped their damping.
      const s = HURT_IMPULSE * powerScale(power);
      enemy.body.applyLinearImpulseToCenter(dir.x * s, 0, dir.z * s);
    });

    ctx.bus.on("enemy-death", ({ enemy, dir, power }) => {
      if (!this.enabled) return;
      // Rotation is already unlocked by Enemy.die(); just hurl the downed agent.
      const s = powerScale(power);
      enemy.body.applyLinearImpulseToCenter(
        dir.x * KILL_IMPULSE * s,
        KILL_LIFT * Math.min(s, MAX_LIFT_SCALE),
        dir.z * KILL_IMPULSE * s,
      );
      // Spin around a mostly-horizontal axis perpendicular to the launch dir.
      const spin = KILL_SPIN * s;
      enemy.body.applyAngularImpulse(
        -dir.z * spin,
        (Math.random() - 0.5) * spin,
        dir.x * spin,
      );
    });
  }
}
