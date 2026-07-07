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
 * Always-on Matrix color grade. A private RenderPipeline (same pattern as the
 * CRT flash / mega grade) that owns the base render path whenever no louder
 * post chain is live: it tints the whole frame toward the sickly green of the
 * Matrix, drains a little saturation, lifts the mids into a green duotone, adds
 * a touch of contrast, and closes with a soft vignette.
 *
 * renderOutput() runs inside the shader (outputColorTransform = false) so the
 * grade operates on the tone-mapped sRGB image, matching the CRT/mega passes.
 * Unlike those, this one renders every frame it's enabled — the grade is the
 * default look, not an event flash — and the main loop only falls back to the
 * plain renderer.render path when this effect is toggled off.
 */

const PARAM_PREFIX = "fabled-revolutions.effect.matrix-grade.param.";

export class MatrixGradeEffect extends BaseEffect {
  readonly id = "matrix-grade";
  readonly label = "Matrix Grade";
  readonly description =
    "Always-on Matrix color grade: clean desaturated teal-green wash + vignette. 'grade' is the master intensity.";
  readonly group: EffectGroup = "Camera";

  // Master intensity (raw↔graded mix), teal-tint strength, saturation, vignette.
  private readonly uAmount = uniform(0.9);
  private readonly uTint = uniform(0.6);
  private readonly uSat = uniform(0.55);
  private readonly uVig = uniform(0.45);

  readonly params: readonly EffectParam[] = [
    this.buildParam("intensity", "grade", 0, 1, 0.02, this.uAmount),
    this.buildParam("tint", "teal tint", 0, 1, 0.02, this.uTint),
    this.buildParam("sat", "saturation", 0, 1.2, 0.02, this.uSat),
    this.buildParam("vignette", "vignette", 0, 1, 0.05, this.uVig),
  ];

  private post: THREE.RenderPipeline | null = null;

  init(ctx: EffectContext): void {
    super.init(ctx);

    const post = new THREE.RenderPipeline(ctx.renderer);
    post.outputColorTransform = false;

    const scenePass = pass(ctx.scene, ctx.camera.camera);
    const sceneTex = scenePass.getTextureNode();

    post.outputNode = Fn(() => {
      const raw = renderOutput(vec4(sceneTex.sample(screenUV).rgb, 1)).rgb.toVar();
      const c = raw.toVar();

      // Rec.601 luma drives the desaturate and the teal duotone ramp.
      const lum = c.dot(vec3(0.299, 0.587, 0.114));

      // Clean, strong desaturation first so the tint reads as a cold wash over
      // near-grey — the Matrix look is low-saturation, not lurid green.
      c.assign(mix(vec3(lum), c, this.uSat));

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
      const tinted = mix(c, ramp.mul(lum.add(0.35).div(0.85)), this.uTint);
      c.assign(tinted);

      // Gentle S-curve contrast keeps the blacks cool-crushed but not muddy.
      c.assign(c.sub(0.5).mul(1.05).add(0.5));

      // Soft vignette.
      const aspect = screenSize.x.div(screenSize.y);
      const p = screenUV.sub(0.5).mul(vec2(aspect, 1));
      const vig = float(1).sub(p.length().smoothstep(0.5, 1.15).mul(this.uVig));
      c.mulAssign(vig);

      // Master mix: dial the whole grade from the untouched frame (0) to full
      // (1) — this is the slider to play with.
      return vec4(mix(raw, c.clamp(0, 1), this.uAmount), 1);
    })();

    this.post = post;
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
