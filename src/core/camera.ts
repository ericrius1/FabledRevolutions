import * as THREE from "three/webgpu";

/**
 * Angled top-down follow camera (~55° pitch like the reference video). Exposes a
 * `shakeOffset` and `shakeRoll` that the camera-shake effect (M2) writes into;
 * the base follow position is computed here and shake is added on top so the two
 * concerns stay decoupled.
 */
export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Additive positional shake, written by the camera-shake effect. */
  readonly shakeOffset = new THREE.Vector3();
  /** Additive roll (radians) around the view direction. */
  shakeRoll = 0;
  /**
   * Bullet-time orbit: yaw (radians) the follow offset is swung around the
   * player. The mega system sweeps this through a full revolution during the
   * post-release slow-mo; 0 = the normal behind-the-player framing.
   */
  orbit = 0;

  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly orbited = new THREE.Vector3();

  // Offset from the player: low and back — a near-level action framing that
  // keeps the horizon in shot so launched enemies visibly sail into the fog.
  private readonly offset = new THREE.Vector3(0, 7.5, 19);
  // Aim a little above the player's feet so the horizon rides higher in frame
  // and distant enemies/buildings stay in shot.
  private readonly lookLift = 2.5;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 500);
    this.camera.position.copy(this.offset);
    this.camera.lookAt(0, 0, 0);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Smoothly track `focus` (the player position). unscaledDt keeps the follow
   * responsive even during hit-stop. */
  update(focus: THREE.Vector3, unscaledDt: number): void {
    this.target.copy(focus);
    // Swing the follow offset around +Y by the orbit angle.
    const cos = Math.cos(this.orbit);
    const sin = Math.sin(this.orbit);
    this.orbited.set(
      this.offset.x * cos + this.offset.z * sin,
      this.offset.y,
      -this.offset.x * sin + this.offset.z * cos,
    );
    this.desired.copy(this.target).add(this.orbited);
    // Exponential smoothing, frame-rate independent.
    const k = 1 - Math.exp(-8 * unscaledDt);
    this.camera.position.lerp(this.desired, k);
    this.camera.position.add(this.shakeOffset);

    this.lookAt.copy(this.target).add(this.shakeOffset);
    this.lookAt.y += this.lookLift;
    this.camera.lookAt(this.lookAt);
    if (this.shakeRoll !== 0) this.camera.rotateZ(this.shakeRoll);
  }
}
