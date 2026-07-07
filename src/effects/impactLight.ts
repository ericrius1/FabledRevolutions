import * as THREE from "three/webgpu";
import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

/**
 * A real point light pops at each impact so the flash physically illuminates
 * everyone standing nearby — enemies, the player, props — instead of the burst
 * being purely additive sprites. Kills fire a much brighter, longer flash.
 *
 * A tiny round-robin pool keeps overlapping hits lit independently. The lights
 * never cast shadows (that would force extra shadow passes per hit); they only
 * add warm fill, which is what sells the "explosion lights up the room" look.
 *
 * The pool lights stay in the scene with `visible = true` at all times — idle
 * ones just sit at intensity 0. Toggling a light's visibility changes the
 * renderer's lighting state and forces shader/pipeline recompiles mid-combat,
 * which is exactly the hitch this pool exists to avoid.
 */

const POOL = 3;
const LIGHT_COLOR = 0xffa85c;
const RANGE = 14;
const HIT_INTENSITY = 70;
const KILL_INTENSITY = 180;
const HIT_TIME = 0.22;
const KILL_TIME = 0.38;

interface Flash {
  light: THREE.PointLight;
  life: number;
  maxLife: number;
  peak: number;
}

export class ImpactLightEffect extends BaseEffect {
  readonly id = "impact-light";
  readonly label = "Impact Light";
  readonly description = "Point-light flash at impact illuminates nearby characters.";
  readonly group: EffectGroup = "Reaction";

  private readonly flashes: Flash[] = [];
  private cursor = 0;

  init(ctx: EffectContext): void {
    super.init(ctx);
    for (let i = 0; i < POOL; i++) {
      const light = new THREE.PointLight(LIGHT_COLOR, 0, RANGE, 2);
      ctx.scene.add(light);
      this.flashes.push({ light, life: 0, maxLife: HIT_TIME, peak: HIT_INTENSITY });
    }

    ctx.bus.on("attack-hit", ({ point, killed }) => {
      if (!this.enabled) return;
      const flash = this.flashes[this.cursor];
      this.cursor = (this.cursor + 1) % POOL;
      flash.light.position.set(point.x, Math.max(point.y, 0.8) + 0.4, point.z);
      flash.peak = killed ? KILL_INTENSITY : HIT_INTENSITY;
      flash.maxLife = killed ? KILL_TIME : HIT_TIME;
      flash.life = flash.maxLife;
      flash.light.intensity = flash.peak;
    });
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return;
    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life -= unscaledDt;
      if (flash.life <= 0) {
        flash.light.intensity = 0;
        continue;
      }
      const k = flash.life / flash.maxLife;
      // Quadratic decay: hard pop, fast falloff — reads as a flash, not a lamp.
      flash.light.intensity = flash.peak * k * k;
    }
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  private clear(): void {
    for (const flash of this.flashes) {
      flash.life = 0;
      if (flash.light) flash.light.intensity = 0;
    }
  }
}
