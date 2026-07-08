# Fabled Revolutions

**[Play the deployed version →](https://fabled-revolutions.vercel.app/)**

> A top-down melee combat sandbox where every "game juice" effect can be toggled
> on and off independently — so you can *feel* exactly how much each one adds.

![gameplay placeholder](docs/hero.gif)

<!-- Replace docs/hero.gif with a capture of the arena with all effects on. -->

Built with **Three.js** for rendering and **[box3d.js]** (WASM bindings for Erin
Catto's [box3d]) for real rigid-body physics. No art assets, no gameplay
frameworks — just a tight loop, a typed event bus, and ten small effect modules.

[box3d.js]: https://www.npmjs.com/package/box3d.js
[box3d]: https://box3d.org/

---

## What & why

Great melee combat *feels* good long before it looks good, and almost all of
that feel comes from a stack of tiny, individually-cheap effects layered on top
of the same underlying hit: a screen-shake here, a freeze-frame there, a spark
burst, a squash. Individually each is nearly invisible. Together they're the
difference between mush and crunch.

Fabled Revolutions makes that stack **legible**. The core game (move, aim, swing, take
damage) is always running and fully playable with *zero* effects enabled — it
just feels flat. Every juice effect is an isolated, toggleable module, so you can
flip one on at a time and feel precisely what it contributes.

This is a hands-on companion to André Cardoso's ([@andre_mc])
[hit-feedback breakdown], built in response to a [SketchpunkLabs request] that
quoted a [Unity VFX breakdown]. It ports the same ideas to an open Three.js +
box3d stack.

[@andre_mc]: https://x.com/andre_mc
[hit-feedback breakdown]: https://x.com/andre_mc/status/1975312383674613851
[SketchpunkLabs request]: https://x.com/SketchpunkLabs/status/2074192874351067616
[Unity VFX breakdown]: https://x.com/unity3dvfx/status/2073703781410250936

## Quick start

```sh
npm install
npm run dev      # vite dev server
npm run build    # type-check + production build to dist/
```

Open the printed local URL. The right-hand panel picks the scenario and toggles
each effect live; `All on` / `All off` for quick A/B comparisons. Toggle state
persists in localStorage.

## Controls

| Action | Keyboard / mouse | Gamepad (standard mapping) |
| --- | --- | --- |
| Move | WASD / arrows | Left stick (analog speed) |
| Aim | Mouse | Right stick |
| Attack | Left click | RT · hold to charge |
| Sprint | Ctrl (hold) | LB / RB / LT |
| Info / pause | Esc | Start |
| Effects panel | Shift | Select |
| Camera mode | C | — |
| Immersive HUD | I | — |

The bottom-left legend follows whichever device you used last, and each row
lights up while its input is engaged. Attacks buffer briefly, so mashing chains
swings back-to-back (~4 swings/sec).

## The effects

| Effect | Group | What it adds | Source |
| --- | --- | --- | --- |
| Swing Animation | Attack | Anticipation + follow-through easing on the sword arc (off = flat linear sweep) | `src/effects/swingAnimation.ts` |
| Weapon Trail | Attack | Additive ribbon following the sword tip, fading out | `src/effects/weaponTrail.ts` |
| Hit Particles | Reaction | Spark burst at the impact point; expanding ring flash on kill | `src/effects/hitParticles.ts` |
| Enemy Flash | Reaction | Hurt enemy flashes white/emissive for ~100 ms | `src/effects/enemyFlash.ts` |
| Knockback | Reaction | Physics impulse away from the player; corpses unlock rotation and tumble on kill | `src/effects/knockback.ts` |
| Enemy Squash | Reaction | Squash & stretch scale punch on hurt; swell-pop on death | `src/effects/enemySquash.ts` |
| Hit Stop | Camera | Freezes game time ~70 ms on hit, ~140 ms on a killing blow | `src/effects/hitStop.ts` |
| Camera Shake | Camera | Trauma-based positional + roll noise shake, scaled by event weight | `src/effects/cameraShake.ts` |
| UI Feedback | UI | Hearts pulse, enemy bars shake, red vignette on player damage | `src/effects/uiFeedback.ts` |
| Sound | Audio | Procedural WebAudio SFX: swing whoosh, hit thock, kill boom, hurt blip | `src/effects/sound.ts` |

Every effect can be disabled mid-game with no residue: trails clear, time scale
restores, scales spring back, emissives reset.

## Scenarios

- **Arena** — a ring of enemies that respawn as they fall. The scene from the
  original breakdown video.
- **Crate Yard** — stacks of dynamic crates; knocked-back corpses plow through
  them, showing the physics is real.
- **Horde** — escalating waves of faster, weaker enemies spawning from the arena
  edges (default).

## Architecture

```
src/
  core/      physics (box3d wrapper, fixed 60 Hz step), event bus, clock
             (timeScale), follow camera (shake write-points), input (kbm+pad)
  game/      player, enemy, combat (swing timing + sector hits), health
  effects/   one module per juice effect + data-driven manager
  scenarios/ arena, crate yard, horde + shared environment helpers
  ui/        toggle panel, HUD (hearts/bars/vignette), controls legend, styles
```

Gameplay code **emits events** (`attack-hit`, `enemy-death`, `player-hurt`, …)
and never knows about effects. Each effect subscribes to the bus in `init` and
owns its whole lifecycle. Combat timing runs on *unscaled* time so hit-stop
can't freeze the swing that triggered it; enemy AI and physics run on *scaled*
time so they do freeze.

## Add your own effect

1. Create `src/effects/myEffect.ts` extending `BaseEffect` with a unique `id`,
   `label`, `description`, and `group`.
2. Subscribe to events in `init(ctx)`; animate in `update(dt)`.
3. Make `setEnabled(false)` clean up anything visible.
4. Register it in the list in `src/effects/manager.ts`.

The panel row, persistence, and update loop all come for free.

## Credits

- [André Cardoso][@andre_mc] — the [hit-feedback breakdown][hit-feedback breakdown] this reproduces.
- SketchpunkLabs — [the request that sparked it][SketchpunkLabs request].
- [Isaac Mason](https://github.com/isaac-mason) — box3d.js WASM bindings;
  Erin Catto — box3d itself.

## License

[MIT](LICENSE)
