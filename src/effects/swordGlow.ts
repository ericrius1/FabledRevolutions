import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * The blade flares hot on a connected hit: an emissive surge on the sword
 * material that spikes at impact and cools back down over ~a quarter second.
 * Kills surge brighter and linger slightly longer.
 *
 * Charging takes the glow over entirely — the blade heats along a color ramp
 * (warm gold → hot orange → electric violet in the mega overcharge band) with
 * intensity climbing the whole way, plus a pulsing point light parented to the
 * sword so the charge visibly lights the player and nearby floor. Everything
 * is uniform-driven: no shader rebuilds, no extra draw calls; the one pooled
 * light stays in the scene at intensity 0 when idle (toggling visibility would
 * force pipeline recompiles mid-combat).
 */

const HIT_TIME = 0.25;
const KILL_TIME = 0.4;
const HIT_PEAK = 1.0;
const KILL_PEAK = 1.6;
/** Kept low enough that the blade reads as a glowing OBJECT, not a white blob. */
const EMISSIVE_GAIN = 2.2;

// Charge color ramp stops.
const COLOR_REST = new THREE.Color(0xffd27a); // warm gold (hit flash)
const COLOR_CHARGE = new THREE.Color(0xff7a2e); // hot orange at full charge
const COLOR_MEGA = new THREE.Color(0x9a5cff); // electric violet at overcharge
/** Charge light: intensity per unit of glow, and its falloff range. Modest —
 * a colored pool under the player, not a floor-washing searchlight. */
const LIGHT_GAIN = 8;
const LIGHT_RANGE = 7;
/** Full-charge pulse (breathing) speed/depth. */
const PULSE_FREQ = 9;
const PULSE_DEPTH = 0.12;

export class SwordGlowEffect extends BaseEffect {
  readonly id = "sword-glow";
  readonly label = "Sword Glow";
  readonly description = "Blade heats gold → orange → violet as it charges; flares on hit.";
  readonly group: EffectGroup = "Attack";

  private readonly uGlow = uniform(0);
  private readonly uColor = uniform(new THREE.Color().copy(COLOR_REST));
  private glow = 0;
  private peak = HIT_PEAK;
  private time = HIT_TIME;
  private clock = 0;
  private light!: THREE.PointLight;

  init(ctx: EffectContext): void {
    super.init(ctx);
    // Player (and its sword material) is created once at boot, so wiring the
    // emissive node here is safe across scenario switches.
    const player = ctx.getPlayer();
    const material = player.swordMesh.material as THREE.MeshStandardNodeMaterial;
    material.emissiveNode = this.uColor.mul(this.uGlow.mul(EMISSIVE_GAIN));

    // Charge light rides the sword pivot so it sweeps with the blade.
    this.light = new THREE.PointLight(COLOR_REST, 0, LIGHT_RANGE, 2);
    this.light.position.set(0, 0.2, 0.7);
    player.swordPivot.add(this.light);

    ctx.bus.on("attack-hit", ({ killed }) => {
      if (!this.enabled) return;
      this.peak = killed ? KILL_PEAK : HIT_PEAK;
      this.time = killed ? KILL_TIME : HIT_TIME;
      this.glow = 1;
    });

    // The dive slam flares the blade like a heavy kill — brighter for a mega.
    ctx.bus.on("dive-impact", ({ mega }) => {
      if (!this.enabled) return;
      this.peak = mega ? KILL_PEAK * 1.5 : KILL_PEAK;
      this.time = KILL_TIME;
      this.glow = 1;
    });
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return;
    this.clock += unscaledDt;

    const combat = this.ctx.getPlayer().combat;
    if (combat?.charging || combat?.spinning) {
      // Charge level 0..2 (spins hold their released level for the whole whirl).
      const c = combat.spinning ? (combat.spinMega ? 2 : 1) : combat.chargeLevel;

      // Color ramp: gold → orange over 0..1, orange → violet over 1..2.
      if (c <= 1) this.uColor.value.copy(COLOR_REST).lerp(COLOR_CHARGE, c);
      else this.uColor.value.copy(COLOR_CHARGE).lerp(COLOR_MEGA, c - 1);

      // Intensity climbs the whole ramp; breathe once a full level is banked.
      let heat = 0.25 + c * 0.55;
      if (c >= 1) heat *= 1 + Math.sin(this.clock * PULSE_FREQ) * PULSE_DEPTH;
      this.uGlow.value = heat;
      this.light.color.copy(this.uColor.value);
      this.light.intensity = heat * LIGHT_GAIN;

      // Prime the decay state so releasing eases down from the current heat.
      this.peak = heat;
      this.time = KILL_TIME;
      this.glow = 1;
      return;
    }

    if (this.glow <= 0) {
      this.light.intensity = 0;
      return;
    }
    this.glow = Math.max(0, this.glow - unscaledDt / this.time);
    // Sharp attack, smooth cool-down. Color eases back to the rest gold.
    const k = Math.pow(this.glow, 1.6);
    this.uGlow.value = k * this.peak;
    this.uColor.value.lerp(COLOR_REST, Math.min(1, unscaledDt * 6));
    this.light.color.copy(this.uColor.value);
    this.light.intensity = k * this.peak * LIGHT_GAIN * 0.5;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  private clear(): void {
    this.glow = 0;
    this.uGlow.value = 0;
    this.uColor.value.copy(COLOR_REST);
    if (this.light) this.light.intensity = 0;
  }
}
