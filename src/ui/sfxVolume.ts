import type { SoundEffect } from "../effects/sound";

// Monochrome speaker glyphs (inherit the panel's green via currentColor).
const ICON_ON = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M1.5 6h3l4-3v10l-4-3h-3z" fill="currentColor"/>
  <path d="M10.5 5.2a4 4 0 0 1 0 5.6M12.4 3.6a6.5 6.5 0 0 1 0 8.8"
    fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;
const ICON_OFF = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M1.5 6h3l4-3v10l-4-3h-3z" fill="currentColor"/>
  <path d="M11 5.5l4 5M15 5.5l-4 5"
    fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;

/** Compact bottom-left SFX volume slider with a mute toggle. */
export class SfxVolume {
  readonly root: HTMLDivElement;

  constructor(sound: SoundEffect) {
    this.root = document.createElement("div");
    this.root.className = "sfx-volume";

    // Remembers the level to restore when un-muting from a click.
    let lastNonZero = Math.max(0.02, sound.getVolume()) * 100;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "sfx-volume-toggle";

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

    const render = (): void => {
      const pct = Number(input.value);
      input.style.setProperty("--sfx-pct", `${pct}%`);
      sound.setVolume(pct / 100);
      value.textContent = `${pct}%`;
      const muted = pct === 0;
      toggle.innerHTML = muted ? ICON_OFF : ICON_ON;
      toggle.classList.toggle("is-muted", muted);
      toggle.setAttribute("aria-pressed", String(muted));
      toggle.setAttribute("aria-label", muted ? "Unmute sound effects" : "Mute sound effects");
      toggle.title = muted ? "Unmute" : "Mute";
    };

    input.addEventListener("input", () => {
      if (Number(input.value) > 0) lastNonZero = Number(input.value);
      render();
    });

    toggle.addEventListener("click", () => {
      if (Number(input.value) > 0) {
        lastNonZero = Number(input.value);
        input.value = "0";
      } else {
        input.value = String(Math.round(lastNonZero));
      }
      render();
    });

    render();

    this.root.append(toggle, label, input, value);
  }
}
