import type { Combat } from "../game/combat";
import type { MegaSystem } from "../game/mega";
import { MEGA_THRESHOLD, megaTuning } from "../game/mega";
import type { EffectManager } from "../effects/manager";
import type { SoundEffect } from "../effects/sound";

/**
 * Dev-only self-driving showcase recorder (`?record=1`, optional
 * `&densities=150,90,50`). Runs the full mega arc in the mega-horde scene once
 * per horde density — burst threshold, overcharge, release, bullet-time orbit,
 * un-dilate — capturing the canvas AND the game's WebAudio master bus, then
 * POSTs each take to the local capture receiver as `mega-<density>.webm`.
 *
 * Audio needs a real user gesture (autoplay policy). The recorder first tries
 * a silent unlock (origins with prior engagement often allow it); if the
 * context stays suspended it shows a START button and waits for one click,
 * which unlocks audio for every take in the session.
 *
 * Exists because scripted capture inside a hidden preview tab is hopeless:
 * background throttling wrecks the pacing and the compositor never presents
 * frames. Opened as a normal foreground tab this records at full 60 fps.
 */

interface RecordHandle {
  combat: Combat;
  mega: MegaSystem;
  effectManager: EffectManager;
  loadScenario: (id: string) => void;
  enemiesAlive: () => number;
  closestEnemyDistance: () => number;
  hearts: () => { current: number; max: number };
  /** Stage a single enemy right in front of the player (opening-hit beat). */
  spawnDuelist: () => void;
  /** Stage a close presser by forward/right offsets from the player's current facing. */
  stagePresser: (forward: number, right: number) => void;
  sound: SoundEffect | undefined;
  /** Cap render resolution so the take holds 60 fps (retina fullscreen is 4K+). */
  setRecordingResolution: () => void;
}

const UPLOAD_URL = "http://127.0.0.1:8787/upload";
/** Matches MegaHordeScenario's persistence key — the take presets it. */
const HORDE_TARGET_KEY = "fabled-revolutions.mega-horde.target";
const REVOLUTIONS_RECORD_TARGET = 340;
const REVOLUTIONS_READY_COUNT = 275;
const REVOLUTIONS_TAKE_MS = 15_000;
const REVOLUTIONS_RECORD_WILD_TAIL = 0.1;
const REVOLUTIONS_FINALE_CHARGE = 1.6;
const REVOLUTIONS_PREROLL_MS = 1_600;
const REVOLUTIONS_CLOSE_DISTANCE = 5.2;
const REVOLUTIONS_PRESSER_SETTLE_MS = 260;
const REVOLUTIONS_OPENING_PRESSERS = [
  { forward: 2.55, right: 0 },
  { forward: 0.85, right: -2.05 },
  { forward: 0.9, right: 2.1 },
  { forward: -1.1, right: -1.25 },
  { forward: 2.15, right: 2.75 },
] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CaptureFormat {
  mimeType: string;
  extension: "mp4" | "webm";
}

function captureFormat(): CaptureFormat {
  const candidates: CaptureFormat[] = [
    { mimeType: "video/mp4;codecs=avc1.640028,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? candidates[1];
}

// Synthetic input helpers (drive the real input path, same as a player).
function keyDown(code: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
}
function keyUp(code: string): void {
  window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
}
function mouseDown(canvas: HTMLElement): void {
  canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
}
function mouseUp(): void {
  window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
}

async function until(cond: () => boolean, capMs: number): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < capMs) {
    if (cond()) return true;
    await sleep(50);
  }
  return false;
}

function banner(text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;" +
    "background:#111;color:#7adcff;font:700 14px monospace;padding:8px 16px;" +
    "border-radius:8px;pointer-events:none";
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

function stageRevolutionsOpeningPressers(h: RecordHandle): void {
  for (const { forward, right } of REVOLUTIONS_OPENING_PRESSERS) {
    h.stagePresser(forward, right);
  }
}

/** Try silent audio unlock; fall back to a real START click if suspended. */
async function unlockAudio(h: RecordHandle, status: HTMLElement): Promise<void> {
  window.dispatchEvent(new PointerEvent("pointerdown")); // nudges the lazy init
  await until(() => h.sound?.audioState === "running", 2000);
  if (h.sound?.audioState === "running") return;

  status.textContent = "AUDIO LOCKED — CLICK START";
  const btn = document.createElement("button");
  btn.textContent = "▶ START RECORDING (with sound)";
  btn.style.cssText =
    "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;" +
    "background:#7adcff;color:#08222e;font:800 20px monospace;padding:18px 30px;" +
    "border:none;border-radius:12px;cursor:pointer";
  document.body.appendChild(btn);
  await new Promise<void>((r) => btn.addEventListener("click", () => r(), { once: true }));
  btn.remove();
  // The click itself unlocked the context (SoundEffect listens on pointerdown).
  await until(() => h.sound?.audioState === "running", 2000);
}

export async function recordMegaShowcase(h: RecordHandle): Promise<void> {
  const previousCameraSpin = megaTuning.cameraSpin;
  megaTuning.cameraSpin = 1;
  try {
    const status = banner("RECORDING SETUP…");
    h.setRecordingResolution();
    h.effectManager.setAll(true);
    h.effectManager.setEnabled("hit-stop", false);
    h.effectManager.setEnabled("crt-flash", false);

    // Landscape guard: the video inherits the window shape.
    if (window.innerWidth / window.innerHeight < 1.3) {
      status.textContent = "WIDEN THIS WINDOW TO RECORD (16:9-ish)…";
      await until(() => window.innerWidth / window.innerHeight >= 1.3, 60000);
      h.setRecordingResolution();
    }

    await unlockAudio(h, status);
    const audioTracks = h.sound?.getCaptureTracks() ?? [];

    const params = new URLSearchParams(location.search);

    // Revolutions cinematic: off-camera pre-roll, opening hit, max spin, then a
    // re-charged double-jump mega smash finale.
    if (params.get("scene") === "revolutions") {
      await runRevolutionsTake(h, audioTracks, status);
      status.textContent = "REVOLUTIONS TAKE UPLOADED — you can close this tab";
      return;
    }

    const densities = (params.get("densities") ?? "150,90,50")
      .split(",")
      .map((d) => Math.max(25, Math.min(500, Number(d) || 150)));

    for (const density of densities) {
      status.textContent = `TAKE: DENSITY ${density} — filling arena…`;
      await runTake(h, density, audioTracks, status);
      await sleep(800);
    }
    status.textContent = "ALL TAKES UPLOADED — you can close this tab";
  } finally {
    megaTuning.cameraSpin = previousCameraSpin;
  }
}

/**
 * Sets up a MediaRecorder over a HUD-composited canvas + game audio, returns
 * the recorder plus a stop() that finalizes and uploads under `name`.
 */
function startCapture(
  h: RecordHandle,
  canvas: HTMLCanvasElement,
  audioTracks: MediaStreamTrack[],
  name: string,
  status: HTMLElement,
): { stop: () => Promise<void> } {
  const comp = document.createElement("canvas");
  comp.width = canvas.width;
  comp.height = canvas.height;
  const cctx = comp.getContext("2d")!;
  let compositing = true;
  const drawLoop = (): void => {
    if (!compositing) return;
    cctx.drawImage(canvas, 0, 0, comp.width, comp.height);
    drawHud(cctx, comp.width, comp.height, h);
    requestAnimationFrame(drawLoop);
  };
  requestAnimationFrame(drawLoop);

  const stream = comp.captureStream(60);
  for (const track of audioTracks) stream.addTrack(track);
  const format = captureFormat();
  const rec = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: 20_000_000,
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(250);

  return {
    stop: async () => {
      rec.stop();
      await stopped;
      compositing = false;
      const blob = new Blob(chunks, { type: format.mimeType });
      const filename = `${name}.${format.extension}`;
      status.textContent = `UPLOADING ${filename} (${(blob.size / 1e6).toFixed(1)} MB)…`;
      try {
        await fetch(`${UPLOAD_URL}?name=${filename}`, { method: "POST", body: blob });
      } catch {
        status.textContent = "UPLOAD FAILED (receiver not running)";
      }
    },
  };
}

/**
 * One continuous Revolutions cinematic:
 *   1. PRE-ROLL (not captured) — facade ranks are already in place; a short
 *      pre-roll plus staged pressers starts the shot with agents on him.
 *   2. OPENING HIT — the first filmed beat clips a staged presser, tipping the
 *      meter into MEGA READY, then immediately holds to max overcharge.
 *   3. MEGA SPIN — release the full violet whirlwind that
 *      scythes the crowd into the buildings in bullet time.
 *   4. FINALE — re-arm, charge again, double-jump, and mega-smash straight down
 *      for the shockwave that hammers everything outward into the facades.
 */
async function runRevolutionsTake(
  h: RecordHandle,
  audioTracks: MediaStreamTrack[],
  status: HTMLElement,
): Promise<void> {
  status.textContent = "REVOLUTIONS — building corridor…";
  const previousWildTail = megaTuning.wildTail;
  megaTuning.wildTail = REVOLUTIONS_RECORD_WILD_TAIL;
  // Denser crowd after the Revolutions optimizations: full facade ranks that
  // still leave headroom for the bullet-time spin and smash-down blast.
  try {
    try {
      localStorage.setItem("fabled-revolutions.revolutions.target", String(REVOLUTIONS_RECORD_TARGET));
    } catch {
      // ignore
    }
    h.loadScenario("revolutions");
    await until(() => h.enemiesAlive() >= REVOLUTIONS_READY_COUNT, 10000);
    await sleep(REVOLUTIONS_PREROLL_MS);
    await until(() => h.closestEnemyDistance() <= REVOLUTIONS_CLOSE_DISTANCE, 1500);
    // Start the filmed action a little after scene start: a few pressers are
    // already tight around the player, while one clean forward target takes
    // the opening hit that tips the meter into MEGA READY.
    h.mega.debugArm(MEGA_THRESHOLD - 1);
    stageRevolutionsOpeningPressers(h);
    await sleep(REVOLUTIONS_PRESSER_SETTLE_MS);

    const canvas = document.querySelector("canvas");
    if (!canvas) {
      status.textContent = "NO CANVAS";
      return;
    }
    const cap = startCapture(h, canvas, audioTracks, "revolutions", status);
    const takeStart = performance.now();
    status.textContent = "RECORDING — revolutions";
    await sleep(120);

    try {
      // --- Beat 1: OPENING HIT — first filmed action tips the meter to ready. ---
      mouseDown(canvas);
      await sleep(90);
      mouseUp();
      await until(() => h.mega.armed, 1200);
      if (!h.mega.armed) h.mega.debugArm();
      await sleep(180);

      // --- Beat 2: MEGA SPIN. Hold to the violet max overcharge and release
      // the bullet-time whirlwind.
      await until(() => h.mega.armed, 600);
      mouseDown(canvas);
      await until(() => h.combat.chargeLevel >= 2, 8000);
      await sleep(180);
      mouseUp();
      await until(() => h.mega.slowMoActive, 3000);
      await until(() => !h.mega.slowMoActive && !h.mega.active, 7000);
      await sleep(150);

      // --- Beat 3: FINALE — re-charge, double-jump, charged mega smash-down. ---
      h.mega.debugArm();
      await until(() => h.mega.armed, 600);
      mouseDown(canvas); // hold to charge (drives diveMega on the plunge)
      await until(() => h.combat.chargeLevel >= REVOLUTIONS_FINALE_CHARGE, 8000);
      await sleep(150);
      // Double jump while still holding the charge.
      keyDown("Space");
      keyUp("Space");
      await sleep(240);
      keyDown("Space");
      await sleep(100);
      // Releasing Space after the second jump triggers the charged mega smash-down:
      // slow-mo plunge, then the ground blast that hammers the crowd outward.
      keyUp("Space");
      await sleep(2500); // slow-mo descent + impact + recovery
      mouseUp();

      const remaining = REVOLUTIONS_TAKE_MS - (performance.now() - takeStart);
      if (remaining > 0) await sleep(remaining);
    } finally {
      keyUp("KeyW");
      mouseUp();
    }

    await cap.stop();
  } finally {
    megaTuning.wildTail = previousWildTail;
  }
}

async function runTake(
  h: RecordHandle,
  density: number,
  audioTracks: MediaStreamTrack[],
  status: HTMLElement,
): Promise<void> {
  // Preset the horde size, then rebuild the scenario so it applies.
  try {
    localStorage.setItem(HORDE_TARGET_KEY, String(density));
  } catch {
    // ignore
  }
  h.loadScenario("mega-horde");
  await until(() => h.enemiesAlive() >= density - 5, 25000);
  // Let the slow march form its staggered rings before the take begins.
  await sleep(4000);

  const canvas = document.querySelector("canvas");
  if (!canvas) {
    status.textContent = "NO CANVAS";
    return;
  }

  // The game canvas alone carries no DOM, so the kill meter / hearts / legend
  // (the left-side UI) are redrawn onto a compositing canvas each frame. The
  // effects panel is deliberately absent — the video shows gameplay UI only.
  const comp = document.createElement("canvas");
  comp.width = canvas.width;
  comp.height = canvas.height;
  const cctx = comp.getContext("2d");
  if (!cctx) {
    status.textContent = "NO 2D CONTEXT";
    return;
  }
  let compositing = true;
  const drawLoop = (): void => {
    if (!compositing) return;
    cctx.drawImage(canvas, 0, 0, comp.width, comp.height);
    drawHud(cctx, comp.width, comp.height, h);
    requestAnimationFrame(drawLoop);
  };
  requestAnimationFrame(drawLoop);

  const stream = comp.captureStream(60);
  for (const track of audioTracks) stream.addTrack(track);
  const format = captureFormat();
  const rec = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: 20_000_000,
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));

  status.textContent = `RECORDING — density ${density}`;
  rec.start(250);
  await sleep(250);

  // Beat 1: meter sits one kill shy. A staged duelist spawns right in front,
  // takes half a second to step up against the player, then eats a full hit
  // and slides across the stone — the kill that tips the meter into MEGA
  // READY, with the wider crowd left intact for the mega itself.
  h.mega.debugArm(11);
  h.spawnDuelist();
  await sleep(550); // let him close the gap
  canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
  await sleep(60);
  window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
  await sleep(1000); // watch the body sail + the meter arm
  if (!h.mega.armed) h.mega.debugArm(); // he somehow survived — arm anyway

  // Beat 2: now the full mega — hold to the violet overcharge.
  canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
  await until(() => h.combat.chargeLevel >= 2, 8000);
  await sleep(350); // linger on the violet overcharge

  // Beat 3: release — the spin itself lerps into bullet time. Wait for the
  // release to actually register (it lands on the *next* game frame, which at
  // low fps can be after our first poll) before waiting for it to finish.
  window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
  await until(() => h.mega.slowMoActive, 3000);
  await until(() => !h.mega.slowMoActive && !h.mega.active, 18000);

  // Beat 4: the aftermath window already includes the wild tail; buffer so
  // the final cut can trim to a clean 10 seconds.
  await sleep(1400);
  rec.stop();
  await stopped;
  compositing = false;

  const blob = new Blob(chunks, { type: format.mimeType });
  const filename = `mega-${density}.${format.extension}`;
  status.textContent = `UPLOADING ${filename} (${(blob.size / 1e6).toFixed(1)} MB)…`;
  try {
    await fetch(`${UPLOAD_URL}?name=${filename}`, { method: "POST", body: blob });
  } catch {
    status.textContent = "UPLOAD FAILED (receiver not running)";
  }
}

// ---- Composited HUD (mirrors the DOM styling of the left-side game UI) ----

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + hh, r);
  c.arcTo(x + w, y + hh, x, y + hh, r);
  c.arcTo(x, y + hh, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawHud(c: CanvasRenderingContext2D, w: number, hgt: number, h: RecordHandle): void {
  const t = performance.now() / 1000;

  // -- Kill-rate meter (top left) --
  const armed = h.mega.armed;
  const active = h.mega.active;
  const x = 18;
  const y = 18;
  const mw = 190;
  const mh = 86;
  c.save();
  if (armed || active) {
    c.shadowColor = active ? "rgba(255,255,255,0.6)" : "rgba(122,220,255,0.5)";
    c.shadowBlur = 20;
  }
  c.fillStyle = "rgba(28,28,32,0.92)";
  roundRect(c, x, y, mw, mh, 8);
  c.fill();
  c.shadowBlur = 0;
  c.strokeStyle = active ? "#ffffff" : armed ? "#7adcff" : "#3a3a40";
  c.lineWidth = 1.5;
  c.stroke();

  c.fillStyle = "#9a9aa2";
  c.font = `700 10px ${FONT}`;
  c.fillText("K I L L   R A T E", x + 12, y + 20);

  c.fillStyle = "#e6e6e8";
  c.font = `800 26px ${FONT}`;
  const count = String(h.mega.burstKills);
  c.fillText(count, x + 12, y + 46);
  c.fillStyle = "#9a9aa2";
  c.font = `400 11px ${FONT}`;
  c.fillText(`/ ${MEGA_THRESHOLD} in 10s`, x + 16 + c.measureText(count).width + 14, y + 44);

  // Progress bar.
  const bw = mw - 24;
  c.fillStyle = "#45454d";
  roundRect(c, x + 12, y + 54, bw, 5, 3);
  c.fill();
  const p = Math.min(1, h.mega.burstKills / MEGA_THRESHOLD);
  if (p > 0) {
    const grad = c.createLinearGradient(x + 12, 0, x + 12 + bw, 0);
    if (armed || active) {
      grad.addColorStop(0, "#7adcff");
      grad.addColorStop(1, "#b48cff");
    } else {
      grad.addColorStop(0, "#ffc85a");
      grad.addColorStop(1, "#ff7a4e");
    }
    c.fillStyle = grad;
    roundRect(c, x + 12, y + 54, bw * p, 5, 3);
    c.fill();
  }

  // Status line.
  if (armed || active) {
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * (active ? 6 : 2.5)));
    c.globalAlpha = pulse;
    c.fillStyle = active ? "#ffffff" : "#7adcff";
    c.font = `800 10px ${FONT}`;
    c.fillText(active ? "M  E  G  A" : "MEGA READY — HOLD ATTACK", x + 12, y + 76);
    c.globalAlpha = 1;
  }
  c.restore();

  // -- Hearts (top center) --
  const hearts = h.hearts();
  const hs = 22;
  const gap = 6;
  const total = hearts.max * hs + (hearts.max - 1) * gap;
  let hx = (w - total) / 2;
  for (let i = 0; i < hearts.max; i++) {
    drawHeart(c, hx, 18, hs, i < hearts.current ? "#e0556a" : "#55555c");
    hx += hs + gap;
  }

  // -- Controls legend (bottom left) --
  const rows: Array<[string, string]> = [
    ["MOVE", "WASD"],
    ["LOOK", "MOUSE"],
    ["ATTACK", "CLICK · HOLD TO CHARGE"],
  ];
  let ly = hgt - 18 - (rows.length - 1) * 20;
  for (const [k, v] of rows) {
    c.font = `600 12px ${FONT}`;
    c.fillStyle = "#7f8087";
    c.fillText(k, 18, ly);
    c.font = `400 12px ${FONT}`;
    c.fillStyle = "#606167";
    c.fillText(v, 18 + 72, ly);
    ly += 20;
  }
}

function drawHeart(c: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  const u = s / 22; // path authored on a 22px grid (matches the CSS clip-path)
  c.save();
  c.translate(x, y);
  c.scale(u, u);
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(11, 20);
  c.lineTo(2, 11);
  c.arc(6.5, 6.5, 6.36, (3 * Math.PI) / 4, (7 * Math.PI) / 4);
  c.arc(15.5, 6.5, 6.36, (5 * Math.PI) / 4, (9 * Math.PI) / 4);
  c.closePath();
  c.fill();
  c.restore();
}
