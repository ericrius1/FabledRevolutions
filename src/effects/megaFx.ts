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
  saturation,
  renderOutput,
  pass,
} from "three/tsl";
import { BaseEffect, type EffectContext, type EffectGroup, type EffectParam } from "./effect";
import { applyMatrixGrade } from "./matrixGrade";
import { megaSlowMoTotal, megaTuning, setMegaTuning } from "../game/mega";
import { smashSlowMoTotal } from "../game/diveSmash";
import { floorTuning, setFloorTuning, setFloorDepth } from "../scenarios/arena";

/**
 * Mega-mode spectacle, in three coordinated layers:
 *
 *  1. POST GRADE — a private RenderPipeline (same pattern as the CRT flash).
 *     While the overcharge is held the frame cools toward steel blue with a
 *     breathing vignette. On release the whole image *contracts* — a radial
 *     UV pinch with ripple rings and chromatic fringing racing outward — then
 *     blooms into a bright Matrix-green lightning surge that pulses through
 *     bullet time. A white-green flash spikes on the release and on every bolt.
 *
 *  2. LIGHTNING — a pool of jagged additive ribbons striking from the sky
 *     around the blast point for the whole aftermath, each with a pooled
 *     point light flash. Every touchdown emits `mega-lightning` so the sound
 *     effect can answer with thunder.
 *
 *  3. Nothing here does gameplay: impulses/damage live in MegaSystem/Combat.
 *     Disabling this effect leaves mega mode functional but visually plain.
 */

const PULSE_TIME = 0.9;
const FLASH_TIME = 0.22;
const CHARGE_RAMP = 4; // per-second approach rate of the charge look

// Lightning.
const BOLT_POOL = 6;
const BOLT_SEGS = 9;
// Forks: every bolt mesh carries room for MAX_FORKS side branches; unused
// forks collapse to zero-width rows below the floor (degenerate triangles),
// so fork count changes never rebuild geometry.
const MAX_FORKS = 4;
const FORK_SEGS = 4;
const BOLT_ROWS = BOLT_SEGS + 1 + MAX_FORKS * (FORK_SEGS + 1);
const BOLT_LIFE = 0.08;
const BOLT_TOP = 15;
const STRIKE_RADIUS = 13;
// Every mega event fires exactly this many bolts at ONCE — a single simultaneous
// burst answered by one giant thunder clap, not a drawn-out storm.
const MEGA_STRIKES = 3;
// Beat after release the burst lands (keeps the release frame clean).
const BURST_DELAY = 0.14;
const LIGHT_POOL = 3;
const LIGHT_INTENSITY = 90;
const RELEASE_LIGHT_INTENSITY = 150;

// Lightning tint endpoints: `boltYellow` lerps each cool/warm pair together
// (ribbons, strike lights, post flash), so one slider warms the whole storm.
const BOLT_COOL = new THREE.Color(0xcfe4ff);
const BOLT_WARM = new THREE.Color(0xffe08a);
const LIGHT_COOL = new THREE.Color(0xbcd7ff);
const LIGHT_WARM = new THREE.Color(0xffd968);
const FLASH_COOL = new THREE.Color(0xdfeaff);
const FLASH_WARM = new THREE.Color(0xfff1bd);

/**
 * Aftermath grade palettes. Every literal in the release grade lives here as a
 * pair — the cool Matrix GREEN for the sword release, and a hot molten GOLD for
 * the ground smash — so one move can wear an entirely different look through
 * the same shader. `rgb()` writes .r/.g/.b straight (no colour-space warp), so
 * the values match the linear vec3 math they feed. Values >1 are deliberate
 * multipliers.
 */
const rgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.NoColorSpace);
interface GradePalette {
  shadow: THREE.Color;
  mid: THREE.Color;
  high: THREE.Color;
  tintMul: THREE.Color;
  glow: THREE.Color;
  ring: THREE.Color;
  edge: THREE.Color;
  flashCore: THREE.Color;
}
/** Sword release: cool Matrix green (the original literals). */
const GRADE_GREEN: GradePalette = {
  shadow: rgb(0.0, 0.16, 0.075),
  mid: rgb(0.16, 0.92, 0.43),
  high: rgb(0.74, 1.0, 0.82),
  tintMul: rgb(0.78, 1.18, 0.9),
  glow: rgb(0.08, 0.45, 0.22),
  ring: rgb(0.02, 0.8, 0.34),
  edge: rgb(0.02, 0.22, 0.16),
  flashCore: rgb(0.48, 1.0, 0.64),
};
/** Ground smash: molten gold — hot core, orange shockwave energy. */
const GRADE_GOLD: GradePalette = {
  shadow: rgb(0.2, 0.06, 0.0),
  mid: rgb(1.0, 0.5, 0.12),
  high: rgb(1.0, 0.94, 0.72),
  tintMul: rgb(1.24, 0.92, 0.58),
  glow: rgb(0.5, 0.26, 0.05),
  ring: rgb(1.0, 0.5, 0.12),
  edge: rgb(0.24, 0.12, 0.03),
  flashCore: rgb(1.0, 0.82, 0.45),
};
/** Smash bolt / flash / strike-light tints (warm to match the gold grade). */
const SMASH_BOLT = new THREE.Color(0xffdca6);
const SMASH_FLASH = new THREE.Color(0xffedc4);
const SMASH_LIGHT = new THREE.Color(0xffc36e);
/** Point-light hue for each release core. */
const RELEASE_LIGHT_GREEN = 0x66ffc2;
const RELEASE_LIGHT_GOLD = 0xffb14d;

const floatUniform = (v: number) => uniform(v);
type FloatUniform = ReturnType<typeof floatUniform>;

interface Bolt {
  mesh: THREE.Mesh;
  positions: Float32Array;
  opacity: FloatUniform;
  life: number;
}

export class MegaFxEffect extends BaseEffect {
  readonly id = "mega-fx";
  readonly label = "Mega FX";
  readonly description =
    "Mega release: screen contraction, bright Matrix-green lightning pulse, lightning storm.";
  readonly group: EffectGroup = "Camera";

  // Post envelopes (0..1), advanced on the CPU.
  private readonly uGrade = uniform(0);
  private readonly uCharge = uniform(0);
  private readonly uPulse = uniform(0);
  private readonly uFlash = uniform(0);
  private readonly uTime = uniform(0);
  /** Radial depth-blur strength: dofBase at rest + dofMega × grade. */
  private readonly uBlur = uniform(0.25);
  /** Screen-space center for the release contraction/rings (player origin). */
  private readonly uPulseCenter = uniform(new THREE.Vector2(0.5, 0.5));
  // Live lightning tint (shared by every bolt material / the post flash).
  private readonly uBoltColor = uniform(BOLT_COOL.clone());
  private readonly uFlashTint = uniform(FLASH_COOL.clone());

  // Aftermath-grade palette (swapped per release: green sword vs gold smash).
  private readonly uShadow = uniform(GRADE_GREEN.shadow.clone());
  private readonly uMid = uniform(GRADE_GREEN.mid.clone());
  private readonly uHigh = uniform(GRADE_GREEN.high.clone());
  private readonly uTintMul = uniform(GRADE_GREEN.tintMul.clone());
  private readonly uGlow = uniform(GRADE_GREEN.glow.clone());
  private readonly uRing = uniform(GRADE_GREEN.ring.clone());
  private readonly uEdge = uniform(GRADE_GREEN.edge.clone());
  private readonly uFlashCore = uniform(GRADE_GREEN.flashCore.clone());

  readonly params: readonly EffectParam[] = [
    tuningParam("spin-speed", "spin speed", 1, 5, 0.5, "spinSpeed"),
    tuningParam("slow-start", "slow start", 0.1, 0.5, 0.01, "slowStart"),
    tuningParam("slow-hold", "slow hold", 0.15, 0.6, 0.01, "slowHold"),
    tuningParam("ramp-in", "ramp in", 0.2, 2, 0.1, "rampIn"),
    tuningParam("spin-hold", "spin hold", 1, 5, 0.25, "spinHold"),
    tuningParam("ramp-out", "ramp out", 0.3, 2, 0.1, "rampOut"),
    tuningParam("wild-tail", "wild tail", 0, 4, 0.25, "wildTail"),
    tuningParam("dof-base", "depth blur", 0, 1, 0.05, "dofBase"),
    tuningParam("dof-mega", "blur on mega", 0, 1.5, 0.05, "dofMega"),
    tuningParam("camera-spin", "camera spin", 0, 1, 1, "cameraSpin"),
    tuningParam("cam-ramp", "cam spin-up", 0.02, 0.6, 0.02, "camRampIn"),
    tuningParam("cam-revs", "cam revs", 1, 3, 1, "camRevs"),
    tuningParam("cam-windup", "cam windup", 0, 0.8, 0.02, "camWindup"),
    tuningParam("sword-revs", "sword revs", 0.5, 3, 0.25, "swordRevs"),
    {
      key: "sword-len",
      label: "sword length",
      min: 1,
      max: 3,
      step: 0.1,
      get: () => megaTuning.swordLen,
      set: (v: number) => {
        setMegaTuning("swordLen", Math.min(3, Math.max(1, v)));
        this.ctx?.getPlayer().setSwordLength(megaTuning.swordLen);
      },
    },
    {
      key: "bolt-yellow",
      label: "bolt yellow",
      min: 0,
      max: 1,
      step: 0.05,
      get: () => megaTuning.boltYellow,
      set: (v: number) => {
        setMegaTuning("boltYellow", Math.min(1, Math.max(0, v)));
        this.applyBoltTint();
      },
    },
    tuningParam("bolt-forks", "bolt forks", 0, MAX_FORKS, 0.5, "boltForks"),
    floorParam("floor-hue", "skin hue", 0, 1, 0.01, "hue"),
    floorParam("floor-sat", "skin sat", 0, 1, 0.05, "sat"),
    floorParam("floor-light", "skin light", 0.02, 0.9, 0.02, "light"),
    floorParam("floor-glow-hue", "layer hue", 0, 1, 0.01, "glowHue"),
    floorParam("floor-glow", "layer glow", 0, 3, 0.05, "glow"),
    floorParam("floor-depth", "skin glass", 0, 1, 0.02, "depth"),
    floorParam("floor-sub-depth", "layer depth", 0.5, 4, 0.1, "subDepth"),
    floorParam("floor-sub-visible", "layer visible", 0, 1, 0.02, "subVisibility"),
    floorParam("floor-detail-scale", "road detail", 0.7, 3.4, 0.05, "detailScale"),
  ];

  private post: THREE.RenderPipeline | null = null;
  private grade = 0;
  /** Grade fade length, set per release to track the bullet-time length. */
  private gradeTime = 5;
  private pulse = 0;
  private flash = 0;
  private charge = 0;

  // Lightning state.
  private readonly bolts: Bolt[] = [];
  private boltCursor = 0;
  private readonly lights: THREE.PointLight[] = [];
  private releaseLight: THREE.PointLight | null = null;
  private releaseLightPower = 0;
  private lightCursor = 0;
  private storm = 0;
  private strikeTimer = 0;
  private readonly stormCenter = new THREE.Vector3();
  private readonly screenCenterScratch = new THREE.Vector3();
  private readonly camRight = new THREE.Vector3();
  /** Main-bolt path points, kept around so forks can branch off mid-column. */
  private readonly pathScratch = new Float32Array((BOLT_SEGS + 1) * 3);

  init(ctx: EffectContext): void {
    super.init(ctx);
    ctx.getPlayer().setSwordLength(megaTuning.swordLen);
    this.buildPost(ctx);
    this.buildBolts(ctx);
    this.applyBoltTint();

    ctx.bus.on("mega-release", ({ origin }) => {
      if (!this.enabled) return;
      this.play(origin, "sword", megaSlowMoTotal());
    });
    ctx.bus.on("mega-smash", ({ origin }) => {
      if (!this.enabled) return;
      this.play(origin, "smash", smashSlowMoTotal());
    });
    ctx.bus.on("mega-end", () => {
      this.storm = 0;
    });
  }

  private buildPost(ctx: EffectContext): void {
    const post = new THREE.RenderPipeline(ctx.renderer);
    post.outputColorTransform = false;

    const scenePass = pass(ctx.scene, ctx.camera.camera);
    const sceneTex = scenePass.getTextureNode();

    post.outputNode = Fn(() => {
      const aspect = screenSize.x.div(screenSize.y);
      const centeredUv = screenUV.sub(this.uPulseCenter).toVar();
      const p = centeredUv.mul(vec2(aspect, 1));
      const r = p.length();

      // Contraction pulse: pinch toward center + ripple rings racing out.
      const ripple = r.mul(26).sub(this.uTime.mul(30)).sin().mul(0.5).add(0.5);
      const pinch = this.uPulse.mul(float(0.12).add(ripple.mul(0.05).mul(this.uPulse)));
      // Subtle inward breathing while the overcharge is held.
      const breathe = this.uCharge.mul(this.uTime.mul(9).sin().mul(0.004).add(0.012));
      const warp = pinch.add(breathe).mul(r.smoothstep(0.0, 0.35));
      const warped = screenUV.sub(centeredUv.mul(warp)).toVar();

      // Chromatic fringing rides the pulse: r/b sampled at offset radii.
      const ab = this.uPulse.mul(0.012).add(this.uGrade.mul(0.003));
      const off = warped.sub(this.uPulseCenter);
      const cr = renderOutput(vec4(sceneTex.sample(warped.sub(off.mul(ab))).rgb, 1)).r;
      const cg = renderOutput(vec4(sceneTex.sample(warped).rgb, 1)).g;
      const cb = renderOutput(vec4(sceneTex.sample(warped.add(off.mul(ab))).rgb, 1)).b;
      const c = vec3(cr, cg, cb).toVar();

      // Radial depth blur (tilt-shift): center stays sharp, the frame edges
      // melt. 8-tap disc, radius scaled by edge distance × uBlur. Reads as
      // depth on the top-down framing and sells the miniature-diorama look;
      // the mega release cranks it while the grade is live.
      const edge = r.smoothstep(0.12, 0.8);
      const blurRadius = this.uBlur.mul(edge).mul(14).div(screenSize.y);
      const acc = c.toVar();
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const ringR = i % 2 === 0 ? 1 : 0.55;
        const tap = warped.add(
          vec2(Math.cos(ang) * ringR, Math.sin(ang) * ringR).mul(blurRadius),
        );
        acc.addAssign(renderOutput(vec4(sceneTex.sample(tap).rgb, 1)).rgb);
      }
      c.assign(acc.div(9));

      // Base look: the always-on Matrix grade, folded into this pass because
      // this chain owns rendering whenever Mega FX is enabled — a separate
      // grade pipeline would never get a frame. Weighted by the inverse of the
      // mega envelopes so the charge/aftermath looks below preempt the grade,
      // exactly as the old pipeline-switching path intended.
      const megaLive = this.uCharge
        .max(this.uGrade)
        .max(this.uPulse)
        .max(this.uFlash)
        .clamp(0, 1);
      c.assign(applyMatrixGrade(c, megaLive.oneMinus()));

      // Charge look: steel-blue energy with a small green lift. It still
      // gathers at the edges, but no longer takes exposure away from the scene.
      const chargeBeat = this.uTime.mul(9).sin().mul(0.5).add(0.5).mul(this.uCharge);
      c.assign(
        mix(
          c,
          c.mul(vec3(0.82, 1.08, 1.28)).add(vec3(0.02, 0.055, 0.08)),
          this.uCharge.mul(0.55),
        ),
      );
      c.assign(saturation(c, float(1).add(this.uCharge.mul(0.12))));
      const vig = r.mul(this.uCharge.mul(0.28)).mul(r);
      c.assign(c.mul(float(1).sub(vig)));
      c.addAssign(vec3(0.02, 0.1, 0.08).mul(chargeBeat.mul(0.35)));

      // Aftermath grade: lightning-bright Matrix surge. It pushes green,
      // raises midtones, adds pulsing radial rings, and only uses contrast
      // around a lifted pivot so bullet time reads electric instead of dark.
      const grade = this.uGrade;
      const pulseBeat = this.uTime.mul(18).sin().mul(0.5).add(0.5);
      const surge = grade
        .mul(0.62)
        .add(this.uPulse.mul(0.26))
        .add(this.uFlash.mul(0.18))
        .clamp(0, 1);
      const lum = c.dot(vec3(0.299, 0.587, 0.114));
      // Palette-driven tri-tone ramp: swapped per release (green sword / gold smash).
      const matrixRamp = mix(
        mix(this.uShadow, this.uMid, lum.mul(2).clamp(0, 1)),
        this.uHigh,
        lum.sub(0.45).mul(2.4).clamp(0, 1),
      );
      const matrixColor = mix(
        c.mul(this.uTintMul),
        matrixRamp.mul(lum.add(0.55)),
        float(0.42),
      );
      c.assign(mix(c, matrixColor, surge));
      c.assign(saturation(c, float(1).add(grade.mul(0.22)).add(this.uPulse.mul(0.18))));
      c.assign(c.sub(0.42).mul(float(1).add(grade.mul(0.38))).add(0.5));

      const glow = lum.smoothstep(0.18, 0.95).mul(grade.mul(0.35).add(this.uPulse.mul(0.3)));
      c.addAssign(this.uGlow.mul(glow));
      const ring = r.mul(22).sub(this.uTime.mul(26)).sin().mul(0.5).add(0.5).pow(7);
      const ringMask = r.smoothstep(0.08, 0.92).mul(float(1).sub(r.smoothstep(0.92, 1.25)));
      c.addAssign(
        this.uRing.mul(
          ring.mul(ringMask).mul(this.uPulse.mul(0.55).add(grade.mul(pulseBeat).mul(0.12))),
        ),
      );
      const edgeGlow = r.smoothstep(0.3, 1.0).mul(grade.mul(0.08).add(this.uPulse.mul(0.16)));
      c.addAssign(this.uEdge.mul(edgeGlow));

      // Release / lightning flash (bolt warmth plus the palette electrical core).
      const electricFlash = mix(this.uFlashTint, this.uFlashCore, grade.mul(0.45));
      c.assign(c.add(electricFlash.mul(this.uFlash.mul(1.15))));

      return vec4(c, 1.0);
    })();

    this.post = post;
  }

  private buildBolts(ctx: EffectContext): void {
    // Static index layout shared by every bolt: the main ribbon plus
    // MAX_FORKS independent fork ribbons (no bridging quads between them).
    const indices: number[] = [];
    const ribbon = (startRow: number, segs: number): void => {
      for (let i = 0; i < segs; i++) {
        const a = (startRow + i) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    };
    ribbon(0, BOLT_SEGS);
    for (let f = 0; f < MAX_FORKS; f++) ribbon(BOLT_SEGS + 1 + f * (FORK_SEGS + 1), FORK_SEGS);

    for (let b = 0; b < BOLT_POOL; b++) {
      const positions = new Float32Array(BOLT_ROWS * 2 * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(indices);

      const opacity = floatUniform(0);
      const material = new THREE.MeshBasicNodeMaterial();
      material.colorNode = this.uBoltColor.mul(3);
      material.opacityNode = float(0).add(opacity);
      material.transparent = true;
      material.depthWrite = false;
      material.blending = THREE.AdditiveBlending;
      material.side = THREE.DoubleSide;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.visible = true;
      ctx.scene.add(mesh);
      this.bolts.push({ mesh, positions, opacity, life: 0 });
    }

    for (let i = 0; i < LIGHT_POOL; i++) {
      const light = new THREE.PointLight(LIGHT_COOL, 0, 26, 1.6);
      light.position.set(0, -100, 0);
      ctx.scene.add(light);
      this.lights.push(light);
    }

    this.releaseLight = new THREE.PointLight(0x66ffc2, 0, 34, 1.45);
    this.releaseLight.position.set(0, -100, 0);
    ctx.scene.add(this.releaseLight);
  }

  /** Re-derive every lightning color from `megaTuning.boltYellow`. */
  private applyBoltTint(): void {
    const y = Math.min(1, Math.max(0, megaTuning.boltYellow));
    this.uBoltColor.value.copy(BOLT_COOL).lerp(BOLT_WARM, y);
    this.uFlashTint.value.copy(FLASH_COOL).lerp(FLASH_WARM, y);
    for (const light of this.lights) light.color.copy(LIGHT_COOL).lerp(LIGHT_WARM, y);
  }

  /**
   * Kick off the full aftermath spectacle from a release point: post-grade
   * contraction pulse + flash, the point-light bloom, and the lightning storm,
   * all paced to `total` (the driving bullet-time length). `mode` swaps the
   * whole colour palette — cool green for the sword, molten gold for the smash.
   */
  private play(origin: THREE.Vector3, mode: "sword" | "smash", total: number): void {
    this.applyPalette(mode);
    this.grade = 1;
    this.gradeTime = total + 0.6;
    this.pulse = 1;
    this.flash = 1;
    this.releaseLightPower = RELEASE_LIGHT_INTENSITY;
    this.setPulseCenter(origin);
    if (this.releaseLight) {
      this.releaseLight.position.copy(origin);
      this.releaseLight.position.y = 3.2;
      this.releaseLight.intensity = RELEASE_LIGHT_INTENSITY;
    }
    // Arm a single simultaneous burst a beat AFTER release — keeps the release
    // frame clean (it's the busiest frame of the whole game) and reads as the
    // sky answering the blast with one hammer-blow, not a rolling storm.
    this.storm = 1;
    this.strikeTimer = BURST_DELAY;
    this.stormCenter.copy(origin);
  }

  /** Load the grade + lightning palette for this release into the uniforms. */
  private applyPalette(mode: "sword" | "smash"): void {
    const p = mode === "smash" ? GRADE_GOLD : GRADE_GREEN;
    this.uShadow.value.copy(p.shadow);
    this.uMid.value.copy(p.mid);
    this.uHigh.value.copy(p.high);
    this.uTintMul.value.copy(p.tintMul);
    this.uGlow.value.copy(p.glow);
    this.uRing.value.copy(p.ring);
    this.uEdge.value.copy(p.edge);
    this.uFlashCore.value.copy(p.flashCore);
    if (mode === "smash") {
      this.uBoltColor.value.copy(SMASH_BOLT);
      this.uFlashTint.value.copy(SMASH_FLASH);
      for (const light of this.lights) light.color.copy(SMASH_LIGHT);
      this.releaseLight?.color.set(RELEASE_LIGHT_GOLD);
    } else {
      // Sword: bolts follow the boltYellow slider; core light is Matrix green.
      this.applyBoltTint();
      this.releaseLight?.color.set(RELEASE_LIGHT_GREEN);
    }
  }

  private setPulseCenter(origin: THREE.Vector3): void {
    const p = this.screenCenterScratch.copy(origin);
    p.y = Math.max(p.y, 0.8);
    p.project(this.ctx.camera.camera);
    this.uPulseCenter.value.set(
      THREE.MathUtils.clamp(p.x * 0.5 + 0.5, 0.05, 0.95),
      THREE.MathUtils.clamp(p.y * 0.5 + 0.5, 0.05, 0.95),
    );
  }

  update(unscaledDt: number): void {
    if (!this.enabled) return;
    this.uTime.value += unscaledDt;

    // Charge look follows the live overcharge state.
    const combat = this.ctx.getPlayer().combat;
    const target = combat?.megaCharging ? Math.min(combat.chargeLevel / 2 + 0.4, 1) : 0;
    this.charge += (target - this.charge) * Math.min(1, CHARGE_RAMP * unscaledDt);

    this.grade = Math.max(0, this.grade - unscaledDt / this.gradeTime);
    this.pulse = Math.max(0, this.pulse - unscaledDt / PULSE_TIME);
    this.flash = Math.max(0, this.flash - unscaledDt / FLASH_TIME);

    this.uCharge.value = this.charge;
    this.uGrade.value = smooth(this.grade);
    this.uPulse.value = this.pulse * this.pulse;
    this.uFlash.value = this.flash * this.flash;
    this.uBlur.value = megaTuning.dofBase + smooth(this.grade) * megaTuning.dofMega;
    // The floor sinks deeper blue-green while the mega look is live.
    setFloorDepth(Math.max(this.charge, smooth(this.grade)) * 0.85);

    this.updateStorm(unscaledDt);
    this.updateBolts(unscaledDt);
    this.updateReleaseLight(unscaledDt);
  }

  private updateStorm(dt: number): void {
    if (this.storm <= 0) return;
    this.strikeTimer -= dt;
    if (this.strikeTimer <= 0) {
      // One burst per event: fire every bolt on the same frame, then disarm.
      this.storm = 0;
      for (let i = 0; i < MEGA_STRIKES; i++) this.spawnBolt();
      // A single thunder emit — the sound answers all three bolts as one
      // overwhelming clap instead of a stutter of overlapping cracks.
      this.ctx.bus.emit("mega-lightning", { point: this.stormCenter.clone() });
    }
  }

  /** Spawn one visual bolt (geometry + ground flash light). No sound. */
  private spawnBolt(): void {
    const ang = Math.random() * Math.PI * 2;
    const radius = 2 + Math.random() * STRIKE_RADIUS;
    const x = this.stormCenter.x + Math.cos(ang) * radius;
    const z = this.stormCenter.z + Math.sin(ang) * radius;

    // Jagged path from sky to ground with decaying lateral jitter.
    const bolt = this.bolts[this.boltCursor];
    this.boltCursor = (this.boltCursor + 1) % BOLT_POOL;

    const cam = this.ctx.camera.camera;
    this.camRight.setFromMatrixColumn(cam.matrixWorld, 0).normalize();

    let jx = 0;
    let jz = 0;
    for (let i = 0; i <= BOLT_SEGS; i++) {
      const t = i / BOLT_SEGS;
      const y = BOLT_TOP * (1 - t);
      if (i > 0 && i < BOLT_SEGS) {
        jx += (Math.random() - 0.5) * 1.6;
        jz += (Math.random() - 0.5) * 1.6;
        // Pull the jitter back toward the strike column so the bolt lands true.
        jx *= 0.72;
        jz *= 0.72;
      } else {
        jx = 0;
        jz = 0;
      }
      const px = x + jx;
      const pz = z + jz;
      this.pathScratch[i * 3] = px;
      this.pathScratch[i * 3 + 1] = y;
      this.pathScratch[i * 3 + 2] = pz;
      // Ribbon expands along the camera-right axis, wide up top, needle at ground.
      this.writeRow(bolt.positions, i, px, y, pz, mainWidth(t));
    }

    // Forks: branch off random mid-column points, wandering outward and down.
    // Fractional tuning = chance of one extra, so 1.5 reads "1, often 2".
    let forks = Math.floor(megaTuning.boltForks);
    if (Math.random() < megaTuning.boltForks - forks) forks++;
    forks = Math.min(MAX_FORKS, forks);
    for (let f = 0; f < MAX_FORKS; f++) {
      const startRow = BOLT_SEGS + 1 + f * (FORK_SEGS + 1);
      if (f >= forks) {
        // Park unused forks as zero-width rows below the floor.
        for (let i = 0; i <= FORK_SEGS; i++) this.writeRow(bolt.positions, startRow + i, x, -1, z, 0);
        continue;
      }
      const si = 2 + Math.floor(Math.random() * (BOLT_SEGS - 3));
      let fx = this.pathScratch[si * 3];
      let fy = this.pathScratch[si * 3 + 1];
      let fz = this.pathScratch[si * 3 + 2];
      const fAng = Math.random() * Math.PI * 2;
      const dirX = Math.cos(fAng);
      const dirZ = Math.sin(fAng);
      // Fork drops through ~30-65% of its remaining height, so most die mid-air.
      const drop = (fy * (0.3 + Math.random() * 0.35)) / FORK_SEGS;
      const w0 = mainWidth(si / BOLT_SEGS) * 0.6;
      for (let i = 0; i <= FORK_SEGS; i++) {
        this.writeRow(bolt.positions, startRow + i, fx, fy, fz, w0 * (1 - (i / FORK_SEGS) * 0.85));
        fx += dirX * (0.35 + Math.random() * 0.55) + (Math.random() - 0.5) * 0.5;
        fz += dirZ * (0.35 + Math.random() * 0.55) + (Math.random() - 0.5) * 0.5;
        fy -= drop * (0.7 + Math.random() * 0.6);
      }
    }
    (bolt.mesh.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    bolt.life = BOLT_LIFE;

    // Ground flash light.
    const light = this.lights[this.lightCursor];
    this.lightCursor = (this.lightCursor + 1) % LIGHT_POOL;
    light.position.set(x, 2.5, z);
    light.intensity = LIGHT_INTENSITY;

    // Sky flash on the post grade. Thunder is emitted once for the whole burst.
    this.flash = Math.max(this.flash, 0.45);
  }

  /** Write one ribbon row: a pair of verts straddling (x,y,z) along camera-right. */
  private writeRow(
    positions: Float32Array,
    row: number,
    x: number,
    y: number,
    z: number,
    width: number,
  ): void {
    const p = row * 6;
    positions[p] = x - this.camRight.x * width;
    positions[p + 1] = y;
    positions[p + 2] = z - this.camRight.z * width;
    positions[p + 3] = x + this.camRight.x * width;
    positions[p + 4] = y;
    positions[p + 5] = z + this.camRight.z * width;
  }

  private updateBolts(dt: number): void {
    for (const bolt of this.bolts) {
      if (bolt.life <= 0) {
        bolt.opacity.value = 0;
        continue;
      }
      bolt.life -= dt;
      // Hard flicker reads more electric than a smooth fade.
      bolt.opacity.value = bolt.life > 0 ? (Math.random() < 0.75 ? 1 : 0.25) : 0;
    }
    for (const light of this.lights) {
      if (light.intensity > 0) {
        light.intensity = Math.max(0, light.intensity - LIGHT_INTENSITY * dt * 7);
      }
    }
  }

  private updateReleaseLight(dt: number): void {
    if (!this.releaseLight) return;
    this.releaseLightPower = Math.max(0, this.releaseLightPower - RELEASE_LIGHT_INTENSITY * dt * 2.6);
    this.releaseLight.intensity = this.releaseLightPower;
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    if (!enabled) this.clear();
  }

  /**
   * Render through the mega post chain EVERY frame while the effect is
   * enabled (with all envelopes at zero the output is identical to the plain
   * path). Never switching render paths is the hitch fix: every material —
   * including enemies spawned mid-game — compiles its render-target pipeline
   * variant once, on its spawn frame, instead of all 150 of them compiling in
   * one burst the first frame the charge look would have flipped the path.
   */
  renderFrame(): boolean {
    if (!this.enabled || !this.post) return false;
    this.post.render();
    return true;
  }

  private clear(): void {
    this.grade = 0;
    this.pulse = 0;
    this.flash = 0;
    this.charge = 0;
    this.storm = 0;
    this.releaseLightPower = 0;
    this.uGrade.value = 0;
    this.uCharge.value = 0;
    this.uPulse.value = 0;
    this.uFlash.value = 0;
    this.uBlur.value = megaTuning.dofBase;
    this.uPulseCenter.value.set(0.5, 0.5);
    for (const bolt of this.bolts) {
      bolt.life = 0;
      bolt.opacity.value = 0;
    }
    for (const light of this.lights) light.intensity = 0;
    if (this.releaseLight) this.releaseLight.intensity = 0;
  }
}

/** Smoothstep the tail so the grade releases gently. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Main-ribbon half width at column fraction t: wide up top, needle at ground. */
function mainWidth(t: number): number {
  return 0.28 * (0.35 + (1 - t) * 0.65);
}

/** Panel slider bound to one floorTuning field (live re-tint, persisted). */
function floorParam(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  field: keyof typeof floorTuning,
): EffectParam {
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => floorTuning[field],
    set: (v: number) => setFloorTuning(field, Math.min(max, Math.max(min, v))),
  };
}

/** Panel slider bound to one megaTuning field (persisted by setMegaTuning). */
function tuningParam(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  field: keyof typeof megaTuning,
): EffectParam {
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => megaTuning[field],
    set: (v: number) => setMegaTuning(field, Math.min(max, Math.max(min, v))),
  };
}
