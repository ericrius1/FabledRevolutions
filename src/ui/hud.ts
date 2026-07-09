import * as THREE from "three/webgpu";
import type { Player } from "../game/player";
import type { Enemy } from "../game/enemy";
import type { Combat } from "../game/combat";
import type { MegaSystem } from "../game/mega";
import { MEGA_THRESHOLD } from "../game/mega";

/**
 * DOM HUD: player hearts (top center), enemy health bars billboarded above
 * each enemy, the kill-rate meter (top left, feeds mega mode), and the charge
 * ring that tracks the player while the sword winds up.
 */
export class Hud {
  private readonly heartsEl: HTMLDivElement;
  private readonly barsEl: HTMLDivElement;
  readonly vignetteEl: HTMLDivElement;

  private readonly hearts: HTMLDivElement[] = [];

  // Halo-style shield meter, sits just under the hearts.
  private readonly shieldEl: HTMLDivElement;
  private readonly shieldFillEl: HTMLDivElement;
  private shownShield = -1;
  private shownRecharging = false;

  // One-time intro box (top center) explaining the goal.
  private readonly introEl: HTMLDivElement;
  private introDismissed = false;
  /** Wall-clock ms when the intro should auto-dismiss (0 = not scheduled yet). */
  private introHideAt = 0;
  /** Reused DOM bars keyed by enemy id; created on first sight. */
  private readonly bars = new Map<number, { el: HTMLDivElement; fill: HTMLDivElement }>();
  private readonly projected = new THREE.Vector3();

  // Kill-rate meter.
  private readonly killMeterEl: HTMLDivElement;
  private readonly killCountEl: HTMLSpanElement;
  private readonly killFillEl: HTMLDivElement;
  private readonly killStatusEl: HTMLDivElement;
  private shownKills = -1;
  private shownState = "";

  // Current active enemies in the scenario.
  private readonly enemyCountEl: HTMLDivElement;
  private readonly enemyLeftEl: HTMLSpanElement;
  private shownEnemiesLeft = -1;

  // Charge ring (tracks the player while charging). Position lives on the wrap
  // so the inner ring can scale-animate without fighting translate3d.
  private readonly chargeRingWrapEl: HTMLDivElement;
  private readonly chargeRingEl: HTMLDivElement;

  constructor(parent: HTMLElement, maxHearts: number) {
    this.heartsEl = document.createElement("div");
    this.heartsEl.className = "hud-hearts";
    for (let i = 0; i < maxHearts; i++) {
      const heart = document.createElement("div");
      heart.className = "heart";
      this.hearts.push(heart);
      this.heartsEl.appendChild(heart);
    }
    parent.appendChild(this.heartsEl);

    // Shield meter under the hearts. Segment ticks hint at the ~5-hit capacity;
    // the fill drains right-to-left and glows while recharging.
    this.shieldEl = document.createElement("div");
    this.shieldEl.className = "shield-meter";
    const shieldTrack = document.createElement("div");
    shieldTrack.className = "shield-track";
    this.shieldFillEl = document.createElement("div");
    this.shieldFillEl.className = "shield-fill";
    shieldTrack.appendChild(this.shieldFillEl);
    this.shieldEl.appendChild(shieldTrack);
    parent.appendChild(this.shieldEl);

    // Intro box: what the player is trying to do. Auto-fades, or click to close.
    this.introEl = document.createElement("div");
    this.introEl.className = "intro-box";
    this.introEl.innerHTML =
      '<div class="intro-title">OBJECTIVE</div>' +
      "<p>Knock every <b>agent</b> off the end of the world.</p>" +
      "<p>Your <span class=\"intro-shield\">shield</span> soaks their hits and " +
      "recharges when you break away. Once it's down, the agents start chipping " +
      "your <span class=\"intro-heart\">hearts</span>.</p>" +
      "<p>Lose all five and you're deleted — respawn back at the beginning.</p>" +
      '<div class="intro-dismiss">click to dismiss</div>';
    this.introEl.addEventListener("click", () => this.dismissIntro());
    parent.appendChild(this.introEl);

    this.barsEl = document.createElement("div");
    this.barsEl.className = "enemy-bars";
    parent.appendChild(this.barsEl);

    this.vignetteEl = document.createElement("div");
    this.vignetteEl.className = "vignette";
    parent.appendChild(this.vignetteEl);

    // Kill-rate meter: count in the rolling window + progress toward mega.
    this.killMeterEl = document.createElement("div");
    this.killMeterEl.className = "kill-meter";
    const title = document.createElement("div");
    title.className = "km-title";
    title.textContent = "KILL RATE";
    this.killCountEl = document.createElement("span");
    this.killCountEl.className = "km-count";
    this.killCountEl.textContent = "0";
    const goal = document.createElement("span");
    goal.className = "km-goal";
    goal.textContent = ` / ${MEGA_THRESHOLD} in 10s`;
    const row = document.createElement("div");
    row.className = "km-row";
    row.append(this.killCountEl, goal);
    const track = document.createElement("div");
    track.className = "km-track";
    this.killFillEl = document.createElement("div");
    this.killFillEl.className = "km-fill";
    track.appendChild(this.killFillEl);
    this.killStatusEl = document.createElement("div");
    this.killStatusEl.className = "km-status";
    this.killMeterEl.append(title, row, track, this.killStatusEl);
    parent.appendChild(this.killMeterEl);

    this.enemyCountEl = document.createElement("div");
    this.enemyCountEl.className = "enemy-count";
    const enemyTitle = document.createElement("div");
    enemyTitle.className = "ec-title";
    enemyTitle.textContent = "ENEMIES LEFT";
    this.enemyLeftEl = document.createElement("span");
    this.enemyLeftEl.className = "ec-count";
    this.enemyLeftEl.textContent = "0";
    this.enemyCountEl.append(enemyTitle, this.enemyLeftEl);
    parent.appendChild(this.enemyCountEl);

    this.chargeRingWrapEl = document.createElement("div");
    this.chargeRingWrapEl.className = "charge-ring-wrap";
    this.chargeRingEl = document.createElement("div");
    this.chargeRingEl.className = "charge-ring";
    this.chargeRingWrapEl.appendChild(this.chargeRingEl);
    parent.appendChild(this.chargeRingWrapEl);
  }

  /** Kill meter + mega status. Cheap DOM writes only on change. */
  private updateKillMeter(mega: MegaSystem): void {
    if (mega.burstKills !== this.shownKills) {
      this.shownKills = mega.burstKills;
      this.killCountEl.textContent = String(mega.burstKills);
      this.killFillEl.style.width = `${Math.min(1, mega.burstKills / MEGA_THRESHOLD) * 100}%`;
      retrigger(this.killMeterEl, "pop");
    }
    const state = mega.active ? "active" : mega.armed ? "armed" : "";
    if (state !== this.shownState) {
      this.shownState = state;
      this.killMeterEl.classList.toggle("armed", state === "armed");
      this.killMeterEl.classList.toggle("active", state === "active");
      this.killStatusEl.textContent =
        state === "armed" ? "MEGA READY — HOLD ATTACK" : state === "active" ? "M E G A" : "";
    }
  }

  /**
   * Objective remaining. Prefer the scenario's `enemiesLeft` (Revolutions tallies
   * at the slab edge); otherwise count non-parked bodies still in the roster.
   */
  private updateEnemyCount(enemies: readonly Enemy[], enemiesLeft?: number): void {
    let left = enemiesLeft;
    if (left === undefined) {
      left = 0;
      for (const enemy of enemies) {
        if (!enemy.parked) left++;
      }
    }
    if (left === this.shownEnemiesLeft) return;
    const previous = this.shownEnemiesLeft;
    this.shownEnemiesLeft = left;
    this.enemyLeftEl.textContent = String(left);
    this.enemyCountEl.classList.toggle("clear", left === 0);
    if (previous >= 0 && left < previous) retrigger(this.enemyCountEl, "drop");
  }

  /** Conic-gradient ring pinned to the player while the sword charges. */
  private updateChargeRing(
    player: Player,
    combat: Combat,
    camera: THREE.Camera,
    width: number,
    height: number,
  ): void {
    const wrap = this.chargeRingWrapEl;
    const el = this.chargeRingEl;
    if (!combat.charging) {
      if (wrap.style.display !== "none") wrap.style.display = "none";
      return;
    }
    this.projected.copy(player.position);
    this.projected.y += 0.1;
    this.projected.project(camera);
    const sx = (this.projected.x * 0.5 + 0.5) * width;
    const sy = (-this.projected.y * 0.5 + 0.5) * height;
    wrap.style.display = "block";
    wrap.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;

    const c = combat.chargeLevel;
    const base = Math.min(c, 1) * 360;
    const over = Math.max(0, Math.min(c - 1, 1)) * 360;
    el.classList.toggle("mega", c > 1);
    el.classList.toggle("full", c >= (combat.megaArmed ? 2 : 1));
    // Two stacked rings: gold for the normal band, electric cyan on top for
    // the overcharge band.
    el.style.background =
      `conic-gradient(rgba(120,220,255,0.95) ${over}deg, rgba(120,220,255,0) ${over}deg), ` +
      `conic-gradient(rgba(255,200,90,0.9) ${base}deg, rgba(255,255,255,0.12) ${base}deg)`;
  }

  /** Update hearts to reflect current HP (static — no animation in M1). */
  private updateHearts(player: Player): void {
    const hp = player.health.current;
    for (let i = 0; i < this.hearts.length; i++) {
      this.hearts[i].classList.toggle("empty", i >= hp);
    }
  }

  /** Drain/refill the shield bar; light it up while it's recharging. */
  private updateShield(player: Player): void {
    const frac = player.shield.fraction;
    // Quantize so we only touch the DOM when the bar visibly moves.
    const pct = Math.round(frac * 100);
    if (pct !== this.shownShield) {
      this.shownShield = pct;
      this.shieldFillEl.style.width = `${pct}%`;
      this.shieldEl.classList.toggle("low", frac > 0 && frac < 0.34);
      this.shieldEl.classList.toggle("down", frac <= 0);
    }
    const recharging = player.shield.recharging;
    if (recharging !== this.shownRecharging) {
      this.shownRecharging = recharging;
      this.shieldEl.classList.toggle("recharging", recharging);
    }
  }

  /** Fade the intro box after a beat; called every frame once shown. */
  private updateIntro(): void {
    if (this.introDismissed) return;
    const now = performance.now();
    if (this.introHideAt === 0) {
      this.introHideAt = now + 11000; // ~11s to read, then auto-fade
      return;
    }
    if (now >= this.introHideAt) this.dismissIntro();
  }

  private dismissIntro(): void {
    if (this.introDismissed) return;
    this.introDismissed = true;
    this.introEl.classList.add("gone");
  }

  /** Pulse the shield meter when it soaks a hit. */
  pulseShield(): void {
    retrigger(this.shieldEl, "flash");
  }

  /**
   * Project each enemy's head to screen space and position its bar. Bars appear
   * once an enemy is hurt (HP below max) so untouched enemies stay clean, like
   * the reference video.
   */
  private updateEnemyBars(
    enemies: readonly Enemy[],
    camera: THREE.Camera,
    width: number,
    height: number,
  ): void {
    const seen = new Set<number>();
    for (const enemy of enemies) {
      const hurt = enemy.health.current < enemy.health.max;
      if (!hurt || enemy.dead) continue;
      seen.add(enemy.id);

      let bar = this.bars.get(enemy.id);
      if (!bar) {
        const el = document.createElement("div");
        el.className = "enemy-bar";
        const fill = document.createElement("div");
        fill.className = "fill";
        el.appendChild(fill);
        this.barsEl.appendChild(el);
        bar = { el, fill };
        this.bars.set(enemy.id, bar);
      }

      // Project a point above the enemy's head.
      this.projected.copy(enemy.position);
      this.projected.y += 2.2;
      this.projected.project(camera);
      const sx = (this.projected.x * 0.5 + 0.5) * width;
      const sy = (-this.projected.y * 0.5 + 0.5) * height;
      const behind = this.projected.z > 1;
      bar.el.style.display = behind ? "none" : "block";
      bar.el.style.left = `${sx}px`;
      bar.el.style.top = `${sy}px`;
      bar.fill.style.width = `${(enemy.health.current / enemy.health.max) * 100}%`;
    }

    // Remove bars for enemies gone / not hurt this frame.
    for (const [id, bar] of this.bars) {
      if (!seen.has(id)) {
        this.barsEl.removeChild(bar.el);
        this.bars.delete(id);
      }
    }
  }

  update(
    player: Player,
    enemies: readonly Enemy[],
    camera: THREE.Camera,
    width: number,
    height: number,
    combat: Combat,
    mega: MegaSystem,
    enemiesLeft?: number,
  ): void {
    // Project with this frame's view — matrixWorld is normally refreshed during
    // render, which runs after the HUD, so a fast follow cam leaves overlays
    // one frame behind the canvas (visible ghosting when moving or jumping).
    camera.updateMatrixWorld();
    this.updateHearts(player);
    this.updateShield(player);
    this.updateIntro();
    this.updateEnemyBars(enemies, camera, width, height);
    this.updateEnemyCount(enemies, enemiesLeft);
    this.updateKillMeter(mega);
    this.updateChargeRing(player, combat, camera, width, height);
  }

  // ---- Feedback hooks (driven by the ui-feedback effect) ----
  // These re-trigger a CSS animation by removing and re-adding a class. When
  // the effect is disabled they are simply never called, leaving the HUD static.

  /** Pulse + shake the hearts row (player took damage). */
  pulseHearts(): void {
    retrigger(this.heartsEl, "hit");
  }

  /** Shake a single enemy's health bar, if it is currently on screen. */
  shakeEnemyBar(enemyId: number): void {
    const bar = this.bars.get(enemyId);
    if (bar) retrigger(bar.el, "hit");
  }

  /** Flash the red damage vignette. */
  flashVignette(): void {
    retrigger(this.vignetteEl, "flash");
  }
}

/** Restart a CSS animation class by forcing a reflow between remove and add. */
function retrigger(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the animation replays even if mid-flight
  el.classList.add(cls);
}
