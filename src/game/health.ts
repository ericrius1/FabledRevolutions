/** Simple HP container with optional invulnerability window (i-frames). */
export class Health {
  private hp: number;
  private iFrameTimer = 0;

  constructor(
    readonly max: number,
    /** Seconds of invulnerability after taking damage (0 = none). */
    private readonly iFrameDuration = 0,
  ) {
    this.hp = max;
  }

  get current(): number {
    return this.hp;
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }

  get invulnerable(): boolean {
    return this.iFrameTimer > 0;
  }

  /** Advance i-frame timer. Call with UNSCALED dt so mercy time is wall-clock. */
  tick(dt: number): void {
    if (this.iFrameTimer > 0) this.iFrameTimer = Math.max(0, this.iFrameTimer - dt);
  }

  /** Apply damage. Returns true if it landed (not blocked by i-frames). */
  damage(amount: number): boolean {
    if (this.invulnerable || this.isDead) return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.iFrameDuration > 0) this.iFrameTimer = this.iFrameDuration;
    return true;
  }

  reset(): void {
    this.hp = this.max;
    this.iFrameTimer = 0;
  }
}
