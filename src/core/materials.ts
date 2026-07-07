import * as THREE from "three/webgpu";
import { color, float } from "three/tsl";

/**
 * Flat-shaded PBR node material: TSL `colorNode`/`roughnessNode` instead of
 * classic material properties. All scene surfaces share this helper so every
 * material in the project is node-based.
 */
export function standardNodeMaterial(
  hex: number,
  roughness: number,
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = color(hex);
  material.roughnessNode = float(roughness);
  return material;
}

/** Mirror-black sunglass lenses with a hard clearcoat highlight. */
export function glossyLensMaterial(hex = 0x101722): THREE.MeshPhysicalNodeMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.colorNode = color(hex);
  material.metalnessNode = float(0.65);
  material.roughnessNode = float(0.005);
  material.clearcoatNode = float(1);
  material.clearcoatRoughnessNode = float(0);
  material.iorNode = float(2.333);
  material.specularIntensityNode = float(1);
  material.specularColorNode = color(0xffffff);
  material.envMapIntensity = 3;
  return material;
}
