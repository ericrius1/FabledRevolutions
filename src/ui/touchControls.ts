import type { Input } from "../core/input";

/**
 * Twin-stick mobile pad: left stick moves, right stick aims, and the action
 * cluster handles attack (hold to charge), jump, and boost. Only mounts when
 * the device looks touch-primary so desktop stays keyboard/mouse clean.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private readonly input: Input;
  private readonly moveStick: Stick;
  private readonly aimStick: Stick;
  private visible = false;

  constructor(input: Input) {
    this.input = input;
    this.root = document.createElement("div");
    this.root.className = "touch-pad";
    this.root.setAttribute("aria-hidden", "true");

    const left = document.createElement("div");
    left.className = "touch-zone touch-zone-left";
    this.moveStick = new Stick(left, "MOVE", (x, y) => {
      this.input.setTouchMove(x, y);
    });

    const right = document.createElement("div");
    right.className = "touch-zone touch-zone-right";

    const actions = document.createElement("div");
    actions.className = "touch-actions";

    const attack = makeButton("ATTACK", "touch-btn touch-btn-attack");
    const jump = makeButton("JUMP", "touch-btn touch-btn-jump");
    const boost = makeButton("BOOST", "touch-btn touch-btn-boost");

    bindHold(attack, (down) => this.input.setTouchAttack(down));
    bindPress(jump, () => this.input.pulseTouchJump(), () => this.input.releaseTouchJump());
    bindHold(boost, (down) => this.input.setTouchBoost(down));

    actions.append(boost, jump, attack);
    right.appendChild(actions);
    this.aimStick = new Stick(right, "AIM", (x, y) => {
      this.input.setTouchAim(x, y);
    });

    this.root.append(left, right);

    // Eat all pointer traffic so the canvas underneath never sees it as an attack.
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());

    this.syncVisibility();
    window.addEventListener("resize", this.syncVisibility);
  }

  private syncVisibility = (): void => {
    const show = shouldShowTouchPad();
    if (show === this.visible) return;
    this.visible = show;
    this.root.classList.toggle("is-visible", show);
    this.root.setAttribute("aria-hidden", String(!show));
    document.body.classList.toggle("touch-controls", show);
    this.input.setTouchEnabled(show);
    if (!show) {
      this.moveStick.reset();
      this.aimStick.reset();
      this.input.clearTouch();
    }
  };

  dispose(): void {
    window.removeEventListener("resize", this.syncVisibility);
    this.moveStick.dispose();
    this.aimStick.dispose();
    this.input.setTouchEnabled(false);
    this.input.clearTouch();
    this.root.remove();
  }
}

/** Coarse pointer + no hover ≈ phone/tablet. Narrow desktop stays mouse. */
function shouldShowTouchPad(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const noHover = window.matchMedia("(hover: none)").matches;
  const touchPoints = navigator.maxTouchPoints > 0;
  return (coarse || noHover) && touchPoints;
}

function makeButton(label: string, className: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("aria-label", label);
  const ring = document.createElement("span");
  ring.className = "touch-btn-ring";
  const text = document.createElement("span");
  text.className = "touch-btn-label";
  text.textContent = label;
  btn.append(ring, text);
  return btn;
}

function bindHold(btn: HTMLButtonElement, set: (down: boolean) => void): void {
  const down = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.add("is-active");
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      // optional
    }
    set(true);
  };
  const up = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.remove("is-active");
    set(false);
  };
  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  btn.addEventListener("lostpointercapture", () => {
    btn.classList.remove("is-active");
    set(false);
  });
}

function bindPress(
  btn: HTMLButtonElement,
  onDown: () => void,
  onUp: () => void,
): void {
  const down = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.add("is-active");
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      // optional
    }
    onDown();
  };
  const up = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.remove("is-active");
    onUp();
  };
  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  btn.addEventListener("lostpointercapture", () => {
    btn.classList.remove("is-active");
    onUp();
  });
}

/** Floating virtual stick: drag within a zone, spring back on release. */
class Stick {
  readonly root: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly onChange: (x: number, y: number) => void;
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private readonly radius: number;

  constructor(
    zone: HTMLElement,
    label: string,
    onChange: (x: number, y: number) => void,
    radius = 52,
  ) {
    this.onChange = onChange;
    this.radius = radius;
    this.root = document.createElement("div");
    this.root.className = "touch-stick";
    this.root.dataset.label = label;

    this.base = document.createElement("div");
    this.base.className = "touch-stick-base";
    this.knob = document.createElement("div");
    this.knob.className = "touch-stick-knob";
    const tag = document.createElement("span");
    tag.className = "touch-stick-tag";
    tag.textContent = label;
    this.base.append(this.knob, tag);
    this.root.appendChild(this.base);
    zone.appendChild(this.root);

    zone.addEventListener("pointerdown", this.onPointerDown);
    zone.addEventListener("pointermove", this.onPointerMove);
    zone.addEventListener("pointerup", this.onPointerUp);
    zone.addEventListener("pointercancel", this.onPointerUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Action buttons sit inside the right zone — ignore those presses.
    if ((e.target as HTMLElement).closest(".touch-btn")) return;
    if (this.pointerId !== null) return;
    e.preventDefault();
    e.stopPropagation();
    this.pointerId = e.pointerId;
    this.originX = e.clientX;
    this.originY = e.clientY;
    this.root.classList.add("is-active");
    this.placeBase(e.clientX, e.clientY);
    this.setKnob(0, 0);
    this.onChange(0, 0);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // optional
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const dx = e.clientX - this.originX;
    const dy = e.clientY - this.originY;
    const len = Math.hypot(dx, dy);
    const scale = len > this.radius ? this.radius / len : 1;
    const kx = dx * scale;
    const ky = dy * scale;
    this.setKnob(kx, ky);
    // NDC-style: x right, y up (screen y is down).
    this.onChange(kx / this.radius, -ky / this.radius);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.reset();
  };

  private placeBase(clientX: number, clientY: number): void {
    const zone = this.root.parentElement;
    if (!zone) return;
    const r = zone.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
  }

  private setKnob(x: number, y: number): void {
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  reset(): void {
    this.pointerId = null;
    this.root.classList.remove("is-active");
    this.setKnob(0, 0);
    this.onChange(0, 0);
    // Park the stick in its default corner until the next press.
    this.root.style.left = "";
    this.root.style.top = "";
  }

  dispose(): void {
    const zone = this.root.parentElement;
    if (!zone) return;
    zone.removeEventListener("pointerdown", this.onPointerDown);
    zone.removeEventListener("pointermove", this.onPointerMove);
    zone.removeEventListener("pointerup", this.onPointerUp);
    zone.removeEventListener("pointercancel", this.onPointerUp);
  }
}
