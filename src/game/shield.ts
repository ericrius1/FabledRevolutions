/**
 * Halo-style regenerating shield that sits in front of the hearts. Enemy touches
 * drain the shield first; only once it is empty do hits reach the hearts. After a
 * short lull with no damage the shield recharges on its own — get clear of the
 * agents for a beat and it fills back up.
 *
 * Timings (all wall-clock seconds):
 *  - `max` segments absorbed before the shield is down (~5 hits to drain).
 *  - `rechargeDelay` of no damage before regen kicks in.
 *  - `rechargeTime` to refill from empty to full once regen has started.
 *  - `hitCooldown` minimum gap between drained segments, so a swarm can't empty
 *    it in a single frame — sustained contact still drains it, just faster.
 */
export class Shield {
  private value: number;
  /** Seconds since the last hit landed (drives the regen delay). */
  private sinceDamage: number;
  /** Per-hit cooldown so one contact = at most one drained segment. */
  private cooldown = 0;

  constructor(
    readonly max = 10,
    private readonly rechargeDelay = 3,
    private readonly rechargeTime = 3,
    private readonly hitCooldown = 0.4,
  ) {
    this.value = max;
    this.sinceDamage = rechargeDelay + rechargeTime;
  }

  /** 0..1 fill for the meter. */
  get fraction(): number {
    return this.value / this.max;
  }

  get isUp(): boolean {
    return this.value > 0;
  }

  /** True while the shield is actively refilling (for the meter's glow). */
  get recharging(): boolean {
    return this.value < this.max && this.sinceDamage >= this.rechargeDelay;
  }

  /**
   * Register an enemy touch.
   *  - "absorbed": the shield ate it — hearts stay untouched.
   *  - "blocked":  on its per-hit cooldown — ignore this contact entirely.
   *  - "down":     shield empty — the caller should damage the hearts.
   */
  hit(): "absorbed" | "blocked" | "down" {
    if (this.cooldown > 0) return "blocked";
    // Any real contact resets the regen clock, even while the shield is down.
    this.sinceDamage = 0;
    if (this.value <= 0) return "down";
    this.value = Math.max(0, this.value - 1);
    this.cooldown = this.hitCooldown;
    return "absorbed";
  }

  /** Advance cooldown + regen. Feed UNSCALED dt so timings are wall-clock. */
  tick(dt: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    this.sinceDamage += dt;
    if (this.recharging) {
      this.value = Math.min(this.max, this.value + (this.max / this.rechargeTime) * dt);
    }
  }

  reset(): void {
    this.value = this.max;
    this.sinceDamage = this.rechargeDelay + this.rechargeTime;
    this.cooldown = 0;
  }
}
