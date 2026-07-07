import * as THREE from "three/webgpu";
import { float, mix, positionLocal, smoothstep, uniform } from "three/tsl";
import { BaseEffect, type EffectGroup, type EffectParam } from "./effect";
import type { EffectContext } from "./effect";

/**
 * Distance haze that reacts to the fight. Two pieces working together:
 *
 * 1. A camera-centered gradient dome (horizon color → darker zenith) replaces
 *    the flat background at the fog line, so the linear fog dissolves into a
 *    sky that matches it exactly — no visible seam where the world "ends".
 * 2. The shared horizon color is re-lit every frame from big events: mega
 *    lightning strobes it cool blue-white, the mega release washes it green,
 *    dive impacts push a short warm pulse. Each pulse decays exponentially and
 *    is attenuated by distance from the camera, so the whole horizon appears
 *    to catch the light of whatever just detonated nearby.
 *
 * scene.fog.color, scene.background and the dome all track the same computed
 * color, which is what sells the "goes on forever" read.
 */

// Must sit inside the camera far plane (500) and past the fog end so the dome
// is fully hazed-to-invisible geometry-wise and only its color reads.
function domeRadius(): number {
  return Math.max(480, fogTuning.far + 40);
}

// Base haze matches the scene background set in main.ts.
const BASE_HORIZON = new THREE.Color(0x1a1e1e);

export const fogTuning = {
  /** Linear fog begins at this distance from the camera. */
  near: 140,
  /** Linear fog is fully opaque by this distance. */
  far: 360,
  /** Zenith sits darker so the sky falls off overhead instead of reading as a wall. */
  zenithScale: 0.45,
  /** Fraction of the event glow that spills up into the zenith. */
  zenithGlow: 0.55,
};

const TUNING_PREFIX = "fabled-revolutions.fog.";
const TUNING_SCHEMA_KEY = `${TUNING_PREFIX}schema`;
const TUNING_SCHEMA = "horizon-v1";
for (const key of Object.keys(fogTuning) as Array<keyof typeof fogTuning>) {
  try {
    const schema = localStorage.getItem(TUNING_SCHEMA_KEY);
    if (schema !== TUNING_SCHEMA) {
      for (const staleKey of Object.keys(fogTuning)) {
        localStorage.removeItem(TUNING_PREFIX + staleKey);
      }
      localStorage.setItem(TUNING_SCHEMA_KEY, TUNING_SCHEMA);
      break;
    }
    const raw = localStorage.getItem(TUNING_PREFIX + key);
    if (raw === null) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) fogTuning[key] = v;
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

/** Apply live fog distances to the scene (works even when Horizon Fog is off). */
export function applySceneFog(scene: THREE.Scene): void {
  if (!scene.fog || !(scene.fog as THREE.Fog).isFog) return;
  const fog = scene.fog as THREE.Fog;
  fog.near = fogTuning.near;
  fog.far = Math.max(fogTuning.near + 1, fogTuning.far);
}

export function setFogTuning(key: keyof typeof fogTuning, value: number): void {
  fogTuning[key] = value;
  if (key === "far") fogTuning.far = Math.max(fogTuning.near + 1, value);
  if (key === "near") fogTuning.near = Math.min(value, fogTuning.far - 1);
  try {
    localStorage.setItem(TUNING_PREFIX + key, String(fogTuning[key]));
  } catch {
    // ignore
  }
}

// Event pulse palette — reuses the tones the effects themselves flash with so
// the horizon looks lit by them rather than doing its own thing.
const LIGHTNING_COLOR = new THREE.Color(0xcfe4ff);
const MEGA_COLOR = new THREE.Color(0x66ffc2);
const DIVE_COLOR = new THREE.Color(0xffd39a);

/** One decaying additive glow contribution. */
interface Pulse {
  readonly color: THREE.Color;
  intensity: number;
  /** Exponential decay time constant (seconds). */
  readonly tau: number;
}

// Beyond ~this distance an event stops meaningfully lighting the horizon.
const ATTEN_DIST = 70;

/** Panel slider bound to one fogTuning field (persisted). */
function fogParam(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  field: keyof typeof fogTuning,
  onSet?: () => void,
): EffectParam {
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => fogTuning[field],
    set: (v: number) => {
      setFogTuning(field, Math.min(max, Math.max(min, v)));
      onSet?.();
    },
  };
}

export class FogGlowEffect extends BaseEffect {
  readonly id = "fog-glow";
  readonly label = "Horizon Fog";
  readonly description =
    "Gradient sky dome + fog haze that catches the light of lightning, mega blasts and dive impacts.";
  readonly group: EffectGroup = "Reaction";

  readonly params: readonly EffectParam[] = [
    fogParam("fog-near", "fog start", 40, 280, 5, "near", () => this.syncSceneFog()),
    fogParam("fog-far", "fog end", 180, 490, 5, "far", () => this.syncSceneFog()),
    fogParam("fog-zenith", "zenith dark", 0.1, 1, 0.05, "zenithScale"),
    fogParam("fog-glow", "horizon glow", 0, 1.5, 0.05, "zenithGlow"),
  ];

  private readonly pulses = {
    lightning: { color: LIGHTNING_COLOR, intensity: 0, tau: 0.12 } as Pulse,
    mega: { color: MEGA_COLOR, intensity: 0, tau: 0.9 } as Pulse,
    dive: { color: DIVE_COLOR, intensity: 0, tau: 0.4 } as Pulse,
  };

  private dome: THREE.Mesh | null = null;
  private domeRadiusBuilt = 0;
  private readonly uHorizon = uniform(BASE_HORIZON.clone());
  private readonly uZenith = uniform(BASE_HORIZON.clone().multiplyScalar(fogTuning.zenithScale));

  // Scratch — composed every frame, zero allocation.
  private readonly horizon = new THREE.Color();
  private readonly zenith = new THREE.Color();
  private readonly glow = new THREE.Color();

  init(ctx: EffectContext): void {
    super.init(ctx);
    this.syncSceneFog();
    ctx.bus.on("mega-lightning", ({ point }) => this.hit("lightning", 0.9, point));
    ctx.bus.on("mega-release", ({ origin }) => this.hit("mega", 0.65, origin));
    ctx.bus.on("dive-impact", ({ origin, power, mega }) =>
      this.hit("dive", 0.35 * power * (mega ? 1.6 : 1), origin),
    );
  }

  private hit(kind: keyof FogGlowEffect["pulses"], strength: number, at: THREE.Vector3): void {
    if (!this.enabled) return;
    const d = this.ctx.camera.camera.position.distanceTo(at);
    const atten = 1 / (1 + (d / ATTEN_DIST) * (d / ATTEN_DIST));
    const pulse = this.pulses[kind];
    pulse.intensity = Math.min(1, pulse.intensity + strength * atten);
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return;

    // Decay pulses and accumulate their additive glow.
    this.glow.setRGB(0, 0, 0);
    for (const pulse of Object.values(this.pulses)) {
      if (pulse.intensity <= 0.001) {
        pulse.intensity = 0;
        continue;
      }
      this.glow.r += pulse.color.r * pulse.intensity;
      this.glow.g += pulse.color.g * pulse.intensity;
      this.glow.b += pulse.color.b * pulse.intensity;
      pulse.intensity *= Math.exp(-unscaledDt / pulse.tau);
    }

    this.horizon.copy(BASE_HORIZON).add(this.glow);
    this.zenith.copy(BASE_HORIZON).multiplyScalar(fogTuning.zenithScale);
    this.zenith.r += this.glow.r * fogTuning.zenithGlow;
    this.zenith.g += this.glow.g * fogTuning.zenithGlow;
    this.zenith.b += this.glow.b * fogTuning.zenithGlow;

    const scene = this.ctx.scene;
    if (scene.fog) scene.fog.color.copy(this.horizon);
    if (scene.background instanceof THREE.Color) scene.background.copy(this.zenith);
    (this.uHorizon.value as THREE.Color).copy(this.horizon);
    (this.uZenith.value as THREE.Color).copy(this.zenith);

    // Dome rides the camera so its horizon band never parallaxes — the sky
    // reads as infinitely far even though it's a 480-unit sphere.
    if (this.dome) this.dome.position.copy(this.ctx.camera.camera.position);
  }

  private syncSceneFog(): void {
    if (!this.ctx) return;
    applySceneFog(this.ctx.scene);
    const r = domeRadius();
    if (this.dome && this.domeRadiusBuilt !== r) {
      this.ctx.scene.remove(this.dome);
      this.dome.geometry.dispose();
      (this.dome.material as THREE.Material).dispose();
      this.dome = null;
      this.domeRadiusBuilt = 0;
    }
    if (this.enabled) {
      if (!this.dome) this.dome = this.buildDome();
      if (!this.dome.parent) this.ctx.scene.add(this.dome);
    }
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (enabled) {
      if (!this.dome) this.dome = this.buildDome();
      this.ctx.scene.add(this.dome);
    } else {
      if (this.dome) this.ctx.scene.remove(this.dome);
      // Hand the flat look back exactly as main.ts set it up.
      const scene = this.ctx.scene;
      if (scene.fog) scene.fog.color.copy(BASE_HORIZON);
      if (scene.background instanceof THREE.Color) scene.background.copy(BASE_HORIZON);
      for (const pulse of Object.values(this.pulses)) pulse.intensity = 0;
    }
  }

  private buildDome(): THREE.Mesh {
    const radius = domeRadius();
    this.domeRadiusBuilt = radius;
    const material = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      depthWrite: false,
    });
    // The fog would otherwise swallow the dome entirely (it sits past the fog
    // end); its gradient IS the "fogged sky", so it must render unfogged.
    material.fog = false;
    // Elevation 0..1 over the dome; the horizon color holds through a low band
    // (and everything below y=0) before easing into the zenith, so the fog
    // line lands on a constant-color region and can't show a seam.
    const elevation = positionLocal.y.div(radius).clamp(0, 1);
    material.colorNode = mix(this.uHorizon, this.uZenith, smoothstep(float(0.05), float(0.5), elevation));

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
    // A camera-centered sphere always surrounds the frustum origin; culling
    // math can false-negative it, and it must never pop out.
    mesh.frustumCulled = false;
    mesh.renderOrder = -100;
    return mesh;
  }
}
