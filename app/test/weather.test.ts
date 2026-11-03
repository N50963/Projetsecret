import { describe, expect, it } from "vitest";

import { planMeals } from "../src/modules/planning/engine";
import type { MealSlot, PlannerContext, PlannerRecipe } from "../src/modules/planning/types";
import { dishKind, isLongCooking, weatherAdjustment, weatherBrief, weatherText, type DayWeather } from "../src/modules/planning/weather";
import { DEFAULT_PREFERENCES } from "../src/modules/recipes/preferences";

const DAY = "2026-07-15";
const day = (tMax: number, over: Partial<DayWeather> = {}): DayWeather => ({ date: DAY, tMin: tMax - 10, tMax, rainMm: 0, code: 0, ...over });
const recipe = (id: string, name: string, over: Partial<PlannerRecipe> = {}): PlannerRecipe => ({
  id, versionId: `v-${id}`, name, totalMin: 30, servings: 4, mainProtein: "volaille", mealTypes: ["diner"],
  seasons: ["printemps", "ete", "automne", "hiver"], cuisine: null, tags: [], allergens: [], spiciness: 0, likes: 0, dislikes: 0,
  ingredients: [{ slug: "sel", label: "sel", category: null, pantry: true, quantity: null, unit: null, baseQuantity: null, baseUnit: null, optional: false, scale: "linear" }],
  ...over,
});
const slot: MealSlot = { id: "s1", date: DAY, mealType: "diner", maxTotalMin: null, servings: 4 };
const ctx = (recipes: PlannerRecipe[], weather?: Record<string, DayWeather>): PlannerContext => ({
  recipes, purchases: [], prefs: { ...DEFAULT_PREFERENCES, meatlessDinnersMin: 0, meatlessDinnersMax: 7 }, history: [], accepted: [], rejected: {}, weather,
});
const order = (c: PlannerContext) => planMeals(c, [slot])[0]!.proposals.map((p) => p.name);

describe("nature des plats pour la météo", () => {
  it("reconnaît les plats frais, réconfortants et neutres d'après leur nom", () => {
    expect(dishKind({ name: "Salade niçoise" })).toBe("frais");
    expect(dishKind({ name: "Taboulé maison aux pois chiches" })).toBe("frais");
    expect(dishKind({ name: "Wraps au poulet et crudités" })).toBe("frais");
    expect(dishKind({ name: "Soupe à l'oignon gratinée" })).toBe("reconfortant");
    expect(dishKind({ name: "Tartiflette" })).toBe("reconfortant");
    expect(dishKind({ name: "Bœuf bourguignon" })).toBe("reconfortant");
    expect(dishKind({ name: "Saucisses-purée" })).toBe("reconfortant");
    expect(dishKind({ name: "Pizza reine" })).toBe("neutre");
    expect(dishKind({ name: "Croque-monsieur et salade" })).toBe("neutre");
  });

  it("compte la cuisson longue, mais pas la marinade des brochettes", () => {
    expect(isLongCooking({ name: "Pot-au-feu", totalMin: 240 })).toBe(true);
    expect(isLongCooking({ name: "Brochettes de poulet marinées et riz", totalMin: 75 })).toBe(false);
    expect(isLongCooking({ name: "Salade de riz au thon", totalMin: 90 })).toBe(false);
  });
});

describe("bonus et malus selon la météo du jour", () => {
  it("chaleur : plat frais en avant, plat réconfortant et cuisson longue en retrait", () => {
    expect(weatherAdjustment({ name: "Salade grecque", totalMin: 15 }, day(32))).toEqual({ delta: 4, note: "Plat frais : 32 °C prévus" });
    expect(weatherAdjustment({ name: "Raclette", totalMin: 35 }, day(32)).delta).toBe(-5);
    expect(weatherAdjustment({ name: "Poulet rôti et pommes de terre au four", totalMin: 100 }, day(32)).delta).toBe(-2);
    expect(weatherAdjustment({ name: "Saumon en papillote, courgettes et citron", totalMin: 35 }, day(30)).note).toBe("Plat léger : 30 °C prévus");
  });

  it("froid ou pluie : plat chaud et réconfortant en avant, plat frais en retrait", () => {
    expect(weatherAdjustment({ name: "Velouté de potimarron", totalMin: 45 }, day(8))).toEqual({ delta: 3, note: "Plat chaud et réconfortant : 8 °C au plus" });
    expect(weatherAdjustment({ name: "Salade grecque", totalMin: 15 }, day(8)).delta).toBe(-3);
    const rainy = weatherAdjustment({ name: "Hachis parmentier", totalMin: 60 }, day(18, { rainMm: 12, code: 63 }));
    expect(rainy).toEqual({ delta: 1.5, note: "Plat réconfortant : pluie prévue" });
    expect(weatherAdjustment({ name: "Soupe de lentilles et carottes", totalMin: 45 }, day(13, { rainMm: 5 })).note).toBe("Plat réconfortant : 13 °C au plus, pluie");
  });

  it("temps doux ou sans prévision : rien ne change", () => {
    expect(weatherAdjustment({ name: "Raclette", totalMin: 35 }, day(19)).delta).toBe(0);
    expect(weatherAdjustment({ name: "Salade grecque", totalMin: 15 }, undefined)).toEqual({ delta: 0 });
  });

  it("libellé du temps et consigne pour les idées de Mistral", () => {
    expect(weatherText(0)).toEqual({ label: "ensoleillé", icon: "sun" });
    expect(weatherText(63)).toEqual({ label: "pluie", icon: "rain" });
    expect(weatherText(95).icon).toBe("storm");
    expect(weatherBrief(day(33))).toContain("plat frais ou léger, sans four");
    expect(weatherBrief(day(7, { code: 3 }))).toBe("Météo à Rochefort-du-Gard : 7 °C au plus, couvert : plat chaud et réconfortant. ");
    expect(weatherBrief(day(19))).toBe("");
  });
});

describe("propositions selon la météo", () => {
  const recipes = [recipe("a", "Tartiflette"), recipe("b", "Salade César au poulet"), recipe("c", "Poulet basquaise")];

  it("par forte chaleur, la salade passe devant la tartiflette, avec la raison affichée", () => {
    const plan = planMeals(ctx(recipes, { [DAY]: day(33) }), [slot])[0]!;
    expect(plan.proposals[0]!.name).toBe("Salade César au poulet");
    expect(plan.proposals[0]!.weatherNote).toBe("Plat frais : 33 °C prévus");
    expect(plan.proposals.map((p) => p.name).at(-1)).toBe("Tartiflette");
  });

  it("par grand froid, la tartiflette passe devant la salade", () => {
    expect(order(ctx(recipes, { [DAY]: day(6) }))[0]).toBe("Tartiflette");
  });

  it("sans prévision (hors réseau), l'ordre ne dépend pas de la météo", () => {
    const plan = planMeals(ctx(recipes), [slot])[0]!;
    expect(plan.proposals.every((p) => p.weatherNote === undefined)).toBe(true);
  });

  it("saison : un plat d'hiver recule en été, un plat d'été propre à la saison avance", () => {
    const summer = [recipe("w", "Poulet aux marrons", { seasons: ["hiver"] }), recipe("s", "Poulet aux poivrons", { seasons: ["ete"] }), recipe("n", "Poulet aux herbes")];
    const plan = planMeals(ctx(summer), [slot])[0]!;
    expect(plan.proposals.map((p) => p.name)).toEqual(["Poulet aux poivrons", "Poulet aux herbes", "Poulet aux marrons"]);
    expect(plan.proposals[0]!.reasons).toContain("Plat de saison");
  });
});
