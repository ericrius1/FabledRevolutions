import type { Effect, EffectContext } from "./effect";
import { SwingAnimationEffect } from "./swingAnimation";
import { SwordFlourishEffect } from "./swordFlourish";
import { WeaponTrailEffect } from "./weaponTrail";
import { HitStopEffect } from "./hitStop";
import { CameraShakeEffect } from "./cameraShake";
import { HitParticlesEffect } from "./hitParticles";
import { ImpactArcsEffect } from "./impactArcs";
import { ImpactLightEffect } from "./impactLight";
import { SwordGlowEffect } from "./swordGlow";
import { EnemyFlashEffect } from "./enemyFlash";
import { KnockbackEffect } from "./knockback";
import { EnemySquashEffect } from "./enemySquash";
import { UiFeedbackEffect } from "./uiFeedback";
import { SoundEffect } from "./sound";
import { CrtEffect } from "./crt";
import { MatrixGradeEffect } from "./matrixGrade";
import { MegaFxEffect } from "./megaFx";
import { StormDebrisEffect } from "./stormDebris";
import { DiveShockwaveEffect } from "./diveShockwave";
import { ImpactSmokeEffect } from "./impactSmoke";
import { RainEffect } from "./rain";
import { CloakEffect } from "./cloak";
import { FogGlowEffect } from "./fogGlow";

const STORAGE_PREFIX = "fabled-revolutions.effect.";

// Effects defaulting to off (everything else defaults on). Hit-stop and the
// CRT flash stack up badly during mass-kill spins (freeze chains + a post pass
// per hit), so they're opt-in now.
const DEFAULT_OFF = new Set<string>(["hit-stop", "crt-flash"]);

// One-time migration: older sessions have hit-stop/crt-flash persisted ON from
// when they defaulted on. Clearing their stored values once lets the new
// defaults take effect; anyone re-enabling afterwards persists as usual.
const DEFAULTS_VERSION_KEY = "fabled-revolutions.defaults-version";
const DEFAULTS_VERSION = "2";

function migrateDefaults(): void {
  try {
    if (localStorage.getItem(DEFAULTS_VERSION_KEY) === DEFAULTS_VERSION) return;
    for (const id of DEFAULT_OFF) localStorage.removeItem(STORAGE_PREFIX + id);
    localStorage.setItem(DEFAULTS_VERSION_KEY, DEFAULTS_VERSION);
  } catch {
    // localStorage unavailable; nothing to migrate.
  }
}

/**
 * Single source of truth for the effect roster. Order here drives both update
 * order and the UI panel layout. Adding an effect = one file + one entry.
 */
export function createEffects(): Effect[] {
  return [
    new SwingAnimationEffect(),
    // Flourish must run after swing-animation (it layers pitch onto the same
    // pivot) and before the trail samples the blade transform.
    new SwordFlourishEffect(),
    new WeaponTrailEffect(),
    new SwordGlowEffect(),
    new HitStopEffect(),
    new CameraShakeEffect(),
    new HitParticlesEffect(),
    new ImpactArcsEffect(),
    new ImpactLightEffect(),
    new EnemyFlashEffect(),
    new KnockbackEffect(),
    new EnemySquashEffect(),
    new CrtEffect(),
    new MatrixGradeEffect(),
    new MegaFxEffect(),
    new StormDebrisEffect(),
    new DiveShockwaveEffect(),
    new ImpactSmokeEffect(),
    new CloakEffect(),
    new RainEffect(),
    new FogGlowEffect(),
    new UiFeedbackEffect(),
    new SoundEffect(),
  ];
}

/** Owns the effect list: init, per-frame update, enable/disable + persistence. */
export class EffectManager {
  readonly effects: readonly Effect[];
  private readonly enabledState = new Map<string, boolean>();

  constructor(effects: Effect[] = createEffects()) {
    this.effects = effects;
  }

  init(ctx: EffectContext): void {
    migrateDefaults();
    for (const effect of this.effects) {
      effect.init(ctx);
      const enabled = this.loadEnabled(effect.id);
      this.enabledState.set(effect.id, enabled);
      effect.setEnabled(enabled);
    }
  }

  update(unscaledDt: number): void {
    for (const effect of this.effects) effect.update(unscaledDt);
  }

  isEnabled(id: string): boolean {
    return this.enabledState.get(id) ?? false;
  }

  setEnabled(id: string, enabled: boolean): void {
    const effect = this.effects.find((e) => e.id === id);
    if (!effect) return;
    this.enabledState.set(id, enabled);
    effect.setEnabled(enabled);
    this.saveEnabled(id, enabled);
  }

  setAll(enabled: boolean): void {
    for (const effect of this.effects) this.setEnabled(effect.id, enabled);
  }

  private loadEnabled(id: string): boolean {
    const defaultValue = !DEFAULT_OFF.has(id);
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + id);
      // Default ON (except DEFAULT_OFF) so a fresh visitor sees the juice;
      // explicit stored value persists.
      return raw === null ? defaultValue : raw === "true";
    } catch {
      return defaultValue;
    }
  }

  private saveEnabled(id: string, enabled: boolean): void {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, String(enabled));
    } catch {
      // localStorage may be unavailable (private mode); ignore.
    }
  }
}
