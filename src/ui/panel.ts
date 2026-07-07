import type { EffectManager } from "../effects/manager";
import type { Effect, EffectGroup, EffectParam } from "../effects/effect";
import { SCENARIOS } from "../scenarios/registry";

const GROUP_ORDER: EffectGroup[] = ["Attack", "Reaction", "Camera", "UI", "Audio"];
const SCENARIO_KEY = "fabled-revolutions.scenario";
/** Scenario shown to first-time visitors (before any localStorage choice). */
const DEFAULT_SCENARIO = "revolutions";

export interface PanelParamGroup {
  readonly label: EffectGroup;
  readonly params: readonly EffectParam[];
}

export interface PanelWireframeToggle {
  readonly enabled: boolean;
  onChange(enabled: boolean): void;
}

/**
 * The right-side control panel: scenario select, all-on/all-off, one toggle per
 * effect (grouped), and an FPS/body-count footer. Fully data-driven from the
 * effect manager + scenario registry.
 */
export class Panel {
  readonly root: HTMLDivElement;
  private fpsEl!: HTMLSpanElement;
  private bodyEl!: HTMLSpanElement;
  private readonly toggles = new Map<string, HTMLInputElement>();
  private scenarioFold!: HTMLDivElement;
  private scenarioFoldLabel!: HTMLSpanElement;
  private scenarioFoldBody!: HTMLDivElement;

  constructor(
    private readonly manager: EffectManager,
    private readonly onScenarioChange: (id: string) => void,
    private readonly paramGroups: readonly PanelParamGroup[] = [],
    private readonly wireframe?: PanelWireframeToggle,
  ) {
    this.root = document.createElement("div");
    this.root.className = "panel";
    this.build();
  }

  static loadScenarioId(): string {
    try {
      return localStorage.getItem(SCENARIO_KEY) ?? DEFAULT_SCENARIO;
    } catch {
      return DEFAULT_SCENARIO;
    }
  }

  private saveScenarioId(id: string): void {
    try {
      localStorage.setItem(SCENARIO_KEY, id);
    } catch {
      // ignore
    }
  }

  private build(): void {
    const title = document.createElement("h1");
    title.textContent = "Fabled Revolutions";
    this.root.appendChild(title);

    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = "Toggle each juice effect to feel its contribution.";
    this.root.appendChild(sub);

    // Scenario select.
    const select = document.createElement("select");
    for (const s of SCENARIOS) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label;
      select.appendChild(opt);
    }
    select.value = Panel.loadScenarioId();
    select.addEventListener("change", () => {
      this.saveScenarioId(select.value);
      this.onScenarioChange(select.value);
    });
    this.root.appendChild(select);

    // All on / all off.
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const allOn = document.createElement("button");
    allOn.textContent = "All on";
    allOn.addEventListener("click", () => this.setAll(true));
    const allOff = document.createElement("button");
    allOff.textContent = "All off";
    allOff.addEventListener("click", () => this.setAll(false));
    buttons.append(allOn, allOff);
    this.root.appendChild(buttons);

    this.buildScenarioFold();

    if (this.wireframe) {
      const renderGroup = document.createElement("div");
      renderGroup.className = "effect-group";
      const h2 = document.createElement("h2");
      h2.textContent = "Render";
      renderGroup.appendChild(h2);
      renderGroup.appendChild(
        this.buildToggleRow(
          "wireframe",
          "Wireframe",
          "Show mesh edges for debugging.",
          this.wireframe.enabled,
          (on) => this.wireframe!.onChange(on),
        ),
      );
      this.root.appendChild(renderGroup);
    }

    // Effect toggles, grouped.
    const effectsWrap = document.createElement("div");
    effectsWrap.className = "effects";
    const byGroup = new Map<EffectGroup, Effect[]>();
    for (const effect of this.manager.effects) {
      const list = byGroup.get(effect.group) ?? [];
      list.push(effect);
      byGroup.set(effect.group, list);
    }
    for (const group of GROUP_ORDER) {
      const extraGroups = this.paramGroups.filter((g) => g.label === group);
      const effects = byGroup.get(group);
      if (extraGroups.length === 0 && (!effects || effects.length === 0)) continue;
      const groupEl = document.createElement("div");
      groupEl.className = "effect-group";
      const h2 = document.createElement("h2");
      h2.textContent = group;
      groupEl.appendChild(h2);
      for (const extraGroup of extraGroups) {
        for (const param of extraGroup.params) {
          groupEl.appendChild(this.buildParamRow(param, false));
        }
      }
      for (const effect of effects ?? []) {
        groupEl.appendChild(this.buildRow(effect));
        for (const param of effect.params ?? []) {
          groupEl.appendChild(this.buildParamRow(param));
        }
      }
      effectsWrap.appendChild(groupEl);
    }
    this.root.appendChild(effectsWrap);

    // Footer: fps + body count.
    const footer = document.createElement("div");
    footer.className = "footer";
    this.fpsEl = document.createElement("span");
    this.fpsEl.textContent = "-- fps";
    this.bodyEl = document.createElement("span");
    this.bodyEl.textContent = "0 bodies";
    footer.append(this.fpsEl, this.bodyEl);
    this.root.appendChild(footer);
  }

  /**
   * Collapsed-by-default disclosure for the active scenario's own tuning
   * controls (horde size, city construction sliders, ...). Hidden entirely
   * when the scenario doesn't expose one.
   */
  private buildScenarioFold(): void {
    this.scenarioFold = document.createElement("div");
    this.scenarioFold.className = "panel-fold";
    this.scenarioFold.hidden = true;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "panel-fold-toggle";
    const chevron = document.createElement("span");
    chevron.className = "panel-fold-chevron";
    chevron.textContent = "▸";
    this.scenarioFoldLabel = document.createElement("span");
    toggle.append(chevron, this.scenarioFoldLabel);
    toggle.addEventListener("click", () => {
      const collapsed = this.scenarioFold.getAttribute("data-collapsed") !== "false";
      this.scenarioFold.setAttribute("data-collapsed", String(!collapsed));
    });
    this.scenarioFold.appendChild(toggle);

    const wrap = document.createElement("div");
    wrap.className = "panel-fold-wrap";
    this.scenarioFoldBody = document.createElement("div");
    this.scenarioFoldBody.className = "panel-fold-body";
    wrap.appendChild(this.scenarioFoldBody);
    this.scenarioFold.appendChild(wrap);

    this.scenarioFold.setAttribute("data-collapsed", "true");
    this.root.appendChild(this.scenarioFold);
  }

  /**
   * Mount (or clear) the active scenario's tuning controls. Always resets to
   * collapsed on a scenario switch so it never grabs space unasked.
   */
  setScenarioControl(el: HTMLElement | null, label: string): void {
    this.scenarioFoldBody.replaceChildren();
    if (!el) {
      this.scenarioFold.hidden = true;
      return;
    }
    this.scenarioFoldLabel.textContent = `${label} controls`;
    this.scenarioFoldBody.appendChild(el);
    this.scenarioFold.hidden = false;
    this.scenarioFold.setAttribute("data-collapsed", "true");
  }

  private buildRow(effect: Effect): HTMLDivElement {
    return this.buildToggleRow(
      effect.id,
      effect.label,
      effect.description,
      this.manager.isEnabled(effect.id),
      (on) => this.manager.setEnabled(effect.id, on),
    );
  }

  private buildToggleRow(
    id: string,
    labelText: string,
    description: string,
    checked: boolean,
    onChange: (enabled: boolean) => void,
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "effect-row";
    row.title = description;

    const label = document.createElement("label");
    label.textContent = labelText;
    label.htmlFor = `toggle-${id}`;

    const sw = document.createElement("label");
    sw.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `toggle-${id}`;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.append(input, slider);
    this.toggles.set(id, input);

    row.append(label, sw);
    return row;
  }

  private buildParamRow(param: EffectParam, indented = true): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "param-row";
    if (!indented) row.classList.add("param-row-root");

    const label = document.createElement("span");
    label.textContent = param.label;

    const value = document.createElement("span");
    value.className = "param-value";
    const fmt = (v: number): string => (param.step < 1 ? v.toFixed(2) : String(Math.round(v)));
    value.textContent = fmt(param.get());

    const input = document.createElement("input");
    input.type = "range";
    input.ariaLabel = param.label;
    input.min = String(param.min);
    input.max = String(param.max);
    input.step = String(param.step);
    input.value = String(param.get());
    input.addEventListener("input", () => {
      param.set(Number(input.value));
      value.textContent = fmt(param.get());
    });

    row.append(label, input, value);
    return row;
  }

  private setAll(enabled: boolean): void {
    this.manager.setAll(enabled);
    for (const input of this.toggles.values()) input.checked = enabled;
  }

  /** Called each frame to update the footer readouts. */
  setStats(fps: number, bodyCount: number): void {
    this.fpsEl.textContent = `${Math.round(fps)} fps`;
    this.bodyEl.textContent = `${bodyCount} bodies`;
  }
}
