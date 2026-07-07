import * as THREE from "three/webgpu";
import CameraControls from "camera-controls";

let installed = false;

function ensureInstalled(): void {
  if (installed) return;
  CameraControls.install({ THREE });
  installed = true;
}

/**
 * Manual orbit / dolly / pan via the camera-controls package. Disabled by
 * default; toggled with C from the main loop.
 */
export class ManualCameraControls {
  readonly controls: CameraControls;
  private readonly lookTarget = new THREE.Vector3();
  private readonly viewDir = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    ensureInstalled();
    this.controls = new CameraControls(camera, domElement);
    this.controls.enabled = false;
    this.controls.dollyToCursor = true;
  }

  get active(): boolean {
    return this.controls.enabled;
  }

  /** Adopt the camera's current pose so toggling in feels seamless. */
  syncFromCamera(): void {
    const cam = this.controls.camera;
    cam.getWorldDirection(this.viewDir);
    this.lookTarget.copy(cam.position).addScaledVector(this.viewDir, 20);
    void this.controls.setLookAt(
      cam.position.x,
      cam.position.y,
      cam.position.z,
      this.lookTarget.x,
      this.lookTarget.y,
      this.lookTarget.z,
      false,
    );
  }

  enter(): void {
    this.syncFromCamera();
    this.controls.enabled = true;
  }

  exit(): void {
    this.controls.enabled = false;
  }

  update(unscaledDt: number): void {
    if (this.controls.enabled) void this.controls.update(unscaledDt);
  }
}
