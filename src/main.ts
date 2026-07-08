import * as THREE from "three/webgpu"
import { Category, Physics } from "./core/physics"
import { EventBus } from "./core/events"
import { GameClock } from "./core/time"
import { FollowCamera } from "./core/camera"
import { ManualCameraControls } from "./core/cameraControls"
import { Input } from "./core/input"
import { Player, wallKickTuningParams } from "./game/player"
import { Enemy } from "./game/enemy"
import { EnemySpatialIndex } from "./game/enemySpatialIndex"
import { KnifeSystem } from "./game/projectile"
import { Combat, combatTuningParams } from "./game/combat"
import { MegaSystem } from "./game/mega"
import { DiveSmash } from "./game/diveSmash"
import { EffectManager } from "./effects/manager"
import { CrtEffect } from "./effects/crt"
import { MatrixGradeEffect } from "./effects/matrixGrade"
import { MegaFxEffect } from "./effects/megaFx"
import { SoundEffect } from "./effects/sound"
import type { EffectContext } from "./effects/effect"
import type { Scenario, ScenarioContext } from "./scenarios/scenario"
import { getScenarioEntry } from "./scenarios/registry"
import { advanceFloorTime } from "./scenarios/arena"
import {
  advanceGroundShockwave,
  collectShockFronts,
  triggerBuildingImpactRipple,
  triggerGroundShockwave
} from "./effects/groundShockwave"
import { MegaHordeScenario } from "./scenarios/megaHorde"
import { RevolutionsScenario } from "./scenarios/revolutions"
import {
  applyWireframe,
  isWireframeEnabled,
  setWireframeEnabled
} from "./core/wireframe"
import { applySceneFog, fogTuning } from "./effects/fogGlow"
import { Panel } from "./ui/panel"
import { Hud } from "./ui/hud"
import { Legend } from "./ui/legend"
import { InfoModal } from "./ui/infoModal"
import { SocialLinks } from "./ui/socialLinks"
import { SfxVolume } from "./ui/sfxVolume"

const PLAYER_TOUCH_DAMAGE = 1
const PLAYER_KNOCKBACK = 5
const MEGA_RELEASE_SHOCK_POWER = 1
const LIGHTNING_SHOCK_POWER = 1
const LIGHTNING_BLAST_RADIUS = 15
const LIGHTNING_BLAST_IMPULSE = 8.75
const LIGHTNING_PHYSICS_MIN_GAP = 0.16
/** Impulse per unit of wave strength when the travelling crest reaches a body. */
const SHOCK_WAVE_IMPULSE = 24
const SHOCK_WAVE_LIFT = 7
const SHOCK_WAVE_SPIN = 4
/** Lightning rings shove noticeably less than the player smash. */
const SHOCK_WAVE_LIGHTNING_SCALE = 0.6
/** Above this strength the wave blows even scenario-held rank agents loose. */
const SHOCK_WAVE_UNLOCK_STRENGTH = 0.5
/** Below this body height the player is dead and the round restarts. Set deep so
 * a miss off the edge is a long ~100 m plunge into the void before the reset,
 * not an instant blink out at the floor line. */
const PLAYER_FALL_DEATH_Y = -100

/** Dossier tabs that a shared link may deep-link into (see infoModal.ts). */
const INFO_TABS = ["visual", "audio"] as const
type InfoTab = (typeof INFO_TABS)[number]

/** `?tab=audio` on load → open the dossier straight to that tab, else null. */
function readInfoDeepLink(): InfoTab | null {
  const v = new URLSearchParams(location.search).get("tab")
  return v && (INFO_TABS as readonly string[]).includes(v)
    ? (v as InfoTab)
    : null
}

/**
 * Mirror the open dossier tab into the URL (no reload) so the address bar is
 * always a shareable deep link; passing null strips the param on close.
 */
function writeInfoUrl(tab: InfoTab | null): void {
  const url = new URL(location.href)
  if (tab) url.searchParams.set("tab", tab)
  else url.searchParams.delete("tab")
  history.replaceState(null, "", url)
}

async function boot(): Promise<void> {
  const app = document.getElementById("app")
  if (!app) throw new Error("#app not found")

  // Info dossier is pure DOM, so build and (for a deep link) show it before the
  // WebGPU device and physics WASM below finish initializing: a shared
  // `?tab=…` link is readable at once while the world boots behind the overlay.
  // The hooks reach live game systems through refs that stay null until boot
  // wires them further down; a pre-boot open just no-ops those. Once the loop
  // runs it sees the modal open and idles until Escape drops into the game.
  let infoClock: GameClock | null = null
  let infoInput: Input | null = null
  let infoSound: SoundEffect | null = null
  let infoCameraMode = false
  let pausedBeforeInfo = false
  const infoModal = new InfoModal({
    onOpen: () => {
      if (!infoClock) return // still booting; the loop idles on isOpen anyway
      pausedBeforeInfo = infoClock.paused
      infoClock.paused = true
      document.body.classList.add("paused")
      infoInput?.setGameplayEnabled(false)
    },
    onClose: () => {
      if (infoClock) {
        infoClock.paused = pausedBeforeInfo
        document.body.classList.toggle("paused", infoClock.paused)
      }
      if (!infoCameraMode) infoInput?.setGameplayEnabled(true)
      writeInfoUrl(null)
    },
    playChargeSound: () => infoSound?.previewChargeHum() ?? 0,
    playBlastSound: () => infoSound?.previewMegaBlast() ?? 0,
    playTimeShiftSound: () => infoSound?.previewTimeDilation() ?? 0,
    playBlastAtRate: (rate) => infoSound?.previewBlastAtRate(rate) ?? 0,
    stopSounds: () => infoSound?.stopPreviewSound(),
    getAnalyser: () => infoSound?.getAnalyser() ?? null,
    onTabChange: (tab) => writeInfoUrl(tab as InfoTab)
  })
  document.body.appendChild(infoModal.button)
  document.body.appendChild(infoModal.root)
  const deepLinkTab = readInfoDeepLink()
  if (deepLinkTab) infoModal.open(deepLinkTab)

  // ---- Renderer + scene ----
  // WebGPU-first: TSL node materials everywhere. WebGPURenderer transparently
  // falls back to a WebGL2 backend where WebGPU is unavailable, and the same
  // TSL graphs compile on both.
  const renderer = new THREE.WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  // Initial size comes from reconcileSurface() on the first sized frame — a
  // hidden tab can report 0×0 here, which must never reach the swapchain.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  app.appendChild(renderer.domElement)
  await renderer.init()

  const scene = new THREE.Scene()
  // Near-neutral cold dark base: the Matrix Grade post owns the green/teal tone
  // now, so the scene itself stays desaturated and the grade toggle reads as a
  // real before/after. Cheap linear fog that only begins ~5 arena-radii out:
  // the play space stays clear, and launched bodies spend seconds sliding
  // toward the band before dissolving into it.
  scene.background = new THREE.Color(0x1a1e1e)
  scene.fog = new THREE.Fog(0x1a1e1e, fogTuning.near, fogTuning.far)
  applySceneFog(scene)

  const hemi = new THREE.HemisphereLight(0xbfc4cc, 0x30302f, 0.8)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(10, 20, 8)
  sun.castShadow = true
  // 2048 keeps contact shadows crisp at this camera distance for a quarter of
  // the shadow-pass cost — measurable headroom during mass-kill spins.
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 80
  // Soft, acne-free contact shadows: bias pair tuned for the 4k map.
  sun.shadow.bias = -0.0003
  sun.shadow.normalBias = 0.02
  // Covers the mid-field of the doubled arena; beyond it enemies are hazed
  // by fog anyway, so the lost shadows don't read.
  const shadowExtent = 48
  sun.shadow.camera.left = -shadowExtent
  sun.shadow.camera.right = shadowExtent
  sun.shadow.camera.top = shadowExtent
  sun.shadow.camera.bottom = -shadowExtent
  scene.add(sun)

  // ---- Core systems ----
  const clock = new GameClock()
  const bus = new EventBus()
  const physics = await Physics.create()
  const camera = new FollowCamera(window.innerWidth / window.innerHeight)
  const manualCamera = new ManualCameraControls(
    camera.camera,
    renderer.domElement
  )
  const input = new Input(renderer.domElement)

  // Player is created once and reused across scenario switches.
  const player = new Player(physics, new THREE.Vector2(0, 0), bus)
  scene.add(player.group)
  const enemyIndex = new EnemySpatialIndex()
  // Reused across shock-front queries to avoid per-front allocation.
  const shockFrontScratch: Enemy[] = []

  // Thrown-knife pool for ranged agents (rail snipers + ground skirmishers).
  const knives = new KnifeSystem(scene)
  const knifeTarget = new THREE.Vector3()
  const knifeAim = { x: 0, y: 0, z: 0 }
  const knifeVel = { x: 0, y: 0, z: 0 }
  const knifeHitCenter = new THREE.Vector3()
  // A ranged agent lobbed a blade: launch it from the announced origin toward
  // the player, leading his live velocity. The hit lands later, in the loop.
  bus.on("enemy-throw", ({ origin }) => {
    player.body.getPosition(knifeAim)
    player.body.getLinearVelocity(knifeVel)
    knifeTarget.set(knifeAim.x, knifeAim.y, knifeAim.z)
    knives.throw(origin, knifeTarget, knifeVel)
  })
  // In-flight knives are meaningless after a death/respawn or scenario switch.
  bus.on("player-death", () => knives.reset())

  const combat = new Combat(bus)
  player.combat = combat
  const mega = new MegaSystem(bus, clock, physics, combat)
  const diveSmash = new DiveSmash(bus, clock, physics)
  bus.on("dive-impact", ({ origin, power, mega }) => {
    triggerGroundShockwave(origin, power, mega)
  })
  bus.on("wall-jump", ({ origin, speed }) => {
    triggerBuildingImpactRipple(origin, speed)
  })
  bus.on("mega-release", ({ origin }) => {
    triggerGroundShockwave(origin, MEGA_RELEASE_SHOCK_POWER, true)
  })
  let lastLightningPhysicsShock = -Infinity
  bus.on("mega-lightning", ({ point }) => {
    triggerGroundShockwave(point, LIGHTNING_SHOCK_POWER, false, "lightning")
    const now = performance.now() / 1000
    if (now - lastLightningPhysicsShock < LIGHTNING_PHYSICS_MIN_GAP) return
    lastLightningPhysicsShock = now
    // Props only: enemies are launched by the travelling wave front instead
    // (applyShockFrontsToEnemies), so the hit lands when the ripple reaches them.
    physics.explode(
      point.x,
      0.6,
      point.z,
      LIGHTNING_BLAST_RADIUS,
      LIGHTNING_BLAST_IMPULSE,
      Category.Prop
    )
  })

  // ---- HUD (created before effects so ui-feedback can hook it) ----
  const hud = new Hud(document.body, player.health.max)

  // ---- Effects ----
  const effectManager = new EffectManager()
  const effectCtx: EffectContext = {
    bus,
    clock,
    scene,
    camera,
    physics,
    hud,
    renderer,
    getPlayer: () => player
  }
  effectManager.init(effectCtx)
  // Post chains own rendering while their envelopes are live; mega outranks
  // the CRT flash, and everything else keeps the plain render path below.
  const crtEffect = effectManager.effects.find(
    (e): e is CrtEffect => e instanceof CrtEffect
  )
  const megaFx = effectManager.effects.find(
    (e): e is MegaFxEffect => e instanceof MegaFxEffect
  )
  // The green grade is folded into the Mega FX chain (which renders every
  // frame it's enabled); this standalone pipeline is the fallback base path
  // for when Mega FX is toggled off.
  const matrixGrade = effectManager.effects.find(
    (e): e is MatrixGradeEffect => e instanceof MatrixGradeEffect
  )
  const soundFx = effectManager.effects.find(
    (e): e is SoundEffect => e instanceof SoundEffect
  )

  // ---- Scenario management ----
  let scenario: Scenario
  const loadScenario = (id: string): void => {
    if (scenario) scenario.dispose()
    knives.reset()
    scenario = getScenarioEntry(id).create()
    // Clear any wall-kick facades from the previous scenario; the new one
    // re-registers its own during setup (only Revolutions has buildings).
    player.setWallSurfaces([])
    const scenarioCtx: ScenarioContext = { physics, scene, bus, player }
    scenario.setup(scenarioCtx)
    player.respawn(scenario.playerSpawn)
    if (isWireframeEnabled()) applyWireframe(scene)
    panel.setScenarioControl(scenario.controlElement ?? null, scenario.label)
  }
  const restartCurrentScenario = (): void => {
    bus.emit("player-death", {})
    clock.paused = false
    clock.timeScale = 1
    document.body.classList.remove("paused")
    combat.reset()
    mega.reset()
    diveSmash.reset()
    loadScenario(scenario.id)
  }

  // ---- UI ----
  const panel = new Panel(
    effectManager,
    loadScenario,
    [
      { label: "Attack", params: combatTuningParams },
      { label: "Attack", params: wallKickTuningParams }
    ],
    {
      enabled: isWireframeEnabled(),
      onChange: (on) => setWireframeEnabled(on, scene)
    }
  )
  document.body.appendChild(panel.root)
  const legend = new Legend()
  document.body.appendChild(legend.root)

  if (soundFx) {
    const sfxVolume = new SfxVolume(soundFx)
    document.body.appendChild(sfxVolume.root)
  }

  // Hand the dossier (built before the awaits above) its live game systems.
  // From here on opening pauses the game and suspends gameplay input; closing
  // restores the prior pause state.
  infoClock = clock
  infoInput = input
  infoSound = soundFx ?? null

  const socialLinks = new SocialLinks()
  document.body.appendChild(socialLinks.root)

  const pauseOverlay = document.createElement("div")
  pauseOverlay.className = "pause-overlay"
  pauseOverlay.textContent = "PAUSED"
  document.body.appendChild(pauseOverlay)

  let cameraMode = false
  let immersive = false
  let panelHidden = false

  loadScenario(Panel.loadScenarioId())

  // "." wipes every persisted choice (effect toggles, tuning sliders, floor
  // colors, scenario, horde size) and reloads — back to source defaults.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "." || e.repeat) return
    try {
      const doomed: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith("fabled-revolutions.")) doomed.push(k)
      }
      for (const k of doomed) localStorage.removeItem(k)
    } catch {
      // localStorage unavailable; nothing persisted anyway.
    }
    location.reload()
  })

  // ---- Resize ----
  // Reconciled per-frame in the loop rather than via a resize listener: the tab
  // can boot hidden with a 0×0 canvas, and configuring the WebGPU swapchain at
  // that size breaks presentation until the next real setSize.
  let surfaceW = 0
  let surfaceH = 0
  const reconcileSurface = (): boolean => {
    const w = window.innerWidth
    const h = window.innerHeight
    if (w > 0 && h > 0 && (w !== surfaceW || h !== surfaceH)) {
      renderer.setSize(w, h)
      camera.setAspect(w / h)
      surfaceW = w
      surfaceH = h
    }
    return surfaceW > 0 && surfaceH > 0
  }

  // ---- Main loop ----
  let fps = 60
  let bodyCount = 0
  let statsTimer = 0
  let lastWireframeBodyCount = 0
  const playerFallPos = { x: 0, y: 0, z: 0 }

  const loop = (): void => {
    const unscaledDt = clock.tick()
    const scaledDt = clock.scaledDt
    fps = fps * 0.9 + (1 / Math.max(unscaledDt, 0.0001)) * 0.1

    // Poll gamepad + activity timers, then read player input.
    input.poll(unscaledDt)

    // While the info dossier is open, hotkeys still drain their queues but do
    // nothing — the modal owns the pause state and Escape.
    if (input.consumeInfoModalToggle()) {
      if (infoModal.isOpen) infoModal.close()
      else infoModal.open()
    }
    if (input.consumeCameraToggle() && !infoModal.isOpen) {
      cameraMode = !cameraMode
      infoCameraMode = cameraMode // keep the dossier's close logic in sync
      if (cameraMode) {
        manualCamera.enter()
        input.setGameplayEnabled(false)
      } else {
        manualCamera.exit()
        input.setGameplayEnabled(true)
      }
    }
    if (input.consumePauseToggle() && !infoModal.isOpen) {
      clock.paused = !clock.paused
      document.body.classList.toggle("paused", clock.paused)
    }
    if (input.consumeImmersiveToggle() && !infoModal.isOpen) {
      immersive = !immersive
      document.body.classList.toggle("immersive", immersive)
    }
    if (input.consumePanelToggle()) {
      panelHidden = !panelHidden
      document.body.classList.toggle("panel-hidden", panelHidden)
    }

    // While the dossier is open the game is paused AND fully hidden behind the
    // near-opaque overlay. Skip all sim, effect, camera, HUD, sync, and render
    // work below: none of it is visible, and — critically — presenting a fresh
    // WebGPU frame under the overlay's `backdrop-filter` forces the browser to
    // re-blur a still-animating scene every frame (camera/effects tick on
    // unscaled dt), which flickers and starves the modal's own scroll + rain of
    // main-thread time. A frozen last frame blurs once and stays crisp. Hotkey
    // queues were already drained above, so nothing fires on close.
    if (infoModal.isOpen) {
      schedule(loop)
      return
    }

    legend.update(input.activeSource, input.activity(), cameraMode)

    if (!clock.paused) {
      player.update(input, camera.camera, scaledDt)
      if (input.consumeAttack()) combat.tryAttack(player)
      combat.setHeld(input.attackHeld)

      // Combat swing timing runs on unscaled dt (so hit-stop can't stall a
      // swing); the mega spin paces itself to the bullet-time timeline.
      const enemies = scenario.enemies
      enemyIndex.rebuild(enemies)
      combat.update(unscaledDt, player, enemies, enemyIndex)

      // Mega mode: kill-burst window, arming, slow-mo ramps (wall-clock).
      mega.update(unscaledDt)

      // Dive smash: descent bullet-time + landing speed-up ramp (wall-clock).
      diveSmash.update(unscaledDt)

      // Fresh hit/blast impulses should transfer through touching rows before AI
      // steering gets a chance to cancel the victim's motion.
      Enemy.resolveBilliardTransfers(enemies, enemyIndex)

      // i-frames + shield regen tick on wall-clock time.
      player.health.tick(unscaledDt)
      player.shield.tick(unscaledDt)

      // Enemy AI + touch damage on scaled dt (freezes during hit-stop). The
      // shield soaks contact first; only once it is down do hearts drop (which
      // gate themselves on their own i-frames).
      for (const enemy of enemies) {
        const inRange = enemy.update(scaledDt, player, enemies, enemyIndex)
        if (inRange && !enemy.dead) {
          damagePlayerFrom(enemy.position.x, enemy.position.z)
        }
      }

      scenario.update(scaledDt)
      // Floor's liquid subsurface and impact wave drift on scaled time.
      advanceFloorTime(scaledDt)
      advanceGroundShockwave(scaledDt)
      // Physical wave: as the displaced-geometry crest sweeps outward it
      // launches the enemies it reaches — not one instant center blast.
      applyShockFrontsToEnemies()

      // Advance physics with scaled dt, then sync meshes.
      physics.step(scaledDt)
      player.body.getPosition(playerFallPos)
      if (playerFallPos.y < PLAYER_FALL_DEATH_Y) restartCurrentScenario()

      // Fly the thrown knives against the freshly-stepped player position;
      // scaledDt so they crawl through bullet time with everything else. A
      // knife reaching the player runs the same shield→hearts damage path as a
      // touch, sourced from where the blade struck.
      knifeHitCenter.set(playerFallPos.x, playerFallPos.y, playerFallPos.z)
      knives.update(scaledDt, knifeHitCenter, (knifePos) =>
        damagePlayerFrom(knifePos.x, knifePos.z)
      )
    }

    // Presentation sync runs while paused so staged fly-ins stay off-screen.
    player.syncMesh()
    for (const enemy of scenario.enemies) enemy.syncMesh()

    // Effects update on unscaled dt.
    effectManager.update(unscaledDt)
    for (const enemy of scenario.enemies) enemy.syncVisuals()

    // Camera + HUD (unscaled — must keep moving during freeze).
    if (cameraMode) {
      camera.shakeOffset.set(0, 0, 0)
      camera.shakeRoll = 0
      manualCamera.update(unscaledDt)
    } else {
      camera.orbit = mega.cameraOrbit
      camera.update(player.position, unscaledDt)
    }
    if (!immersive) {
      hud.update(
        player,
        scenario.enemies,
        camera.camera,
        window.innerWidth,
        window.innerHeight,
        combat,
        mega
      )
    }

    // Footer readout at ~4 Hz — writing DOM text every frame invalidates
    // layout for no visible benefit.
    statsTimer -= unscaledDt
    if (statsTimer <= 0 && !immersive && !panelHidden) {
      statsTimer = 0.25
      bodyCount = physics.bodyCount
      panel.setStats(fps, bodyCount)
      if (isWireframeEnabled() && bodyCount !== lastWireframeBodyCount) {
        lastWireframeBodyCount = bodyCount
        applyWireframe(scene)
      }
    }

    // Present only once the surface has a real size (see reconcileSurface) —
    // WebGPU cannot create a 0×0 swapchain texture. Simulation above already
    // ran, so gameplay stays live while hidden.
    if (reconcileSurface()) {
      if (
        !megaFx?.renderFrame() &&
        !crtEffect?.renderFrame() &&
        !matrixGrade?.renderFrame()
      ) {
        renderer.render(scene, camera.camera)
      }
    }
    schedule(loop)
  }

  // Offline-capture mode: when true the loop stops self-scheduling and an
  // external driver (dev-only __fabledRevolutions.capture) steps frames manually
  // with a forced fixed dt — deterministic video capture immune to tab
  // throttling.
  let captureMode = false

  // rAF stops when the tab is hidden; in dev, fall back to setTimeout so
  // automated QA (and background tabs) keep simulating.
  const schedule = (fn: () => void): void => {
    if (captureMode) return // externally driven
    if (import.meta.env.DEV && document.hidden) {
      setTimeout(fn, 16)
    } else {
      requestAnimationFrame(fn)
    }
  }

  /**
   * The gameplay half of the travelling ground shockwave: each frame, every
   * enemy standing in the band the crest swept this frame takes an outward
   * impulse scaled by distance falloff — so the crowd goes flying row by row
   * exactly as the visible floor wave reaches them. Dead bodies get extra
   * loft and tumble; strong hits blow even scenario-held rank agents loose.
   */
  function applyShockFrontsToEnemies(): void {
    const fronts = collectShockFronts()
    if (fronts.length === 0) return
    for (const front of fronts) {
      const basePower =
        front.power *
        // Mega ripples (spin release + mega smash) fling ~2x as hard.
        (front.mega ? 3.2 : 1) *
        (front.kind === "lightning" ? SHOCK_WAVE_LIGHTNING_SCALE : 1)
      // Only the thin annulus (prevFront, front] matters; the circle query
      // over-collects the interior and the band test below does the filtering.
      const candidates = enemyIndex.collectCircle(
        front.originX,
        front.originZ,
        front.front,
        shockFrontScratch
      )
      for (const enemy of candidates) {
        if (enemy.parked) continue
        const dx = enemy.position.x - front.originX
        const dz = enemy.position.z - front.originZ
        const dist = Math.hypot(dx, dz)
        if (dist <= front.prevFront || dist > front.front) continue
        const falloff = Math.max(0.2, 1 - dist / front.radius)
        // Cap so the launch stays hard but not into orbit. Mega waves get a
        // doubled ceiling to match their doubled shove (basePower 3.2x above).
        const s = Math.min(front.mega ? 6 : 3, basePower * falloff)
        const inv = dist > 0.001 ? 1 / dist : 0
        const nx = inv > 0 ? dx * inv : 1
        const nz = inv > 0 ? dz * inv : 0
        const impulse = SHOCK_WAVE_IMPULSE * s
        if (s > SHOCK_WAVE_UNLOCK_STRENGTH) enemy.setMovementLocked(false)
        if (enemy.dead) {
          enemy.body.applyLinearImpulseToCenter(
            nx * impulse,
            SHOCK_WAVE_LIFT * s,
            nz * impulse
          )
          enemy.body.applyAngularImpulse(
            -nz * SHOCK_WAVE_SPIN * s,
            (Math.random() - 0.5) * SHOCK_WAVE_SPIN * s,
            nx * SHOCK_WAVE_SPIN * s
          )
        } else {
          // Stagger first: low damping + a stun so the AI can't steer against
          // the shove and the body actually slides.
          enemy.stagger(s)
          enemy.body.applyLinearImpulseToCenter(
            nx * impulse,
            SHOCK_WAVE_LIFT * s * 0.5,
            nz * impulse
          )
        }
      }
      // Let scenarios react to the same band (building facades, etc.).
      bus.emit("shock-front", front)
    }
  }

  /**
   * Run an incoming hit against the player from a source position on the XZ
   * plane — shared by enemy touches and thrown knives. Drains the shield first,
   * then hearts (i-frame gated), shoving the player away from the source.
   */
  function damagePlayerFrom(sourceX: number, sourceZ: number): void {
    const shieldState = player.shield.hit()
    // On its per-hit cooldown — this contact does nothing.
    if (shieldState === "blocked") return

    const dir = new THREE.Vector3(
      player.position.x - sourceX,
      0,
      player.position.z - sourceZ
    )
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    else dir.normalize()
    const point = player.position.clone().setY(1)

    // Shield ate it: shove the player back, flash the meter, keep hearts intact.
    if (shieldState === "absorbed") {
      player.body.applyLinearImpulseToCenter(
        dir.x * PLAYER_KNOCKBACK,
        0,
        dir.z * PLAYER_KNOCKBACK
      )
      bus.emit("player-shielded", { point, dir })
      return
    }

    // Shield is down — hearts take the hit (gated by their own i-frames).
    const landed = player.health.damage(PLAYER_TOUCH_DAMAGE)
    if (!landed) return
    player.body.applyLinearImpulseToCenter(
      dir.x * PLAYER_KNOCKBACK,
      0,
      dir.z * PLAYER_KNOCKBACK
    )
    bus.emit("player-hurt", { point, dir })
    if (player.health.isDead) {
      bus.emit("player-death", {})
      player.respawn(scenario.playerSpawn)
    }
  }

  // Dev-only handle for driving the game from the console / automated QA.
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__fabledRevolutions = {
      player,
      combat,
      mega,
      input,
      bus,
      physics,
      clock,
      camera,
      effectManager,
      get scenario() {
        return scenario
      },
      attack: () => combat.tryAttack(player),
      loadScenario,
      capture: {
        begin(fps = 60): void {
          captureMode = true
          clock.forcedDt = 1 / fps
        },
        /** Run exactly one simulated+rendered frame. */
        step(): void {
          loop()
        },
        end(): void {
          captureMode = false
          clock.forcedDt = null
          schedule(loop)
        }
      }
    }

    // TEMP QA: /?stormtest=1 loops the mega lightning storm FX (no gameplay)
    // so bolts/forks/debris can be eyeballed without earning a mega.
    if (new URLSearchParams(location.search).has("stormtest")) {
      const fire = (): void =>
        bus.emit("mega-release", { origin: new THREE.Vector3(0, 0, 0) })
      setTimeout(fire, 2500)
      setInterval(fire, 8000)
    }

    // Self-driving showcase recorder: open /?record=1 in a normal foreground
    // tab and it plays + captures the whole mega sequence on its own.
    if (new URLSearchParams(location.search).has("record")) {
      const stagePresser = (forward: number, right: number): void => {
        if (
          scenario instanceof MegaHordeScenario ||
          scenario instanceof RevolutionsScenario
        ) {
          const p = player.position
          const f = player.facing
          scenario.spawnNear(
            p.x + f.x * forward + f.z * right,
            p.z + f.z * forward - f.x * right
          )
        }
      }
      void import("./dev/record").then((m) =>
        m.recordMegaShowcase({
          combat,
          mega,
          effectManager,
          loadScenario,
          enemiesAlive: () => scenario.enemies.filter((e) => !e.dead).length,
          closestEnemyDistance: () =>
            scenario.enemies.reduce(
              (nearest, enemy) =>
                enemy.dead
                  ? nearest
                  : Math.min(nearest, enemy.distanceTo(player.position)),
              Infinity
            ),
          hearts: () => ({
            current: player.health.current,
            max: player.health.max
          }),
          spawnDuelist: () => stagePresser(2.6, 0),
          stagePresser,
          sound: effectManager.effects.find(
            (e): e is SoundEffect => e instanceof SoundEffect
          ),
          setRecordingResolution: () => {
            // 1× pixel ratio keeps the mega blast at a locked 60 fps; the
            // canvas is still ~2K on a retina fullscreen window.
            renderer.setPixelRatio(1)
            renderer.setSize(window.innerWidth, window.innerHeight)
          }
        })
      )
    }
  }

  schedule(loop)
}

void boot()
