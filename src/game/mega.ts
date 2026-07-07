import { Category, type Physics } from "../core/physics";
import type { EventBus } from "../core/events";
import type { GameClock } from "../core/time";
import type { Combat } from "./combat";

/** Kills must land inside this rolling window to count toward the burst. */
const BURST_WINDOW = 10;
/** Burst kills needed to arm mega mode. */
export const MEGA_THRESHOLD = 12;
/**
 * Post-release bullet-time timeline. Everything is ONE synchronized sequence
 * that starts the instant the blade whips out: world speed lerps down fast,
 * the optional cinematic camera orbit can begin, and the mega spin paces
 * itself to this exact timeline (Combat reads megaSlowMoTotal()). The world
 * cruises at SLOWMO_SCALE for the hold, then as time lerps back to normal the
 * sword spin winds down and the optional orbit settles with it.
 */
/**
 * Panel-tunable bullet-time choreography (Mega FX panel sliders, persisted).
 *
 * The mega release timeline:
 *   t=0            — blade releases: time SNAPS to `slowStart` (5× slow) the
 *                    same frame, and the camera orbit begins immediately.
 *   0 → rampIn     — time eases up to `slowHold` (3× slow). At the end of
 *                    this ramp the sword starts its spin.
 *   rampIn → +spinHold — the spin plays out in sustained slow-mo, audio
 *                    pitched down with it (iPhone slo-mo style).
 *   → +rampOut     — everything lerps back to full speed; the sword winds
 *                    down and the camera settles in the same window.
 *   → +wildTail    — normal-speed carnage plays out (lightning/grade fade).
 */
export const megaTuning = {
  /** Normal (non-mega) charged spin speed multiplier. */
  spinSpeed: 3,
  /** World speed the instant of release (0.2 = 5× slow). */
  slowStart: 0.2,
  /** Sustained world speed during the spin (0.33 ≈ 3× slow). */
  slowHold: 0.33,
  /** Seconds the slow-mo takes to ease from slowStart to slowHold. */
  rampIn: 0.5,
  /** Seconds the spin sustains in slow-mo. */
  spinHold: 1.3,
  /** Seconds to lerp back to full speed (spin + orbit wind down here). */
  rampOut: 0.7,
  /** Normal-speed aftermath seconds after time recovers. */
  wildTail: 2.0,
  /** Baseline radial depth-blur strength (tilt-shift edges, always on). */
  dofBase: 0.25,
  /** Extra depth blur layered in while the mega grade is live. */
  dofMega: 0.7,
  /** Cinematic camera wind-back/orbit. Off by default for live gameplay. */
  cameraSpin: 0,
  /** Camera orbit spin-up time — small = near-instant whip. */
  camRampIn: 0.15,
  /** Camera revolutions over the whole sequence. */
  camRevs: 1,
  /** Radians the camera winds BACK (against the spin) during the charge. */
  camWindup: 0.42,
  /** Sword revolutions across its spin — fast even in slow-mo; the speed
   * contrast against the crawling camera is what sells the power. */
  swordRevs: 2.5,
  /** Blade length multiplier (1 = the original short box). */
  swordLen: 2,
  /** Lightning warmth: 0 = cool blue-white, 1 = full amber. Tints bolts,
   * strike lights, and the post flash together. */
  boltYellow: 0.45,
  /** Average fork branches per bolt (0-4; the fraction is a chance of one more). */
  boltForks: 2,
};

const TUNING_PREFIX = "fabled-revolutions.mega.";

// Restore persisted tuning before anything reads it.
for (const key of Object.keys(megaTuning) as Array<keyof typeof megaTuning>) {
  try {
    const raw = localStorage.getItem(TUNING_PREFIX + key);
    if (raw === null) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) megaTuning[key] = v;
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

export function setMegaTuning(key: keyof typeof megaTuning, value: number): void {
  megaTuning[key] = value;
  try {
    localStorage.setItem(TUNING_PREFIX + key, String(value));
  } catch {
    // ignore
  }
}

/** Full slow-mo timeline length: ramp in → spin hold → ramp out. */
export function megaSlowMoTotal(): number {
  return megaTuning.rampIn + megaTuning.spinHold + megaTuning.rampOut;
}

/** Aftermath (lightning + post grade) covers the timeline + the wild tail. */
function aftermathLength(): number {
  return megaSlowMoTotal() + megaTuning.wildTail;
}
/** Physics shockwave on release: radius / impulse density. */
const BLAST_RADIUS = 12;
const BLAST_IMPULSE = 5;

/**
 * Mega mode: core gameplay glue (not a toggleable effect). Watches kill
 * timestamps on a rolling 10 s window; enough kills arms the overcharge and
 * lets the sword charge past level 1. The mega release detonates at full speed
 * — a real box3d explosion shoves every crate and corpse outward — then the
 * world lerps into slow motion (see the SLOWMO_* timeline) so the launched
 * bodies hang mid-flight, and eases back to real time as the lightning and
 * post grade play out.
 */
export class MegaSystem {
  /** Kills inside the current burst window. */
  burstKills = 0;
  /** True once the burst threshold is reached; consumed by the mega release. */
  armed = false;
  /** Seconds left in the post-release aftermath (0 = idle). */
  aftermath = 0;

  private readonly killTimes: number[] = [];
  /** Wall-clock seconds since the mega release, or -1 when idle. */
  private slowMoTimeline = -1;
  private wasCharging = false;
  /** Smoothed camera-crane yaw (wind-back during charge, whip on release). */
  private orbitAngle = 0;
  /** Orbit angle captured the instant of release — the spring's start. */
  private releaseStart = 0;
  /**
   * Wall-clock seconds since release for the CAMERA (or -1 idle). Runs longer
   * than the slow-mo timeline: the orbit cruises slowly through bullet time
   * and only completes its revolution during the normal-speed tail.
   */
  private orbitTimeline = -1;
  /** Mega release blast queued one update tick after the visual/audio release. */
  private pendingBlastFrames = -1;
  private pendingBlastX = 0;
  private pendingBlastZ = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly clock: GameClock,
    private readonly physics: Physics,
    private readonly combat: Combat,
  ) {
    bus.on("enemy-death", () => {
      this.killTimes.push(performance.now() / 1000);
    });

    bus.on("spin-attack", ({ origin, mega }) => {
      if (!mega) return;
      // Time snaps to the deep 5×-slow the SAME frame the blade releases —
      // no ramp down, straight into the frozen moment. The camera crane
      // springs from wherever the charge wound it back to.
      this.clock.slowMo = megaTuning.slowStart;
      this.slowMoTimeline = 0;
      if (megaTuning.cameraSpin >= 0.5) {
        this.orbitTimeline = 0;
        this.releaseStart = this.orbitAngle;
      } else {
        this.orbitTimeline = -1;
        this.releaseStart = 0;
      }
      // Physics fidelity halves during bullet time: 150 fresh ragdolls in one
      // contact island is the release-frame spike, and at 5×-slow nobody can
      // see the difference between 2 and 4 substeps.
      this.physics.subSteps = 2;
      this.armed = false;
      this.combat.megaArmed = false;
      this.aftermath = aftermathLength();
      // Reset the burst so the next mega must be earned from zero.
      this.killTimes.length = 0;
      // Fire visual/audio release immediately, then let the costly physics
      // explosion land on the next update tick so the release frame stays crisp.
      this.pendingBlastX = origin.x;
      this.pendingBlastZ = origin.z;
      this.pendingBlastFrames = 1;
      this.bus.emit("mega-release", { origin: origin.clone() });
    });
  }

  get active(): boolean {
    return this.aftermath > 0;
  }

  /** True while the post-release slow-mo timeline is running. */
  get slowMoActive(): boolean {
    return this.slowMoTimeline >= 0;
  }

  /**
   * Dev/showcase helper: bank `count` burst kills instantly. Defaults to the
   * full threshold; pass threshold-1 to leave the meter one kill shy so a
   * real hit on camera tips it over into MEGA READY.
   */
  debugArm(count = MEGA_THRESHOLD): void {
    const now = performance.now() / 1000;
    for (let i = 0; i < count; i++) this.killTimes.push(now);
  }

  reset(): void {
    this.burstKills = 0;
    this.armed = false;
    this.aftermath = 0;
    this.killTimes.length = 0;
    this.slowMoTimeline = -1;
    this.wasCharging = false;
    this.orbitAngle = 0;
    this.releaseStart = 0;
    this.orbitTimeline = -1;
    this.pendingBlastFrames = -1;
    this.pendingBlastX = 0;
    this.pendingBlastZ = 0;
    this.combat.megaArmed = false;
    this.clock.slowMo = 1;
    this.physics.subSteps = 4;
  }

  /**
   * Camera-crane yaw, physical in spirit: during a charge the crane winds
   * BACK against the coming spin (easing with the sword's own wind-up); on
   * release it springs from that wound angle, unwinding through zero and
   * whipping the full camRevs around when cameraSpin is enabled — spun up
   * almost instantly (camRampIn), cruising at constant angular speed on its
   * own clock, then decelerating over the tail to land exactly back at the
   * home framing (2π ≡ 0).
   */
  get cameraOrbit(): number {
    return this.orbitAngle;
  }

  private updateOrbit(unscaledDt: number): void {
    if (megaTuning.cameraSpin < 0.5) {
      this.orbitTimeline = -1;
      this.releaseStart = 0;
      this.orbitAngle += (0 - this.orbitAngle) * Math.min(1, 5 * unscaledDt);
      return;
    }

    if (this.orbitTimeline >= 0) {
      this.orbitTimeline += unscaledDt;
      // Release spring: trapezoidal velocity profile, integrated in closed
      // form so the landing is exact. The orbit's window is the slow-mo
      // timeline PLUS most of the wild tail — a much slower cruise than the
      // whirling blade, completing only as the chaos plays out at full speed.
      const total = megaSlowMoTotal() + megaTuning.wildTail * 0.8;
      const t = Math.min(1, this.orbitTimeline / total);
      const a = Math.min(0.4, Math.max(0.01, megaTuning.camRampIn / total));
      const b = 0.38;
      const area = (u: number): number => {
        if (u < a) return (u * u) / (2 * a);
        if (u < 1 - b) return a / 2 + (u - a);
        const w = u - (1 - b);
        return a / 2 + (1 - b - a) + w - (w * w) / (2 * b);
      };
      const end = Math.PI * 2 * Math.round(megaTuning.camRevs);
      this.orbitAngle = this.releaseStart + (end - this.releaseStart) * (area(t) / area(1));
      if (t >= 1) {
        this.orbitTimeline = -1;
        // 2π*revs ≡ 0: same framing, zeroed so the crane doesn't re-unwind.
        this.orbitAngle = 0;
      }
      return;
    }

    // Charge wind-back (any charge — the crane leans with the sword), easing
    // home when idle. Follows the charge level so it moves in the sword's
    // rhythm, not on its own timer.
    const charging = this.combat.charging;
    const c = Math.min(this.combat.chargeLevel, 2);
    const target = charging ? -megaTuning.camWindup * smoothstep(c / 2) : 0;
    const rate = charging ? 2.2 : 5;
    this.orbitAngle += (target - this.orbitAngle) * Math.min(1, rate * unscaledDt);
  }

  /** Call once per frame with UNSCALED dt (slow-mo must ramp on wall-clock). */
  update(unscaledDt: number): void {
    // Prune the rolling window + arm when the threshold is crossed.
    const now = performance.now() / 1000;
    while (this.killTimes.length > 0 && now - this.killTimes[0] > BURST_WINDOW) {
      this.killTimes.shift();
    }
    this.burstKills = this.killTimes.length;

    if (!this.armed && this.burstKills >= MEGA_THRESHOLD && this.aftermath <= 0) {
      this.armed = true;
      this.combat.megaArmed = true;
      this.bus.emit("mega-armed", {});
    }

    // mega-begin still marks the overcharge starting (FX/audio cue).
    const megaCharging = this.armed && this.combat.charging;
    if (megaCharging && !this.wasCharging) this.bus.emit("mega-begin", {});
    this.wasCharging = megaCharging;

    if (this.pendingBlastFrames >= 0) {
      if (this.pendingBlastFrames > 0) {
        this.pendingBlastFrames--;
      } else {
        // One real shockwave: downed agents, live enemies, and every crate in range.
        this.physics.explode(
          this.pendingBlastX,
          1,
          this.pendingBlastZ,
          BLAST_RADIUS,
          BLAST_IMPULSE,
          Category.Enemy | Category.Prop,
        );
        this.pendingBlastFrames = -1;
      }
    }

    // Post-release bullet-time timeline: ease in → hold → ease out.
    if (this.slowMoTimeline >= 0) {
      this.slowMoTimeline += unscaledDt;
      this.clock.slowMo = slowMoAt(this.slowMoTimeline);
      if (this.slowMoTimeline >= megaSlowMoTotal()) {
        this.slowMoTimeline = -1;
        this.clock.slowMo = 1;
        this.physics.subSteps = 4;
      }
    }

    this.updateOrbit(unscaledDt);

    if (this.aftermath > 0) {
      this.aftermath -= unscaledDt;
      if (this.aftermath <= 0) {
        this.aftermath = 0;
        this.bus.emit("mega-end", {});
      }
    }
  }
}

/**
 * Piecewise slow-mo curve over wall-clock time since release: starts AT
 * slowStart (deep 5×), eases up to slowHold (3×) over rampIn, sustains
 * through spinHold, then recovers to full speed over rampOut.
 */
function slowMoAt(t: number): number {
  let u = t;
  if (u < megaTuning.rampIn) {
    return lerp(megaTuning.slowStart, megaTuning.slowHold, smoothstep(u / megaTuning.rampIn));
  }
  u -= megaTuning.rampIn;
  if (u < megaTuning.spinHold) return megaTuning.slowHold;
  u -= megaTuning.spinHold;
  if (u < megaTuning.rampOut) {
    return lerp(megaTuning.slowHold, 1, smoothstep(u / megaTuning.rampOut));
  }
  return 1;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
