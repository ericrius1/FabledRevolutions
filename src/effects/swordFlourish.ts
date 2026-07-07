import * as THREE from "three/webgpu";
import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";
import { HAND_RANGE } from "../game/player";

/**
 * The detached sword hand + its flourishes. The fist and blade ride a floating
 * mount (player.handPivot) that this effect drifts around its rest point inside
 * a small spherical range at the player's side — Rayman rules, no arm. Because
 * the hand can move OFF the body, the blade can wheel through full circles
 * without ever clipping the capsule.
 *
 * On top of the float it plays samurai/fencing flourishes as an extra PITCH
 * axis on the sword pivot (the swing animation owns yaw, so they never fight):
 *
 *  - double jump:   a quick aerial moulinet — one full wheel of the blade
 *  - spin release:  the blade wheels once (twice, wider for mega) beside the
 *                   body before settling back to the on-guard position
 *  - dive smash:    the hand rides high and wide so the plunge reads; on
 *                   touchdown the blade carries on around — out of the ground,
 *                   around behind, over the top, back to guard
 *
 * The hand also leans with movement (a light velocity lag), coils in while
 * charging, and bobs faintly at rest, so it always feels alive.
 *
 * OFF: the hand pins to its rest point and the player's baseline poses apply
 * unchanged — exactly the pre-flourish look.
 */

const TWO_PI = Math.PI * 2;

/** Easing rate (1/s) of the hand float in ordinary states. */
const EASE_RATE = 10;
/** Snappier rate for the dive pose and flourish timelines. */
const FAST_RATE = 18;
/** Pitch easing rate outside flourish timelines (which write it directly). */
const PITCH_RATE = 14;
/** Velocity-lag factor: seconds of velocity the hand trails behind by. */
const LAG = 0.022;

/** Sword pitch during the dive — deeper than the player's baseline thrust so
 * the plunge reads as fully committed (the body adds its own forward lean). */
const DIVE_PITCH = 0.9;

type FlourishKind = "jump" | "spin" | "mega" | "land";

const FLOURISH_DURATION: Record<FlourishKind, number> = {
  jump: 0.38,
  spin: 0.6,
  mega: 1.05,
  land: 0.55,
};

interface Flourish {
  kind: FlourishKind;
  t: number;
  /** Pitch the timeline starts from (the land sweep continues the plunge). */
  fromPitch: number;
}

export class SwordFlourishEffect extends BaseEffect {
  readonly id = "sword-flourish";
  readonly label = "Sword Flourish";
  readonly description =
    "Detached floating hand; moulinet twirls after spins, dives, and double jumps.";
  readonly group: EffectGroup = "Attack";

  private time = 0;
  /** Current hand offset from its rest point (aim-pivot local space). */
  private readonly offset = new THREE.Vector3();
  private readonly targetOffset = new THREE.Vector3();
  private readonly vel = { x: 0, y: 0, z: 0 };
  /** Extra pitch written onto the sword pivot each frame. */
  private pitch = 0;
  private flourish: Flourish | null = null;
  private prevJumps = 0;

  init(ctx: EffectContext): void {
    super.init(ctx);
    ctx.bus.on("spin-end", ({ mega }) => this.startFlourish(mega ? "mega" : "spin"));
    ctx.bus.on("dive-impact", () => this.startFlourish("land"));
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return;
    this.time += unscaledDt;
    const player = this.ctx.getPlayer();
    const combat = player.combat;

    // Double-jump rising edge → aerial moulinet.
    if (player.jumpsUsed === 2 && this.prevJumps < 2 && !player.diving) {
      this.startFlourish("jump");
    }
    this.prevJumps = player.jumpsUsed;

    // The plunge owns the blade — a dive cancels any twirl in flight.
    if (player.diving) this.flourish = null;

    const target = this.targetOffset.set(0, 0, 0);
    let rate = EASE_RATE;
    let pitchTarget = 0;

    if (player.diving) {
      // Hand high and wide of the pitched-forward body; blade thrust down.
      target.set(0.42, 0.5, 0.15);
      pitchTarget = DIVE_PITCH;
      rate = FAST_RATE;
    } else if (this.flourish) {
      rate = FAST_RATE;
      this.advanceFlourish(this.flourish, target, unscaledDt);
    } else if (combat?.spinning) {
      // Hold the blade wide of the body while it whirls.
      target.set(0.38, 0.12, 0);
    } else if (combat?.charging) {
      // Coil: the hand draws in and back with the wind-up.
      target.set(-0.06, -0.08, -0.2);
    } else if (player.jumpsUsed > 0) {
      // Airborne: hand lifts a touch, blade raised — ready to cut on the way down.
      target.set(0.12, 0.22, 0.05);
      pitchTarget = -0.3;
    } else {
      // At-rest float: a faint three-axis bob so the hand never sits dead.
      target.set(
        Math.sin(this.time * 1.3) * 0.03,
        Math.sin(this.time * 2.1) * 0.045,
        Math.sin(this.time * 1.7 + 1.3) * 0.025,
      );
    }

    // Movement lag: the hand trails the body's velocity slightly (converted to
    // aim-local axes), selling the "floating, loosely attached" read.
    if (!this.flourish && !player.diving) {
      player.body.getLinearVelocity(this.vel);
      const f = player.facing;
      target.x -= (this.vel.x * f.z - this.vel.z * f.x) * LAG;
      target.z -= (this.vel.x * f.x + this.vel.z * f.z) * LAG;
      target.y -= this.vel.y * LAG * 0.5;
    }

    // Ease toward the target and clamp to the hand's spherical range.
    const k = 1 - Math.exp(-rate * unscaledDt);
    this.offset.lerp(target, k);
    if (this.offset.length() > HAND_RANGE) this.offset.setLength(HAND_RANGE);
    player.handPivot.position.copy(player.handRest).add(this.offset);

    // Pitch: timelines write it directly inside advanceFlourish; every other
    // state eases. Runs after player.syncMesh, so this wins over the baseline.
    if (!this.flourish) {
      this.pitch += (pitchTarget - this.pitch) * (1 - Math.exp(-PITCH_RATE * unscaledDt));
    }
    player.swordPivot.rotation.x = this.pitch;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (enabled) return;
    // Pin the hand home; the player re-baselines the pivot pitch every sync.
    this.flourish = null;
    this.pitch = 0;
    this.offset.set(0, 0, 0);
    const player = this.ctx?.getPlayer();
    if (player) player.handPivot.position.copy(player.handRest);
  }

  private startFlourish(kind: FlourishKind): void {
    if (!this.enabled) return;
    this.flourish = { kind, t: 0, fromPitch: this.pitch };
  }

  /** Advance the active flourish: writes `this.pitch` and the hand target. */
  private advanceFlourish(f: Flourish, target: THREE.Vector3, dt: number): void {
    f.t += dt;
    const u = Math.min(1, f.t / FLOURISH_DURATION[f.kind]);
    // Hand arcs out and back over the timeline.
    const arc = Math.sin(Math.PI * u);

    switch (f.kind) {
      case "jump":
        // One reverse wheel — tip sweeps up and over with the leap.
        this.pitch = -TWO_PI * easeInOutCubic(u);
        target.set(0.3 * arc, 0.28 * arc, 0);
        break;
      case "spin":
        this.pitch = -TWO_PI * easeInOutCubic(u);
        target.set(0.5 * arc, 0.22 * arc, 0);
        break;
      case "mega":
        // Grander: two wheels, hand swept high and wide before settling.
        this.pitch = -2 * TWO_PI * easeInOutCubic(u);
        target.set(0.6 * arc, 0.45 * arc, 0);
        break;
      case "land":
        // Continue the plunge's rotation on around — out of the ground,
        // behind, over the top, forward into guard (2π ≡ rest).
        this.pitch = f.fromPitch + (TWO_PI - f.fromPitch) * easeOutCubic(u);
        target.set(0.45 * arc, -0.3 * (1 - u), 0.1 * arc);
        break;
    }

    if (u >= 1) {
      this.flourish = null;
      this.pitch = 0;
    }
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
