import * as THREE from "three/webgpu";

/** Which control scheme the player last used. Drives the on-screen legend. */
export type InputSource = "kbm" | "gamepad";

/** Per-action "is this input engaged right now" flags for the legend. */
export interface InputActivity {
  move: boolean;
  look: boolean;
  attack: boolean;
}

const STICK_DEADZONE = 0.25;
/** How long a discrete input (click / stick flick) stays "lit" in the legend. */
const FLASH_TIME = 0.16;
const LOOK_DECAY = 0.12;
/** Standard-mapping button index for jump (A). */
const JUMP_BUTTON = 0;
/** Standard-mapping button index for sprint (LB). */
const SPRINT_BUTTON = 4;
/** Standard-mapping button indices we treat as "attack". */
const ATTACK_BUTTONS = [5, 7]; // RB / RT

/**
 * Keyboard + pointer + gamepad state. Movement is polled each frame; aim comes
 * either from the cursor (projected onto the ground) or the right stick. Tracks
 * which source is active and which actions are currently engaged so the legend
 * can reflect the live control scheme.
 */
export class Input {
  private keys = new Set<string>();
  private pointerNdc = new THREE.Vector2(0, 0);
  private attackQueued = false;
  private releaseQueued = false;
  /** Rising-edge toggles for mode hotkeys (C / P / I). */
  private cameraToggleQueued = false;
  private pauseToggleQueued = false;
  private immersiveToggleQueued = false;
  /** When false, pointer / pad attacks are ignored (camera-control mode). */
  private gameplayEnabled = true;
  /** Rising-edge latch for jump (Space / A) — one jump per press. */
  private jumpQueued = false;
  /** Falling-edge latch for jump (Space / A) — drives the air smash. */
  private jumpReleaseQueued = false;
  /** True while the attack input (mouse button / pad button) is held down. */
  private attackHeldNow = false;
  private mouseAttackDown = false;

  private source: InputSource = "kbm";
  // Decay timers (seconds remaining) for legend activity highlighting.
  private lookTimer = 0;
  private attackFlash = 0;

  // Latest gamepad snapshot (null when none connected / active this frame).
  private lx = 0;
  private ly = 0;
  private rx = 0;
  private ry = 0;
  private gamepadConnected = false;
  private sprintPadHeld = false;
  private prevAttackDown = false;
  private prevJumpDown = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly aimPoint = new THREE.Vector3();

  constructor(private readonly domElement: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    domElement.addEventListener("pointermove", this.onPointerMove);
    domElement.addEventListener("pointerdown", this.onPointerDown);
    // Release listens on window so dragging off the canvas still ends a charge.
    window.addEventListener("pointerup", this.onPointerUp);
    domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!e.repeat) {
      if (e.code === "KeyC") this.cameraToggleQueued = true;
      if (e.code === "KeyP") this.pauseToggleQueued = true;
      if (e.code === "KeyI") this.immersiveToggleQueued = true;
    }
    // Rising edge only: the OS repeats keydown while Space is held, but a jump
    // fires once per physical press. Guard on the key not already being down.
    if (e.code === "Space") {
      if (!this.keys.has("Space")) this.jumpQueued = true;
      e.preventDefault(); // don't scroll the page
    }
    this.keys.add(e.code);
    this.source = "kbm";
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space" && this.keys.has("Space")) this.jumpReleaseQueued = true;
    this.keys.delete(e.code);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.source = "kbm";
    this.lookTimer = LOOK_DECAY;
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (!this.gameplayEnabled) return;
    try {
      this.domElement.setPointerCapture(e.pointerId);
    } catch {
      // capture optional — window pointerup is the fallback
    }
    this.attackQueued = true;
    this.mouseAttackDown = true;
    this.attackFlash = FLASH_TIME;
    this.source = "kbm";
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (this.mouseAttackDown) this.releaseQueued = true;
    this.mouseAttackDown = false;
    try {
      this.domElement.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  /**
   * Poll gamepads and advance activity timers. Call once per frame with the
   * unscaled dt, before reading movement/aim/attack.
   */
  poll(dt: number): void {
    this.lookTimer = Math.max(0, this.lookTimer - dt);
    this.attackFlash = Math.max(0, this.attackFlash - dt);

    const pad = this.firstGamepad();
    this.gamepadConnected = pad !== null;
    if (!pad) {
      this.lx = this.ly = this.rx = this.ry = 0;
      if (this.prevAttackDown) this.releaseQueued = true;
      if (this.prevJumpDown) this.jumpReleaseQueued = true;
      this.prevAttackDown = false;
      this.prevJumpDown = false;
      this.sprintPadHeld = false;
      this.attackHeldNow = this.gameplayEnabled && this.mouseAttackDown;
      return;
    }

    this.lx = deadzone(pad.axes[0] ?? 0);
    this.ly = deadzone(pad.axes[1] ?? 0);
    this.rx = deadzone(pad.axes[2] ?? 0);
    this.ry = deadzone(pad.axes[3] ?? 0);

    const jumpDown = pad.buttons[JUMP_BUTTON]?.pressed ?? false;
    const attackDown = ATTACK_BUTTONS.some((i) => pad.buttons[i]?.pressed);
    this.sprintPadHeld = pad.buttons[SPRINT_BUTTON]?.pressed ?? false;
    const anyActivity =
      this.lx !== 0 ||
      this.ly !== 0 ||
      this.rx !== 0 ||
      this.ry !== 0 ||
      pad.buttons.some((b) => b.pressed);
    if (anyActivity) this.source = "gamepad";

    // Rising edge -> queue jump; falling edge -> queue jump release (air smash).
    if (jumpDown && !this.prevJumpDown) {
      this.jumpQueued = true;
      this.source = "gamepad";
    }
    if (!jumpDown && this.prevJumpDown) this.jumpReleaseQueued = true;
    this.prevJumpDown = jumpDown;

    // Rising edge -> queue an attack; falling edge -> queue a release.
    if (attackDown && !this.prevAttackDown && this.gameplayEnabled) {
      this.attackQueued = true;
      this.attackFlash = FLASH_TIME;
      this.source = "gamepad";
    }
    if (!attackDown && this.prevAttackDown) this.releaseQueued = true;
    this.prevAttackDown = attackDown;
    this.attackHeldNow = this.gameplayEnabled && (attackDown || this.mouseAttackDown);
    if (this.rx !== 0 || this.ry !== 0) this.lookTimer = LOOK_DECAY;
  }

  private firstGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** WASD / left-stick -> a 2D vector in camera space (x right, y forward). */
  moveAxis(out: THREE.Vector2): THREE.Vector2 {
    if (this.source === "gamepad" && (this.lx !== 0 || this.ly !== 0)) {
      out.set(this.lx, -this.ly); // stick up (-y) = forward
      if (out.lengthSq() > 1) out.normalize();
      return out;
    }
    let x = 0;
    let y = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) y += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) y -= 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) x -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) x += 1;
    out.set(x, y);
    if (out.lengthSq() > 1) out.normalize();
    return out;
  }

  /**
   * Right-stick aim as a camera-space vector (x right, y forward), or null when
   * the stick is centered / not the active source. When null, callers should
   * fall back to cursor aim via {@link aimGroundPoint}.
   */
  aimStick(out: THREE.Vector2): THREE.Vector2 | null {
    if (this.source !== "gamepad" || (this.rx === 0 && this.ry === 0)) return null;
    out.set(this.rx, -this.ry);
    return out;
  }

  /**
   * Cursor position relative to the viewport center (x right, y up), aspect-
   * corrected so equal physical mouse travel reads equally on both axes. A
   * length of 1 is half the viewport height. The direction is the "radial
   * dial" angle for sword aim; the length is how far off-center the cursor is.
   */
  pointerRadial(out: THREE.Vector2): THREE.Vector2 {
    const rect = this.domElement.getBoundingClientRect();
    const aspect = rect.height > 0 ? rect.width / rect.height : 1;
    return out.set(this.pointerNdc.x * aspect, this.pointerNdc.y);
  }

  /** Ground-plane point under the cursor, or null if the ray misses. */
  aimGroundPoint(camera: THREE.Camera): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.pointerNdc, camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.aimPoint);
    return hit ? this.aimPoint : null;
  }

  /** Enable / disable gameplay pointer + pad attacks (camera mode). */
  setGameplayEnabled(enabled: boolean): void {
    this.gameplayEnabled = enabled;
    if (!enabled) {
      this.attackQueued = false;
      if (this.mouseAttackDown) this.releaseQueued = true;
      this.mouseAttackDown = false;
      this.attackHeldNow = false;
    }
  }

  consumeCameraToggle(): boolean {
    if (!this.cameraToggleQueued) return false;
    this.cameraToggleQueued = false;
    return true;
  }

  consumePauseToggle(): boolean {
    if (!this.pauseToggleQueued) return false;
    this.pauseToggleQueued = false;
    return true;
  }

  consumeImmersiveToggle(): boolean {
    if (!this.immersiveToggleQueued) return false;
    this.immersiveToggleQueued = false;
    return true;
  }

  /** Returns true once per queued attack; resets the flag. */
  consumeAttack(): boolean {
    if (!this.gameplayEnabled || !this.attackQueued) return false;
    this.attackQueued = false;
    return true;
  }

  /** Returns true once per attack-button release; resets the flag. */
  consumeAttackRelease(): boolean {
    if (!this.releaseQueued) return false;
    this.releaseQueued = false;
    return true;
  }

  /** Returns true once per jump press (Space / A, rising edge); resets the flag. */
  consumeJump(): boolean {
    if (!this.jumpQueued) return false;
    this.jumpQueued = false;
    return true;
  }

  /** Returns true once per jump release (Space / A, falling edge); resets the flag. */
  consumeJumpRelease(): boolean {
    if (!this.jumpReleaseQueued) return false;
    this.jumpReleaseQueued = false;
    return true;
  }

  /** True while the attack input is held (drives sword charging). */
  get attackHeld(): boolean {
    return this.gameplayEnabled && this.attackHeldNow;
  }

  /** True while an attack press is queued but not consumed yet. */
  get attackPressQueued(): boolean {
    return this.gameplayEnabled && this.attackQueued;
  }

  /** True while sprint is held (Shift / LB) — doubles ground move speed. */
  get sprintHeld(): boolean {
    return (
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight") ||
      this.sprintPadHeld
    );
  }

  /** Active control scheme, for the legend. */
  get activeSource(): InputSource {
    return this.source;
  }

  get hasGamepad(): boolean {
    return this.gamepadConnected;
  }

  /** Which actions are engaged right now, for legend highlighting. */
  activity(): InputActivity {
    const moving =
      this.source === "gamepad"
        ? this.lx !== 0 || this.ly !== 0
        : this.keys.has("KeyW") ||
          this.keys.has("KeyA") ||
          this.keys.has("KeyS") ||
          this.keys.has("KeyD") ||
          this.keys.has("ArrowUp") ||
          this.keys.has("ArrowDown") ||
          this.keys.has("ArrowLeft") ||
          this.keys.has("ArrowRight");
    return {
      move: moving,
      look: this.lookTimer > 0,
      attack: this.attackFlash > 0,
    };
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.domElement.removeEventListener("pointerdown", this.onPointerDown);
  }
}

function deadzone(v: number): number {
  return Math.abs(v) < STICK_DEADZONE ? 0 : v;
}
