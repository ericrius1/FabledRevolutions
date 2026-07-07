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
    input.id = "sfx-volume-range";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.value = String(Math.round(sound.getVolume() * 100));
    input.setAttribute("aria-label", "Sound effects volume");

    const value = document.createElement("output");
    value.className = "sfx-volume-value";
    value.setAttribute("for", input.id);

    const syncSlider = (): void => {
      const pct = Number(input.value);
      input.style.setProperty("--sfx-pct", `${pct}%`);
      sound.setVolume(pct / 100);
      value.textContent = `${pct}%`;
    };
    syncSlider();

    input.addEventListener("input", syncSlider);

    this.root.append(label, input, value);
  }
}
