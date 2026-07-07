/**
 * Central clock. Gameplay uses SCALED dt (so hit-stop can freeze the world by
 * dropping timeScale to ~0), while effects and UI read UNSCALED dt so shake,
 * particles, and HUD animations keep running during a freeze.
 */
export class GameClock {
  /** User pause (P). Freezes scaled gameplay; unscaled systems keep ticking. */
  paused = false;
  /** 0 = frozen, 1 = normal. Hit-stop drives this toward 0 then back to 1. */
  timeScale = 1;
  /**
   * Second, independent multiplier for sustained slow motion (mega-mode charge).
   * Kept separate from `timeScale` so hit-stop's snap-to-zero-and-back never
   * fights the mega system's smooth ramp — they multiply.
   */
  slowMo = 1;
  /**
   * When set, tick() reports exactly this dt instead of wall-clock time —
   * offline capture steps the sim deterministically at a fixed rate no matter
   * how fast frames actually render (or how throttled the tab is).
   */
  forcedDt: number | null = null;

  private last = performance.now() / 1000;
  private _unscaledDt = 0;
  private _scaledDt = 0;

  /** Call once per frame before updating anything. Returns unscaled dt. */
  tick(): number {
    const now = performance.now() / 1000;
    // Clamp to avoid huge steps after a tab stall.
    this._unscaledDt = this.forcedDt ?? Math.min(now - this.last, 0.1);
    this.last = now;
    this._scaledDt = this._unscaledDt * this.timeScale * this.slowMo;
    return this._unscaledDt;
  }

  get unscaledDt(): number {
    return this._unscaledDt;
  }

  get scaledDt(): number {
    return this.paused ? 0 : this._scaledDt;
  }
}
