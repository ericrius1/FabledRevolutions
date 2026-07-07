import { Category, type Physics } from "../core/physics";
import type { EventBus } from "../core/events";
import type { GameClock } from "../core/time";

/**
 * Air-dive bullet time + ground blast (core gameplay glue, not a toggleable
 * effect — the move should always FEEL heavy).
 *
 * The mega dive (a full overcharge held at launch) still gets the big impact
 * freeze, but the DESCENT stays full-speed. The move must read as a committed
 * downward slam, never as a floaty hover at the top of the jump.
 *
 * Either way, when the body slams the floor (`dive-impact`) a single real box3d
 * explosion shoves the crates in range outward. Enemies and building cubes are
 * instead hit by the TRAVELLING wave front as the displaced-floor crest
 * reaches them (see applyShockFrontsToEnemies in main and the scenario
 * `shock-front` handlers). The visual half (ground chunks, dust) lives in the
 * effects. The mega impact additionally emits `mega-smash`, which drives the
 * warm-palette mega spectacle (post-grade contraction + lightning storm).
 */

/** Blast geometry at power 1; scales with the event `power` (radius capped so
 * the 5×-power mega smash stays a big-but-sane blast, not the whole arena). */
const BLAST_RADIUS = 30;
const BLAST_RADIUS_CAP = 96;
const BLAST_IMPULSE = 17.5;

// ---- Post-impact bullet-time freeze (mega smash only) ----
/** World speed the frame he lands (0.14 ≈ 7× slow) — the deepest freeze. */
const SMASH_SLOW_START = 0.14;
/** Sustained bullet-time speed during the hold (0.3 ≈ 3.3× slow). */
const SMASH_SLOW_HOLD = 0.3;
/** Seconds to ease from the landing freeze up to the sustained hold. */
const SMASH_RAMP_IN = 0.14;
/** Seconds the bullet-time hold sustains while the storm erupts. */
const SMASH_HOLD = 0.5;
/** Seconds to lerp back to full speed as the aftermath plays out. */
const SMASH_RAMP_OUT = 0.95;

/** Full post-impact bullet-time length; effects pace their storm to this. */
export function smashSlowMoTotal(): number {
  return SMASH_RAMP_IN + SMASH_HOLD + SMASH_RAMP_OUT;
}

export class DiveSmash {
  /** Wall-clock seconds since the mega impact freeze, or -1 when idle. */
  private smashTimer = -1;

  constructor(
    private readonly bus: EventBus,
    private readonly clock: GameClock,
    private readonly physics: Physics,
  ) {
    bus.on("dive-start", ({ mega }) => {
      // The plunge itself must stay fast. A max-charge dive gets spectacle on
      // impact only; slowing the descent makes the player look like he floats.
      if (!mega) return;
      this.smashTimer = -1;
      this.clock.slowMo = 1;
    });

    bus.on("dive-impact", ({ origin, power, mega }) => {
      if (mega) {
        // SNAP into the deep freeze the frame he lands, then hold (the timeline
        // in update eases it back out). Physics fidelity drops during the
        // freeze — nobody can tell 2 substeps from 4 at 7× slow, and this is
        // the heaviest frame of the game.
        this.clock.slowMo = SMASH_SLOW_START;
        this.smashTimer = 0;
        this.physics.subSteps = 2;
        this.bus.emit("mega-smash", { origin: origin.clone(), power });
      } else {
        this.clock.slowMo = 1;
      }

      // The physical shockwave, prop half: one radial blast launches crates
      // outward+up. Enemies are NOT in this mask — they get launched by the
      // travelling wave front as the visible floor crest reaches them (see
      // applyShockFrontsToEnemies in main), so the crowd falls row by row.
      const radius = Math.min(BLAST_RADIUS_CAP, BLAST_RADIUS * power);
      this.physics.explode(
        origin.x,
        0.6,
        origin.z,
        radius,
        BLAST_IMPULSE * power,
        Category.Prop,
      );
    });
  }

  /** Call once per frame with UNSCALED dt (slow-mo runs on wall-clock). */
  update(unscaledDt: number): void {
    // Post-impact bullet-time freeze: ease in from the landing snap → hold →
    // ease back to real time.
    if (this.smashTimer >= 0) {
      this.smashTimer += unscaledDt;
      this.clock.slowMo = smashSlowMoAt(this.smashTimer);
      if (this.smashTimer >= smashSlowMoTotal()) {
        this.smashTimer = -1;
        this.clock.slowMo = 1;
        this.physics.subSteps = 4;
      }
    }
  }

  reset(): void {
    this.smashTimer = -1;
    this.clock.slowMo = 1;
    this.physics.subSteps = 4;
  }
}

/**
 * Piecewise bullet-time curve over wall-clock seconds since the mega impact:
 * starts AT the deep freeze, eases up to the sustained hold over rampIn, holds,
 * then recovers to full speed over rampOut.
 */
function smashSlowMoAt(t: number): number {
  let u = t;
  if (u < SMASH_RAMP_IN) {
    return lerp(SMASH_SLOW_START, SMASH_SLOW_HOLD, smoothstep(u / SMASH_RAMP_IN));
  }
  u -= SMASH_RAMP_IN;
  if (u < SMASH_HOLD) return SMASH_SLOW_HOLD;
  u -= SMASH_HOLD;
  if (u < SMASH_RAMP_OUT) {
    return lerp(SMASH_SLOW_HOLD, 1, smoothstep(u / SMASH_RAMP_OUT));
  }
  return 1;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
