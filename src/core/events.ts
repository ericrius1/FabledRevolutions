import type * as THREE from "three/webgpu";
import type { Enemy } from "../game/enemy";
import type { ShockFrontSnapshot } from "../effects/groundShockwave";

/**
 * Payload shapes for every game event. Effects (M2) subscribe to these to add
 * juice without touching gameplay code. Keep payloads plain data + object refs.
 */
export interface GameEventMap {
  "attack-start": { origin: THREE.Vector3; facing: THREE.Vector3 };
  /** Fired at the swing's contact frame, before hit resolution. */
  "attack-swing-contact": { origin: THREE.Vector3; facing: THREE.Vector3 };
  "attack-hit": {
    enemy: Enemy;
    point: THREE.Vector3;
    dir: THREE.Vector3;
    killed: boolean;
    /** Knockback multiplier: 1 = normal swing, higher for charged/mega spins. */
    power: number;
  };
  "enemy-hurt": { enemy: Enemy; point: THREE.Vector3; dir: THREE.Vector3; power: number };
  "enemy-death": { enemy: Enemy; point: THREE.Vector3; dir: THREE.Vector3; power: number };
  "player-hurt": { point: THREE.Vector3; dir: THREE.Vector3 };
  /** An enemy touch was soaked by the shield (hearts untouched). */
  "player-shielded": { point: THREE.Vector3; dir: THREE.Vector3 };
  "player-death": Record<string, never>;

  /** A ranged agent (rail sniper / ground skirmisher) hurled a knife. `origin`
   * is where it launches from (shoulder height, up on the rail for perched
   * throwers); the knife system leads the live player from there. */
  "enemy-throw": { origin: THREE.Vector3 };

  // ---- Charge / spin attack ----
  /** The sword began charging (attack held past the hold threshold). */
  "charge-start": Record<string, never>;
  /** Charge crossed a full level; mega=true when the overcharge (level 2) fills. */
  "charge-full": { mega: boolean };
  /** Attack released before the minimum charge — no spin happened. */
  "charge-cancel": Record<string, never>;
  /** Charged release: the Zelda-style spin begins. */
  "spin-attack": { origin: THREE.Vector3; power: number; mega: boolean; range: number };
  /** The release spin finished its revolutions (fires for mega spins too). */
  "spin-end": { mega: boolean };

  // ---- Air dive smash ----
  /** Player kicked off the downward dive smash; the world eases into slow-mo.
   * `mega` when a full overcharge is held at launch (the extra-special dive). */
  "dive-start": { mega: boolean };
  /** The dive slammed into the ground. `power` scales the shockwave; `origin`
   * is the impact point (player position at y≈0). */
  "dive-impact": { origin: THREE.Vector3; power: number; mega: boolean };
  /** Player wall-kicked off a building facade. A subtle ripple radiates from
   * `origin` on the wall; `speed` scales its reach. */
  "wall-jump": { origin: THREE.Vector3; speed: number };
  /** The max-charge dive slammed home — the ground-smash spectacle: impact
   * bullet time plus a mega lightning storm in its own warmer molten palette.
   * `power` scales the blast, `origin` is the impact point. Fires alongside the
   * mega `dive-impact`, the beat AFTER it (so effects can key on it directly). */
  "mega-smash": { origin: THREE.Vector3; power: number };

  // ---- Mega mode ----
  /** Enough kills landed inside the burst window; overcharge is unlocked. */
  "mega-armed": Record<string, never>;
  /** Mega charge engaged: world slow-mo starts ramping in. */
  "mega-begin": Record<string, never>;
  /** The mega spin released: time snaps back, the world detonates. */
  "mega-release": { origin: THREE.Vector3 };
  /** Aftermath (lightning / post grade) finished. */
  "mega-end": Record<string, never>;
  /** Cosmetic lightning bolt touched down (aftermath); used for thunder SFX. */
  "mega-lightning": { point: THREE.Vector3 };

  // ---- Scenario staging ----
  /** One or more staged enemies finished a high fly-in and hit formation.
   * `point` is the average landing position for the frame. */
  "enemy-arrival-impact": { point: THREE.Vector3; count: number; dropHeight: number };

  // ---- Travelling ground shockwave ----
  /** Fired each frame per live wave front, AFTER the wave advanced: the band
   * (prevFront, front] is what the crest swept this frame. Scenarios use it to
   * knock building cubes loose exactly when the ripple reaches the facade.
   * Payload is a reused scratch object — consume synchronously, never hold. */
  "shock-front": ShockFrontSnapshot;
}

export type GameEventName = keyof GameEventMap;
export type GameEventHandler<K extends GameEventName> = (
  payload: GameEventMap[K],
) => void;

/** Tiny typed pub/sub. No wildcards, no async — deliberately minimal.
 *
 * Internally the handler sets are stored untyped (per-event-name Sets keyed by
 * string) because a homogeneous mapped type can't be soundly indexed by a
 * generic `K`. The public method signatures below are the real type contract. */
export class EventBus {
  private readonly handlers = new Map<GameEventName, Set<(payload: never) => void>>();

  on<K extends GameEventName>(name: K, handler: GameEventHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (payload: never) => void);
    return () => this.off(name, handler);
  }

  off<K extends GameEventName>(name: K, handler: GameEventHandler<K>): void {
    this.handlers.get(name)?.delete(handler as (payload: never) => void);
  }

  emit<K extends GameEventName>(name: K, payload: GameEventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    // Copy so handlers may unsubscribe during dispatch.
    for (const handler of [...set]) (handler as GameEventHandler<K>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
