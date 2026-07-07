import * as THREE from "three/webgpu";

const STORAGE_KEY = "fabled-revolutions.wireframe";

let enabled = load();

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isWireframeEnabled(): boolean {
  return enabled;
}

/** Toggle wireframe on all mesh materials under `root` and persist the choice. */
export function setWireframeEnabled(next: boolean, root: THREE.Object3D): void {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // localStorage unavailable.
  }
  applyWireframe(root, next);
}

/** Apply the current (or overridden) wireframe state without changing persistence. */
export function applyWireframe(root: THREE.Object3D, wireframe = enabled): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat && "wireframe" in mat) mat.wireframe = wireframe;
    }
  });
}
