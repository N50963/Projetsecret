/**
 * Moteur de menus sur les achats réels du foyer (instantané hors dépôt : PLANNER_SNAPSHOT_DIR contient purchases.json,
 * extrait de purchased_ingredients, et ingredients.json, exporté du référentiel) et le jeu initial de recettes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { planMeals } from "../src/modules/planning/engine";
import type { MealSlot, PlannerRecipe, Purchase } from "../src/modules/planning/types";
import { DEFAULT_PREFERENCES, maxSpicinessFor } from "../src/modules/recipes/preferences";

const dir = process.env.PLANNER_SNAPSHOT_DIR;

describe.skipIf(!dir)("menus de la semaine sur les achats réels", () => {
  const meta = JSON.parse(readFileSync(join(dir ?? "", "ingredients.json"), "utf8")) as Record<string, [string, boolean]>;
  const purchases: Purchase[] = (JSON.parse(readFileSync(join(dir ?? "", "purchases.json"), "utf8")) as any[][])
    .map(([slug, category, quantity, unit, purchasedAt]) => ({ slug, category, quantity, unit, purchasedAt }));
  const seed = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/recipes/seed.json", import.meta.url)), "utf8")) as any[];
  const recipes: PlannerRecipe[] = seed.map((r) => ({
    id: r.slug, versionId: r.slug, name: r.name, totalMin: r.prep_min + r.cook_min + r.rest_min, servings: r.servings, mainProtein: r.main_protein,
    mealTypes: r.meal_types, seasons: r.seasons, cuisine: r.cuisine, tags: r.tags, allergens: r.allergens, spiciness: r.spiciness, likes: 0, dislikes: 0,
    ingredients: r.ingredients.map((i: any) => ({
      slug: i.slug, label: i.label, category: meta[i.slug]?.[0] ?? null, pantry: meta[i.slug]?.[1] ?? false, quantity: i.quantity, unit: i.unit,
      baseQuantity: i.base_quantity, baseUnit: i.base_unit, optional: i.optional, scale: i.scale,
    })),
  }));
  const prefs = {
    ...DEFAULT_PREFERENCES, teens: 1, children: 1, excludedFoodGroups: ["abats", "coquillages"] as any, spiceLevel: "doux" as const,
    meatlessDinnersMin: 1, meatlessDinnersMax: 2,
  };
  const days = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  const slots: MealSlot[] = days.map((d, i) => ({ id: d, date: d, mealType: "diner", maxTotalMin: i === 1 || i === 2 ? 90 : 45, servings: 4 }));

  it("propose des dîners réalisables, variés et conformes aux préférences pour la semaine", () => {
    const plan = planMeals({ recipes, purchases, prefs, history: [], accepted: [], rejected: {} }, slots);
    const byId = new Map(recipes.map((r) => [r.id, r]));
    for (const p of plan) {
      const slot = slots.find((s) => s.id === p.slotId)!;
      console.log(`${slot.date} (${slot.maxTotalMin} min) tour ${p.round}: ${p.proposals.map((x) =>
        `${x.name} [${x.mainProtein}, ${x.totalMin} min, ${x.score}${x.missing.length ? `, à acheter : ${x.missing.map((m) => m.label).join(" + ")}` : ""}] ${x.reasons.join(" | ")}`).join("\n    ")}`);
      expect(p.proposals.length).toBeGreaterThan(0);
      for (const x of p.proposals) {
        const r = byId.get(x.recipeId)!;
        expect(r.totalMin).toBeLessThanOrEqual(slot.maxTotalMin!);
        expect(r.spiciness).toBeLessThanOrEqual(maxSpicinessFor("doux"));
        expect(x.missing.length).toBeLessThanOrEqual(3);
      }
    }
    const firsts = plan.map((p) => p.proposals[0]!);
    expect(new Set(firsts.map((x) => x.recipeId)).size).toBe(firsts.length);
    const repeats = firsts.filter((x, i) => i > 0 && x.mainProtein === firsts[i - 1]!.mainProtein).length;
    expect(repeats).toBeLessThanOrEqual(1);

    const second = planMeals({ recipes, purchases, prefs, history: [], accepted: [], rejected: { [days[0]!]: plan[0]!.proposals.map((x) => x.recipeId) } },
      slots.slice(0, 1), { rounds: { [days[0]!]: 2 } });
    console.log(`Après refus : ${second[0]!.proposals.map((x) => `${x.name} (à acheter : ${x.missing.map((m) => m.label).join(", ")})`).join(" ; ")}`);
    expect(second[0]!.proposals.every((x) => x.missing.length >= 1 && x.missing.length <= 3)).toBe(true);
  });
});
