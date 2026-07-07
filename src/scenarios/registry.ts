import type { ScenarioEntry } from "./scenario";
import { ArenaScenario } from "./arena";
import { CrateYardScenario } from "./crateYard";
import { HordeScenario } from "./horde";
import { MegaHordeScenario } from "./megaHorde";
import { RevolutionsScenario } from "./revolutions";

/** Data-driven scenario list; drives the UI `<select>`. */
export const SCENARIOS: readonly ScenarioEntry[] = [
  { id: "revolutions", label: "Revolutions", create: () => new RevolutionsScenario() },
  { id: "arena", label: "Arena", create: () => new ArenaScenario() },
  { id: "crate-yard", label: "Crate Yard", create: () => new CrateYardScenario() },
  { id: "horde", label: "Horde", create: () => new HordeScenario() },
  { id: "mega-horde", label: "Mega Horde", create: () => new MegaHordeScenario() },
];

export function getScenarioEntry(id: string): ScenarioEntry {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}
