import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  vec4,
  uniform,
  screenUV,
  screenSize,
  mix,
  saturation,
  renderOutput,
  pass,
} from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup, type EffectParam } from "./effect";

/**
 * Retro-CRT impact flash, ported from sanfrancisco_codex's postfx "retro crt"
 * stage (virtual pixel grid + Bayer-dithered color quantize + scanlines).
 * Unlike the SF version — a static toggle — here the whole look is driven by a
 * hit envelope: it snaps in when a hit lands (player→enemy or enemy→player),
 * holds while hits keep landing, then quickly fades back to the clean image.
 *
 * Implementation: a private RenderPipeline over the same scene/camera.
 * The CRT amount is a uniform mixing clean vs CRT color, so fades are free
 * (no shader rebuild). While the envelope is at zero the main loop keeps using
 * the plain renderer.render path, so the effect costs nothing at rest.
 * renderOutput() is applied inside the shader (outputColorTransform = false)
 * so quantize/scanlines operate on the display-referred 0..1 image.
 */

const FADE_IN_TIME = 0.05;
const HOLD_TIME = 0.18;
const FADE_OUT_TIME = 0.25;

const PARAM_PREFIX = "fabled-revolutions.effect.crt.param.";

// compact analytic 4x4 Bayer matrix (no arrays/If — pure float math)
/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs defeat the typings */
const bayer2 = (a: any) => {
  const f = a.floor();
  return f.x.mul(0.5).add(f.y.mul(f.y).mul(0.75)).fract();
};
const bayer4 = (a: any) => bayer2(a.mul(0.5)).mul(0.25).add(bayer2(a));
/* eslint-enable @typescript-eslint/no-explicit-any */

export class CrtEffect extends BaseEffect {
  readonly id = "crt-flash";
  readonly label = "CRT Flash";
  readonly description =
    "Screen snaps to a retro CRT (pixel grid, dithered palette, scanlines) while hits land.";
  readonly group: EffectGroup = "Camera";

  private readonly uAmount = uniform(0);
  private readonly uPixel = uniform(3);
  private readonly uLevels = uniform(6);
  private readonly uScan = uniform(0.35);

  readonly params: readonly EffectParam[] = [
    this.buildParam("pixel", "pixel size", 1, 8, 1, this.uPixel),
    this.buildParam("levels", "color steps", 2, 10, 1, this.uLevels),
    this.buildParam("scan", "scanlines", 0, 1, 0.05, this.uScan),
  ];

  private post: THREE.RenderPipeline | null = null;
  private fade = 0;
  private hold = 0;

  init(ctx: EffectContext): void {
    super.init(ctx);

    const trigger = (): void => {
      if (!this.enabled) return;
      this.hold = HOLD_TIME;
    };
    ctx.bus.on("attack-hit", trigger);
    ctx.bus.on("player-hurt", trigger);

    const post = new THREE.RenderPipeline(ctx.renderer);
    // renderOutput is applied manually inside the shader so the CRT stages see
    // tone-mapped sRGB, matching the SF pipeline.
    post.outputColorTransform = false;

    const scenePass = pass(ctx.scene, ctx.camera.camera);
    const sceneTex = scenePass.getTextureNode();

    post.outputNode = Fn(() => {
      // virtual pixel grid: CRT color is sampled at the snapped cell center
      const grid = screenSize.div(this.uPixel);
      const cell = screenUV.mul(grid).floor();
      const snapped = cell.add(0.5).div(grid);

      const clean = renderOutput(vec4(sceneTex.sample(screenUV).rgb, 1)).rgb;

      const c = renderOutput(vec4(sceneTex.sample(snapped).rgb, 1)).rgb.toVar();
      c.assign(saturation(c, 1.12)); // small candy pop before the palette snaps
      const levels = this.uLevels.sub(1).max(1);
      // 0.7 dither span: full-strength Bayer turns flat ground into rainbow
      // static; backing off keeps the crosshatch without the dirt
      c.assign(
        c.clamp(0.0, 1.0).mul(levels).add(bayer4(cell).mul(0.7).add(0.15)).floor().div(levels),
      );
      const fy = screenUV.y.mul(grid.y).fract();
      c.mulAssign(float(1).sub(fy.sub(0.5).abs().mul(2.0).pow(2.5).mul(this.uScan)));

      return vec4(mix(clean, c, this.uAmount), 1.0);
    })();

    this.post = post;
  }

  update(unscaledDt: number): void {
    if (this.hold > 0) {
      this.hold = Math.max(0, this.hold - unscaledDt);
      this.fade = Math.min(1, this.fade + unscaledDt / FADE_IN_TIME);
    } else if (this.fade > 0) {
      this.fade = Math.max(0, this.fade - unscaledDt / FADE_OUT_TIME);
    }
    // Ease-out on the tail so the CRT look releases smoothly.
    this.uAmount.value = this.fade * this.fade * (3 - 2 * this.fade);
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) {
      this.fade = 0;
      this.hold = 0;
      this.uAmount.value = 0;
    }
  }

  /**
   * Render this frame through the CRT chain when the flash is live.
   * Returns false when idle/disabled so the caller uses the plain render path.
   */
  renderFrame(): boolean {
    if (!this.enabled || !this.post || this.fade <= 0.001) return false;
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
    // Restore persisted value before first render.
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
