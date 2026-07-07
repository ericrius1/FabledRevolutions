import { defineConfig } from "vite";

// Just enough of Node's `process` for the PORT lookup below — the config runs
// under Node, but the project deliberately doesn't pull in @types/node.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  base: "./",
  server: {
    open: true,
    // Preview tooling assigns a free port via PORT when the default is taken.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
  // box3d.js ships an emscripten-generated inline WASM module that the esbuild
  // dep pre-bundler can't process (it references Node-only builtins in a dead
  // browser branch). Exclude it so Vite serves it untouched.
  // three/webgpu + three/tsl are excluded so the dev pre-bundler doesn't create
  // a second copy of the three core next to the source-resolved one (the
  // "Multiple instances of Three.js" warning).
  optimizeDeps: {
    exclude: ["box3d.js", "three", "three/webgpu", "three/tsl"],
  },
  build: {
    target: "es2022",
  },
});
