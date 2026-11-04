import { describe, expect, it } from "vitest";

import { planMeals } from "../src/modules/planning/engine";
import type { MealSlot, PlannerContext, PlannerRecipe } from "../src/modules/planning/types";
import { autoLevel, dishKind, isLongCooking, weatherAdjustment, weatherAdvice, weatherBrief, weatherText, type DayWeather } from "../src/modules/planning/weather";
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

describe("classement par temps (de -2 temps froid à 2 temps chaud)", () => {
  it("suggère un classement d'après le nom du plat", () => {
    expect(autoLevel({ name: "Salade niçoise" })).toBe(2);
    expect(autoLevel({ name: "Saumon en papillote, courgettes et citron" })).toBe(1);
    expect(autoLevel({ name: "Pizza reine" })).toBe(0);
    expect(autoLevel({ name: "Gratin de chou-fleur" })).toBe(-1);
    expect(autoLevel({ name: "Raclette" })).toBe(-2);
    expect(autoLevel({ name: "Velouté de potimarron" })).toBe(-2);
  });

  it("le choix du foyer l'emporte sur la suggestion", () => {
    // Pizza (tout temps d'après le nom) classée « temps chaud » par le foyer : en avant par forte chaleur.
    expect(weatherAdjustment({ name: "Pizza reine", totalMin: 30 }, day(31), 2)).toEqual({ delta: 4, note: "Plat frais : 31 °C prévus" });
    // Gratin classé « tout temps » : plus de malus quand il fait chaud.
    expect(weatherAdjustment({ name: "Gratin de courgettes au chèvre", totalMin: 45 }, day(31), 0)).toEqual({ delta: 0, note: undefined });
    // Salade classée « plutôt froid » : en avant par temps frais.
    expect(weatherAdjustment({ name: "Salade de chèvre chaud", totalMin: 25 }, day(9), -1)).toEqual({ delta: 2, note: "Plat réconfortant : 9 °C au plus" });
  });

  it("plutôt chaud ou plutôt froid : bonus plus faible que temps chaud ou temps froid", () => {
    const hot = day(30);
    expect(weatherAdjustment({ name: "x", totalMin: 30 }, hot, 1).delta).toBeLessThan(weatherAdjustment({ name: "x", totalMin: 30 }, hot, 2).delta);
    const cold = day(5);
    expect(weatherAdjustment({ name: "x", totalMin: 30 }, cold, -1).delta).toBeLessThan(weatherAdjustment({ name: "x", totalMin: 30 }, cold, -2).delta);
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
    expect(rainy).toEqual({ delta: 1, note: "Plat réconfortant : pluie prévue" });
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

  it("conseil de la carte du jour, selon les mêmes repères que les propositions", () => {
    expect(weatherAdvice(day(31))).toEqual({ tone: "hot", advice: expect.stringContaining("plat frais, sans four") });
    expect(weatherAdvice(day(25)).tone).toBe("warm");
    expect(weatherAdvice(day(10, { rainMm: 6 }))).toEqual({ tone: "cold", advice: expect.stringMatching(/^Froid et pluie : un plat chaud et réconfortant/) });
    expect(weatherAdvice(day(14, { rainMm: 4 })).tone).toBe("cold");
    expect(weatherAdvice(day(14)).tone).toBe("cool");
    expect(weatherAdvice(day(20, { rainMm: 5 })).advice).toBe("Pluie prévue : un plat réconfortant fera plaisir.");
    expect(weatherAdvice(day(20)).advice).toBe("Temps doux : tous les plats conviennent.");
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

  it("un plat classé « temps chaud » par le foyer passe devant par forte chaleur", () => {
    const mine = [recipe("p", "Pizza reine", { weatherLevel: 2 }), recipe("c", "Poulet basquaise"), recipe("t", "Tartiflette")];
    expect(order(ctx(mine, { [DAY]: day(33) }))[0]).toBe("Pizza reine");
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
