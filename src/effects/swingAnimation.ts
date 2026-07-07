import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";
import { megaTuning } from "../game/mega";

/**
 * Sword swing pose. The combat system decides *when* hits land; this effect only
 * drives how the sword *looks* getting there, keyed off `combat.swingProgress`.
 *
 * ON: the sword winds back (anticipation), whips through the arc, then eases
 * into a follow-through before returning to rest.
 *
 * OFF: the sword still sweeps, but as a single linear back-and-forth with no
 * wind-up or overshoot, so a swing reads as a flat teleport-through-the-arc.
 * Either way the pivot returns exactly to its rest rotation, so disabling
 * mid-swing leaves no residue.
 */

// Rest, wound-back, and end-of-swing angles of the sword pivot (radians).
const REST_ANGLE = 0;
const WINDUP_ANGLE = 1.35;
const SWING_END_ANGLE = -1.55;
/** Charge pose: wound back past the normal windup, deeper as charge builds. */
const CHARGE_ANGLE = 1.9;
/** Full-charge tremble amplitude/frequency — a faint strain, not a jitter. */
const TREMBLE_AMP = 0.015;
const TREMBLE_FREQ = 18;
/** Easing rate (per second) the pivot takes toward its charge pose. */
const WIND_RATE = 6;

export class SwingAnimationEffect extends BaseEffect {
  readonly id = "swing-animation";
  readonly label = "Swing Animation";
  readonly description = "Sword sweeps in an arc with anticipation and follow-through.";
  readonly group: EffectGroup = "Attack";

  private time = 0;
  /** Smoothed pivot angle — the charge wind-back eases through this so state
   * transitions (swing → charge, rest → charge) never snap the blade. */
  private angle = REST_ANGLE;

  init(ctx: EffectContext): void {
    super.init(ctx);
    this.ctx.getPlayer().swordPivot.rotation.y = REST_ANGLE;
  }

  update(unscaledDt: number): void {
    this.time += unscaledDt;
    const player = this.ctx.getPlayer();
    const combat = player.combat;
    const pivot = player.swordPivot;

    if (!combat) {
      this.angle = REST_ANGLE;
      pivot.rotation.y = this.angle;
      return;
    }

    // Spin release: the pivot whips through full revolutions. The mega
    // snapback starts the instant of release but eases in HARD — the blade
    // creeps through its first beats in deep bullet time, surges through the
    // middle, and dies back down exactly as the world speeds up.
    if (combat.spinning) {
      const revs = combat.spinMega ? megaTuning.swordRevs : 1;
      const t = combat.spinMega
        ? easeInOutPow(combat.spinProgress, 2.2)
        : easeInOutCubic(combat.spinProgress);
      this.angle = CHARGE_ANGLE - t * (Math.PI * 2 * revs + CHARGE_ANGLE);
      pivot.rotation.y = this.angle;
      return;
    }

    // Charging: ease slowly back toward the wound pose (never snap), with a
    // faint strain-tremble once a full level is banked.
    if (combat.charging) {
      const c = Math.min(combat.chargeLevel, 2);
      const wound = lerp(REST_ANGLE, CHARGE_ANGLE, smooth01(Math.min(c, 1)));
      const tremble = c >= 1 ? Math.sin(this.time * TREMBLE_FREQ) * TREMBLE_AMP * (c / 2) : 0;
      const target = this.enabled ? wound + tremble : WINDUP_ANGLE;
      this.angle += (target - this.angle) * Math.min(1, WIND_RATE * unscaledDt);
      pivot.rotation.y = this.angle;
      return;
    }

    if (!combat.swinging) {
      // Ease home rather than teleporting (e.g. after a cancelled charge).
      // A finished spin leaves the angle at a whole number of negative
      // revolutions; wrap first so the ease doesn't visibly unwind them.
      this.angle = Math.atan2(Math.sin(this.angle), Math.cos(this.angle));
      this.angle += (REST_ANGLE - this.angle) * Math.min(1, 12 * unscaledDt);
      if (Math.abs(this.angle) < 0.001) this.angle = REST_ANGLE;
      pivot.rotation.y = this.angle;
      return;
    }

    const t = combat.swingProgress;
    this.angle = this.enabled ? this.easedAngle(t) : this.linearAngle(t);
    pivot.rotation.y = this.angle;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    // Reset to rest so a mid-swing toggle never freezes the sword askew.
    const player = this.ctx?.getPlayer();
    if (player) player.swordPivot.rotation.y = REST_ANGLE;
  }

  /** Full curve: brief wind-up, fast whip, soft settle back to rest. */
  private easedAngle(t: number): number {
    if (t < 0.18) {
      // Anticipation: ease from rest back to the wound-up pose.
      return lerp(REST_ANGLE, WINDUP_ANGLE, easeOutCubic(t / 0.18));
    }
    if (t < 0.55) {
      // Action: whip through the full arc.
      return lerp(WINDUP_ANGLE, SWING_END_ANGLE, easeInOutCubic((t - 0.18) / 0.37));
    }
    // Follow-through: gentle overshoot settling back to rest.
    return lerp(SWING_END_ANGLE, REST_ANGLE, easeOutBack((t - 0.55) / 0.45));
  }

  /** OFF pose: linear sweep with no wind-up or overshoot. */
  private linearAngle(t: number): number {
    if (t < 0.5) return lerp(REST_ANGLE, SWING_END_ANGLE, t / 0.5);
    return lerp(SWING_END_ANGLE, REST_ANGLE, (t - 0.5) / 0.5);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Symmetric ease with tunable sharpness — higher p = slower start and end. */
function easeInOutPow(t: number, p: number): number {
  return t < 0.5 ? 0.5 * Math.pow(2 * t, p) : 1 - 0.5 * Math.pow(2 * (1 - t), p);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
