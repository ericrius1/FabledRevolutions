import type { InputActivity, InputSource } from "../core/input";

type Action = "move" | "look" | "attack";

interface RowLabels {
  title: string;
  value: string;
}

/** Label sets per control scheme. Swapped live when the source changes. */
const LABELS: Record<InputSource, Record<Action, RowLabels>> = {
  kbm: {
    move: { title: "MOVE", value: "WASD" },
    look: { title: "LOOK", value: "MOUSE" },
    attack: { title: "ATTACK", value: "CLICK · HOLD TO CHARGE" },
  },
  gamepad: {
    move: { title: "MOVE", value: "L STICK" },
    look: { title: "AIM", value: "R STICK" },
    attack: { title: "ATTACK", value: "RT · HOLD TO CHARGE" },
  },
};

const ACTIONS: Action[] = ["move", "look", "attack"];

const HOTKEY_ROWS: { title: string; value: string }[] = [
  { title: "CAMERA", value: "C · ORBIT · DOLLY · PAN" },
  { title: "PAUSE", value: "P" },
  { title: "IMMERSIVE", value: "I" },
  { title: "PANEL", value: "/" },
];

/**
 * Bottom-left controls legend. Reflects the active control scheme (keyboard/
 * mouse vs gamepad) and highlights each row while its input is engaged, fading
 * back out on release (the fade itself is a CSS transition).
 */
export class Legend {
  readonly root: HTMLDivElement;
  private readonly rows = new Map<
    Action,
    { row: HTMLDivElement; title: HTMLSpanElement; value: HTMLSpanElement }
  >();
  private source: InputSource | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "legend";
    for (const action of ACTIONS) {
      const row = document.createElement("div");
      row.className = "row";
      const title = document.createElement("span");
      title.className = "key";
      const value = document.createElement("span");
      value.className = "val";
      row.append(title, value);
      this.root.appendChild(row);
      this.rows.set(action, { row, title, value });
    }

    const hotkeys = document.createElement("div");
    hotkeys.className = "legend-hotkeys";
    for (const { title, value } of HOTKEY_ROWS) {
      const row = document.createElement("div");
      row.className =
        title === "PANEL" ? "row hotkey panel-hint" : "row hotkey";
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = title;
      const val = document.createElement("span");
      val.className = "val";
      if (title === "PANEL") {
        const cap = document.createElement("kbd");
        cap.className = "panel-keycap";
        cap.textContent = value;
        val.appendChild(cap);
      } else {
        val.textContent = value;
      }
      row.append(key, val);
      hotkeys.appendChild(row);
    }
    this.root.appendChild(hotkeys);

    this.applyLabels("kbm");
  }

  private applyLabels(source: InputSource): void {
    this.source = source;
    for (const action of ACTIONS) {
      const els = this.rows.get(action)!;
      const labels = LABELS[source][action];
      els.title.textContent = labels.title;
      els.value.textContent = labels.value;
    }
  }

  /** Call each frame with the live source + per-action activity. */
  update(source: InputSource, activity: InputActivity, cameraMode = false): void {
    if (source !== this.source) this.applyLabels(source);
    for (const action of ACTIONS) {
      this.rows.get(action)!.row.classList.toggle("active", activity[action]);
    }
    if (cameraMode) {
      const look = this.rows.get("look")!;
      look.title.textContent = "CAMERA";
      look.value.textContent = "LMB ORBIT · RMB PAN · SCROLL DOLLY";
    } else if (this.source) {
      const labels = LABELS[this.source].look;
      const look = this.rows.get("look")!;
      look.title.textContent = labels.title;
      look.value.textContent = labels.value;
    }
    this.root.classList.toggle("camera-mode", cameraMode);
  }
}
