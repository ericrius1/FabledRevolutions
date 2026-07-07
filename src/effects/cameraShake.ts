import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * Trauma-based camera shake (the Squirrel Eiserloh model). Events add "trauma"
 * (0..1); each frame the actual shake is trauma² so it ramps in punchy and
 * decays smoothly. Offset and roll are driven by cheap value-noise sampled at a
 * high frequency, giving a jittery hand-held feel rather than a sine wobble.
 *
 * We write into the camera's reserved `shakeOffset` / `shakeRoll` each frame
 * (including zeroing them at rest), so the follow camera stays decoupled and
 * disabling the effect leaves no residual offset.
 */

const TRAUMA_HIT = 0.42;
const TRAUMA_KILL = 0.75;
const TRAUMA_PLAYER_HURT = 0.55;
const DECAY_PER_SEC = 1.6;
const MAX_OFFSET = 0.9; // world units at full trauma
const MAX_ROLL = 0.05; // radians at full trauma
const FREQUENCY = 22; // noise samples per second

export class CameraShakeEffect extends BaseEffect {
  readonly id = "camera-shake";
  readonly label = "Camera Shake";
  readonly description = "Trauma-based positional + roll shake, scaled by event weight.";
  readonly group: EffectGroup = "Camera";

  private trauma = 0;
  private time = 0;
  // Distinct noise seeds per channel so axes move independently.
  private readonly seeds = [11.3, 47.9, 83.1];

  init(ctx: EffectContext): void {
    super.init(ctx);
    ctx.bus.on("attack-hit", ({ killed }) => {
      this.addTrauma(killed ? TRAUMA_KILL : TRAUMA_HIT);
    });
    ctx.bus.on("player-hurt", () => this.addTrauma(TRAUMA_PLAYER_HURT));
    ctx.bus.on("spin-attack", ({ mega }) => this.addTrauma(mega ? 0.6 : 0.45));
    // The mega detonation maxes the trauma meter outright.
    ctx.bus.on("mega-release", () => this.addTrauma(1));
    // Dive slam: a heavy jolt, maxed for the mega variant.
    ctx.bus.on("dive-impact", ({ mega }) => this.addTrauma(mega ? 1 : 0.7));
  }

  update(unscaledDt: number): void {
    const cam = this.ctx.camera;
    if (!this.enabled || this.trauma <= 0) {
      cam.shakeOffset.set(0, 0, 0);
      cam.shakeRoll = 0;
      return;
    }

    this.time += unscaledDt;
    this.trauma = Math.max(0, this.trauma - DECAY_PER_SEC * unscaledDt);
    const shake = this.trauma * this.trauma;
    const t = this.time * FREQUENCY;

    cam.shakeOffset.set(
      noise(t, this.seeds[0]) * MAX_OFFSET * shake,
      noise(t, this.seeds[1]) * MAX_OFFSET * shake,
      0,
    );
    cam.shakeRoll = noise(t, this.seeds[2]) * MAX_ROLL * shake;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) {
      this.trauma = 0;
      if (this.ctx) {
        this.ctx.camera.shakeOffset.set(0, 0, 0);
        this.ctx.camera.shakeRoll = 0;
      }
    }
  }

  private addTrauma(amount: number): void {
    if (!this.enabled) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }
}

/** Cheap smooth value noise in [-1, 1] from a scalar phase + seed. */
function noise(t: number, seed: number): number {
  const x = t + seed;
  const i = Math.floor(x);
  const f = x - i;
  const a = hash(i);
  const b = hash(i + 1);
  const u = f * f * (3 - 2 * f); // smoothstep
  return (a + (b - a) * u) * 2 - 1;
}

function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
