import type { SoundEffect } from "../effects/sound";

/** Compact bottom-left SFX volume slider. */
export class SfxVolume {
  readonly root: HTMLDivElement;

  constructor(sound: SoundEffect) {
    this.root = document.createElement("div");
    this.root.className = "sfx-volume";

    const label = document.createElement("span");
    label.className = "sfx-volume-label";
    label.textContent = "SFX";

    const input = document.createElement("input");
    input.type = "range";
    input.className = "sfx-volume-slider";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.value = String(Math.round(sound.getVolume() * 100));
    input.setAttribute("aria-label", "Sound effects volume");

    const value = document.createElement("span");
    value.className = "sfx-volume-value";
    value.textContent = `${input.value}%`;

    input.addEventListener("input", () => {
      const pct = Number(input.value);
      sound.setVolume(pct / 100);
      value.textContent = `${pct}%`;
    });

    this.root.append(label, input, value);
  }
}
