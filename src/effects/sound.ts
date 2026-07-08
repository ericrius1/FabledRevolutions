import { BaseEffect, type EffectContext, type EffectGroup } from "./effect";

const VOLUME_KEY = "fabled-revolutions.sfx-volume";
/** Master bus level at 100% slider — individual voices are tuned against this. */
const BASE_MASTER_GAIN = 0.35;
const DEFAULT_VOLUME = 0.5;

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return DEFAULT_VOLUME;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function saveVolume(value: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    // localStorage unavailable; ignore.
  }
}

/**
 * Procedural WebAudio SFX — no audio assets, everything is synthesized:
 *   - swing "whoosh": filtered noise burst that sweeps down (attack-start)
 *   - hit "crack":    short pitched bite + crackling noise transient (attack-hit)
 *   - kill "boom":    deeper sine thump with a crackling front edge (kill)
 *   - charge hum:     rising detuned saw drone tracking the charge level
 *   - spin release:   double whoosh + slash crack, scaled by power
 *   - mega blast:     sub drop + saw-stack chord + noise crash through a
 *                     generated convolver reverb and a feedback echo
 *   - thunder:        crackling discharge + rolling low thunder per lightning
 *                     strike (aftermath)
 *   - agent landings: grouped concrete crash when fly-in ranks slam down
 *
 * Browsers block audio until a user gesture, so the AudioContext is created
 * lazily on the first pointer/key event and resumed if suspended. When disabled
 * the effect simply stops playing (the context is left alive but silent).
 */
export class SoundEffect extends BaseEffect {
  readonly id = "sound";
  readonly label = "Sound";
  readonly description = "Procedural WebAudio SFX: swings, hits, charge hum, mega blast, arrival crashes.";
  readonly group: EffectGroup = "Audio";

  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 0..1 user volume; applied on top of BASE_MASTER_GAIN. */
  private volume = loadVolume();
  private noiseBuffer: AudioBuffer | null = null;
  /** Wet bus: convolver reverb + feedback echo, fed per-sound via sendVerb(). */
  private verb: ConvolverNode | null = null;
  private verbSend: GainNode | null = null;
  /** Brick-wall-ish limiter on the master out so the loud thunder boom can
   *  hit hard without clipping the whole mix into ugly digital fuzz. */
  private limiter: DynamicsCompressorNode | null = null;
  /** Read-only tap off the master bus for the dossier's live audio viz. */
  private analyser: AnalyserNode | null = null;

  // Charge drone voice (lives while charging; everything tracks the charge
  // level). Deliberately LOW and menacing — think Neo realizing he's the One,
  // not a laser charging: detuned saws around 55 Hz, a sub octave underneath,
  // a dark lowpass that never opens past ~900 Hz, and a slow throb LFO that
  // quickens as the charge deepens. Menace comes from weight and detune spread,
  // not pitch.
  private humOsc: OscillatorNode | null = null;
  private humOsc2: OscillatorNode | null = null;
  private humSub: OscillatorNode | null = null;
  private humLfo: OscillatorNode | null = null;
  private humLfoDepth: GainNode | null = null;
  private humGain: GainNode | null = null;
  private humFilter: BiquadFilterNode | null = null;

  // Dossier preview: a self-contained charge drone (its own voice, not the live
  // `hum*` nodes) so the info panel can demo the sound without a real charge.
  private previewHum: { oscs: OscillatorNode[]; gain: GainNode } | null = null;
  /** Pending "slowed" blast in the time-dilation A/B demo (cleared on stop). */
  private timeShiftTimer = 0;

  // Voice rate limiting: a mass-kill spin fires dozens of hit events in a few
  // frames; building an oscillator graph per event stalls both the audio
  // thread and the main thread. One thock/boom per short window is plenty —
  // the ear can't separate them anyway.
  private lastThock = -1;
  private lastBoom = -1;
  private lastChargedHitBoom = -1;
  private lastMegaBoom = -1;
  private lastArrivalCrash = -1;
  private lastThunderRoll = -1;
  private lastThunderClap = -1;

  init(ctx: EffectContext): void {
    super.init(ctx);

    // Defer AudioContext creation to the first user gesture (autoplay policy).
    const unlock = (): void => this.ensureAudio();
    window.addEventListener("pointerdown", unlock, { once: false });
    window.addEventListener("keydown", unlock, { once: false });

    ctx.bus.on("attack-start", () => this.enabled && this.whoosh());
    ctx.bus.on("attack-hit", ({ killed, power }) => {
      if (!this.enabled) return;
      // Bullet-time hits get the huge waterfall-boom treatment instead of the
      // dry thock/boom — each connect lands like a depth charge.
      if (this.timeRate() < 0.9) this.megaHitBoom();
      else if (power >= 4.6) this.chargedHitBoom(power, killed);
      else if (killed) this.boom();
      else this.thock();
    });

    ctx.bus.on("charge-start", () => this.enabled && this.startHum());
    ctx.bus.on("charge-cancel", () => this.stopHum());
    ctx.bus.on("charge-full", ({ mega }) => this.enabled && this.chargeDing(mega));
    ctx.bus.on("spin-attack", ({ power, mega }) => {
      this.stopHum();
      if (!this.enabled) return;
      if (!mega) this.spinWhoosh(power);
    });
    ctx.bus.on("dive-start", ({ mega }) => this.enabled && this.diveDescend(mega));
    ctx.bus.on("dive-impact", ({ mega }) => this.enabled && this.diveImpact(mega));
    ctx.bus.on("mega-armed", () => this.enabled && this.megaArmedCharge());
    ctx.bus.on("mega-release", () => this.enabled && this.megaBlast());
    // The ground smash lands the same deep mega boom on top of its dive impact.
    ctx.bus.on("mega-smash", () => this.enabled && this.megaBlast());
    ctx.bus.on("mega-lightning", () => this.enabled && this.thunder());
    ctx.bus.on("enemy-arrival-impact", ({ count, dropHeight }) => {
      if (this.enabled) this.arrivalCrash(count, dropHeight);
    });
  }

  update(_unscaledDt: number): void {
    // Drone weight/detune/throb track the live charge level every frame.
    // Pitch only climbs one octave (55 → 110 Hz) — it gets HEAVIER, not higher.
    if (!this.humOsc || !this.audio) return;
    const combat = this.ctx.getPlayer().combat;
    if (!combat?.charging) return;
    const c = combat.chargeLevel; // 0..2
    const t = this.now();
    const freq = 55 * (1 + c * 0.5);
    this.humOsc.frequency.setTargetAtTime(freq, t, 0.05);
    this.humOsc2?.frequency.setTargetAtTime(freq, t, 0.05);
    // Detune spread widens with charge — the drone grows more dissonant.
    this.humOsc2?.detune.setTargetAtTime(7 + c * 9, t, 0.05);
    this.humSub?.frequency.setTargetAtTime(freq / 2, t, 0.05);
    this.humFilter?.frequency.setTargetAtTime(200 + c * 350, t, 0.08);
    this.humGain?.gain.setTargetAtTime(0.16 + Math.min(c, 2) * 0.13, t, 0.06);
    // Throb quickens and deepens as the overcharge builds.
    this.humLfo?.frequency.setTargetAtTime(1.8 + c * 1.7, t, 0.1);
    this.humLfoDepth?.gain.setTargetAtTime(0.04 + c * 0.06, t, 0.1);
  }

  setEnabled(enabled: boolean): void {
    super.setEnabled(enabled);
    // Warm up the context as soon as the user opts in (still needs a gesture to
    // actually start on some browsers, but resume() here covers the common case).
    if (enabled) this.ensureAudio();
    else this.stopHum();
  }

  /**
   * Route the master bus into a MediaStream for video capture (dev/record
   * mode). Returns [] until the AudioContext exists and is running — the
   * caller is responsible for having a user gesture unlock audio first.
   */
  getCaptureTracks(): MediaStreamTrack[] {
    this.ensureAudio();
    if (!this.audio || !this.master || this.audio.state !== "running") return [];
    const dest = this.audio.createMediaStreamDestination();
    (this.limiter ?? this.master).connect(dest);
    return dest.stream.getAudioTracks();
  }

  /** Current AudioContext state for capture tooling ("none" if not created). */
  get audioState(): string {
    return this.audio?.state ?? "none";
  }

  /** Master-bus analyser for the dossier's live audio viz (lazily created). */
  getAnalyser(): AnalyserNode | null {
    this.ensureAudio();
    return this.analyser;
  }

  /** User SFX volume, 0..1 (default 0.5). */
  getVolume(): number {
    return this.volume;
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    saveVolume(this.volume);
    this.applyMasterGain();
  }

  /** Create (or resume) the AudioContext + shared noise buffer + wet bus. */
  private ensureAudio(): void {
    if (!this.audio) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      this.audio = new Ctor();
      this.master = this.audio.createGain();
      this.applyMasterGain();
      // Master -> limiter -> speakers. Fast, aggressive limiting catches the
      // thunder transients so they read as LOUD, not clipped.
      this.limiter = this.audio.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.18;
      this.master.connect(this.limiter).connect(this.audio.destination);
      // Parallel read-only tap for the dossier viz (no output — just samples).
      this.analyser = this.audio.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.78;
      this.master.connect(this.analyser);
      this.noiseBuffer = this.makeNoise(this.audio);

      // Wet bus: send -> convolver (generated 2.6 s hall IR) -> master, plus a
      // feedback delay tapped off the same send for the echo slap-backs.
      this.verbSend = this.audio.createGain();
      this.verbSend.gain.value = 1;
      this.verb = this.audio.createConvolver();
      this.verb.buffer = this.makeImpulseResponse(this.audio, 2.6, 2.4);
      this.verbSend.connect(this.verb).connect(this.master);
      const delay = this.audio.createDelay(1);
      delay.delayTime.value = 0.27;
      const feedback = this.audio.createGain();
      feedback.gain.value = 0.42;
      const echoTone = this.audio.createBiquadFilter();
      echoTone.type = "lowpass";
      echoTone.frequency.value = 2200;
      this.verbSend.connect(delay);
      delay.connect(echoTone).connect(feedback).connect(delay);
      const echoOut = this.audio.createGain();
      echoOut.gain.value = 0.5;
      feedback.connect(echoOut).connect(this.master);
    }
    if (this.audio.state === "suspended") void this.audio.resume();
  }

  private applyMasterGain(): void {
    if (!this.master) return;
    this.master.gain.value = BASE_MASTER_GAIN * this.volume;
  }

  /** Exponentially decaying stereo noise burst — a serviceable hall IR. */
  private makeImpulseResponse(audio: AudioContext, seconds: number, decay: number): AudioBuffer {
    const len = Math.floor(audio.sampleRate * seconds);
    const buffer = audio.createBuffer(2, len, audio.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buffer;
  }

  /** Route a node into the reverb+echo bus at the given send level. */
  private sendVerb(node: AudioNode, level: number): void {
    if (!this.audio || !this.verbSend) return;
    const send = this.audio.createGain();
    send.gain.value = level;
    node.connect(send).connect(this.verbSend);
  }

  private makeNoise(audio: AudioContext): AudioBuffer {
    const len = Math.floor(audio.sampleRate * 0.5);
    const buffer = audio.createBuffer(1, len, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private now(): number {
    return this.audio ? this.audio.currentTime : 0;
  }

  /**
   * Current time-dilation for new voices. During mega bullet time everything
   * pitches down and stretches out with the world — the iPhone slo-mo sound.
   * Clamped so hit-stop (timeScale 0) can't zero a frequency.
   */
  private timeRate(): number {
    return Math.max(0.12, Math.min(1, this.ctx.clock.slowMo));
  }

  /** Filtered noise burst sweeping down — an air-whoosh. */
  private whoosh(): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const r = this.timeRate();
    const src = this.audio.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = r;
    const filter = this.audio.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1800 * r, t);
    filter.frequency.exponentialRampToValueAtTime(400 * r, t + 0.18 / r);
    filter.Q.value = 1.2;
    const gain = this.audio.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02 / r);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2 / r);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.22 / r);
  }

  /** Pitched bite + crackling noise transient — the hit "crack". */
  private thock(): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    if (t - this.lastThock < 0.045) return;
    this.lastThock = t;
    const r = this.timeRate();

    const osc = this.audio.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(420 * r, t);
    osc.frequency.exponentialRampToValueAtTime(115 * r, t + 0.065 / r);
    const oscGain = this.audio.createGain();
    oscGain.gain.setValueAtTime(0.52, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.105 / r);
    osc.connect(oscGain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12 / r);

    const src = this.audio.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = r;
    const hp = this.audio.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1500 * r;
    const nGain = this.audio.createGain();
    nGain.gain.setValueAtTime(0.5, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05 / r);
    src.connect(hp).connect(nGain).connect(this.master);
    src.start(t);
    src.stop(t + 0.06 / r);

    this.hitCrackle(t, r, 0.55, 0.2);
  }

  /** Deeper sine thump with a longer tail — the kill "boom". */
  private boom(): void {
    if (!this.audio || !this.master) return;
    const t = this.now();
    if (t - this.lastBoom < 0.07) return;
    this.lastBoom = t;
    const r = this.timeRate();
    const osc = this.audio.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160 * r, t);
    osc.frequency.exponentialRampToValueAtTime(45 * r, t + 0.3 / r);
    const gain = this.audio.createGain();
    gain.gain.setValueAtTime(0.9, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45 / r);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.47 / r);
    this.hitCrackle(t, r, 0.75, 0.35);
  }

  /**
   * Normal full-charge / strong non-mega impact: a lighter version of the
   * bullet-time mega hit, with the same sub + wet wash character but less tail.
   */
  private chargedHitBoom(power: number, killed: boolean): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    if (t - this.lastChargedHitBoom < 0.075) return;
    this.lastChargedHitBoom = t;
    const r = this.timeRate();
    const strength = Math.max(0, Math.min(1, (power - 4.6) / 1.4));
    const stretch = 1 / Math.max(0.65, r);
    const hitScale = killed ? 1.15 : 1;

    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime((94 - strength * 12) * r, t);
    sub.frequency.exponentialRampToValueAtTime((34 - strength * 6) * r, t + 0.26 * stretch);
    const subGain = this.audio.createGain();
    subGain.gain.setValueAtTime((0.55 + strength * 0.16) * hitScale, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.42 * stretch);
    sub.connect(subGain).connect(this.master);
    this.sendVerb(subGain, 0.48 + strength * 0.16);
    sub.start(t);
    sub.stop(t + 0.47 * stretch);

    const wash = this.audio.createBufferSource();
    wash.buffer = this.noiseBuffer;
    wash.loop = true;
    wash.playbackRate.value = 0.66 * (0.75 + 0.25 * r);
    const lp = this.audio.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1100 + strength * 350, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 0.48 * stretch);
    const washGain = this.audio.createGain();
    washGain.gain.setValueAtTime(0.0001, t);
    washGain.gain.exponentialRampToValueAtTime((0.24 + strength * 0.1) * hitScale, t + 0.035 * stretch);
    washGain.gain.exponentialRampToValueAtTime(0.001, t + 0.58 * stretch);
    wash.connect(lp).connect(washGain).connect(this.master);
    this.sendVerb(washGain, 0.72 + strength * 0.18);
    wash.start(t);
    wash.stop(t + 0.62 * stretch);

    this.hitCrackle(t, r, 0.85 + strength * 0.25, 0.55);
  }

  /** Short uneven arcs layered on impacts so hits crack instead of only thud. */
  private hitCrackle(t: number, r: number, amount: number, wet: number): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const stretch = 1 / Math.max(0.55, r);
    const bursts = 3 + Math.round(amount * 3);
    for (let i = 0; i < bursts; i++) {
      const at = t + (i === 0 ? 0 : (0.006 + Math.random() * 0.034) * stretch);
      const src = this.audio.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = (1.2 + Math.random() * 1.1) * r;

      const bite = this.audio.createBiquadFilter();
      bite.type = "bandpass";
      bite.frequency.value = (1800 + Math.random() * 3600) * (0.75 + 0.25 * r);
      bite.Q.value = 3 + Math.random() * 4;

      const sizzle = this.audio.createBiquadFilter();
      sizzle.type = "highpass";
      sizzle.frequency.value = (3600 + Math.random() * 2200) * (0.75 + 0.25 * r);

      const gain = this.audio.createGain();
      const peak = (i === 0 ? 0.24 : 0.1 + Math.random() * 0.14) * amount;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.0025 * stretch);
      gain.gain.exponentialRampToValueAtTime(0.001, at + (0.018 + Math.random() * 0.03) * stretch);

      src.connect(bite).connect(gain);
      src.connect(sizzle).connect(gain);
      gain.connect(this.master);
      this.sendVerb(gain, wet);
      src.start(at);
      src.stop(at + 0.08 * stretch);
    }
  }

  // ---- Charge / spin / mega voices ----

  /** Low menacing charge drone; update() rides weight/detune with the charge. */
  private startHum(): void {
    this.ensureAudio();
    if (!this.audio || !this.master || this.humOsc) return;
    const t = this.now();
    this.humGain = this.audio.createGain();
    this.humGain.gain.setValueAtTime(0.0001, t);
    this.humGain.gain.exponentialRampToValueAtTime(0.16, t + 0.25);
    this.humFilter = this.audio.createBiquadFilter();
    this.humFilter.type = "lowpass";
    this.humFilter.frequency.value = 200;
    this.humFilter.Q.value = 2.5;

    this.humOsc = this.audio.createOscillator();
    this.humOsc.type = "sawtooth";
    this.humOsc.frequency.value = 55;
    this.humOsc2 = this.audio.createOscillator();
    this.humOsc2.type = "sawtooth";
    this.humOsc2.frequency.value = 55;
    this.humOsc2.detune.value = 7;
    // Sub octave straight into the gain (skips the filter — pure weight).
    this.humSub = this.audio.createOscillator();
    this.humSub.type = "sine";
    this.humSub.frequency.value = 27.5;

    // Slow amplitude throb on the drone gain.
    this.humLfo = this.audio.createOscillator();
    this.humLfo.type = "sine";
    this.humLfo.frequency.value = 1.8;
    this.humLfoDepth = this.audio.createGain();
    this.humLfoDepth.gain.value = 0.04;
    this.humLfo.connect(this.humLfoDepth).connect(this.humGain.gain);

    this.humOsc.connect(this.humFilter);
    this.humOsc2.connect(this.humFilter);
    this.humSub.connect(this.humGain);
    this.humFilter.connect(this.humGain).connect(this.master);
    // Big cathedral send — the drone should feel like it fills the room.
    this.sendVerb(this.humGain, 0.35);
    this.humOsc.start(t);
    this.humOsc2.start(t);
    this.humSub.start(t);
    this.humLfo.start(t);
  }

  private stopHum(): void {
    if (!this.audio || !this.humOsc) return;
    const t = this.now();
    this.humGain?.gain.setTargetAtTime(0.0001, t, 0.05);
    this.humOsc.stop(t + 0.3);
    this.humOsc2?.stop(t + 0.3);
    this.humSub?.stop(t + 0.3);
    this.humLfo?.stop(t + 0.3);
    this.humOsc = null;
    this.humOsc2 = null;
    this.humSub = null;
    this.humLfo = null;
    this.humLfoDepth = null;
    this.humGain = null;
    this.humFilter = null;
  }

  /**
   * Charge-level-full impact. NOT a shiny ping — a deep cyberpunk power swell:
   * a sub thump for weight, a detuned saw power chord that BLOOMS open through a
   * rising lowpass (the surge landing), and a soft metallic overtone that fades
   * fast so it reads as "charged", not "beep". Mega drops the root an octave,
   * hits harder, opens brighter and drowns deeper in the hall — the Neo "he's
   * the One" moment, not a laser topping off.
   */
  private chargeDing(mega: boolean): void {
    if (!this.audio || !this.master) return;
    const t = this.now();

    // Low root power chord (root + fifth + octave). Mega sits an octave lower
    // and heavier so the max-charge hit lands in the chest.
    const root = mega ? 55 : 82.4; // A1 / E2
    const chord = [root, root * 1.5, root * 2];
    const peak = mega ? 0.6 : 0.42;
    const dur = mega ? 1.1 : 0.7;

    // Sub thump — the impact of the charge locking in.
    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(root, t);
    sub.frequency.exponentialRampToValueAtTime(root * 0.55, t + dur * 0.6);
    const subGain = this.audio.createGain();
    subGain.gain.setValueAtTime(mega ? 0.9 : 0.6, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    sub.connect(subGain).connect(this.master);
    this.sendVerb(subGain, mega ? 0.6 : 0.4);
    sub.start(t);
    sub.stop(t + dur + 0.05);

    // Detuned saw stack blooming open through a rising lowpass — the surge.
    const filter = this.audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(mega ? 2600 : 1600, t + dur * 0.35);
    filter.frequency.exponentialRampToValueAtTime(400, t + dur);
    const chordGain = this.audio.createGain();
    chordGain.gain.setValueAtTime(0.0001, t);
    chordGain.gain.exponentialRampToValueAtTime(peak, t + 0.06);
    chordGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    filter.connect(chordGain).connect(this.master);
    this.sendVerb(chordGain, mega ? 0.7 : 0.4);
    for (const base of chord) {
      for (const detune of [-9, 0, 9]) {
        const osc = this.audio.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = base;
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      }
    }

    // Soft metallic overtone shimmer on top — a hint of shine, gone fast so it
    // never reads as a tinny beep.
    const shimmer = this.audio.createOscillator();
    shimmer.type = "triangle";
    shimmer.frequency.value = root * (mega ? 8 : 6);
    const shimGain = this.audio.createGain();
    shimGain.gain.setValueAtTime(0.0001, t);
    shimGain.gain.exponentialRampToValueAtTime(mega ? 0.12 : 0.08, t + 0.02);
    shimGain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    shimmer.connect(shimGain).connect(this.master);
    this.sendVerb(shimGain, mega ? 0.6 : 0.35);
    shimmer.start(t);
    shimmer.stop(t + 0.3);
  }

  /**
   * Mega armed: a deep readiness swell, not a reward jingle. The old C5-C6
   * square arpeggio read like a chest opening; this sits in the low mids with a
   * sub impact, detuned saw pressure, and a short filtered air pull.
   */
  private megaArmedCharge(): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const dur = 1.25;
    const root = 49; // G1: low enough to feel armed without becoming muddy.

    // Immediate body hit so crossing 12/12 still gives clear feedback.
    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(74, t);
    sub.frequency.exponentialRampToValueAtTime(32, t + 0.52);
    const subGain = this.audio.createGain();
    subGain.gain.setValueAtTime(0.95, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    sub.connect(subGain).connect(this.master);
    this.sendVerb(subGain, 0.65);
    sub.start(t);
    sub.stop(t + 0.8);

    // Pressure bloom: a low power chord opens just enough to say "ready".
    const tone = this.audio.createBiquadFilter();
    tone.type = "lowpass";
    tone.Q.value = 5;
    tone.frequency.setValueAtTime(120, t);
    tone.frequency.exponentialRampToValueAtTime(860, t + 0.45);
    tone.frequency.exponentialRampToValueAtTime(260, t + dur);
    const toneGain = this.audio.createGain();
    toneGain.gain.setValueAtTime(0.0001, t);
    toneGain.gain.exponentialRampToValueAtTime(0.52, t + 0.12);
    toneGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    tone.connect(toneGain).connect(this.master);
    this.sendVerb(toneGain, 0.75);
    for (const base of [root, root * 1.5, root * 2]) {
      for (const detune of [-12, 0, 12]) {
        const osc = this.audio.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = base;
        osc.detune.value = detune;
        osc.connect(tone);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      }
    }

    // Air being pulled into the strike: low, short, and filtered away from
    // sparkly highs.
    const pull = this.audio.createBufferSource();
    pull.buffer = this.noiseBuffer;
    pull.loop = true;
    pull.playbackRate.value = 0.55;
    const bp = this.audio.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(980, t + 0.38);
    bp.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const pullGain = this.audio.createGain();
    pullGain.gain.setValueAtTime(0.0001, t);
    pullGain.gain.exponentialRampToValueAtTime(0.28, t + 0.08);
    pullGain.gain.exponentialRampToValueAtTime(0.001, t + 0.92);
    pull.connect(bp).connect(pullGain).connect(this.master);
    this.sendVerb(pullGain, 0.7);
    pull.start(t);
    pull.stop(t + 0.95);
  }

  /** Big double whoosh + low crack for a charged (non-mega) spin release. */
  private spinWhoosh(power: number): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const gainScale = Math.min(1, 0.4 + power * 0.1);

    const src = this.audio.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.audio.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.4;
    // Sweep up then down: the blade coming around the full circle.
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.exponentialRampToValueAtTime(2400, t + 0.18);
    filter.frequency.exponentialRampToValueAtTime(350, t + 0.5);
    const gain = this.audio.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.7 * gainScale, t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    src.connect(filter).connect(gain).connect(this.master);
    this.sendVerb(gain, 0.3);
    src.start(t);
    src.stop(t + 0.6);

    const osc = this.audio.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.25);
    const oGain = this.audio.createGain();
    oGain.gain.setValueAtTime(0.5 * gainScale, t);
    oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(oGain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  /**
   * The ultimate: sub drop, detuned saw-stack power chord through a closing
   * lowpass, and a noise crash — everything soaked in the reverb + echo bus.
   * Half-strength rate scaling: the blast fires as time snaps to 5×-slow, and
   * a full 5× pitch-down would bury it in mud; √rate keeps the weight.
   */
  private megaBlast(rateOverride?: number): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    // `r` scales pitch (×r) and stretches every envelope (÷r). Live play uses
    // √timeRate so bullet-time doesn't bury the blast in mud; the dossier's
    // A/B demo passes an explicit rate to show the shift.
    const r = rateOverride ?? Math.sqrt(this.timeRate());

    // Sub drop: 110 Hz falling to the floor over a second.
    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(110 * r, t);
    sub.frequency.exponentialRampToValueAtTime(24 * r, t + 1.0 / r);
    const subGain = this.audio.createGain();
    subGain.gain.setValueAtTime(1.0, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 1.4 / r);
    sub.connect(subGain).connect(this.master);
    this.sendVerb(subGain, 0.6);
    sub.start(t);
    sub.stop(t + 1.45 / r);

    // Detuned saw stack on a low power chord (A1 + E2 + A2), lowpass closing.
    const chordFilter = this.audio.createBiquadFilter();
    chordFilter.type = "lowpass";
    chordFilter.frequency.setValueAtTime(3200 * r, t);
    chordFilter.frequency.exponentialRampToValueAtTime(160 * r, t + 1.6 / r);
    const chordGain = this.audio.createGain();
    chordGain.gain.setValueAtTime(0.0001, t);
    chordGain.gain.exponentialRampToValueAtTime(0.5, t + 0.03 / r);
    chordGain.gain.exponentialRampToValueAtTime(0.001, t + 1.7 / r);
    chordFilter.connect(chordGain).connect(this.master);
    this.sendVerb(chordGain, 0.9);
    for (const base of [55, 82.4, 110]) {
      for (const detune of [-8, 0, 8]) {
        const osc = this.audio.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = base * r;
        osc.detune.value = detune;
        osc.connect(chordFilter);
        osc.start(t);
        osc.stop(t + 1.75 / r);
      }
    }

    // Noise crash on top, highpassed so it doesn't mud the sub.
    const crash = this.audio.createBufferSource();
    crash.buffer = this.noiseBuffer;
    crash.playbackRate.value = r;
    const hp = this.audio.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1400 * r;
    const crashGain = this.audio.createGain();
    crashGain.gain.setValueAtTime(0.8, t);
    crashGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5 / r);
    crash.connect(hp).connect(crashGain).connect(this.master);
    this.sendVerb(crashGain, 1.0);
    crash.start(t);
    crash.stop(t + 0.5 / r);
  }

  // ---- Dossier previews ----
  // These play regardless of the Sound toggle: they're an explicit user action
  // in the info panel, and the click itself is the gesture that unlocks audio.

  /**
   * One-shot demo of the continuous charge drone for the info dossier. The live
   * voice (`startHum`) rides the player's charge level frame by frame; here we
   * fake that arc — rest → full overcharge over ~1.7 s, then release — on a
   * throwaway voice so the diagram's "building hum" has something to hear.
   * Returns the total length in seconds (0 if audio is unavailable).
   */
  previewChargeHum(): number {
    this.ensureAudio();
    if (!this.audio || !this.master) return 0;
    this.stopPreviewSound();
    const t = this.now();
    const rise = 1.7; // rest -> full overcharge
    const rel = 0.35; // fade-out
    const end = t + rise + rel;

    // Gain: quick fade-in, climb with the charge, then release. The same 55→110
    // "gets heavier, not higher" arc and 200→900 Hz filter open as the live hum.
    const gain = this.audio.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.25);
    gain.gain.linearRampToValueAtTime(0.42, t + rise);
    gain.gain.setTargetAtTime(0.0001, t + rise, rel * 0.4);

    const filter = this.audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 2.5;
    filter.frequency.setValueAtTime(200, t);
    filter.frequency.linearRampToValueAtTime(900, t + rise);

    const oscA = this.audio.createOscillator();
    oscA.type = "sawtooth";
    oscA.frequency.setValueAtTime(55, t);
    oscA.frequency.linearRampToValueAtTime(110, t + rise);
    const oscB = this.audio.createOscillator();
    oscB.type = "sawtooth";
    oscB.frequency.setValueAtTime(55, t);
    oscB.frequency.linearRampToValueAtTime(110, t + rise);
    oscB.detune.setValueAtTime(7, t);
    oscB.detune.linearRampToValueAtTime(25, t + rise);
    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(27.5, t);
    sub.frequency.linearRampToValueAtTime(55, t + rise);

    const lfo = this.audio.createOscillator();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(1.8, t);
    lfo.frequency.linearRampToValueAtTime(5.2, t + rise);
    const lfoDepth = this.audio.createGain();
    lfoDepth.gain.setValueAtTime(0.04, t);
    lfoDepth.gain.linearRampToValueAtTime(0.16, t + rise);
    lfo.connect(lfoDepth).connect(gain.gain);

    oscA.connect(filter);
    oscB.connect(filter);
    sub.connect(gain);
    filter.connect(gain).connect(this.master);
    this.sendVerb(gain, 0.35);

    const oscs = [oscA, oscB, sub, lfo];
    for (const o of oscs) o.start(t);
    for (const o of oscs) o.stop(end + 0.05);
    this.previewHum = { oscs, gain };
    oscA.addEventListener("ended", () => {
      if (this.previewHum?.oscs[0] === oscA) this.previewHum = null;
    });
    return rise + rel;
  }

  /** One-shot mega blast for the info dossier. Returns its length in seconds. */
  previewMegaBlast(): number {
    this.ensureAudio();
    if (!this.audio) return 0;
    this.megaBlast();
    return 1.8;
  }

  /**
   * Time-dilation A/B for the dossier: the same blast at full speed, then again
   * a moment later at bullet-time rate — pitched down an octave and stretched —
   * so the ear hears exactly what slow motion does to a voice. Returns the
   * total demo length in seconds.
   */
  previewTimeDilation(): number {
    this.ensureAudio();
    if (!this.audio) return 0;
    if (this.timeShiftTimer) window.clearTimeout(this.timeShiftTimer);
    this.megaBlast(1); // full speed reference
    this.timeShiftTimer = window.setTimeout(() => {
      this.timeShiftTimer = 0;
      this.megaBlast(0.5); // bullet-time: an octave down, twice as long
    }, 1900);
    return 4.4;
  }

  /**
   * Fire the blast at an explicit time rate for the dossier's TIME SCALE
   * slider — the pitch and envelope lengths follow the rate the user picked, so
   * it matches what the diagram is showing. Returns an approximate length.
   */
  previewBlastAtRate(rate: number): number {
    this.ensureAudio();
    if (!this.audio) return 0;
    const r = Math.max(0.15, Math.min(1, rate));
    this.megaBlast(r);
    return Math.min(5, 1.9 / r);
  }

  /** Kill any in-flight preview drone (e.g. when the dossier closes). */
  stopPreviewSound(): void {
    if (this.timeShiftTimer) {
      window.clearTimeout(this.timeShiftTimer);
      this.timeShiftTimer = 0;
    }
    if (!this.previewHum || !this.audio) return;
    const t = this.now();
    this.previewHum.gain.gain.cancelScheduledValues(t);
    this.previewHum.gain.gain.setTargetAtTime(0.0001, t, 0.03);
    for (const o of this.previewHum.oscs) {
      try {
        o.stop(t + 0.12);
      } catch {
        // already stopped
      }
    }
    this.previewHum = null;
  }

  /**
   * The dive descent "wishhh": a long airy noise sweep gliding DOWN in pitch,
   * heavily reverbed. It fires as time drops into slow-mo, so the low timeRate
   * stretches and detunes it into the classic bullet-time wishing whoosh. Mega
   * dives sweep deeper and longer.
   */
  private diveDescend(mega: boolean): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const r = this.timeRate();
    const dur = (mega ? 1.1 : 0.8) / r;

    const src = this.audio.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = r;
    const bp = this.audio.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime((mega ? 2600 : 2000) * r, t);
    bp.frequency.exponentialRampToValueAtTime(180 * r, t + dur);
    const gain = this.audio.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(mega ? 0.5 : 0.38, t + 0.08 / r);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(gain).connect(this.master);
    this.sendVerb(gain, 0.7);
    src.start(t);
    src.stop(t + dur + 0.05);

    // A falling sine underneath sells the plummet.
    const osc = this.audio.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime((mega ? 320 : 260) * r, t);
    osc.frequency.exponentialRampToValueAtTime(70 * r, t + dur);
    const oGain = this.audio.createGain();
    oGain.gain.setValueAtTime(0.0001, t);
    oGain.gain.exponentialRampToValueAtTime(0.22, t + 0.1 / r);
    oGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(oGain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /**
   * The ground slam: a deep sub thud + a highpassed noise crack (the impact),
   * soaked in reverb. Mega dives hit harder and lower.
   */
  private diveImpact(mega: boolean): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const r = this.timeRate();
    const stretch = 1 / Math.max(0.25, r);
    const gainScale = mega ? 1.3 : 1;

    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime((mega ? 130 : 150) * r, t);
    sub.frequency.exponentialRampToValueAtTime(28 * r, t + 0.5 * stretch);
    const subGain = this.audio.createGain();
    subGain.gain.setValueAtTime(1.1 * gainScale, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.7 * stretch);
    sub.connect(subGain).connect(this.master);
    this.sendVerb(subGain, 0.7);
    sub.start(t);
    sub.stop(t + 0.75 * stretch);

    const crack = this.audio.createBufferSource();
    crack.buffer = this.noiseBuffer;
    crack.playbackRate.value = r;
    const hp = this.audio.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 500 * r;
    const cGain = this.audio.createGain();
    cGain.gain.setValueAtTime(0.7 * gainScale, t);
    cGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35 * stretch);
    crack.connect(hp).connect(cGain).connect(this.master);
    this.sendVerb(cGain, 0.9);
    crack.start(t);
    crack.stop(t + 0.4 * stretch);
  }

  /**
   * Bullet-time hit: a felt-in-the-chest "boo" — deep sine drop plus a washy
   * lowpassed noise tail (the waterfall), drowned in the reverb bus. Rate
   * scaling stretches the wash with the slow-mo without burying the pitch.
   */
  private megaHitBoom(): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    if (t - this.lastMegaBoom < 0.09) return;
    this.lastMegaBoom = t;
    const r = this.timeRate();
    const stretch = 1 / Math.max(0.25, r);

    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(64 * (0.6 + 0.4 * r) + 40 * r, t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 0.4 * stretch);
    const subGain = this.audio.createGain();
    subGain.gain.setValueAtTime(0.85, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55 * stretch);
    sub.connect(subGain).connect(this.master);
    this.sendVerb(subGain, 0.9);
    sub.start(t);
    sub.stop(t + 0.6 * stretch);

    const wash = this.audio.createBufferSource();
    wash.buffer = this.noiseBuffer;
    wash.loop = true;
    wash.playbackRate.value = 0.45 * (0.5 + 0.5 * r);
    const lp = this.audio.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.8 * stretch);
    const washGain = this.audio.createGain();
    washGain.gain.setValueAtTime(0.0001, t);
    washGain.gain.exponentialRampToValueAtTime(0.4, t + 0.05 * stretch);
    washGain.gain.exponentialRampToValueAtTime(0.001, t + 0.9 * stretch);
    wash.connect(lp).connect(washGain).connect(this.master);
    this.sendVerb(washGain, 1.0);
    wash.start(t);
    wash.stop(t + 0.95 * stretch);
  }

  /**
   * Revolutions fly-in landing: a row of agents finishing their staged fall
   * becomes one scalable concrete crash instead of hundreds of stacked voices.
   */
  private arrivalCrash(count: number, dropHeight: number): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const r = this.timeRate();
    const stretch = 1 / Math.max(0.65, r);
    if (t - this.lastArrivalCrash < 0.045 * stretch) return;
    this.lastArrivalCrash = t;

    const crowd = Math.min(1.8, Math.max(0.45, Math.sqrt(count) * 0.34));
    const height = Math.min(1.35, Math.max(0.65, dropHeight / 58));
    const force = crowd * height;
    const pitchRate = 0.75 + 0.25 * r;

    // Chest hit: a short stacked sub drop, louder and longer when a whole rank
    // lands together.
    const sub = this.audio.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime((88 + force * 10) * pitchRate, t);
    sub.frequency.exponentialRampToValueAtTime(Math.max(18, 27 * pitchRate), t + 0.42 * stretch);
    const subGain = this.audio.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.75 + force * 0.52, t + 0.01 * stretch);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + (0.58 + force * 0.12) * stretch);
    sub.connect(subGain).connect(this.master);
    this.sendVerb(subGain, 0.72);
    sub.start(t);
    sub.stop(t + (0.66 + force * 0.12) * stretch);

    // Front-edge slab break: broad, crunchy, and very fast so it reads as
    // bodies smashing into pavement rather than only a bass boom.
    const crack = this.audio.createBufferSource();
    crack.buffer = this.noiseBuffer;
    crack.playbackRate.value = (1.05 + Math.random() * 0.35) * r;
    const crackTone = this.audio.createBiquadFilter();
    crackTone.type = "bandpass";
    crackTone.frequency.value = (720 + force * 360 + Math.random() * 260) * pitchRate;
    crackTone.Q.value = 0.75;
    const crackGain = this.audio.createGain();
    crackGain.gain.setValueAtTime(0.0001, t);
    crackGain.gain.exponentialRampToValueAtTime(0.95 + force * 0.38, t + 0.004 * stretch);
    crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.13 * stretch);
    crack.connect(crackTone).connect(crackGain).connect(this.master);
    this.sendVerb(crackGain, 0.85);
    crack.start(t);
    crack.stop(t + 0.16 * stretch);

    // Dust/debris wash that rolls off after the slam.
    const debris = this.audio.createBufferSource();
    debris.buffer = this.noiseBuffer;
    debris.loop = true;
    debris.playbackRate.value = 0.34 * pitchRate;
    const debrisTone = this.audio.createBiquadFilter();
    debrisTone.type = "lowpass";
    debrisTone.frequency.setValueAtTime((1050 + force * 240) * pitchRate, t);
    debrisTone.frequency.exponentialRampToValueAtTime(115 * pitchRate, t + (0.55 + force * 0.16) * stretch);
    debrisTone.Q.value = 1.1;
    const debrisGain = this.audio.createGain();
    debrisGain.gain.setValueAtTime(0.0001, t);
    debrisGain.gain.exponentialRampToValueAtTime(0.32 + force * 0.18, t + 0.045 * stretch);
    debrisGain.gain.exponentialRampToValueAtTime(0.001, t + (0.72 + force * 0.18) * stretch);
    debris.connect(debrisTone).connect(debrisGain).connect(this.master);
    this.sendVerb(debrisGain, 1.05);
    debris.start(t);
    debris.stop(t + (0.82 + force * 0.2) * stretch);

    // A few offset gravel/body hits inside the same crash sell the crowd count
    // without creating one audio graph per enemy.
    const clacks = Math.min(7, 2 + Math.floor(count / 3));
    for (let i = 0; i < clacks; i++) {
      const at = t + (0.012 + Math.random() * 0.13) * stretch;
      const shard = this.audio.createBufferSource();
      shard.buffer = this.noiseBuffer;
      shard.playbackRate.value = (0.8 + Math.random() * 1.0) * r;
      const shardTone = this.audio.createBiquadFilter();
      shardTone.type = "bandpass";
      shardTone.frequency.value = (650 + Math.random() * 2200) * pitchRate;
      shardTone.Q.value = 2.4 + Math.random() * 2.8;
      const shardGain = this.audio.createGain();
      const peak = (0.11 + Math.random() * 0.16) * Math.min(1.25, force);
      shardGain.gain.setValueAtTime(0.0001, at);
      shardGain.gain.exponentialRampToValueAtTime(peak, at + 0.003 * stretch);
      shardGain.gain.exponentialRampToValueAtTime(0.001, at + (0.035 + Math.random() * 0.055) * stretch);
      shard.connect(shardTone).connect(shardGain).connect(this.master);
      this.sendVerb(shardGain, 0.55);
      shard.start(at);
      shard.stop(at + 0.12 * stretch);
    }
  }

  /** Lightning discharge plus rolling thunder, wet with reverb and echo. */
  private thunder(): void {
    if (!this.audio || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const r = this.timeRate();
    const stretch = 1 / Math.max(0.35, r);

    // Broadband electrical crackle: a dense stutter of fast, uneven arcs. The
    // low-mid body filter gives it weight; a bright grit band and a very-high
    // sizzle band on top make it read as raw ELECTRIC discharge, not a tick.
    // Sharp near-zero attacks + tight random gaps = the fizzing crackle.
    for (let i = 0; i < 9; i++) {
      const at = t + (i === 0 ? 0 : (0.008 + Math.random() * 0.07) * stretch);
      const src = this.audio.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = (0.8 + Math.random() * 1.1) * r;

      const body = this.audio.createBiquadFilter();
      body.type = "bandpass";
      body.frequency.value = (620 + Math.random() * 980) * (0.65 + 0.35 * r);
      body.Q.value = 1.4 + Math.random() * 1.2;

      const grit = this.audio.createBiquadFilter();
      grit.type = "bandpass";
      grit.frequency.value = (1700 + Math.random() * 2600) * (0.7 + 0.3 * r);
      grit.Q.value = 3.4 + Math.random() * 2.6;

      // High sizzle: the bright zap/fizz that sells electricity.
      const sizzle = this.audio.createBiquadFilter();
      sizzle.type = "bandpass";
      sizzle.frequency.value = (4800 + Math.random() * 4200) * (0.75 + 0.25 * r);
      sizzle.Q.value = 5 + Math.random() * 4;

      const gain = this.audio.createGain();
      const peak = (i === 0 ? 0.72 : 0.34 + Math.random() * 0.24) * (0.85 + 0.15 * r);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.0035 * stretch);
      gain.gain.exponentialRampToValueAtTime(0.001, at + (0.025 + Math.random() * 0.05) * stretch);

      src.connect(body).connect(gain);
      src.connect(grit).connect(gain);
      src.connect(sizzle).connect(gain);
      gain.connect(this.master);
      this.sendVerb(gain, 0.7);
      src.start(at);
      src.stop(at + 0.12 * stretch);
    }

    // Short low snap under the crackle: the air pressure pop at the strike.
    const snap = this.audio.createOscillator();
    snap.type = "triangle";
    snap.frequency.setValueAtTime(180 * (0.55 + 0.45 * r), t);
    snap.frequency.exponentialRampToValueAtTime(48 * (0.55 + 0.45 * r), t + 0.18 * stretch);
    const snapGain = this.audio.createGain();
    snapGain.gain.setValueAtTime(0.42, t);
    snapGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22 * stretch);
    snap.connect(snapGain).connect(this.master);
    this.sendVerb(snapGain, 0.85);
    snap.start(t);
    snap.stop(t + 0.24 * stretch);

    // Thunder CLAP: the hard boom that lands with (or a hair after) the flash.
    // The mega burst fires ONE thunder for all three bolts, so this is tuned to
    // be genuinely overwhelming for that instant — a near-instant broadband
    // crack plus a wall of stacked subs, driven hard into the shared limiter so
    // the whole mix ducks under it and then the reverb tail echoes away.
    if (t - this.lastThunderClap >= 0.14 * stretch) {
      this.lastThunderClap = t;
      const clapT = t + 0.02 * stretch; // right after the flash

      // Instant pressure "ksss-BOOM" crack: a doubled broadband slam, one bright
      // and fast, one darker and longer, both far louder than a single bolt.
      for (let c = 0; c < 2; c++) {
        const crack = this.audio.createBufferSource();
        crack.buffer = this.noiseBuffer;
        crack.loop = true;
        crack.playbackRate.value = (0.5 + Math.random() * 0.25 - c * 0.15) * r;
        const crackTone = this.audio.createBiquadFilter();
        crackTone.type = "lowpass";
        const topF = (c === 0 ? 5200 : 3000) * (0.7 + 0.3 * r);
        const tail = (c === 0 ? 0.75 : 1.1) * stretch;
        crackTone.frequency.setValueAtTime(topF, clapT);
        crackTone.frequency.exponentialRampToValueAtTime(120 * (0.7 + 0.3 * r), clapT + tail);
        const crackGain = this.audio.createGain();
        crackGain.gain.setValueAtTime(0.0001, clapT);
        crackGain.gain.exponentialRampToValueAtTime(c === 0 ? 2.6 : 1.9, clapT + 0.005 * stretch);
        crackGain.gain.exponentialRampToValueAtTime(0.001, clapT + tail + 0.1 * stretch);
        crack.connect(crackTone).connect(crackGain).connect(this.master);
        this.sendVerb(crackGain, 1.4);
        crack.start(clapT);
        crack.stop(clapT + tail + 0.15 * stretch);
      }

      // A stacked wall of subs — three octaves of chest-hit weight sweeping down
      // into the infrasonic. This is what makes the clap "overwhelm everything".
      const subF = (54 + Math.random() * 12) * (0.7 + 0.3 * r);
      const subLayers: Array<{ mul: number; peak: number; dur: number; floor: number }> = [
        { mul: 1.0, peak: 2.8, dur: 0.9, floor: 0.32 },
        { mul: 0.5, peak: 2.4, dur: 1.05, floor: 0.22 },
        { mul: 0.25, peak: 1.7, dur: 1.25, floor: 0.5 },
      ];
      for (const L of subLayers) {
        const sub = this.audio.createOscillator();
        sub.type = "sine";
        const f = subF * L.mul;
        sub.frequency.setValueAtTime(f, clapT);
        sub.frequency.exponentialRampToValueAtTime(Math.max(13, f * L.floor), clapT + L.dur * 0.7);
        const subGain = this.audio.createGain();
        subGain.gain.setValueAtTime(0.0001, clapT);
        subGain.gain.exponentialRampToValueAtTime(L.peak, clapT + 0.012 * stretch);
        subGain.gain.exponentialRampToValueAtTime(0.001, clapT + L.dur * stretch);
        sub.connect(subGain).connect(this.master);
        this.sendVerb(subGain, 0.9);
        sub.start(clapT);
        sub.stop(clapT + L.dur * stretch + 0.05);
      }

      // Hard transient "hammer" on top of the subs: a single very short, very
      // loud noise spike that gives the clap its front-edge slam.
      const hammer = this.audio.createBufferSource();
      hammer.buffer = this.noiseBuffer;
      hammer.playbackRate.value = (0.9 + Math.random() * 0.4) * r;
      const hammerGain = this.audio.createGain();
      hammerGain.gain.setValueAtTime(0.0001, clapT);
      hammerGain.gain.exponentialRampToValueAtTime(3.0, clapT + 0.003 * stretch);
      hammerGain.gain.exponentialRampToValueAtTime(0.001, clapT + 0.08 * stretch);
      hammer.connect(hammerGain).connect(this.master);
      this.sendVerb(hammerGain, 0.6);
      hammer.start(clapT);
      hammer.stop(clapT + 0.1 * stretch);
    }

    // Let every bolt crackle, but only start a deep rolling thunder layer a few
    // times per burst so the storm booms instead of clipping into mud.
    if (t - this.lastThunderRoll < 0.28 * stretch) return;
    this.lastThunderRoll = t;

    const rollT = t + (0.06 + Math.random() * 0.12) * stretch;
    const rollDur = (1.8 + Math.random() * 0.9) * stretch;

    const roll = this.audio.createBufferSource();
    roll.buffer = this.noiseBuffer;
    roll.loop = true;
    roll.playbackRate.value = 0.28 * (0.65 + 0.35 * r);
    const rollTone = this.audio.createBiquadFilter();
    rollTone.type = "lowpass";
    rollTone.frequency.setValueAtTime(130 * (0.7 + 0.3 * r), rollT);
    rollTone.frequency.exponentialRampToValueAtTime(55 * (0.7 + 0.3 * r), rollT + rollDur);
    rollTone.Q.value = 1.8;
    const rollGain = this.audio.createGain();
    rollGain.gain.setValueAtTime(0.0001, rollT);
    rollGain.gain.exponentialRampToValueAtTime(0.6, rollT + 0.16 * stretch);
    rollGain.gain.exponentialRampToValueAtTime(0.001, rollT + rollDur);
    roll.connect(rollTone).connect(rollGain).connect(this.master);
    this.sendVerb(rollGain, 1.3);
    roll.start(rollT);
    roll.stop(rollT + rollDur + 0.05);

    // A cluster of deep sine booms rolling out under the noise wash — the
    // low-end body of the thunder. Lower, louder, and one more than before.
    for (let i = 0; i < 4; i++) {
      const boomT = rollT + i * (0.2 + Math.random() * 0.16) * stretch;
      const boom = this.audio.createOscillator();
      boom.type = "sine";
      const f = (26 + Math.random() * 16) * (0.7 + 0.3 * r);
      boom.frequency.setValueAtTime(f, boomT);
      boom.frequency.exponentialRampToValueAtTime(Math.max(15, f * 0.5), boomT + 0.65 * stretch);
      const boomGain = this.audio.createGain();
      boomGain.gain.setValueAtTime(0.0001, boomT);
      boomGain.gain.exponentialRampToValueAtTime(0.55 - i * 0.08, boomT + 0.035 * stretch);
      boomGain.gain.exponentialRampToValueAtTime(0.001, boomT + 0.85 * stretch);
      boom.connect(boomGain).connect(this.master);
      this.sendVerb(boomGain, 1.1);
      boom.start(boomT);
      boom.stop(boomT + 0.9 * stretch);
    }
  }
}
