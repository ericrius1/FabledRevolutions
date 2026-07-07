import * as THREE from "three/webgpu";
import type { EventBus } from "../core/events";
import type { Player } from "./player";
import type { Enemy } from "./enemy";
import type { EnemySpatialIndex } from "./enemySpatialIndex";
import { megaSlowMoTotal, megaTuning } from "./mega";

/** Total swing duration (anticipation -> contact -> recovery). */
const SWING_DURATION = 0.26;
/**
 * Hits resolve every frame the swing is inside this window (fractions of the
 * swing). A window, not a single frame, so an enemy that steps into the arc
 * mid-swing — or that the player turns toward — still gets clipped. This is
 * what makes contact feel responsive rather than luck-of-the-frame.
 */
const CONTACT_START = 0.18;
const CONTACT_END = 0.62;
/**
 * Minimum time between swing *starts*. Shorter than SWING_DURATION so a held /
 * mashed attack chains the instant the previous swing's contact window closes,
 * giving rapid slicing without letting a single click double-hit.
 */
const ATTACK_COOLDOWN = 0.16;
/**
 * A click that arrives while busy is remembered this long and fired the moment
 * the swing frees up — so early clicks aren't silently eaten.
 */
const BUFFER_WINDOW = 0.18;

/** Half-angle of the hit sector, radians (~130° total arc). */
const ATTACK_HALF_ANGLE = (Math.PI / 180) * 65;
const KNOCKBACK_DIST = 0.4; // used to nudge the reported hit point outward

// ---- Charge / spin attack ----
/** Attack must stay held this long (past any swing) before charging begins. */
const CHARGE_HOLD_DELAY = 0.16;
/** Seconds of holding to reach a full normal charge (level 1). */
const CHARGE_TIME = 1.0;
/** Extra seconds from level 1 to the mega overcharge cap (level 2). */
const OVERCHARGE_TIME = 1.3;
/** Releasing below this charge cancels instead of spinning. */
const MIN_RELEASE_CHARGE = 0.3;
/** Charge level a mega release requires (deep into the overcharge band). */
const MEGA_RELEASE_LEVEL = 1.5;
/** Base normal spin length; divided by megaTuning.spinSpeed (3× = whip). */
const SPIN_DURATION = 0.55;
/**
 * Mega spin hits all land within this wall-clock window from release —
 * during the frozen 5×-slow moment, before the blade even starts its slow
 * whirl — so the crowd is launched INTO bullet time by the blast itself.
 */
const MEGA_HIT_WINDOW_WALL = 0.5;
/** Spin hit radius grows with charge; mega clears most of the screen. */
const SPIN_RANGE_BASE = 3.4;
const MEGA_SPIN_RANGE = 10;
const SPIN_DAMAGE = 2;
/** Knockback power multipliers reported on hit events. Normal charged spins
 * hit hard now (max ≈ the old mega); the mega release doubles that again. */
const SPIN_POWER_BASE = 3.2;
const SPIN_POWER_PER_CHARGE = 2.2;
const MEGA_POWER = 10;
/**
 * Max spin hits resolved per frame. A packed mega spin can touch 100+ enemies;
 * landing them all on one frame stacks that many kill events (impulses, GPU
 * particle dispatches, audio voices) into a single hitch. Capping per frame
 * and taking nearest-first spreads the cost across the spin window and reads
 * as a shockwave expanding outward.
 */
const SPIN_HITS_PER_FRAME = 9;

type CombatTuningKey = "swingRange" | "swingPower" | "maxChargeSpinRangeMultiplier";

interface CombatTuningMeta {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
}

const COMBAT_TUNING_META: Record<CombatTuningKey, CombatTuningMeta> = {
  swingRange: {
    label: "swing range",
    min: 1.5,
    max: 4,
    step: 0.1,
    defaultValue: 2.5,
  },
  swingPower: {
    label: "swing power",
    min: 0.3,
    max: 2,
    step: 0.05,
    defaultValue: 0.85,
  },
  maxChargeSpinRangeMultiplier: {
    label: "max range x",
    min: 1,
    max: 5,
    step: 0.1,
    defaultValue: 3,
  },
};

export const combatTuning: Record<CombatTuningKey, number> = {
  swingRange: COMBAT_TUNING_META.swingRange.defaultValue,
  swingPower: COMBAT_TUNING_META.swingPower.defaultValue,
  maxChargeSpinRangeMultiplier: COMBAT_TUNING_META.maxChargeSpinRangeMultiplier.defaultValue,
};

export const combatTuningParams = Object.entries(COMBAT_TUNING_META).map(([key, meta]) => ({
  key: `combat-${key}`,
  label: meta.label,
  min: meta.min,
  max: meta.max,
  step: meta.step,
  get: () => combatTuning[key as CombatTuningKey],
  set: (value: number) => setCombatTuning(key as CombatTuningKey, value),
}));

const TUNING_PREFIX = "fabled-revolutions.combat.";
const TUNING_SCHEMA_KEY = `${TUNING_PREFIX}schema`;
const TUNING_SCHEMA = JSON.stringify(COMBAT_TUNING_META);

restoreCombatTuning();

function setCombatTuning(key: CombatTuningKey, value: number): void {
  const meta = COMBAT_TUNING_META[key];
  combatTuning[key] = THREE.MathUtils.clamp(value, meta.min, meta.max);
  try {
    localStorage.setItem(TUNING_SCHEMA_KEY, TUNING_SCHEMA);
    localStorage.setItem(TUNING_PREFIX + key, String(combatTuning[key]));
  } catch {
    // localStorage unavailable; keep the live value only.
  }
}

function restoreCombatTuning(): void {
  try {
    if (localStorage.getItem(TUNING_SCHEMA_KEY) !== TUNING_SCHEMA) {
      for (const key of Object.keys(COMBAT_TUNING_META)) {
        localStorage.removeItem(TUNING_PREFIX + key);
      }
      localStorage.setItem(TUNING_SCHEMA_KEY, TUNING_SCHEMA);
      return;
    }
    for (const key of Object.keys(COMBAT_TUNING_META) as CombatTuningKey[]) {
      const raw = localStorage.getItem(TUNING_PREFIX + key);
      if (raw === null) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) setCombatTuning(key, value);
    }
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

// ---- Dive smash ----
/** Damage radius under the landing blade at dive power 1; grows with the
 * event's power (the max-charge mega dive lands at 5×). */
const DIVE_RANGE = 3.5;
/** Wall-clock window after touchdown during which dive hits resolve — paired
 * with the per-frame cap it reads as the shockwave expanding outward. */
const DIVE_HIT_WINDOW = 0.3;
const DIVE_DAMAGE = 2;
/** Knockback multiplier reported on dive hit events (scaled by dive power). */
const DIVE_HIT_POWER = 4;

/**
 * Owns attack timing and sector hit detection. Emits events; effects and the
 * game react. Hits resolve across a contact *window* (not one frame), and each
 * enemy can only be struck once per swing so the window can't multi-hit.
 *
 * Beyond the basic swing there is a Zelda-style charge: holding attack winds
 * the sword up (chargeLevel 0..1, or up to 2 while mega is armed); releasing
 * unleashes a 360° spin that hits everything in a radius with power scaled by
 * the charge. Effects read `charging` / `chargeLevel` / `spinning` /
 * `spinProgress` directly for their visuals.
 */
export class Combat {
  /** True while a swing is in progress (drives swing-animation timing). */
  swinging = false;
  /** 0..1 progress through the current swing (unscaled). */
  swingProgress = 0;

  /** True while the attack button is held past the charge threshold. */
  charging = false;
  /** 0..1 normal charge; 1..2 is the mega overcharge band. */
  chargeLevel = 0;
  /** True while the release spin is playing. */
  spinning = false;
  /** 0..1 progress through the spin. */
  spinProgress = 0;
  /** True when the in-flight spin is a mega release. */
  spinMega = false;
  /** Set by the mega system: unlocks the overcharge band (level 1 → 2). */
  megaArmed = false;

  private held = false;
  private heldTime = 0;
  private spinPower = 1;
  private spinRange = SPIN_RANGE_BASE;
  /** Wall-clock duration of the in-flight spin (mega spans the bullet time). */
  private spinDuration = SPIN_DURATION;
  /** Mega: seconds the blade holds its wound pose before whirling (rampIn).
   * Public so the swing animation can deepen the windup as it counts down. */
  spinDelay = 0;
  /** Wall-clock seconds since the spin released (drives the mega hit window). */
  private spinElapsed = 0;
  private cooldown = 0;
  /** Remaining time a buffered attack stays valid, or 0 if none pending. */
  private bufferTimer = 0;
  /** Remaining dive-damage window after a dive-impact, or 0 when idle. */
  private diveTimer = 0;
  /** Power carried by the in-flight dive impact (1 normal, 5 mega). */
  private divePower = 1;
  /** True when the resolving dive was the mega variant (lethal hits). */
  private diveMega = false;
  /** Impact point the dive damage radiates from (player may move after). */
  private readonly diveOrigin = new THREE.Vector3();
  /** Enemies already hit by the in-progress swing/spin (cleared per attack). */
  private readonly hitThisSwing = new Set<Enemy>();
  private readonly origin = new THREE.Vector3();
  private readonly facing = new THREE.Vector3();
  private readonly hitDir = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly toEnemy = new THREE.Vector3();
  private readonly queryEnemies: Enemy[] = [];
  private readonly hitCandidates: Enemy[] = [];
  private readonly hitCandidateDistSq: number[] = [];

  constructor(private readonly bus: EventBus) {
    // The dive's physical shove (DiveSmash's explosion) is separate; combat
    // owns the sword's damage so the slam kills with every effect toggled off.
    bus.on("dive-impact", ({ origin, power, mega }) => {
      this.diveTimer = DIVE_HIT_WINDOW;
      this.divePower = power;
      this.diveMega = mega;
      this.diveOrigin.copy(origin);
      this.hitThisSwing.clear();
    });
  }

  get onCooldown(): boolean {
    return this.cooldown > 0;
  }

  /** True while a mega overcharge is actively being held. */
  get megaCharging(): boolean {
    return this.charging && this.megaArmed;
  }

  /**
   * Request a swing. Starts immediately if free; otherwise the request is
   * buffered so it fires the instant the current swing/cooldown clears.
   * Returns true if a swing started this call.
   */
  tryAttack(player: Player): boolean {
    if (this.canSwing()) {
      this.beginSwing(player);
      return true;
    }
    if (!this.charging && !this.spinning) this.bufferTimer = BUFFER_WINDOW;
    return false;
  }

  /** Per-frame held state from input; drives the charge build-up. */
  setHeld(held: boolean): void {
    this.held = held;
    if (!held) this.heldTime = 0;
  }

  /** Attack button released: unleash the spin if charged enough (ground only). */
  release(player: Player): void {
    this.heldTime = 0;
    // Never spin during a jump arc or off the ground — dive owns those releases.
    if (player.inAirArc || player.jumpsUsed > 0 || !player.touchingGround) {
      this.cancelCharge();
      return;
    }
    if (!this.charging) return;
    this.charging = false;
    const charge = this.chargeLevel;
    this.chargeLevel = 0;
    if (charge < MIN_RELEASE_CHARGE) {
      this.bus.emit("charge-cancel", {});
      return;
    }
    this.beginSpin(player, charge);
  }

  /**
   * Drop the current charge WITHOUT firing a spin — used when an airborne
   * release is spent on a mega dive smash instead of an air spin.
   */
  cancelCharge(): void {
    this.heldTime = 0;
    if (!this.charging) return;
    this.charging = false;
    this.chargeLevel = 0;
    this.bus.emit("charge-cancel", {});
  }

  /**
   * Dive has priority over every sword state. Clear swing/charge/spin timers so
   * an airborne attack cannot keep floating in a wind-up or whirl animation.
   */
  cancelForDive(): void {
    const wasCharging = this.charging;
    this.heldTime = 0;
    this.swinging = false;
    this.swingProgress = 0;
    this.charging = false;
    this.chargeLevel = 0;
    this.spinning = false;
    this.spinProgress = 0;
    this.spinDelay = 0;
    this.spinElapsed = 0;
    this.bufferTimer = 0;
    this.hitThisSwing.clear();
    if (wasCharging) this.bus.emit("charge-cancel", {});
  }

  reset(): void {
    const wasCharging = this.charging;
    this.held = false;
    this.heldTime = 0;
    this.swinging = false;
    this.swingProgress = 0;
    this.charging = false;
    this.chargeLevel = 0;
    this.spinning = false;
    this.spinProgress = 0;
    this.spinMega = false;
    this.megaArmed = false;
    this.spinPower = 1;
    this.spinRange = SPIN_RANGE_BASE;
    this.spinDuration = SPIN_DURATION;
    this.spinDelay = 0;
    this.spinElapsed = 0;
    this.cooldown = 0;
    this.bufferTimer = 0;
    this.diveTimer = 0;
    this.divePower = 1;
    this.diveMega = false;
    this.hitThisSwing.clear();
    if (wasCharging) this.bus.emit("charge-cancel", {});
  }

  private canSwing(): boolean {
    return !this.swinging && !this.charging && !this.spinning && this.cooldown <= 0;
  }

  private beginSwing(player: Player): void {
    this.swinging = true;
    this.swingProgress = 0;
    this.cooldown = ATTACK_COOLDOWN;
    this.bufferTimer = 0;
    this.hitThisSwing.clear();
    this.origin.copy(player.position);
    this.facing.copy(player.facing);
    this.bus.emit("attack-start", {
      origin: this.origin.clone(),
      facing: this.facing.clone(),
    });
  }

  /**
   * Advance swing + cooldown clocks and resolve hits across the contact window.
   * `dt` is UNSCALED so swings play at wall-clock speed and a killing-blow
   * hit-stop doesn't freeze the swing that caused it. The charge also builds
   * on wall-clock time. The mega spin is wall-clock too, with its duration set
   * to the bullet-time timeline (megaSlowMoTotal), so blade, camera orbit, and
   * time dilation stay in lockstep by construction.
   */
  update(
    dt: number,
    player: Player,
    enemies: readonly Enemy[],
    enemyIndex?: EnemySpatialIndex,
  ): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);

    // Fire a buffered attack the moment we're free.
    if (this.bufferTimer > 0) {
      this.bufferTimer = Math.max(0, this.bufferTimer - dt);
      if (this.canSwing()) this.beginSwing(player);
    }

    // Dive damage radiates from the impact point across a short window,
    // nearest-first — the sword lands on top, the shockwave takes the rest.
    if (this.diveTimer > 0) {
      this.diveTimer = Math.max(0, this.diveTimer - dt);
      this.origin.copy(this.diveOrigin);
      this.resolveHits(
        enemies,
        DIVE_RANGE * this.divePower,
        Math.PI,
        this.diveMega ? 999 : DIVE_DAMAGE,
        DIVE_HIT_POWER * this.divePower,
        SPIN_HITS_PER_FRAME,
        enemyIndex,
      );
    }

    this.updateCharge(dt, player);
    if (this.spinning) this.updateSpin(dt, player, enemies, enemyIndex);

    if (!this.swinging) return;

    this.swingProgress = Math.min(1, this.swingProgress + dt / SWING_DURATION);

    // Origin + facing track the player so hits follow movement/aim mid-swing.
    this.origin.copy(player.position);
    this.facing.copy(player.facing);

    // Fire the contact event once, on the frame the window opens.
    const enteringWindow =
      this.swingProgress >= CONTACT_START &&
      this.swingProgress - dt / SWING_DURATION < CONTACT_START;
    if (enteringWindow) {
      this.bus.emit("attack-swing-contact", {
        origin: this.origin.clone(),
        facing: this.facing.clone(),
      });
    }

    if (this.swingProgress >= CONTACT_START && this.swingProgress <= CONTACT_END) {
      this.resolveHits(
        enemies,
        combatTuning.swingRange,
        ATTACK_HALF_ANGLE,
        1,
        combatTuning.swingPower,
        Infinity,
        enemyIndex,
      );
    }

    if (this.swingProgress >= 1) this.swinging = false;
  }

  /** Build charge while held; start charging once the hold delay passes. */
  private updateCharge(dt: number, player: Player): void {
    if (!this.held) return;
    if (player.diving || player.inAirArc || player.jumpsUsed > 0 || !player.touchingGround) {
      return;
    }
    this.heldTime += dt;
    if (!this.charging && !this.swinging && !this.spinning && this.heldTime >= CHARGE_HOLD_DELAY) {
      this.charging = true;
      this.chargeLevel = 0;
      this.bus.emit("charge-start", {});
    }
    if (!this.charging) return;

    const cap = this.megaArmed ? 2 : 1;
    const rate = this.chargeLevel < 1 ? 1 / CHARGE_TIME : 1 / OVERCHARGE_TIME;
    const prev = this.chargeLevel;
    this.chargeLevel = Math.min(cap, this.chargeLevel + dt * rate);
    if (prev < 1 && this.chargeLevel >= 1) this.bus.emit("charge-full", { mega: false });
    if (prev < 2 && this.chargeLevel >= 2) this.bus.emit("charge-full", { mega: true });
  }

  private beginSpin(player: Player, charge: number): void {
    if (player.inAirArc || player.jumpsUsed > 0) return;
    this.spinning = true;
    this.spinProgress = 0;
    this.spinMega = this.megaArmed && charge >= MEGA_RELEASE_LEVEL;
    this.hitThisSwing.clear();
    this.origin.copy(player.position);

    this.spinElapsed = 0;
    if (this.spinMega) {
      this.spinPower = MEGA_POWER;
      this.spinRange = MEGA_SPIN_RANGE;
      // The blade starts its snapback the instant of release (heavily eased,
      // so it CREEPS at first) and spans the whole bullet-time timeline.
      this.spinDelay = 0;
      this.spinDuration = megaSlowMoTotal();
    } else {
      const c = Math.min(charge, 1);
      this.spinPower = SPIN_POWER_BASE + c * SPIN_POWER_PER_CHARGE;
      this.spinRange =
        SPIN_RANGE_BASE *
        THREE.MathUtils.lerp(1, combatTuning.maxChargeSpinRangeMultiplier, c);
      this.spinDelay = 0;
      this.spinDuration = SPIN_DURATION / Math.max(1, megaTuning.spinSpeed);
    }

    this.bus.emit("spin-attack", {
      origin: this.origin.clone(),
      power: this.spinPower,
      mega: this.spinMega,
      range: this.spinRange,
    });
  }

  private updateSpin(
    dt: number,
    player: Player,
    enemies: readonly Enemy[],
    enemyIndex?: EnemySpatialIndex,
  ): void {
    this.spinElapsed += dt;
    // Mega: blade holds the wound pose through the deep-slow ramp.
    if (this.spinDelay > 0) {
      this.spinDelay = Math.max(0, this.spinDelay - dt);
    } else {
      this.spinProgress = Math.min(1, this.spinProgress + dt / this.spinDuration);
    }
    this.origin.copy(player.position);

    // Hit the full circle so nothing escapes on a frame boundary. Mega hits
    // all land in the first half second of wall time — the blast launches the
    // crowd into the frozen moment before the blade even starts its whirl.
    const inWindow = this.spinMega
      ? this.spinElapsed <= MEGA_HIT_WINDOW_WALL
      : this.spinProgress >= 0.05 && this.spinProgress <= 0.85;
    if (inWindow) {
      const damage = this.spinMega ? 999 : SPIN_DAMAGE;
      this.resolveHits(
        enemies,
        this.spinRange,
        Math.PI,
        damage,
        this.spinPower,
        SPIN_HITS_PER_FRAME,
        enemyIndex,
      );
    }

    if (this.spinProgress >= 1) {
      this.spinning = false;
      this.spinProgress = 0;
      this.cooldown = ATTACK_COOLDOWN;
      // Effects hook this for the return-to-guard flourish.
      this.bus.emit("spin-end", { mega: this.spinMega });
    }
  }

  /**
   * Sector hit test shared by swings (130° cone) and spins (halfAngle = π,
   * i.e. the full circle). `maxHits` caps how many land this call — candidates
   * are taken nearest-first so a capped spin reads as an expanding shockwave.
   */
  private resolveHits(
    enemies: readonly Enemy[],
    range: number,
    halfAngle: number,
    damage: number,
    power: number,
    maxHits = Infinity,
    enemyIndex?: EnemySpatialIndex,
  ): void {
    this.hitCandidates.length = 0;
    this.hitCandidateDistSq.length = 0;
    const queryRadius = range + 1;
    const source = enemyIndex
      ? enemyIndex.collectCircle(this.origin.x, this.origin.z, queryRadius, this.queryEnemies)
      : enemies;
    const limited = Number.isFinite(maxHits);
    const maxCount = limited ? maxHits : Infinity;
    const minDot = halfAngle < Math.PI ? Math.cos(halfAngle) : -1;

    // Gather candidates in range/sector first (cheap distance math only). When
    // capped, keep the nearest N in-place instead of sorting a fresh object list.
    for (const enemy of source) {
      if (enemy.dead || this.hitThisSwing.has(enemy)) continue;
      const dx = enemy.position.x - this.origin.x;
      const dz = enemy.position.z - this.origin.z;
      const distSq = dx * dx + dz * dz;
      // Include the enemy's body radius so contact registers on the surface,
      // not the center — a fast enemy grazing the tip still counts.
      const reach = range + enemy.radius;
      if (distSq > reach * reach || distSq < 1e-8) continue;
      if (halfAngle < Math.PI) {
        const invDist = 1 / Math.sqrt(distSq);
        const dot = (dx * invDist) * this.facing.x + (dz * invDist) * this.facing.z;
        if (dot < minDot) continue;
      }
      if (!limited || this.hitCandidates.length < maxCount) {
        this.hitCandidates.push(enemy);
        this.hitCandidateDistSq.push(distSq);
        continue;
      }

      let farthest = 0;
      let farthestDistSq = this.hitCandidateDistSq[0];
      for (let i = 1; i < this.hitCandidateDistSq.length; i++) {
        if (this.hitCandidateDistSq[i] > farthestDistSq) {
          farthest = i;
          farthestDistSq = this.hitCandidateDistSq[i];
        }
      }
      if (distSq < farthestDistSq) {
        this.hitCandidates[farthest] = enemy;
        this.hitCandidateDistSq[farthest] = distSq;
      }
    }

    if (limited) {
      for (let i = 1; i < this.hitCandidates.length; i++) {
        const enemy = this.hitCandidates[i];
        const distSq = this.hitCandidateDistSq[i];
        let j = i - 1;
        while (j >= 0 && this.hitCandidateDistSq[j] > distSq) {
          this.hitCandidates[j + 1] = this.hitCandidates[j];
          this.hitCandidateDistSq[j + 1] = this.hitCandidateDistSq[j];
          j--;
        }
        this.hitCandidates[j + 1] = enemy;
        this.hitCandidateDistSq[j + 1] = distSq;
      }
    }

    for (const enemy of this.hitCandidates) {
      this.toEnemy.copy(enemy.position).sub(this.origin);
      this.toEnemy.y = 0;
      const dist = this.toEnemy.length();
      if (dist < 0.0001) continue;
      this.toEnemy.multiplyScalar(1 / dist);

      this.hitThisSwing.add(enemy);

      // Hit! Direction is player -> enemy (used for knockback).
      this.hitDir.copy(this.toEnemy);
      this.hitPoint
        .copy(enemy.position)
        .addScaledVector(this.hitDir, -KNOCKBACK_DIST);
      this.hitPoint.y = 1.0;

      const landed = enemy.health.damage(damage);
      if (!landed) continue;
      // Stagger scales with power: big hits stun longer and drop the body's
      // damping so the knockback impulse reads as a long slide.
      enemy.stagger(power);

      const killed = enemy.health.isDead;
      const point = this.hitPoint.clone();
      const dir = this.hitDir.clone();

      this.bus.emit("attack-hit", { enemy, point, dir, killed, power });
      if (killed) {
        // Baseline topple is core gameplay (works with all effects off); the
        // knockback effect adds the big launch on the enemy-death event.
        enemy.die(dir, power);
        this.bus.emit("enemy-death", { enemy, point, dir, power });
      } else {
        this.bus.emit("enemy-hurt", { enemy, point, dir, power });
      }
    }
  }
}
