import * as THREE from "three/webgpu";
import { Physics, Body, Category } from "../core/physics";
import { glossyLensMaterial, standardNodeMaterial } from "../core/materials";
import { Health } from "./health";
import { Shield } from "./shield";
import type { Input } from "../core/input";
import type { Combat } from "./combat";
import type { EventBus } from "../core/events";

const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.5;
const MOVE_SPEED = 14;
/** Ground move speed multiplier while sprint is held. */
const SPRINT_MULT = 2.25;
/** How fast the body eases toward its heading (exponential smoothing rate, 1/s). */
const TURN_RATE = 10;
/** How fast the sword aim chases the cursor angle — snappier than the body. */
const SWORD_AIM_RATE = 16;
/** Max angle (radians) the sword can sweep away from the movement heading. */
const SWORD_CONE = Math.PI * 0.55;
/** Fraction of the sword offset the body leans into; the rest is all arms. */
const BODY_LEAN = 0.35;
/** Cursor radius (half-viewport-height units) where aim engages / saturates. */
const AIM_DEADZONE = 0.08;
const AIM_FULL_RADIUS = 0.4;
const MAX_HEARTS = 5;
const I_FRAMES = 0.8;
/** Shield segments absorbed before hearts start dropping (~10 hits to drain). */
const SHIELD_HITS = 10;
/** Seconds clear of damage before the shield begins recharging. */
const SHIELD_RECHARGE_DELAY = 3;
/** Seconds to refill the shield from empty once recharging starts. */
const SHIELD_RECHARGE_TIME = 3;
const UP = new THREE.Vector3(0, 1, 0);

/** What the player collides with. Balcony decks/rails are presentation-only
 * (no colliders), so the player passes cleanly through them from every side. */
const PLAYER_MASK = Category.Enemy | Category.Ground | Category.Prop;

/** Upward launch speed of a jump (m/s) — a big, floaty leap. */
const JUMP_SPEED = 42;
/** Fraction of the remaining ascent kept when the jump button is let go early.
 * Turns the fixed leap into a variable-height jump: a tap is a short hop, a
 * held press floats to the full apex. Cutting the climb (not zeroing it) keeps
 * a hint of upward drift so the arc still reads as a jump, not a hard stop. */
const JUMP_CUT = 0.32;
/** Jumps allowed before touching down again — 2 gives the double jump. */
const MAX_JUMPS = 2;
/** Player-owned gravity (m/s²). We integrate vertical velocity ourselves and
 * feed it to the body each frame, so the capsule's high linear damping (tuned
 * for snappy ground movement) never turns the fall into slow-motion. */
const GRAVITY = 48;
/** Downward speed slammed on during the dive smash (m/s). */
const SMASH_SPEED = 48;
/** Mega dive multiplies the plunge speed — the super move slams down HARD. */
const MEGA_SMASH_MULT = 1.6;
/** Charge level (mega overcharge band) that arms the auto-plunge on release. */
const MEGA_DIVE_LEVEL = 1.5;
/** Forward lunge speed added along facing during the dive (m/s). */
const DIVE_SPEED = 18;
/** Forward body pitch (radians) during the dive — head-down samurai plunge. */
const DIVE_BODY_PITCH = 1.15;
/** Sword pitch (radians) during the dive — blade thrust down and forward. */
const DIVE_SWORD_X = 0.5;
/** Body y within this of its rest height counts as standing on the ground. */
const GROUND_EPS = 0.06;

/** Decay rate (1/s) of the horizontal pop from a wall-kick. */
const LAUNCH_DECAY = 3;

/** Arcade wall-kick: a jump pressed while airborne near a facade bounces off it
 * like a wall-jump — no cling, no climb. Reach, upward pop, and outward boost
 * are panel-tunable (see {@link wallKickTuning}). These two shape the bounce:
 * how strongly the approach speed amplifies the outward push, and how much of
 * the along-wall drift carries through so the exit angle tracks the entry. */
const WALL_KICK_BOUNCE = 0.7;
const WALL_KICK_TANGENT = 0.6;
/** Minimum gap between kicks (s) so one mash can't chain-stack a single face. */
const WALL_KICK_COOLDOWN = 0.25;
/** After a kick, air control is suppressed this long (s) so the outward launch
 * actually carries you off the wall instead of being cancelled by WASD still
 * held into it. Short enough that steering returns well before the apex. */
const WALL_KICK_LOCK = 0.22;
/** Height up the facade the kick's ripple radiates from (relative to the feet). */
const WALL_RIPPLE_Y = PLAYER_HEIGHT * 0.45;
/** Impact "speed" fed to the facade ripple — tuned low for a subtle, local
 * wobble rather than a full wave sweep across the building. */
const WALL_RIPPLE_SPEED = 6;

// ---- Wall-kick tuning (panel-adjustable, persisted) ----
interface WallKickTuningMeta {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
}
const WALL_KICK_TUNING_META: Record<string, WallKickTuningMeta> = {
  /** Gap from the wall surface within which a kick fires (m) — close, but you
   * never have to be right up against it. */
  reach: { label: "kick reach", min: 0.05, max: 2.5, step: 0.05, defaultValue: 0.25 },
  /** Upward pop of the kick (m/s). */
  up: { label: "kick up", min: 20, max: 70, step: 1, defaultValue: 46 },
  /** Outward boost off the wall (m/s) — the floor under the reflected speed.
   * High enough that the kick reads as a diagonal launch back toward center. */
  out: { label: "kick out", min: 5, max: 60, step: 1, defaultValue: 30 },
};
export const wallKickTuning: Record<string, number> = {
  reach: WALL_KICK_TUNING_META.reach.defaultValue,
  up: WALL_KICK_TUNING_META.up.defaultValue,
  out: WALL_KICK_TUNING_META.out.defaultValue,
};
export const wallKickTuningParams = Object.entries(WALL_KICK_TUNING_META).map(
  ([key, meta]) => ({
    key: `wallkick-${key}`,
    label: meta.label,
    min: meta.min,
    max: meta.max,
    step: meta.step,
    get: () => wallKickTuning[key],
    set: (value: number) => setWallKickTuning(key, value),
  }),
);

const WALL_KICK_TUNING_PREFIX = "fabled-revolutions.wallkick.";
const WALL_KICK_TUNING_SCHEMA_KEY = `${WALL_KICK_TUNING_PREFIX}schema`;
const WALL_KICK_TUNING_SCHEMA = JSON.stringify(WALL_KICK_TUNING_META);
restoreWallKickTuning();

function setWallKickTuning(key: string, value: number): void {
  const meta = WALL_KICK_TUNING_META[key];
  if (!meta) return;
  wallKickTuning[key] = THREE.MathUtils.clamp(value, meta.min, meta.max);
  try {
    localStorage.setItem(WALL_KICK_TUNING_SCHEMA_KEY, WALL_KICK_TUNING_SCHEMA);
    localStorage.setItem(WALL_KICK_TUNING_PREFIX + key, String(wallKickTuning[key]));
  } catch {
    // localStorage unavailable; keep the live value only.
  }
}

function restoreWallKickTuning(): void {
  try {
    if (localStorage.getItem(WALL_KICK_TUNING_SCHEMA_KEY) !== WALL_KICK_TUNING_SCHEMA) {
      for (const key of Object.keys(WALL_KICK_TUNING_META)) {
        localStorage.removeItem(WALL_KICK_TUNING_PREFIX + key);
      }
      localStorage.setItem(WALL_KICK_TUNING_SCHEMA_KEY, WALL_KICK_TUNING_SCHEMA);
      return;
    }
    for (const key of Object.keys(WALL_KICK_TUNING_META)) {
      const raw = localStorage.getItem(WALL_KICK_TUNING_PREFIX + key);
      if (raw === null) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) setWallKickTuning(key, value);
    }
  } catch {
    // localStorage unavailable; keep defaults.
  }
}

/** Dive-smash power vs how far the plunge fell: each metre of fall adds this
 * much power, which scales the shockwave radius, launch force, and how much
 * building it guts. A ground double-jump apex (~13 m) lands a modest hit; the
 * top of a skyscraper lands a monster. */
const DIVE_POWER_PER_M = 1 / 10;
const DIVE_POWER_BASE = 0.8;
const DIVE_POWER_MAX = 6;
/** A full mega overcharge held at launch multiplies the height power... */
const DIVE_MEGA_MULT = 1.6;
/** ...up to this hard ceiling (keeps downstream blast radii in their caps). */
const DIVE_POWER_CAP = 8;

/** Radius of the small spherical range the detached sword hand may float in
 * around its rest point at the player's side (the flourish effect clamps to
 * it, so twirls stay wide of the body without ever wandering off). */
export const HAND_RANGE = 0.7;

/**
 * A wall-kick facade plane at |x| = `plane`, spanning z ∈ [zMin, zMax]. `topAt`
 * gives the tower top at a z so a kick can't fire off a facade the feet have
 * already cleared. Scenarios register these; an empty set disables wall-kicks.
 */
export interface WallSurface {
  sign: number;
  plane: number;
  zMin: number;
  zMax: number;
  topAt?: (z: number) => number;
}

/**
 * The player: a blue capsule with a small fist sphere and a white box "sword".
 * The mesh's XZ position is synced from the physics body (physics rotation is
 * locked). The body yaw follows the movement heading; the sword rides its own
 * aim pivot that the mouse's radial angle sweeps around the body.
 */
export class Player {
  readonly group = new THREE.Group();
  readonly body: Body;
  readonly health = new Health(MAX_HEARTS, I_FRAMES);
  /** Halo-style regenerating shield in front of the hearts. Drains ~10 hits,
   * refills after ~3s clear of the agents, taking ~3s to top off. */
  readonly shield = new Shield(SHIELD_HITS, SHIELD_RECHARGE_DELAY, SHIELD_RECHARGE_TIME);

  /** World-space aim direction on the XZ plane (unit vector) — where the
   * sword points at rest and where attacks land. Body yaw lags behind it. */
  readonly facing = new THREE.Vector3(0, 0, 1);

  /** Yaw mount for the fist + sword: sweeps them around the body toward the
   * cursor's radial angle, independent of the body's own heading. */
  readonly aimPivot = new THREE.Group();

  /** Detached sword hand: one floating mount carrying the fist + sword pivot,
   * hovering beside the body Rayman-style. The flourish effect drifts it
   * inside a small sphere around {@link handRest} so twirls swing the blade
   * clear of the capsule; gameplay never reads it. */
  readonly handPivot = new THREE.Group();
  /** Rest position of the hand in aim-pivot space. */
  readonly handRest = new THREE.Vector3(0, PLAYER_HEIGHT * 0.55, 0.3);

  /** Pivot the sword swings around; combat/effects rotate this. */
  readonly swordPivot = new THREE.Group();
  readonly swordMesh: THREE.Mesh;

  /** The combat controller driving this player; set once during boot. Effects
   * (swing-animation, weapon-trail) read live swing state from it. */
  combat: Combat | null = null;

  private readonly moveAxis = new THREE.Vector2();
  private readonly aimAxis = new THREE.Vector2();
  private readonly moveDir = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private readonly camRight = new THREE.Vector3();
  private readonly pos = { x: 0, y: 0, z: 0 };
  /** Scratch physics velocity, read before we overwrite it for this frame. */
  private readonly bodyVel = { x: 0, y: 0, z: 0 };

  /** Current smoothed body yaw — drives the mesh rotation. */
  private yaw = 0;
  /** Current smoothed sword-aim yaw; facing is derived from this each frame. */
  private aimYaw = 0;
  /** Heading of the last movement input — the anchor the sword offsets around. */
  private baseYaw = 0;

  /** Self-integrated vertical velocity (m/s), fed to the body each frame. */
  private vy = 0;
  /** Jumps used since last touching ground (0 = grounded, up to MAX_JUMPS). */
  private jumps = 0;
  /** Set on jump, cleared on firm landing — survives bogus ground contacts mid-arc. */
  private airArc = false;
  /** True from the moment an air smash starts until the next landing. */
  private smashing = false;
  /** Whether the in-flight dive launched from a full mega overcharge. */
  private diveMega = false;
  /** This frame's ground state — refreshed at the end of update for attack release. */
  private groundedNow = false;
  /** Last update dt — used to re-test ground contact on attack release. */
  private lastDt = 0;
  /** Feet height the current dive launched from — the fall distance that its
   * impact power scales with. */
  private smashStartY = 0;

  /** Facade planes the player can wall-kick off (scenario-provided; empty = none). */
  private readonly wallSurfaces: WallSurface[] = [];
  /** Decaying horizontal velocity from a wall-kick (m/s). */
  private launchVX = 0;
  private launchVZ = 0;
  /** Counts down after a wall-kick so a single mash can't chain-stack them. */
  private wallKickCd = 0;
  /** Post-kick air-control suppression (s) so the launch clears the wall. */
  private wallKickLock = 0;
  /** Body y last frame — lets us detect a blocked descent (rooftop landing). */
  private prevY = PLAYER_HEIGHT / 2;

  /** Footprint the road exists over. Outside it the feet find no ground at
   * y=0, so the player falls into the void (gameplay then kills + restarts).
   * Null = infinite floor everywhere (default; non-corridor scenarios/tests). */
  private floorBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  constructor(
    private readonly physics: Physics,
    spawn: THREE.Vector2,
    private readonly bus: EventBus,
  ) {
    // Yaw-then-pitch order so the dive lean (rotation.x) tips forward ALONG the
    // facing yaw, not around a fixed world axis.
    this.group.rotation.order = "YXZ";
    this.body = physics.createCapsule({
      x: spawn.x,
      z: spawn.y,
      height: PLAYER_HEIGHT,
      radius: PLAYER_RADIUS,
      linearDamping: 10,
      category: Category.Player,
      mask: PLAYER_MASK,
      verticalMotion: true, // jumping needs the y axis unlocked
    });
    // Render-interpolate the capsule so fast sprints/jumps don't judder against
    // the 60 Hz fixed step (see Physics.getInterpolatedPosition). Gameplay reads
    // the true body position directly; only syncMesh + the follow camera use the
    // blended one.
    physics.enableInterpolation(this.body);

    // Body capsule.
    const bodyMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - 2 * PLAYER_RADIUS, 6, 12),
      standardNodeMaterial(0x4a90e2, 0.7),
    );
    bodyMesh.position.y = PLAYER_HEIGHT / 2;
    bodyMesh.castShadow = true;
    this.group.add(bodyMesh);

    // Detached hand mount on the aim pivot: the mouse sweeps it around the
    // body, and the flourish effect floats it inside its little sphere.
    this.handPivot.position.copy(this.handRest);
    this.group.add(this.aimPivot);
    this.aimPivot.add(this.handPivot);

    // Small "fist" sphere gripping the blade base; rides the hand mount so
    // fist and sword always travel together.
    const fist = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 12, 12),
      standardNodeMaterial(0x3a72b8, 0.6),
    );
    fist.position.set(0, 0, 0.25);
    fist.castShadow = true;
    this.handPivot.add(fist);

    // Morpheus lenses: rimless mirror-black ovals resting on the "face".
    const lensGeometry = new THREE.SphereGeometry(0.115, 16, 12);
    lensGeometry.scale(1, 0.68, 0.34);
    const lensMaterial = glossyLensMaterial();
    for (const side of [-1, 1]) {
      const lens = new THREE.Mesh(lensGeometry, lensMaterial);
      lens.position.set(side * 0.14, PLAYER_HEIGHT * 0.79, 0.44);
      lens.rotation.y = side * 0.22;
      this.group.add(lens);
    }

    // Sword on a pivot for swinging, mounted at the hand's origin. The blade
    // is a flattened diamond profile tapering to a point (4-segment cylinder,
    // squashed); the hilt — guard, wrapped grip, pommel — is a separate fixed
    // group so blade-length tuning stretches only the steel.
    const bladeGeometry = new THREE.CylinderGeometry(0.02, 0.11, 1.4, 4, 1);
    bladeGeometry.rotateX(Math.PI / 2); // axis → +Z, tip forward
    bladeGeometry.scale(1, 0.32, 1); // flatten into a blade cross-section
    this.swordMesh = new THREE.Mesh(bladeGeometry, standardNodeMaterial(0xe8ecf2, 0.35));
    this.swordMesh.position.set(0, 0, 0.5);
    this.swordMesh.castShadow = true;
    this.swordPivot.add(this.swordMesh);

    const hilt = new THREE.Group();
    const guard = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.07, 0.09),
      standardNodeMaterial(0x9aa2ad, 0.5),
    );
    guard.position.z = -0.24;
    guard.castShadow = true;
    const gripGeometry = new THREE.CylinderGeometry(0.045, 0.05, 0.3, 8);
    gripGeometry.rotateX(Math.PI / 2);
    const grip = new THREE.Mesh(gripGeometry, standardNodeMaterial(0x24262b, 0.9));
    grip.position.z = -0.42;
    const pommel = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 10, 10),
      standardNodeMaterial(0xb9c0cc, 0.4),
    );
    pommel.position.z = -0.6;
    hilt.add(guard, grip, pommel);
    this.swordPivot.add(hilt);
    this.handPivot.add(this.swordPivot);
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** True while the dive smash is in flight (drives the plunge flourish). */
  get diving(): boolean {
    return this.smashing;
  }

  /** True when the feet are on a walkable surface this frame (floor or roof). */
  get touchingGround(): boolean {
    return this.groundedNow;
  }

  /** True while in a jump arc since the last firm landing (release always dives). */
  get inAirArc(): boolean {
    return this.airArc;
  }

  /** Jumps spent since the last touchdown (2 while a double jump is live). */
  get jumpsUsed(): number {
    return this.jumps;
  }

  /**
   * Read input, drive velocity + body yaw + sword aim. Uses camera-relative
   * WASD. The body eases toward the movement heading; the mouse is a radial
   * dial around the viewport center — its angle sweeps the sword around the
   * body within a clamped cone, its distance from center ramps how hard the
   * blade commits to that angle. The right stick gets the full circle.
   */
  update(input: Input, camera: THREE.Camera, dt: number): void {
    this.lastDt = dt;
    // Camera basis on the ground plane (shared by movement + stick aim).
    camera.getWorldDirection(this.camDir);
    this.camDir.y = 0;
    this.camDir.normalize();
    this.camRight.crossVectors(this.camDir, UP).normalize();

    // Move axis polled once up front — the movement solve below reads it.
    input.moveAxis(this.moveAxis);

    // Vertical: we own the y velocity and hand it to the body. Ground (or a
    // rooftop) stops the descent, and a firm landing refills the jump count.
    this.body.getPosition(this.pos);
    this.body.getLinearVelocity(this.bodyVel);
    const bodyY = this.pos.y;
    const feetY = bodyY - PLAYER_HEIGHT / 2;
    const grounded = this.computeGrounded(bodyY, this.vy, dt, this.bodyVel.y);
    const onFloor = bodyY <= PLAYER_HEIGHT / 2 + GROUND_EPS;
    this.prevY = bodyY;
    // Cache this frame's ground state + feet height for combat / effects.
    this.groundedNow = grounded;
    if (this.wallKickCd > 0) this.wallKickCd = Math.max(0, this.wallKickCd - dt);
    if (this.wallKickLock > 0) this.wallKickLock = Math.max(0, this.wallKickLock - dt);

    if (grounded) {
      // Landing out of a dive smash is the impact frame — fire the shockwave.
      // Power grows with how far the plunge fell: the higher you started, the
      // bigger the blast, the harder the launch, the more building it guts.
      if (this.smashing) {
        const impactY = onFloor ? 0 : feetY;
        const fallHeight = Math.max(0, this.smashStartY - impactY);
        this.bus.emit("dive-impact", {
          origin: new THREE.Vector3(this.pos.x, impactY, this.pos.z),
          power: diveSmashPower(fallHeight, this.diveMega),
          mega: this.diveMega,
        });
      }
      // Only end the jump arc on a firm landing — a flaky ground contact mid-air
      // must not reset jumps and open a charged release into a spin.
      if (this.isFirmlyOnGround(bodyY, this.vy, dt)) {
        // Firm touchdown out of a jump arc gets a footfall thud. A dive smash
        // already owns its impact with `dive-impact` (a full boom), so exclude
        // it. `airArc` is set only by a real jump/wall-kick, so a plain walk
        // stays silent. Impact speed scales the thud.
        if (this.airArc && !this.smashing) {
          this.bus.emit("land", {
            speed: Math.max(-this.vy, Math.abs(this.bodyVel.y)),
          });
        }
        this.airArc = false;
        this.jumps = 0;
      }
      this.smashing = false;
      if (this.vy < 0) this.vy = 0;
    }

    // Jump / double jump / wall-kick. An airborne jump press near a facade
    // bounces off it (arcade wall-kick) and takes priority over the double
    // jump; otherwise it's a normal ground jump or double jump.
    if (input.consumeJump()) {
      if (
        !grounded &&
        !this.smashing &&
        this.wallKickCd <= 0 &&
        this.tryWallKick(feetY)
      ) {
        // Wall-kick handled inside tryWallKick.
      } else if (this.jumps < MAX_JUMPS && !this.smashing) {
        this.vy = JUMP_SPEED;
        this.jumps++;
        this.airArc = true;
      }
    }

    // Variable jump height: letting go of jump while still rising cuts the
    // ascent short so a tap is a short hop and only a held press floats to the
    // full apex. A charged double-jump release owns that same edge first: it is
    // the deliberate crush-down commit, not a height trim.
    const jumpReleased = input.consumeJumpRelease();
    if (
      jumpReleased &&
      !this.resolveChargeJumpReleaseDive() &&
      this.vy > 0 &&
      !this.smashing
    ) {
      this.vy *= JUMP_CUT;
    }

    // Absolute airborne attack rule: a fresh attack press while airborne dives
    // immediately. Holding a charge from the ground must still allow a jump;
    // that path spends the charge on a dive only when the button is released.
    this.resolveAirDiveIntent(input);

    if (!grounded) this.vy -= GRAVITY * dt;

    // Decay the horizontal pop from a wall-kick.
    if (this.launchVX !== 0 || this.launchVZ !== 0) {
      const k = Math.exp(-LAUNCH_DECAY * dt);
      this.launchVX *= k;
      this.launchVZ *= k;
      if (Math.abs(this.launchVX) < 0.05) this.launchVX = 0;
      if (Math.abs(this.launchVZ) < 0.05) this.launchVZ = 0;
    }

    // Movement solve. A dive commits to a forward lunge; a fresh wall-kick lets
    // its launch own the horizontal for a moment (so WASD held into the wall
    // can't cancel the push off it); otherwise camera-relative WASD plus any
    // decaying wall-kick pop. The y component always carries jump/gravity.
    const moveMag = this.moveAxis.length();
    if (this.smashing) {
      this.body.setLinearVelocity(this.facing.x * DIVE_SPEED, this.vy, this.facing.z * DIVE_SPEED);
      this.baseYaw = Math.atan2(this.facing.x, this.facing.z);
    } else if (moveMag > 0 && this.wallKickLock <= 0) {
      this.moveDir
        .set(0, 0, 0)
        .addScaledVector(this.camRight, this.moveAxis.x)
        .addScaledVector(this.camDir, this.moveAxis.y);
      if (this.moveDir.lengthSq() > 0) this.moveDir.normalize();
      // Analog sticks scale speed by how far they're pushed; keys are full tilt.
      const speed = MOVE_SPEED * Math.min(moveMag, 1) * (input.sprintHeld ? SPRINT_MULT : 1);
      this.body.setLinearVelocity(
        this.moveDir.x * speed + this.launchVX,
        this.vy,
        this.moveDir.z * speed + this.launchVZ,
      );
      // Movement heading is the anchor facing eases toward.
      this.baseYaw = Math.atan2(this.moveDir.x, this.moveDir.z);
    } else {
      this.body.setLinearVelocity(this.launchVX, this.vy, this.launchVZ);
    }

    // Committed stance: while the sword is charging or mid-spin the facing is
    // LOCKED. The camera crane winds/orbits during those states, which drags
    // the cursor's ground ray across the world every frame — chasing that
    // moving target made the body (and the wound-back blade with it) flicker
    // between angles instead of holding its pose.
    if (!this.combat?.charging && !this.combat?.spinning) {
      // Sword offset from the movement heading. Right stick: full circle at
      // full strength. Mouse: radial dial — the cursor's angle around the
      // viewport center picks the direction, its distance from center ramps
      // engagement, so a cursor resting near the middle keeps the blade forward.
      let offsetTarget = 0;
      const stick = input.aimStick(this.aimAxis);
      if (stick) {
        this.moveDir
          .set(0, 0, 0)
          .addScaledVector(this.camRight, stick.x)
          .addScaledVector(this.camDir, stick.y);
        if (this.moveDir.lengthSq() > 0.0004) {
          const stickYaw = Math.atan2(this.moveDir.x, this.moveDir.z);
          offsetTarget = wrapAngle(stickYaw - this.baseYaw);
        }
      } else {
        input.pointerRadial(this.aimAxis);
        const radius = this.aimAxis.length();
        if (radius > AIM_DEADZONE) {
          this.moveDir
            .set(0, 0, 0)
            .addScaledVector(this.camRight, this.aimAxis.x)
            .addScaledVector(this.camDir, this.aimAxis.y);
          const dialYaw = Math.atan2(this.moveDir.x, this.moveDir.z);
          const engagement = THREE.MathUtils.smoothstep(radius, AIM_DEADZONE, AIM_FULL_RADIUS);
          offsetTarget =
            THREE.MathUtils.clamp(wrapAngle(dialYaw - this.baseYaw), -SWORD_CONE, SWORD_CONE) *
            engagement;
        }
      }

      // Body chases the heading with a light lean toward the sword; the sword
      // chases the full offset faster, so wrist flicks read immediately.
      // Framerate-independent exponential lerps.
      const bodyTarget = this.baseYaw + offsetTarget * BODY_LEAN;
      const aimTarget = this.baseYaw + offsetTarget;
      this.yaw += wrapAngle(bodyTarget - this.yaw) * (1 - Math.exp(-TURN_RATE * dt));
      this.aimYaw += wrapAngle(aimTarget - this.aimYaw) * (1 - Math.exp(-SWORD_AIM_RATE * dt));
      this.facing.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
    }

    // Attack release is resolved last so dive velocity lands the same frame and
    // ground contact is re-tested with the final movement state.
    this.resolveAttackRelease(input);
  }

  /**
   * Register the facade planes the player can wall-kick off (scenario-provided).
   * Pass an empty array to disable wall-kicks (non-building scenarios).
   */
  setWallSurfaces(surfaces: readonly WallSurface[]): void {
    this.wallSurfaces.length = 0;
    this.wallSurfaces.push(...surfaces);
  }

  /**
   * Register the road footprint the player can stand on (scenario-provided).
   * Pass null to restore the default infinite floor (non-corridor scenarios).
   */
  setFloorBounds(
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
  ): void {
    this.floorBounds = bounds;
  }

  /** Whether the current XZ position sits over solid road (not the void). */
  private isOverFloor(): boolean {
    const b = this.floorBounds;
    if (!b) return true;
    return (
      this.pos.x >= b.minX &&
      this.pos.x <= b.maxX &&
      this.pos.z >= b.minZ &&
      this.pos.z <= b.maxZ
    );
  }

  /**
   * A fresh attack press while airborne starts the dive on that frame. A held
   * charge that began on the ground does not count as a fresh press; releasing
   * it in the air is handled by {@link resolveAttackRelease}.
   */
  private resolveAirDiveIntent(input: Input): void {
    if (this.smashing) return;
    if (!input.attackPressQueued) return;

    this.body.getPosition(this.pos);
    const bodyY = this.pos.y;
    const feetY = bodyY - PLAYER_HEIGHT / 2;
    this.body.getLinearVelocity(this.bodyVel);
    if (this.canGroundSpin(bodyY, this.vy, this.lastDt, this.bodyVel.y)) return;

    if (input.attackPressQueued) input.consumeAttack();
    const charge = this.combat?.chargeLevel ?? 0;
    const mega = !!this.combat?.megaArmed && charge >= MEGA_DIVE_LEVEL;
    this.startSmash(feetY, mega);
    this.combat?.cancelForDive();
  }

  /**
   * While a sword charge is held through the double jump, releasing jump is the
   * air-smash commit. The first jump release still belongs to variable-height
   * jumping so a charged hop does not instantly cancel itself into a dive.
   */
  private resolveChargeJumpReleaseDive(): boolean {
    if (this.smashing) return false;
    if (!this.combat?.charging) return false;
    if (this.jumps < MAX_JUMPS) return false;

    this.body.getPosition(this.pos);
    const bodyY = this.pos.y;
    const feetY = bodyY - PLAYER_HEIGHT / 2;
    this.body.getLinearVelocity(this.bodyVel);
    if (this.canGroundSpin(bodyY, this.vy, this.lastDt, this.bodyVel.y)) return false;

    const charge = this.combat.chargeLevel;
    const mega = this.combat.megaArmed && charge >= MEGA_DIVE_LEVEL;
    this.startSmash(feetY, mega);
    this.combat.cancelForDive();
    return true;
  }

  /**
   * Attack button released. Absolute rule: dive whenever not firmly on the
   * ground (including the whole jump arc after leaving the floor). Spin only
   * when standing still on a surface with jumps reset — charge level, mega
   * armed, and where charging started do not matter.
   */
  private resolveAttackRelease(input: Input): void {
    if (!input.consumeAttackRelease()) return;
    if (this.smashing) {
      this.combat?.cancelCharge();
      return;
    }

    this.body.getPosition(this.pos);
    const bodyY = this.pos.y;
    const feetY = bodyY - PLAYER_HEIGHT / 2;
    this.body.getLinearVelocity(this.bodyVel);
    const spinAllowed = this.canGroundSpin(bodyY, this.vy, this.lastDt, this.bodyVel.y);
    this.groundedNow = spinAllowed;

    if (!spinAllowed) {
      const charge = this.combat?.chargeLevel ?? 0;
      const mega = !!this.combat?.megaArmed && charge >= MEGA_DIVE_LEVEL;
      this.startSmash(feetY, mega);
      this.combat?.cancelForDive();
      return;
    }

    this.combat?.release(this);
  }

  /** True when feet are on the floor or a rooftop ledge this frame. */
  private computeGrounded(
    bodyY: number,
    vy: number,
    dt: number,
    physicalVy = vy,
  ): boolean {
    // The y=0 road only holds you up where there's actually road. Off its edge
    // the feet find nothing and you keep falling. Rooftop landings still ground
    // via the physics-contact `blocked` branch below, so this only gates the
    // flat street plane, not the buildings.
    const onFloor = bodyY <= PLAYER_HEIGHT / 2 + GROUND_EPS && this.isOverFloor();
    const wantedDrop = Math.max(0, -vy) * dt;
    const actualDrop = this.prevY - bodyY;
    const blocked =
      vy < -1 &&
      physicalVy > -0.2 &&
      actualDrop >= 0 &&
      actualDrop < wantedDrop * 0.4;
    return (onFloor || blocked) && vy <= 0.01;
  }

  /** Standing still on a walkable surface — the only state that may spin. */
  private isFirmlyOnGround(bodyY: number, vy: number, dt: number, physicalVy = vy): boolean {
    if (Math.abs(vy) > 0.15) return false;
    return this.computeGrounded(bodyY, vy, dt, physicalVy);
  }

  /** Ground spin is allowed only from a settled, non-jump state. */
  private canGroundSpin(bodyY: number, vy: number, dt: number, physicalVy = vy): boolean {
    return !this.airArc && this.jumps === 0 && this.isFirmlyOnGround(bodyY, vy, dt, physicalVy);
  }

  /** Commit to a downward dive smash from the current airborne position. */
  private startSmash(feetY: number, mega: boolean): void {
    this.airArc = true;
    this.groundedNow = false;
    this.smashing = true;
    this.vy = -SMASH_SPEED * (mega ? MEGA_SMASH_MULT : 1);
    this.smashStartY = feetY;
    this.diveMega = mega;
    this.body.setLinearVelocity(this.facing.x * DIVE_SPEED, this.vy, this.facing.z * DIVE_SPEED);
    this.bus.emit("dive-start", { mega });
  }

  /**
   * Closest wall-kick facade within `range` of (x,z) at the given feet height
   * that the feet haven't already cleared the roof of, or null if none reach.
   */
  private nearestWall(
    feetY: number,
    x: number,
    z: number,
    range: number,
  ): { sign: number; plane: number } | null {
    let best = Infinity;
    let found: { sign: number; plane: number } | null = null;
    for (const s of this.wallSurfaces) {
      if (z < s.zMin || z > s.zMax) continue;
      const d = Math.abs(s.sign * s.plane - x);
      if (d > range || d >= best) continue;
      const top = s.topAt ? s.topAt(z) : Infinity;
      if (feetY >= top - 0.3) continue; // above the roof — no wall to kick
      best = d;
      found = { sign: s.sign, plane: s.plane };
    }
    return found;
  }

  /**
   * Arcade wall-kick: bounce off a nearby facade like a ball. The horizontal
   * approach is reflected across the wall — the component driving into the wall
   * flips and boosts out (never below the tunable `out` floor), while some of
   * the along-wall drift carries through so the exit angle tracks the entry.
   * Pops up by the tunable `up`, and RESETS the jump count so a full double
   * jump is available after the kick. The sword charge is untouched, so a
   * charged kick can flow into a double jump and a charged smash back down.
   * Returns false (letting a normal jump run) when no wall is close enough.
   */
  private tryWallKick(feetY: number): boolean {
    const range = PLAYER_RADIUS + wallKickTuning.reach;
    const wall = this.nearestWall(feetY, this.pos.x, this.pos.z, range);
    if (!wall) return false;

    // Outward normal points off the wall face into the play area.
    const nX = -wall.sign;
    // bodyVel is this frame's pre-solve velocity — the approach into the wall.
    const approach = this.bodyVel.x * nX; // < 0 while moving toward the wall
    const outSpeed = Math.max(wallKickTuning.out, Math.abs(approach) * WALL_KICK_BOUNCE);
    this.launchVX = nX * outSpeed;
    this.launchVZ = this.bodyVel.z * WALL_KICK_TANGENT;

    this.vy = wallKickTuning.up;
    this.jumps = 0; // full double jump restored after the kick
    this.airArc = true;
    this.wallKickCd = WALL_KICK_COOLDOWN;
    this.wallKickLock = WALL_KICK_LOCK;
    this.emitWallRipple(wall.sign, wall.plane, feetY);
    return true;
  }

  /** Fire a subtle facade ripple from the point a wall-kick pushed off. */
  private emitWallRipple(sign: number, plane: number, feetY: number): void {
    this.bus.emit("wall-jump", {
      origin: new THREE.Vector3(sign * plane, feetY + WALL_RIPPLE_Y, this.pos.z),
      speed: WALL_RIPPLE_SPEED,
    });
  }

  /**
   * Scale the blade length (panel-tunable). The hilt end stays planted in the
   * fist; only the reach grows. Trail sampling picks the change up for free —
   * its tip point is in blade-local space, so the world matrix scales it.
   */
  setSwordLength(mult: number): void {
    this.swordMesh.scale.z = mult;
    // Blade geometry spans z ∈ [-0.7, 0.7]; keep the rear edge at -0.2.
    this.swordMesh.position.z = -0.2 + 0.7 * mult;
  }

  /** Sync mesh transform from the physics body + yaws. Call after physics.
   * The aim pivot carries whatever part of the aim the body hasn't leaned
   * into, so the sword's rest pose always points exactly along `facing`. */
  syncMesh(): void {
    // Presentation reads the interpolated position so the mesh (and the camera
    // that follows it) glides between fixed steps instead of snapping per frame.
    this.physics.getInterpolatedPosition(this.body, this.pos);
    // Body y is the capsule center; at rest it sits at PLAYER_HEIGHT/2, which
    // maps to a group at ground level (y=0). Offset by that so a jump lifts it.
    this.group.position.set(this.pos.x, this.pos.y - PLAYER_HEIGHT / 2, this.pos.z);
    this.group.rotation.y = this.yaw;
    // Dive smash: pitch the whole body head-down into the plunge; otherwise upright.
    this.group.rotation.x = this.smashing ? DIVE_BODY_PITCH : 0;
    this.aimPivot.rotation.y = wrapAngle(this.aimYaw - this.yaw);
    // Blade thrust forward-down during the dive (pitch only — the swing
    // animation owns the pivot's yaw, so the two don't fight). Reset otherwise.
    this.swordPivot.rotation.x = this.smashing ? DIVE_SWORD_X : 0;
  }

  respawn(spawn: THREE.Vector2): void {
    this.body.setPosition(spawn.x, PLAYER_HEIGHT / 2, spawn.y);
    this.body.setLinearVelocity(0, 0, 0);
    // Collapse the interpolation snapshots onto the spawn so the first rendered
    // frame doesn't blend a streak from wherever the body just teleported from.
    this.physics.resetInterpolation(this.body);
    this.vy = 0;
    this.jumps = 0;
    this.airArc = false;
    this.smashing = false;
    this.launchVX = 0;
    this.launchVZ = 0;
    this.wallKickCd = 0;
    this.wallKickLock = 0;
    this.smashStartY = 0;
    this.prevY = PLAYER_HEIGHT / 2;
    this.health.reset();
    this.shield.reset();
  }
}

/** Wrap an angle to (-π, π] so lerps take the short way around. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Dive-smash power from the fall distance. A short hop lands a modest hit; the
 * top of a skyscraper lands a monster. A full mega overcharge multiplies it,
 * both clamped so downstream blast radii stay inside their caps.
 */
function diveSmashPower(fallHeight: number, mega: boolean): number {
  const base = Math.min(DIVE_POWER_MAX, DIVE_POWER_BASE + fallHeight * DIVE_POWER_PER_M);
  return mega ? Math.min(DIVE_POWER_CAP, base * DIVE_MEGA_MULT) : base;
}
