import type { Input } from "../core/input";

/**
 * Mobile controls: drag anywhere on the map to move (dynamic stick under the
 * finger) plus the action cluster for attack / jump / boost. Aim follows
 * movement facing — no separate aim stick. Only mounts when the device looks
 * touch-primary.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private readonly input: Input;
  private readonly mapMove: MapDrag;
  private readonly bodyObserver: MutationObserver;
  private visible = false;

  constructor(input: Input) {
    this.input = input;
    this.root = document.createElement("div");
    this.root.className = "touch-pad";
    this.root.setAttribute("aria-hidden", "true");

    // Full-screen drag layer — finger anywhere on the playfield steers move.
    const map = document.createElement("div");
    map.className = "touch-map";
    this.mapMove = new MapDrag(map, (x, y) => {
      this.input.setTouchMove(x, y);
    });

    const actions = document.createElement("div");
    actions.className = "touch-actions";

    const attack = makeButton("ATTACK", "touch-btn touch-btn-attack");
    const jump = makeButton("JUMP", "touch-btn touch-btn-jump");
    const boost = makeButton("BOOST", "touch-btn touch-btn-boost");

    bindHold(attack, (down) => this.input.setTouchAttack(down));
    bindPress(jump, () => this.input.pulseTouchJump(), () => this.input.releaseTouchJump());
    bindHold(boost, (down) => this.input.setTouchBoost(down));

    actions.append(boost, jump, attack);
    this.root.append(map, actions);

    // Eat all pointer traffic so the canvas underneath never sees it as an attack.
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());

    this.bodyObserver = new MutationObserver(this.onBodyClass);
    this.bodyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    this.syncVisibility();
    window.addEventListener("resize", this.syncVisibility);
  }

  private onBodyClass = (): void => {
    // Immersive / info hide the pad via CSS without unmounting — force-release
    // so a held drag can't leave movement stuck under the overlay.
    if (
      document.body.classList.contains("immersive") ||
      document.body.classList.contains("info-open")
    ) {
      this.mapMove.reset();
      this.input.clearTouch();
    }
  };

  private syncVisibility = (): void => {
    const show = shouldShowTouchPad();
    if (show === this.visible) return;
    this.visible = show;
    this.root.classList.toggle("is-visible", show);
    this.root.setAttribute("aria-hidden", String(!show));
    document.body.classList.toggle("touch-controls", show);
    this.input.setTouchEnabled(show);
    if (!show) {
      this.mapMove.reset();
      this.input.clearTouch();
    }
  };

  dispose(): void {
    window.removeEventListener("resize", this.syncVisibility);
    this.bodyObserver.disconnect();
    this.mapMove.dispose();
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

/**
 * Full-map drag-to-move: press anywhere, drag to steer. A translucent stick
 * blooms under the finger so the direction reads clearly.
 */
class MapDrag {
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly onChange: (x: number, y: number) => void;
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  /** Pixels of drag that map to full tilt — generous so a thumb flick feels good. */
  private readonly radius: number;

  constructor(
    private readonly zone: HTMLElement,
    onChange: (x: number, y: number) => void,
    radius = 64,
  ) {
    this.onChange = onChange;
    this.radius = radius;

    this.base = document.createElement("div");
    this.base.className = "touch-stick-base touch-map-stick";
    this.knob = document.createElement("div");
    this.knob.className = "touch-stick-knob";
    const tag = document.createElement("span");
    tag.className = "touch-stick-tag";
    tag.textContent = "DRAG TO MOVE";
    this.base.append(this.knob, tag);
    this.zone.appendChild(this.base);

    this.zone.addEventListener("pointerdown", this.onPointerDown);
    this.zone.addEventListener("pointermove", this.onPointerMove);
    this.zone.addEventListener("pointerup", this.onPointerUp);
    this.zone.addEventListener("pointercancel", this.onPointerUp);
    this.zone.addEventListener("lostpointercapture", this.onLostCapture);
    // Window fallbacks: capture can drop or the pad can be CSS-hidden mid-drag
    // without a zone-level up, which used to leave movement stuck on.
    window.addEventListener("pointerup", this.onWindowPointerEnd);
    window.addEventListener("pointercancel", this.onWindowPointerEnd);
    window.addEventListener("blur", this.reset);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Action buttons sit above this layer and stopPropagation — guard anyway.
    if ((e.target as HTMLElement).closest(".touch-btn, .touch-actions")) return;
    if (this.pointerId !== null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.originX = e.clientX;
    this.originY = e.clientY;
    this.placeBase(e.clientX, e.clientY);
    this.base.classList.add("is-active");
    this.setKnob(0, 0);
    this.onChange(0, 0);
    try {
      this.zone.setPointerCapture(e.pointerId);
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
    // Soft deadzone so a resting thumb doesn't creep.
    const nx = kx / this.radius;
    const ny = -ky / this.radius;
    const mag = Math.hypot(nx, ny);
    if (mag < 0.12) {
      this.onChange(0, 0);
      return;
    }
    this.onChange(nx, ny);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.reset();
  };

  private onLostCapture = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.reset();
  };

  private onWindowPointerEnd = (e: PointerEvent): void => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.reset();
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) this.reset();
  };

  private placeBase(clientX: number, clientY: number): void {
    const r = this.zone.getBoundingClientRect();
    this.base.style.left = `${clientX - r.left}px`;
    this.base.style.top = `${clientY - r.top}px`;
  }

  private setKnob(x: number, y: number): void {
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  reset = (): void => {
    this.pointerId = null;
    this.base.classList.remove("is-active");
    this.setKnob(0, 0);
    this.onChange(0, 0);
  };

  dispose(): void {
    this.zone.removeEventListener("pointerdown", this.onPointerDown);
    this.zone.removeEventListener("pointermove", this.onPointerMove);
    this.zone.removeEventListener("pointerup", this.onPointerUp);
    this.zone.removeEventListener("pointercancel", this.onPointerUp);
    this.zone.removeEventListener("lostpointercapture", this.onLostCapture);
    window.removeEventListener("pointerup", this.onWindowPointerEnd);
    window.removeEventListener("pointercancel", this.onWindowPointerEnd);
    window.removeEventListener("blur", this.reset);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
}
