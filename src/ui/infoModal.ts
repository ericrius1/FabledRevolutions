/**
 * "System dossier" info modal: a floating ⓘ button on the left edge opens a
 * near-fullscreen overlay explaining the project — the juice philosophy, the
 * effect stack, sound synthesis, the event-bus architecture, the two-clock
 * trick, the box3d WASM physics pipeline, threading, and the WebGPU/TSL render
 * path.
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
  /** Play the game's charge-hum voice once for the diagram. Returns seconds. */
  playChargeSound?(): number
  /** Play the game's mega-blast voice once for the diagram. Returns seconds. */
  playBlastSound?(): number
  /** Stop any in-flight preview sound (called on close). */
  stopSounds?(): void
  /** Master-bus analyser for drawing the live audio viz. */
  getAnalyser?(): AnalyserNode | null
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
  private synthDiagramRaf = 0
  /** rAF handle for the live audio visualization under a diagram. */
  private vizRaf = 0
  /** Per play-button timers that clear the transient "playing" state. */
  private previewTimers = new Map<HTMLButtonElement, number>()

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
    this.queueSynthDiagramUpdate()
  }

  close(): void {
    if (!this.openState) return
    this.openState = false
    this.root.hidden = true
    document.body.classList.remove("info-open")
    this.stopRain()
    this.stopViz()
    cancelAnimationFrame(this.synthDiagramRaf)
    this.synthDiagramRaf = 0
    this.hooks.stopSounds?.()
    for (const [btn, id] of this.previewTimers) {
      window.clearTimeout(id)
      btn.classList.remove("is-playing")
    }
    this.previewTimers.clear()
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
        ${this.sectionSoundSynthesis()}
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
    modal
      .querySelector(".info-body")
      ?.addEventListener("scroll", () => this.queueSynthDiagramUpdate(), {
        passive: true
      })
    window.addEventListener("resize", () => this.queueSynthDiagramUpdate())

    // Diagram "play" buttons: fire the real game voice once, then reset the
    // button's playing state after the sound's own length.
    modal
      .querySelectorAll<HTMLButtonElement>(".synth-preview-btn")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation()
          const kind = btn.dataset.preview === "blast" ? "blast" : "charge"
          const seconds =
            kind === "blast"
              ? (this.hooks.playBlastSound?.() ?? 0)
              : (this.hooks.playChargeSound?.() ?? 0)
          this.flashPreviewButton(btn, seconds)
          if (seconds > 0) this.startViz(kind, seconds)
        })
      })
  }

  /** Mark a play button as sounding for `seconds`, then clear it. */
  private flashPreviewButton(btn: HTMLButtonElement, seconds: number): void {
    const prev = this.previewTimers.get(btn)
    if (prev) window.clearTimeout(prev)
    if (seconds <= 0) {
      btn.classList.remove("is-playing")
      this.previewTimers.delete(btn)
      return
    }
    btn.classList.add("is-playing")
    const id = window.setTimeout(() => {
      btn.classList.remove("is-playing")
      this.previewTimers.delete(btn)
    }, seconds * 1000)
    this.previewTimers.set(btn, id)
  }

  // ------------------------------------------------------- live audio viz

  /**
   * Draw the real WebAudio output in the blank space under a diagram while its
   * sound plays: a low-band spectrum (harmonics filling in / the blast's
   * broadband burst) with an oscilloscope trace over the top. Reads the master
   * analyser tap the game already mixes into — it IS the sound, not a fake.
   */
  private startViz(kind: "charge" | "blast", seconds: number): void {
    this.stopViz()
    const analyser = this.hooks.getAnalyser?.()
    const wrap = this.root.querySelector<HTMLElement>(
      kind === "blast" ? ".synth-blast-scroll" : ".synth-charge-scroll"
    )
    const canvas = wrap?.querySelector<HTMLCanvasElement>(".synth-viz")
    const ctx = canvas?.getContext("2d")
    if (!analyser || !canvas || !ctx) return

    const dpr = Math.min(window.devicePixelRatio, 2)
    const cssW = canvas.clientWidth || 600
    const cssH = canvas.clientHeight || 200
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    canvas.classList.add("is-live")

    const bins = analyser.frequencyBinCount
    const freq = new Uint8Array(bins)
    const wave = new Uint8Array(analyser.fftSize)
    // These voices live low; only the bottom ~40% of bins carry the action.
    const usable = Math.floor(bins * 0.42)
    const bars = 56
    const gap = 2
    const bw = (cssW - gap * (bars - 1)) / bars
    const endAt = performance.now() + seconds * 1000 + 320

    const draw = (): void => {
      analyser.getByteFrequencyData(freq)
      analyser.getByteTimeDomainData(wave)
      ctx.clearRect(0, 0, cssW, cssH)

      let energy = 0
      for (let i = 0; i < bars; i++) {
        // Perceptual-ish spread: more bars to the low end where the body sits.
        const frac = i / (bars - 1)
        const bin = Math.min(usable, Math.floor(Math.pow(frac, 1.5) * usable))
        const v = freq[bin] / 255
        energy += v
        const h = Math.max(1, v * (cssH - 16))
        const x = i * (bw + gap)
        const y = cssH - h
        const grad = ctx.createLinearGradient(0, cssH, 0, y)
        grad.addColorStop(0, "rgba(31,174,82,0.22)")
        grad.addColorStop(1, `rgba(120,255,190,${0.34 + v * 0.55})`)
        ctx.fillStyle = grad
        ctx.fillRect(x, y, bw, h)
      }
      energy /= bars

      ctx.beginPath()
      const step = wave.length / cssW
      for (let x = 0; x < cssW; x++) {
        const s = wave[Math.floor(x * step)] / 128 - 1
        const y = cssH * 0.5 + s * cssH * 0.32
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = `rgba(200,255,221,${0.3 + energy * 0.55})`
      ctx.lineWidth = 1.5
      ctx.shadowColor = "rgba(52,224,122,0.85)"
      ctx.shadowBlur = 8
      ctx.stroke()
      ctx.shadowBlur = 0

      ctx.font = "700 9px ui-monospace, monospace"
      ctx.fillStyle = "rgba(52,224,122,0.65)"
      ctx.fillText("◈ LIVE OUTPUT", 2, 10)

      if (performance.now() < endAt && this.openState) {
        this.vizRaf = requestAnimationFrame(draw)
      } else {
        this.stopViz()
      }
    }
    this.vizRaf = requestAnimationFrame(draw)
  }

  private stopViz(): void {
    cancelAnimationFrame(this.vizRaf)
    this.vizRaf = 0
    this.root
      .querySelectorAll<HTMLCanvasElement>(".synth-viz.is-live")
      .forEach((c) => {
        c.classList.remove("is-live")
        c.getContext("2d")?.clearRect(0, 0, c.width, c.height)
      })
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
        "Procedural WebAudio SFX — swing whoosh, charge hum, hit thock, mega blast."
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

  private sectionSoundSynthesis(): string {
    return `
    <section class="info-section info-section-wide info-bonus-section">
      <div class="info-bonus-box">
        <span class="info-title-tag">// BONUS SOUND LAB</span>
        <h2><span class="info-num">BONUS</span> Procedural sound synthesis</h2>
        <p>
          This part is extra for fun: the combat lesson above is about feel and
          architecture; the audio layer is a tiny synthesis lab hiding inside the
          same event system. There are no WAV or MP3 files in the effect stack.
          <code>SoundEffect</code> builds short WebAudio graphs at the moment of
          impact.
        </p>
      </div>
      <p>
        Most voices here are made from four reusable pieces: an oscillator for
        tonal body, a noise burst for air or crackle, filters for color, and
        gain envelopes for motion. The sound is <em>performed</em>, not played
        back. Slow motion lowers playback rates and stretches envelopes; charge
        level keeps pushing oscillator pitch, detune, filter cutoff, and LFO
        throb while the button is held.
      </p>
      <p>
        The important WebAudio trick is that nearly every number is scheduled on
        an <code>AudioParam</code>. A pitch glide is not a loop that constantly
        rewrites frequency; it is a tiny automation curve. A punchy hit is not
        just a loud oscillator; it is a gain envelope that rises almost
        instantly and then falls on purpose. This project leans on those curves
        so the audio reacts to the same combat events that drive particles,
        camera shake, and hit stop.
      </p>
      <dl class="synth-concept-list">
        <div>
          <dt>Oscillators</dt>
          <dd>Saws make bright charge energy. Sines carry low weight without fizz.</dd>
        </div>
        <div>
          <dt>Filters</dt>
          <dd>The lowpass opens during charge, revealing harmonics as power builds.</dd>
        </div>
        <div>
          <dt>Envelopes</dt>
          <dd>Short ramps define attack, body, release, and whether a sound feels heavy.</dd>
        </div>
        <div>
          <dt>Wet bus</dt>
          <dd>Reverb and echo are shared, so separate blast layers land in one room.</dd>
        </div>
      </dl>
      ${this.soundChargeStage()}
      <p>
        The charge patch is a continuous voice. While the player holds the
        attack, the graph stays alive and receives updated control values every
        frame. The saw pair is deliberately a little wrong: detune spreads the
        voices apart so the hum beats and wobbles. The sine sub sits underneath
        at half frequency, making the charge feel large without needing to be
        harsh or loud.
      </p>
      <p>
        Notice how the filter does as much emotional work as the pitch. If only
        the oscillator frequency rose, the sound would feel like a siren. Opening
        the lowpass makes the same voice reveal more harmonics over time, which
        reads as stored energy. The LFO is another small illusion: it modulates
        gain, so the charge breathes instead of becoming a flat drone.
      </p>
      ${this.soundBlastStage()}
      <p>
        The blast is a one-shot event, but it is not one sound. It is a stack of
        envelopes that begin together: a falling sine sub for mass, a detuned
        chord for bite, a highpassed noise flash for impact air, and a room tail
        that keeps the hit alive after the dry layers are gone. The curves are
        intentionally different lengths so the ear can read a beginning, a body,
        and an aftermath.
      </p>
      <p>
        This is also why procedural effects are useful in a game-feel prototype.
        The same code can scale a hit, a kill, a charged release, or a slow-motion
        moment without exporting a new file for every case. Instead of choosing
        one recording, the game chooses a patch and pushes live values through it.
      </p>
      <div class="info-link-grid" aria-label="Further learning links">
        <a href="https://learningsynths.ableton.com/" target="_blank" rel="noopener">
          <span>Learning Synths</span>
          <small>Ableton's interactive browser synth: oscillators, filters, envelopes, LFOs, and playable patches.</small>
        </a>
        <a href="https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Advanced_techniques" target="_blank" rel="noopener">
          <span>Web Audio techniques</span>
          <small>MDN's code-level walkthrough of envelopes, LFO modulation, noise buffers, filters, and sequencing.</small>
        </a>
      </div>
    </section>`
  }

  private soundChargeStage(): string {
    const { defs, head } = diagDefs()
    return `
      <div class="synth-sticky-scroll synth-charge-scroll" data-synth-diagram="charge-stage">
        <div class="synth-sticky-stage">
          <div class="synth-stage-copy">
            <span class="info-title-tag">DIAGRAM 1 / CHARGE PATCH</span>
            <h3 class="synth-stage-title">Building a hum while power rises</h3>
            <button class="synth-preview-btn" type="button" data-preview="charge"
                    aria-label="Play the charge hum sound effect">
              <span class="synth-preview-icon" aria-hidden="true"></span>
              <span class="synth-preview-label">Play charge hum</span>
            </button>
            <div class="synth-stage-steps">
              <p class="synth-stage-line cs-copy-osc">
                <strong>Oscillator rack.</strong>
                Two saws create the bright electrical edge. A sine one octave
                lower adds weight without cluttering the top end.
              </p>
              <p class="synth-stage-line cs-copy-filter">
                <strong>Lowpass motion.</strong>
                The cutoff opens during charge, so harmonics appear as the
                sword fills.
              </p>
              <p class="synth-stage-line cs-copy-amp">
                <strong>Gain modulation.</strong>
                A sine LFO pulses the level. Faster charge means faster throb.
              </p>
              <p class="synth-stage-line cs-copy-space">
                <strong>Output path.</strong>
                Dry signal goes through a limiter while a quieter copy feeds the
                shared wet bus.
              </p>
            </div>
            <dl class="synth-readouts">
              <div>
                <dt>charge</dt>
                <dd><span class="sd-charge-readout">0.00</span></dd>
              </div>
              <div>
                <dt>cutoff</dt>
                <dd><span class="sd-cutoff-readout">180</span> Hz</dd>
              </div>
              <div>
                <dt>throb</dt>
                <dd><span class="sd-lfo-readout">1.8</span> Hz</dd>
              </div>
            </dl>
          </div>
          <div class="info-scroll synth-scroll-diagram">
            <svg class="info-diagram synth-diagram synth-stage-diagram synth-charge-diagram" viewBox="0 0 1080 600" width="1080" height="600" preserveAspectRatio="xMidYMin meet" role="img"
                 aria-label="Sticky animated WebAudio charge synthesis diagram showing oscillators, filter, gain modulation, and output routing">
              ${defs}
              <clipPath id="synth-charge-clip"><rect x="24" y="18" width="1032" height="550" rx="8"/></clipPath>
              <g clip-path="url(#synth-charge-clip)">
              <text x="34" y="42" class="dg-title">LIVE CHARGE HUM PATCH</text>
              <text x="34" y="64" class="dg-sub">continuous voice, updated every frame</text>

              <g class="cs-meter">
                <rect x="734" y="30" width="286" height="18" rx="4" class="sd-meter-shell"/>
                <rect x="734" y="30" width="286" height="18" rx="4" class="sd-charge-fill"/>
                <line x1="877" y1="26" x2="877" y2="54" class="sd-meter-tick"/>
                <text x="734" y="70" class="dg-sub">0</text>
                <text x="866" y="70" class="dg-sub">1 full</text>
                <text x="994" y="70" class="dg-sub">2 mega</text>
                <text x="880" y="96" class="dg-hot" text-anchor="middle">level <tspan class="sd-charge-readout">0.00</tspan></text>
              </g>

              <g class="cs-step cs-step-osc">
                <rect x="48" y="112" width="266" height="242" rx="8" class="cs-node-box"/>
                <text x="70" y="144" class="dg-title">OSCILLATOR RACK</text>
                <text x="70" y="166" class="dg-sub">tone body before filtering</text>
                <rect x="70" y="194" width="214" height="38" rx="5" class="cs-scope"/>
                <path d="M86 220 l10 -22 v22 l10 -22 v22 l10 -22 v22 l10 -22 v22 l10 -22 v22" class="sd-wave"/>
                <text x="70" y="258" class="dg-hot">saw A</text>
                <text x="132" y="258" class="dg-sub">55 -> 110 Hz</text>
                <rect x="70" y="276" width="214" height="38" rx="5" class="cs-scope"/>
                <path d="M86 302 l10 -22 v22 l10 -22 v22 l10 -22 v22 l10 -22 v22 l10 -22 v22" class="sd-wave sd-wave-alt cs-detune-wave"/>
                <text x="70" y="340" class="dg-hot">saw B</text>
                <text x="132" y="340" class="dg-sub">detune <tspan class="sd-detune-readout">3</tspan> cents</text>
                <rect x="70" y="372" width="214" height="48" rx="5" class="cs-scope"/>
                <path d="M88 401 c16 -23 32 -23 48 0 s32 23 48 0 s32 -23 48 0" class="sd-wave sd-sub-wave"/>
                <text x="70" y="448" class="dg-hot">sine sub</text>
                <text x="152" y="448" class="dg-sub">half frequency</text>
              </g>

              ${diagArrow(head, 314, 238, 374, 238)}

              <g class="cs-step cs-step-filter">
                <rect x="374" y="130" width="262" height="262" rx="8" class="cs-node-box cs-node-hot"/>
                <text x="402" y="164" class="dg-title">LOWPASS FILTER</text>
                <text x="402" y="186" class="dg-sub">cutoff opens as charge rises</text>
                <rect x="402" y="218" width="204" height="104" rx="5" class="cs-scope"/>
                <line x1="420" y1="292" x2="588" y2="292" class="dg-line"/>
                <line x1="420" y1="252" x2="588" y2="252" class="dg-line"/>
                <path d="M420 292 C458 290 486 276 508 252 S548 222 588 220" class="sd-filter-curve" pathLength="1"/>
                <circle cx="430" cy="290" r="7" class="sd-filter-dot"/>
                <text x="402" y="352" class="dg-hot">cutoff <tspan class="sd-cutoff-readout">180</tspan> Hz</text>
                <text x="402" y="374" class="dg-sub">darker start, brighter finish</text>
              </g>

              ${diagArrow(head, 636, 238, 700, 238)}

              <g class="cs-step cs-step-amp">
                <rect x="700" y="124" width="300" height="210" rx="8" class="cs-node-box"/>
                <text x="728" y="158" class="dg-title">GAIN + LFO</text>
                <text x="728" y="180" class="dg-sub">envelope plus animated throb</text>
                <rect x="728" y="210" width="232" height="74" rx="5" class="cs-scope"/>
                <path d="M748 260 C778 216 808 216 838 260 S896 304 940 238" class="sd-lfo-wave" pathLength="1"/>
                <text x="728" y="314" class="dg-hot">LFO <tspan class="sd-lfo-readout">1.8</tspan> Hz</text>
                <text x="828" y="314" class="dg-sub">modulates gain</text>
              </g>

              <g class="cs-step cs-step-space">
                <rect x="704" y="406" width="128" height="66" rx="6" class="dg-box"/>
                <text x="768" y="435" class="dg-box-title" text-anchor="middle">wet bus</text>
                <text x="768" y="455" class="dg-sub" text-anchor="middle">reverb + echo</text>
                <rect x="872" y="406" width="128" height="66" rx="6" class="dg-box"/>
                <text x="936" y="435" class="dg-box-title" text-anchor="middle">speakers</text>
                <text x="936" y="455" class="dg-sub" text-anchor="middle">limited output</text>
                ${diagArrowDashed(head, 850, 334, 778, 406)}
                ${diagArrow(head, 850, 334, 936, 406)}
                ${diagArrowDashed(head, 832, 438, 872, 438)}
              </g>

              <circle r="6" cx="344" cy="238" class="sd-flow-pulse sd-flow-a"/>
              <circle r="5" cx="670" cy="238" class="sd-flow-pulse sd-flow-b"/>
              <circle r="5" cx="850" cy="334" class="sd-flow-pulse sd-flow-c"/>

              <g class="cs-step cs-step-auto">
                <text x="48" y="516" class="dg-title">CONTROL AUTOMATION</text>
                <text x="48" y="538" class="dg-sub">AudioParam ramps written while charging</text>
                <text x="48" y="570" class="dg-hot">pitch</text>
                <text x="168" y="570" class="dg-hot">cutoff</text>
                <text x="300" y="570" class="dg-hot">gain throb</text>
                <rect x="430" y="500" width="570" height="28" rx="5" class="cs-scope"/>
                <rect x="430" y="542" width="570" height="28" rx="5" class="cs-scope"/>
                <path d="M448 520 C548 518 646 512 736 507 S892 505 982 506" class="cs-auto-line cs-auto-pitch" pathLength="1"/>
                <path d="M448 562 C540 562 610 554 676 540 S812 520 982 518" class="cs-auto-line cs-auto-cutoff" pathLength="1"/>
                <path d="M448 553 C486 540 524 540 562 553 S638 566 676 553 S752 540 790 553 S866 566 904 553 S960 540 982 548" class="cs-auto-line cs-auto-lfo" pathLength="1"/>
              </g>
              </g>
            </svg>
            <canvas class="synth-viz" data-viz="charge" aria-hidden="true"></canvas>
          </div>
        </div>
      </div>`
  }

  private soundBlastStage(): string {
    const { defs } = diagDefs()
    return `
      <div class="synth-sticky-scroll synth-blast-scroll" data-synth-diagram="blast-stage">
        <div class="synth-sticky-stage">
          <div class="synth-stage-copy">
            <span class="info-title-tag">DIAGRAM 2 / BLAST RELEASE</span>
            <h3 class="synth-stage-title">Layering one event into a hit</h3>
            <button class="synth-preview-btn" type="button" data-preview="blast"
                    aria-label="Play the mega blast sound effect">
              <span class="synth-preview-icon" aria-hidden="true"></span>
              <span class="synth-preview-label">Play mega blast</span>
            </button>
            <div class="synth-stage-steps">
              <p class="synth-stage-line bd-copy-sub">
                <strong>Sub drop.</strong>
                A sine falls quickly from weapon-sized tension to chest-sized
                weight.
              </p>
              <p class="synth-stage-line bd-copy-chord">
                <strong>Power chord.</strong>
                Detuned saws give the blast a pitched, aggressive center.
              </p>
              <p class="synth-stage-line bd-copy-noise">
                <strong>Noise flash.</strong>
                Filtered noise adds the bright transient that makes the event
                feel physical.
              </p>
              <p class="synth-stage-line bd-copy-tail">
                <strong>Room tail.</strong>
                Reverb and delay stay after the dry layers fade, selling size.
              </p>
            </div>
            <dl class="synth-readouts">
              <div>
                <dt>time</dt>
                <dd><span class="bd-time-readout">0.00</span>s</dd>
              </div>
              <div>
                <dt>dry</dt>
                <dd><span class="bd-dry-readout">100</span>%</dd>
              </div>
              <div>
                <dt>wet</dt>
                <dd><span class="bd-wet-readout">24</span>%</dd>
              </div>
            </dl>
          </div>
          <div class="info-scroll synth-scroll-diagram">
            <svg class="info-diagram synth-diagram synth-stage-diagram synth-blast-diagram" viewBox="0 0 1080 700" width="1080" height="700" preserveAspectRatio="xMidYMin meet" role="img"
                 aria-label="Sticky animated mega blast timeline showing sub, chord, noise, and reverb envelopes in separate lanes">
              ${defs}
              <clipPath id="synth-blast-chart-clip"><rect x="320" y="86" width="708" height="554" rx="8"/></clipPath>

              <text x="34" y="42" class="dg-title">MEGA BLAST LAYER TIMELINE</text>
              <text x="34" y="66" class="dg-sub">one combat event, four scheduled envelopes</text>
              <line x1="296" y1="86" x2="296" y2="640" class="bd-divider"/>
              <text x="340" y="66" class="dg-hot">scroll the pinned panel: each curve reveals as the release opens</text>

              <g class="bd-labels">
                <text x="48" y="128" class="dg-hot">SUB DROP</text>
                <text x="48" y="151" class="dg-sub">sine oscillator</text>
                <text x="48" y="174" class="dg-sub">110 Hz -> 24 Hz</text>

                <text x="48" y="250" class="dg-hot">SAW CHORD</text>
                <text x="48" y="273" class="dg-sub">A/E/A stack</text>
                <text x="48" y="296" class="dg-sub">detuned body</text>

                <text x="48" y="372" class="dg-hot">NOISE CRASH</text>
                <text x="48" y="395" class="dg-sub">highpassed burst</text>
                <text x="48" y="418" class="dg-sub">fast decay</text>

                <text x="48" y="494" class="dg-hot">ROOM TAIL</text>
                <text x="48" y="517" class="dg-sub">convolver + delay</text>
                <text x="48" y="540" class="dg-sub">long aftermath</text>
              </g>

              <g clip-path="url(#synth-blast-chart-clip)">
                <rect x="340" y="100" width="660" height="88" rx="7" class="sd-lane"/>
                <rect x="340" y="218" width="660" height="88" rx="7" class="sd-lane"/>
                <rect x="340" y="336" width="660" height="88" rx="7" class="sd-lane"/>
                <rect x="340" y="454" width="660" height="88" rx="7" class="sd-lane sd-tail-lane"/>

                ${Array.from({ length: 6 }, (_, i) => `<line x1="${340 + i * 132}" y1="86" x2="${340 + i * 132}" y2="640" class="bd-grid-line"/>`).join("")}
                <path d="M358 127 C448 129 540 141 632 159 S808 171 982 167" class="sd-layer-line sd-layer-sub" pathLength="1"/>
                <path d="M358 283 C440 247 560 247 686 267 S852 301 982 299" class="sd-layer-line sd-layer-chord" pathLength="1"/>
                <path d="M358 407 C390 359 448 359 492 399 S610 443 706 419" class="sd-layer-line sd-layer-noise" pathLength="1"/>
                <path d="M358 531 C476 507 642 513 790 531 S910 559 982 557" class="sd-layer-line sd-layer-verb" pathLength="1"/>

                <line x1="340" y1="640" x2="1000" y2="640" class="dg-line"/>
                ${Array.from({ length: 6 }, (_, i) => `<line x1="${340 + i * 132}" y1="632" x2="${340 + i * 132}" y2="648" class="dg-tick"/>`).join("")}
              </g>

              <text x="335" y="668" class="dg-sub">0.0s</text>
              <text x="940" y="668" class="dg-sub">1.8s tail</text>

              <g class="bd-playhead" transform="translate(340 0)">
                <rect x="-44" y="74" width="88" height="28" rx="5" class="sd-playhead-tag"/>
                <line x1="0" y1="108" x2="0" y2="640" class="sd-playhead-line"/>
                <circle cx="0" cy="640" r="8" class="sd-playhead-dot"/>
                <text x="0" y="94" class="dg-hot" text-anchor="middle">t=<tspan class="bd-time-readout">0.00</tspan>s</text>
              </g>

              <g class="bd-mixer">
                <rect x="748" y="18" width="130" height="38" rx="5" class="dg-box"/>
                <text x="813" y="44" class="dg-box-title" text-anchor="middle">dry bus <tspan class="bd-dry-readout">100</tspan>%</text>
                <rect x="894" y="18" width="130" height="38" rx="5" class="dg-box"/>
                <text x="959" y="44" class="dg-box-title" text-anchor="middle">wet bus <tspan class="bd-wet-readout">24</tspan>%</text>
              </g>
            </svg>
            <canvas class="synth-viz" data-viz="blast" aria-hidden="true"></canvas>
          </div>
        </div>
      </div>`
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

  // -------------------------------------------------------- scroll diagrams

  private queueSynthDiagramUpdate(): void {
    if (!this.openState || this.synthDiagramRaf) return
    this.synthDiagramRaf = requestAnimationFrame(() => {
      this.synthDiagramRaf = 0
      this.updateSynthDiagrams()
    })
  }

  private updateSynthDiagrams(): void {
    const body = this.root.querySelector<HTMLElement>(".info-body")
    if (!body) return
    const bodyRect = body.getBoundingClientRect()
    const diagrams = body.querySelectorAll<HTMLElement>("[data-synth-diagram]")
    for (const diagram of diagrams) {
      const rect = diagram.getBoundingClientRect()
      const stage = diagram.querySelector<HTMLElement>(".synth-sticky-stage")
      const stageHeight = stage?.getBoundingClientRect().height ?? bodyRect.height
      const travel = Math.max(1, rect.height - stageHeight)
      const progress = clamp01((bodyRect.top + 12 - rect.top) / travel)
      const eased = progress * progress * (3 - 2 * progress)
      diagram.style.setProperty("--p", progress.toFixed(3))
      diagram.style.setProperty("--ease", eased.toFixed(3))
      if (diagram.dataset.synthDiagram === "charge-stage") {
        this.updateChargeStage(diagram, progress)
      } else if (diagram.dataset.synthDiagram === "blast-stage") {
        this.updateBlastStage(diagram, progress)
      }
    }
  }

  private updateChargeStage(diagram: HTMLElement, progress: number): void {
    const chargeProgress = clamp01(progress)
    const chargeEase = smooth01(chargeProgress)
    const chargeLevel = Math.min(2, chargeEase * 2.05)
    const cutoffHz = Math.round(180 + chargeEase * 980)
    const detuneCents = Math.round(3 + chargeEase * 25)
    const lfoHz = 1.8 + chargeLevel * 1.7
    diagram.style.setProperty("--charge", chargeProgress.toFixed(3))
    diagram.style.setProperty("--charge-ease", chargeEase.toFixed(3))
    diagram.style.setProperty("--tone-opacity", fmt(mix(0.38, 1, clamp01(chargeProgress * 3.2))))
    diagram.style.setProperty("--filter-opacity", fmt(mix(0.2, 1, clamp01((chargeProgress - 0.08) * 4.5))))
    diagram.style.setProperty("--gain-opacity", fmt(mix(0.2, 1, clamp01((chargeProgress - 0.28) * 4.5))))
    diagram.style.setProperty("--output-opacity", fmt(mix(0.18, 1, clamp01((chargeProgress - 0.48) * 4.2))))
    diagram.style.setProperty("--stage-osc-opacity", fmt(mix(0.5, 1, clamp01(chargeProgress * 2.6))))
    diagram.style.setProperty("--stage-filter-opacity", fmt(mix(0.24, 1, clamp01((chargeProgress - 0.16) * 4))))
    diagram.style.setProperty("--stage-amp-opacity", fmt(mix(0.18, 1, clamp01((chargeProgress - 0.34) * 4))))
    diagram.style.setProperty("--stage-space-opacity", fmt(mix(0.16, 1, clamp01((chargeProgress - 0.56) * 3.6))))
    diagram.style.setProperty("--wave-alt-opacity", fmt(mix(0.45, 1, chargeEase)))
    diagram.style.setProperty("--sub-wave-opacity", fmt(mix(0.4, 1, chargeEase)))
    diagram.style.setProperty("--detune-y", `${fmt(chargeEase * 8)}px`)
    diagram.style.setProperty("--charge-dash", fmt(1 - chargeEase))
    diagram.style.setProperty("--filter-dot-x", `${fmt(chargeEase * 150)}px`)
    diagram.style.setProperty("--filter-dot-y", `${fmt(chargeEase * -70)}px`)
    diagram.style.setProperty("--lfo-scale", fmt(0.55 + chargeEase * 0.7))
    diagram.style.setProperty("--flow-opacity", fmt(clamp01((chargeProgress - 0.18) * 3.8)))
    diagram.style.setProperty("--flow-a-x", `${fmt(chargeEase * 48)}px`)
    diagram.style.setProperty("--flow-b-x", `${fmt(chargeEase * 48)}px`)
    diagram.style.setProperty("--flow-c-x", `${fmt(chargeEase * 50)}px`)
    diagram
      .querySelectorAll(".sd-charge-readout")
      .forEach((el) => el.replaceChildren(chargeLevel.toFixed(2)))
    diagram
      .querySelectorAll(".sd-cutoff-readout")
      .forEach((el) => el.replaceChildren(String(cutoffHz)))
    diagram
      .querySelectorAll(".sd-detune-readout")
      .forEach((el) => el.replaceChildren(String(detuneCents)))
    diagram
      .querySelectorAll(".sd-lfo-readout")
      .forEach((el) => el.replaceChildren(lfoHz.toFixed(1)))
  }

  private updateBlastStage(diagram: HTMLElement, progress: number): void {
    const blastProgress = clamp01(progress)
    const blastEase = smooth01(blastProgress)
    const seconds = blastProgress * 1.8
    const dryPercent = Math.max(0, Math.round(100 - blastEase * 72))
    const wetPercent = Math.round(24 + blastEase * 76)
    diagram.style.setProperty("--blast", blastProgress.toFixed(3))
    diagram.style.setProperty("--blast-ease", blastEase.toFixed(3))
    diagram.style.setProperty("--stage-sub-opacity", fmt(mix(0.45, 1, clamp01(blastProgress * 4))))
    diagram.style.setProperty("--stage-chord-opacity", fmt(mix(0.25, 1, clamp01((blastProgress - 0.08) * 4))))
    diagram.style.setProperty("--stage-noise-opacity", fmt(mix(0.2, 1, clamp01((blastProgress - 0.18) * 4))))
    diagram.style.setProperty("--stage-tail-opacity", fmt(mix(0.2, 1, clamp01((blastProgress - 0.36) * 3.2))))
    diagram.style.setProperty("--blast-dash", fmt(1 - blastProgress))
    diagram.style.setProperty("--sub-dash", fmt(clamp01(1 - blastProgress * 1.25)))
    diagram.style.setProperty("--chord-dash", fmt(clamp01(1 - (blastProgress - 0.1) * 1.5)))
    diagram.style.setProperty("--noise-dash", fmt(clamp01(1 - (blastProgress - 0.04) * 3.2)))
    diagram.style.setProperty("--verb-dash", fmt(clamp01(1 - (blastProgress - 0.16) * 1.25)))
    diagram.style.setProperty("--blast-glow", `${fmt(blastEase * 10)}px`)
    diagram
      .querySelectorAll(".bd-time-readout")
      .forEach((el) => el.replaceChildren(seconds.toFixed(2)))
    diagram
      .querySelectorAll(".bd-dry-readout")
      .forEach((el) => el.replaceChildren(String(dryPercent)))
    diagram
      .querySelectorAll(".bd-wet-readout")
      .forEach((el) => el.replaceChildren(String(wetPercent)))
    diagram
      .querySelector<SVGElement>(".bd-playhead")
      ?.setAttribute("transform", `translate(${340 + blastProgress * 660} 0)`)
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function smooth01(value: number): number {
  return value * value * (3 - 2 * value)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function fmt(value: number): string {
  return value.toFixed(3)
}
