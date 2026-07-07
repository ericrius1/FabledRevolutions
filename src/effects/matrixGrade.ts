import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  uniform,
  screenUV,
  screenSize,
  mix,
  renderOutput,
  pass,
} from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup, type EffectParam } from "./effect";

/**
 * Always-on Matrix color grade: tints the frame toward the sickly green of the
 * Matrix, drains a little saturation, lifts the mids into a green duotone, adds
 * a touch of contrast, and closes with a soft vignette.
 *
 * The grade math lives in `applyMatrixGrade`, shared by two render paths:
 * the Mega FX post chain folds it in (that chain owns rendering whenever it is
 * enabled, so a separate grade pass would never run — and costs nothing extra
 * inside a pass that already exists), and this effect's own RenderPipeline
 * serves as the fallback base path when Mega FX is toggled off.
 *
 * renderOutput() runs inside the shader (outputColorTransform = false) so the
 * grade operates on the tone-mapped sRGB image, matching the CRT/mega passes.
 */

const PARAM_PREFIX = "fabled-revolutions.effect.matrix-grade.param.";

// Module-scope uniforms so both pipelines (standalone + the Mega FX chain)
// read the same live slider values and enabled state.
const uAmount = uniform(0.9);
const uTint = uniform(0.6);
const uSat = uniform(0.55);
const uVig = uniform(0.45);
/** 1 while the Matrix Grade effect is enabled; gates the folded-in path. */
const uEnabled = uniform(1);

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs defeat the typings */
/**
 * Apply the grade to a tone-mapped sRGB color node. `weight` scales the master
 * mix on top of the sliders — the Mega FX chain passes the inverse of its own
 * envelopes so the mega look preempts the grade exactly like the old
 * pipeline-switching path did.
 */
export function applyMatrixGrade(raw: any, weight: any): any {
  const c = raw.toVar();

  // Rec.601 luma drives the desaturate and the teal duotone ramp.
  const lum = c.dot(vec3(0.299, 0.587, 0.114));

  // Clean, strong desaturation first so the tint reads as a cold wash over
  // near-grey — the Matrix look is low-saturation, not lurid green.
  c.assign(mix(vec3(lum), c, uSat));

  // Teal → pale-green duotone: cold dark-teal shadows, muted green mids,
  // pale green-white highlights. Blending toward it (uTint) gives the clean
  // filmic cast of the rain scene rather than a flat two-tone.
  const shadow = vec3(0.02, 0.1, 0.11);
  const mids = vec3(0.16, 0.34, 0.3);
  const high = vec3(0.82, 0.96, 0.86);
  const ramp = mix(
    mix(shadow, mids, lum.mul(2).clamp(0, 1)),
    high,
    lum.sub(0.5).mul(2).clamp(0, 1),
  );
  // Scale the ramp back up by luma so the tint recolors without dimming the
  // image, then blend it in by strength.
  c.assign(mix(c, ramp.mul(lum.add(0.35).div(0.85)), uTint));

  // Gentle S-curve contrast keeps the blacks cool-crushed but not muddy.
  c.assign(c.sub(0.5).mul(1.05).add(0.5));

  // Soft vignette.
  const aspect = screenSize.x.div(screenSize.y);
  const p = screenUV.sub(0.5).mul(vec2(aspect, 1));
  const vig = float(1).sub(p.length().smoothstep(0.5, 1.15).mul(uVig));
  c.mulAssign(vig);

  // Master mix: dial the whole grade from the untouched frame (0) to full (1).
  const amount: any = uAmount.mul(uEnabled).mul(weight);
  return mix(raw, c.clamp(0, 1), amount);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class MatrixGradeEffect extends BaseEffect {
  readonly id = "matrix-grade";
  readonly label = "Matrix Grade";
  readonly description =
    "Always-on Matrix color grade: clean desaturated teal-green wash + vignette. 'grade' is the master intensity.";
  readonly group: EffectGroup = "Camera";

  readonly params: readonly EffectParam[] = [
    this.buildParam("intensity", "grade", 0, 1, 0.02, uAmount),
    this.buildParam("tint", "teal tint", 0, 1, 0.02, uTint),
    this.buildParam("sat", "saturation", 0, 1.2, 0.02, uSat),
    this.buildParam("vignette", "vignette", 0, 1, 0.05, uVig),
  ];

  private post: THREE.RenderPipeline | null = null;

  init(ctx: EffectContext): void {
    super.init(ctx);

    const post = new THREE.RenderPipeline(ctx.renderer);
    post.outputColorTransform = false;

    const scenePass = pass(ctx.scene, ctx.camera.camera);
    const sceneTex = scenePass.getTextureNode();

    post.outputNode = Fn(() => {
      const raw = renderOutput(vec4(sceneTex.sample(screenUV).rgb, 1)).rgb;
      return vec4(applyMatrixGrade(raw, float(1)), 1);
    })();

    this.post = post;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    // The Mega FX chain evaluates the grade unconditionally; this gate is what
    // makes the panel toggle work on that path.
    uEnabled.value = enabled ? 1 : 0;
  }

  /**
   * Render the graded frame. Returns false when disabled so the main loop uses
   * the plain render path. Louder post chains (mega, CRT) are checked first in
   * the loop, so they preempt the grade while their envelopes are live.
   */
  renderFrame(): boolean {
    if (!this.enabled || !this.post) return false;
    this.post.render();
    return true;
  }

  private buildParam(
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    u: { value: number },
  ): EffectParam {
    try {
      const raw = localStorage.getItem(PARAM_PREFIX + key);
      if (raw !== null) {
        const v = Number(raw);
        if (Number.isFinite(v)) u.value = Math.min(max, Math.max(min, v));
      }
    } catch {
      // localStorage unavailable; keep default.
    }
    return {
      key,
      label,
      min,
      max,
      step,
      get: () => u.value,
      set: (value: number) => {
        u.value = Math.min(max, Math.max(min, value));
        try {
          localStorage.setItem(PARAM_PREFIX + key, String(u.value));
        } catch {
          // ignore
        }
      },
    };
  }
}
