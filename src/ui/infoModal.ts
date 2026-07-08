/**
 * "System dossier" info modal: a floating ⓘ button on the left edge opens a
 * near-fullscreen overlay explaining the project — the juice philosophy, the
 * effect stack, the event-bus architecture, the two-clock trick, the box3d
 * WASM physics pipeline, threading, and the WebGPU/TSL render path.
 *
 * Opening pauses the GameClock (via the callbacks the caller wires up) and
 * dims the live frame behind a grayscale/green backdrop, Matrix style. The
 * overlay owns a digital-rain canvas that only animates while open.
 */

export interface InfoModalHooks {
  /** Called when the modal opens — pause the game, remember prior state. */
  onOpen(): void
  /** Called when the modal closes — restore whatever onOpen suspended. */
  onClose(): void
}

const RAIN_GLYPHS =
  "アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEFXZ<>+*="

export class InfoModal {
  readonly button: HTMLButtonElement
  readonly root: HTMLDivElement

  private openState = false
  private rainCanvas!: HTMLCanvasElement
  private rainRaf = 0
  private rainDrops: number[] = []
  private rainLast = 0

  constructor(private readonly hooks: InfoModalHooks) {
    this.button = document.createElement("button")
    this.button.className = "info-button"
    this.button.type = "button"
    this.button.title = "About this project — systems, physics, rendering (Esc)"
    this.button.setAttribute("aria-label", "About this project")
    this.button.innerHTML = `<span class="info-button-glyph">i</span><span class="info-button-ring"></span>`
    this.button.addEventListener("click", () => this.open())

    this.root = document.createElement("div")
    this.root.className = "info-overlay"
    this.root.hidden = true
    this.build()
  }

  get isOpen(): boolean {
    return this.openState
  }

  open(): void {
    if (this.openState) return
    this.openState = true
    this.root.hidden = false
    document.body.classList.add("info-open")
    this.hooks.onOpen()
    this.startRain()
    // Reset scroll and move focus into the dialog for keyboard users.
    this.root.querySelector<HTMLElement>(".info-body")?.scrollTo({ top: 0 })
    this.root.querySelector<HTMLButtonElement>(".info-close")?.focus()
  }

  close(): void {
    if (!this.openState) return
    this.openState = false
    this.root.hidden = true
    document.body.classList.remove("info-open")
    this.stopRain()
    this.hooks.onClose()
    this.button.focus()
  }

  // ---------------------------------------------------------------- markup

  private build(): void {
    this.rainCanvas = document.createElement("canvas")
    this.rainCanvas.className = "info-rain"
    this.root.appendChild(this.rainCanvas)

    const modal = document.createElement("div")
    modal.className = "info-modal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.setAttribute("aria-label", "About Fabled Revolutions")
    modal.innerHTML = `
      <header class="info-header">
        <div class="info-title">
          <span class="info-title-tag">// SYSTEM DOSSIER</span>
          <h1>Fabled Revolutions</h1>
          <p>How a boring brawler becomes crunchy — one stacked effect on another.</p>
        </div>
        <button class="info-close" type="button" aria-label="Close">[ ESC ]</button>
      </header>
      <div class="info-body">
        ${this.sectionJuice()}
        ${this.sectionEffects()}
        ${this.sectionArchitecture()}
        ${this.sectionClocks()}
        ${this.sectionPhysics()}
        ${this.sectionThreads()}
        ${this.sectionRender()}
        ${this.sectionDesign()}
        <footer class="info-footer">
          <span>Fabled Revolutions · MIT · three.js + box3d.js</span>
          <span class="info-footer-blink">▮</span>
        </footer>
      </div>`
    this.root.appendChild(modal)

    // Backdrop click closes; clicks inside the panel don't.
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root || e.target === this.rainCanvas) this.close()
    })
    modal
      .querySelector(".info-close")
      ?.addEventListener("click", () => this.close())
  }

  private sectionJuice(): string {
    return `
    <section class="info-section">
      <h2><span class="info-num">01</span> What is real?</h2>
      <p>
        What is a <em>hit</em>? A number changes. A body slides. None of it is real —
        it is a shape on a screen, electrical signals interpreted by your brain. So
        how do you make the mind <em>feel</em> the blow? Not with one grand illusion,
        but with many small ones, all agreeing at once: a screen shake here, a
        freeze-frame there, a spark burst, a squash. Alone, each is a whisper you'd
        never notice. Layered — every channel insisting <em>something happened</em> —
        they conspire into a truth the body cannot argue with. That is the difference
        between <span class="mx-dim">mush</span> and <span class="mx-hot">crunch</span>:
        not more reality, but more illusions telling the same lie.
      </p>
      <p>
        This project makes that stack <strong>legible</strong>. The core game — move,
        aim, swing, take damage — always runs and is fully playable with zero effects
        enabled; it just feels flat. Every juice effect is an isolated, toggleable
        module, so you can flip one on at a time and feel precisely what it
        contributes. Try it: hit <em>All off</em> in the panel, fight for ten
        seconds, then turn on Hit Stop alone.
      </p>
      <p>
        It began as a hands-on companion to André Cardoso's hit-feedback breakdown,
        sparked by a SketchpunkLabs request that quoted a Unity VFX breakdown thread.
        This is a port of the same ideas to an open stack: Three.js for rendering,
        box3d compiled to WebAssembly for real rigid-body physics.
      </p>
    </section>`
  }

  private sectionEffects(): string {
    const rows: Array<[string, string, string]> = [
      [
        "Swing Animation",
        "Attack",
        "Anticipation + follow-through easing on the sword arc. Off = flat linear sweep."
      ],
      [
        "Weapon Trail",
        "Attack",
        "Additive ribbon chasing the sword tip, fading out over a few frames."
      ],
      [
        "Hit Particles",
        "Reaction",
        "Spark burst at the impact point; expanding ring flash on a kill."
      ],
      [
        "Enemy Flash",
        "Reaction",
        "Hurt enemy flashes white/emissive for ~100 ms."
      ],
      [
        "Knockback",
        "Reaction",
        "Real physics impulse away from the player; corpses unlock rotation and tumble."
      ],
      [
        "Enemy Squash",
        "Reaction",
        "Squash & stretch scale punch on hurt; swell-pop on death."
      ],
      [
        "Hit Stop",
        "Camera",
        "Freezes game time ~70 ms on hit, ~140 ms on a killing blow."
      ],
      [
        "Camera Shake",
        "Camera",
        "Trauma-based positional + roll noise, scaled by event weight."
      ],
      [
        "UI Feedback",
        "UI",
        "Hearts pulse, enemy bars shake, red vignette on player damage."
      ],
      [
        "Sound",
        "Audio",
        "Procedural WebAudio SFX — swing whoosh, hit thock, kill boom, hurt blip."
      ]
    ]
    const body = rows
      .map(
        ([name, group, desc]) => `
        <tr>
          <td class="fx-name">${name}</td>
          <td class="fx-group">${group}</td>
          <td>${desc}</td>
        </tr>`
      )
      .join("")
    return `
    <section class="info-section">
      <h2><span class="info-num">02</span> The effect stack</h2>
      <p>
        Ten modules, five groups. Every one can be disabled mid-game with no residue:
        trails clear, time scale restores, scales spring back, emissives reset.
      </p>
      <div class="info-scroll">
        <table class="fx-table">
          <thead><tr><th>Effect</th><th>Group</th><th>What it adds</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>`
  }

  private sectionArchitecture(): string {
    const { defs, head } = diagDefs()
    return `
    <section class="info-section">
      <h2><span class="info-num">03</span> Architecture — events, not calls</h2>
      <p>
        Gameplay code never knows the effects exist. Combat, enemies, and the player
        <strong>emit events</strong> on a typed bus — <code>attack-hit</code>,
        <code>enemy-death</code>, <code>player-hurt</code>, <code>dive-impact</code> —
        and each effect subscribes in its <code>init()</code> and owns its whole
        lifecycle. Adding an eleventh effect touches exactly two files: the new
        module and one line in the manager's registration list. The toggle row,
        persistence, and update loop come for free.
      </p>
      <div class="info-scroll">
        <svg class="info-diagram" viewBox="0 0 940 300" width="940" height="300" role="img"
             aria-label="Event bus diagram: gameplay systems emit events onto a bus, effect modules subscribe">
          ${defs}
          ${diagBox(20, 30, 150, 44, "Combat", "swing timing, sector hits")}
          ${diagBox(20, 96, 150, 44, "Enemy / Player", "AI, damage, death")}
          ${diagBox(20, 162, 150, 44, "Dive Smash", "landing impacts")}
          ${diagBox(20, 228, 150, 44, "Mega System", "kill-burst windows")}
          ${diagArrow(head, 170, 52, 330, 130)}
          ${diagArrow(head, 170, 118, 330, 142)}
          ${diagArrow(head, 170, 184, 330, 158)}
          ${diagArrow(head, 170, 250, 330, 170)}
          <rect x="332" y="106" width="180" height="88" rx="6" class="dg-bus"/>
          <text x="422" y="140" class="dg-title" text-anchor="middle">EVENT BUS</text>
          <text x="422" y="160" class="dg-sub" text-anchor="middle">attack-hit · enemy-death</text>
          <text x="422" y="176" class="dg-sub" text-anchor="middle">player-hurt · dive-impact</text>
          ${diagArrow(head, 512, 120, 660, 46)}
          ${diagArrow(head, 512, 135, 660, 112)}
          ${diagArrow(head, 512, 165, 660, 178)}
          ${diagArrow(head, 512, 180, 660, 244)}
          ${diagBox(662, 24, 250, 44, "Attack FX", "swing easing · weapon trail")}
          ${diagBox(662, 90, 250, 44, "Reaction FX", "particles · flash · knockback · squash")}
          ${diagBox(662, 156, 250, 44, "Camera FX", "hit stop · trauma shake")}
          ${diagBox(662, 222, 250, 44, "UI + Audio FX", "hearts, bars, vignette · WebAudio")}
          <text x="95" y="18" class="dg-label" text-anchor="middle">EMITS</text>
          <text x="787" y="16" class="dg-label" text-anchor="middle">SUBSCRIBES</text>
        </svg>
      </div>
    </section>`
  }

  private sectionClocks(): string {
    return `
    <section class="info-section">
      <h2><span class="info-num">04</span> Two clocks — the hit-stop trick</h2>
      <p>
        Hit stop freezes the world for ~70 ms on every landed hit. But if it froze
        <em>everything</em>, it would also freeze the sword swing that caused it, and
        chained attacks would stutter. So the game runs two timelines from one
        <code>GameClock</code>:
      </p>
      <ul>
        <li><strong>Unscaled time</strong> — real wall-clock delta. Drives combat swing
          timing, the camera, invulnerability frames, and the effects themselves
          (a shake must keep shaking during a freeze).</li>
        <li><strong>Scaled time</strong> — the same delta multiplied by
          <code>timeScale</code>. Drives enemy AI and the physics step. Hit stop sets
          the scale to 0; mega bullet-time ramps it smoothly to ~0.2 and back.</li>
      </ul>
      <div class="info-scroll">
        <svg class="info-diagram" viewBox="0 0 900 190" width="900" height="190" role="img"
             aria-label="Timeline diagram comparing unscaled wall-clock time to scaled game time with a hit-stop gap">
          <text x="16" y="42" class="dg-title">UNSCALED</text>
          <text x="16" y="60" class="dg-sub">combat · camera · fx</text>
          <line x1="150" y1="48" x2="880" y2="48" class="dg-line"/>
          ${Array.from({ length: 25 }, (_, i) => `<line x1="${160 + i * 30}" y1="42" x2="${160 + i * 30}" y2="54" class="dg-tick"/>`).join("")}
          <text x="16" y="126" class="dg-title">SCALED</text>
          <text x="16" y="144" class="dg-sub">AI · physics</text>
          <line x1="150" y1="132" x2="880" y2="132" class="dg-line"/>
          ${Array.from({ length: 8 }, (_, i) => `<line x1="${160 + i * 30}" y1="126" x2="${160 + i * 30}" y2="138" class="dg-tick"/>`).join("")}
          <rect x="400" y="118" width="120" height="28" class="dg-freeze"/>
          <text x="460" y="112" class="dg-hot" text-anchor="middle">HIT STOP · timeScale = 0</text>
          ${Array.from({ length: 12 }, (_, i) => `<line x1="${532 + i * 30}" y1="126" x2="${532 + i * 30}" y2="138" class="dg-tick"/>`).join("")}
          <text x="460" y="170" class="dg-sub" text-anchor="middle">world freezes — the swing that caused it keeps moving above</text>
        </svg>
      </div>
      <p>
        Same trick, opposite direction: during the mega spin, bullet-time slows the
        scaled clock 5× while the player's spin paces itself on the wall clock — so
        the world crawls and you don't.
      </p>
    </section>`
  }

  private sectionPhysics(): string {
    const { defs, head } = diagDefs()
    return `
    <section class="info-section">
      <h2><span class="info-num">05</span> WASM physics — box3d</h2>
      <p>
        The knockbacks are not scripted slides — every capsule and crate is a rigid
        body in <strong>box3d</strong>, Erin Catto's 3D successor to Box2D, written
        in C and compiled to <strong>WebAssembly</strong> (via the box3d.js
        bindings). The C API is flat and handle-based —
        <code>b3CreateWorld</code>, <code>b3CreateBody</code>,
        <code>b3World_Step</code> — operating on opaque id structs. A thin typed
        wrapper (<code>src/core/physics.ts</code>) keeps those ids internal so the
        rest of the game never touches the raw WASM layer.
      </p>
      <p>Key decisions:</p>
      <ul>
        <li><strong>Fixed 60 Hz accumulator.</strong> Render frames are irregular;
          the sim is not. Frame time accrues in an accumulator and the world steps
          in exact <code>1/60 s</code> ticks (4 solver substeps each), capped at 5
          per frame to avoid a death spiral after a stall. Determinism regardless
          of frame rate.</li>
        <li><strong>2.5D via motion locks.</strong> box3d is a full 3D engine, used
          here as top-down 2.5D: capsules translate on the XZ plane with X/Z
          rotation locked so they stay upright. Gameplay yaw is purely visual, on
          the mesh. When an enemy dies, the knockback effect calls
          <code>unlockRotation()</code> — and the same body becomes a tumbling
          ragdoll, free.</li>
        <li><strong>Continuous collision for launches.</strong> A big impulse can
          step a body clean through a wall in one tick. Launched corpses flip on
          <em>bullet mode</em> (swept collision), and the ground is a 4-metre-deep
          slab so even a missed contact gets pushed back out.</li>
        <li><strong>Native explosions.</strong> The mega release calls
          <code>b3World_Explode</code> — one real radial impulse field with distance
          falloff and category masks — instead of looping scripted per-body pushes.</li>
      </ul>
      <div class="info-scroll">
        <svg class="info-diagram" viewBox="0 0 1060 150" width="1060" height="150" role="img"
             aria-label="Frame pipeline: input, combat on unscaled time, AI on scaled time, fixed-step physics in WASM, mesh sync, effects, render">
          ${defs}
          ${diagBox(10, 44, 96, 56, "input.poll()", "kbm + gamepad")}
          ${diagArrow(head, 106, 72, 128, 72)}
          ${diagBox(130, 44, 118, 56, "combat", "unscaled dt")}
          ${diagArrow(head, 248, 72, 270, 72)}
          ${diagBox(272, 44, 118, 56, "enemy AI", "scaled dt")}
          ${diagArrow(head, 390, 72, 412, 72)}
          <rect x="414" y="26" width="266" height="94" rx="6" class="dg-bus"/>
          <text x="547" y="50" class="dg-title" text-anchor="middle">physics.step(dt)</text>
          <text x="547" y="70" class="dg-sub" text-anchor="middle">accumulator ≥ 1/60 →</text>
          <text x="547" y="86" class="dg-sub" text-anchor="middle">b3World_Step(1/60, 4 substeps)</text>
          <text x="547" y="106" class="dg-hot" text-anchor="middle">⟨ WASM ⟩</text>
          ${diagArrow(head, 680, 72, 702, 72)}
          ${diagBox(704, 44, 110, 56, "sync meshes", "read positions")}
          ${diagArrow(head, 814, 72, 836, 72)}
          ${diagBox(838, 44, 100, 56, "effects", "unscaled dt")}
          ${diagArrow(head, 938, 72, 960, 72)}
          ${diagBox(962, 44, 88, 56, "render", "WebGPU")}
        </svg>
      </div>
    </section>`
  }

  private sectionThreads(): string {
    const { defs, head } = diagDefs()
    return `
    <section class="info-section">
      <h2><span class="info-num">06</span> Threads, workers &amp; why the sim stays on main</h2>
      <p>
        A WASM module is not a separate process — it executes on whatever thread
        calls into it, sharing the call stack with your JavaScript. When the loop
        calls <code>b3World_Step</code>, V8 jumps into precompiled machine code
        operating on the module's <em>linear memory</em> (one big
        <code>ArrayBuffer</code>), runs the whole solver at near-native speed with
        no GC pauses, and returns. Reading a body position afterwards is just a
        struct read out of that buffer — no serialization.
      </p>
      <p>
        So could the physics move to a <strong>Web Worker</strong>? Yes — and it's a
        deliberate choice not to, here:
      </p>
      <ul>
        <li><strong>The step is cheap relative to the frame.</strong> Even a
          150-ragdoll mega blast resolves in a few milliseconds. The game reads
          positions <em>immediately</em> after stepping, every frame — the data
          dependency is tight and synchronous.</li>
        <li><strong>A worker adds a boundary.</strong> <code>postMessage</code>
          copies (structured clone) unless you ship buffers back and forth; either
          way you now have a frame of latency or a lockstep wait. For a heavy sim
          (thousands of bodies, expensive scenes) that trade wins. For this one it
          would cost more than it saves.</li>
        <li><strong>The real multithreaded path</strong> is
          <code>SharedArrayBuffer</code>: put the WASM memory in shared memory,
          step in a worker (or run the engine's internal task system across a
          worker pool with WASM threads/atomics), and read positions from the main
          thread without copying. It requires cross-origin isolation headers
          (COOP/COEP) — one reason many web games still keep physics on main.</li>
      </ul>
      <p>
        Where the app <em>does</em> lean on other threads: WebGPU command
        submission and shader compilation happen on the browser's GPU process, and
        WebAudio synthesis runs on the dedicated audio rendering thread — the
        procedural SFX never glitch during a frame spike.
      </p>
      <div class="info-scroll">
        <svg class="info-diagram" viewBox="0 0 940 240" width="940" height="240" role="img"
             aria-label="Thread diagram: main thread runs JS and WASM in one call stack; GPU process and audio thread run in parallel">
          ${defs}
          <text x="16" y="34" class="dg-title">MAIN THREAD</text>
          <line x1="150" y1="30" x2="920" y2="30" class="dg-line"/>
          ${diagBox(160, 44, 130, 40, "JS game loop", "")}
          ${diagArrow(head, 290, 64, 316, 64)}
          ${diagBox(318, 44, 190, 40, "WASM b3World_Step", "same call stack")}
          ${diagArrow(head, 508, 64, 534, 64)}
          ${diagBox(536, 44, 170, 40, "read linear memory", "positions, quats")}
          ${diagArrow(head, 706, 64, 732, 64)}
          ${diagBox(734, 44, 150, 40, "submit render", "")}
          <text x="16" y="140" class="dg-title">GPU PROCESS</text>
          <line x1="150" y1="136" x2="920" y2="136" class="dg-line"/>
          ${diagBox(734, 150, 150, 36, "execute passes", "WGSL pipelines")}
          ${diagArrowDashed(head, 809, 84, 809, 148)}
          <text x="16" y="212" class="dg-title">AUDIO THREAD</text>
          <line x1="150" y1="208" x2="920" y2="208" class="dg-line"/>
          ${diagBox(318, 216, 190, 20, "", "")}
          <text x="413" y="230" class="dg-sub" text-anchor="middle">WebAudio graph — procedural SFX</text>
        </svg>
      </div>
    </section>`
  }

  private sectionRender(): string {
    return `
    <section class="info-section">
      <h2><span class="info-num">07</span> WebGPU + TSL rendering</h2>
      <p>
        Rendering is WebGPU-first through Three.js's <code>WebGPURenderer</code>.
        Materials are written in <strong>TSL</strong> (Three.js Shading Language) —
        shader logic as composable JS node graphs instead of raw shader strings.
        The same graph compiles to <strong>WGSL</strong> on WebGPU and falls back
        transparently to a WebGL2 backend (GLSL) where WebGPU isn't available. One
        codebase, two APIs.
      </p>
      <ul>
        <li><strong>The green you're seeing is post.</strong> The scene itself is a
          deliberately desaturated cold gray — the always-on <em>Matrix Grade</em>
          post-processing pass owns the green/teal tone, so toggling it is a true
          before/after. Mega mode and the CRT flash are competing post chains that
          preempt it by priority.</li>
        <li><strong>The travelling ground shockwave is genuinely physical to
          gameplay.</strong> The floor displacement is a TSL vertex effect, but the
          crest's radius is tracked on the CPU — each frame, enemies standing in
          the band the wave swept <em>this frame</em> take the impulse. The crowd
          goes flying row by row, exactly as the visible ripple reaches them.</li>
        <li><strong>Budgeted shadows.</strong> One directional light with a 2048px
          map covering the mid-field; beyond it the fog hazes everything anyway,
          so the lost shadows never read. Measured headroom for mass-kill spins.</li>
      </ul>
    </section>`
  }

  private sectionDesign(): string {
    return `
    <section class="info-section">
      <h2><span class="info-num">08</span> Design notes from the Unity original</h2>
      <p>
        The ideas ported from André Cardoso's breakdown are less about any single
        effect and more about discipline:
      </p>
      <ul>
        <li><strong>Layering beats intensity.</strong> Ten subtle effects at 20%
          feel better than two at 100%. Nothing here is dramatic in isolation —
          that's the point of the toggles.</li>
        <li><strong>Everything answers the same event.</strong> One hit fans out to
          sparks, flash, squash, knockback, freeze, shake, and sound
          simultaneously. Coherence — every channel agreeing something happened —
          is what the brain reads as impact.</li>
        <li><strong>Anticipation sells the hit before it lands.</strong> The swing
          eases back before it whips forward. Remove Swing Animation and the same
          damage feels weightless.</li>
        <li><strong>Real physics buys honesty.</strong> Scripted knockback always
          slides the same way. A real impulse plows corpses through crate stacks
          and other enemies, differently every time — the Crate Yard scenario
          exists to prove it isn't faked.</li>
        <li><strong>Effects must be removable.</strong> If an effect can't be
          cleanly disabled mid-game, it's entangled with gameplay and will
          eventually corrupt it. Toggles are an architectural constraint disguised
          as a UI feature.</li>
      </ul>
      <p class="mx-dim">
        Want to add your own? Extend <code>BaseEffect</code>, subscribe to the bus
        in <code>init()</code>, clean up in <code>setEnabled(false)</code>, register
        it in the manager. The panel row and persistence come for free.
      </p>
    </section>`
  }

  // ------------------------------------------------------------- rain fx

  private startRain(): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const canvas = this.rainCanvas
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio, 2)
    canvas.width = Math.floor(window.innerWidth * dpr)
    canvas.height = Math.floor(window.innerHeight * dpr)
    ctx.scale(dpr, dpr)
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight)

    const fontSize = 16
    const columns = Math.ceil(window.innerWidth / fontSize)
    this.rainDrops = Array.from({ length: columns }, () => Math.random() * -60)
    this.rainLast = 0

    const tick = (t: number): void => {
      this.rainRaf = requestAnimationFrame(tick)
      // ~18 fps is plenty for rain and keeps the overlay nearly free.
      if (t - this.rainLast < 55) return
      this.rainLast = t
      ctx.fillStyle = "rgba(0, 8, 3, 0.14)"
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight)
      ctx.font = `${fontSize}px monospace`
      for (let i = 0; i < this.rainDrops.length; i++) {
        const glyph =
          RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)]
        const y = this.rainDrops[i] * fontSize
        if (y > 0) {
          ctx.fillStyle = Math.random() < 0.06 ? "#c8ffdd" : "#1fae52"
          ctx.fillText(glyph, i * fontSize, y)
        }
        if (y > window.innerHeight && Math.random() > 0.975) {
          this.rainDrops[i] = 0
        } else {
          this.rainDrops[i]++
        }
      }
    }
    this.rainRaf = requestAnimationFrame(tick)
  }

  private stopRain(): void {
    cancelAnimationFrame(this.rainRaf)
    this.rainRaf = 0
  }
}

// ------------------------------------------------------------ svg helpers

let diagIdCounter = 0

/**
 * Per-SVG arrowhead marker defs. Each diagram gets its own marker id so the
 * markup stays valid regardless of which SVGs are in the DOM; the returned
 * `head` is passed to the arrow helpers.
 */
function diagDefs(): { defs: string; head: string } {
  const id = `dg-head-${diagIdCounter++}`
  return {
    defs: `<defs><marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" class="dg-head"/></marker></defs>`,
    head: id
  }
}

/** A titled box for the inline diagrams. */
function diagBox(
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  sub: string
): string {
  const cx = x + w / 2
  const titleY = sub ? y + h / 2 - 4 : y + h / 2 + 5
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" class="dg-box"/>
    ${title ? `<text x="${cx}" y="${titleY}" class="dg-box-title" text-anchor="middle">${title}</text>` : ""}
    ${sub ? `<text x="${cx}" y="${y + h / 2 + 14}" class="dg-sub" text-anchor="middle">${sub}</text>` : ""}`
}

function diagArrow(
  head: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="dg-arrow" marker-end="url(#${head})"/>`
}

function diagArrowDashed(
  head: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="dg-arrow dg-dashed" marker-end="url(#${head})"/>`
}
