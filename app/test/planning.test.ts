import { describe, expect, it } from "vitest";

import { planMeals } from "../src/modules/planning/engine";
import { addDays, dayDiff, Stock } from "../src/modules/planning/stock";
import type { MealSlot, PlannerContext, PlannerIngredient, PlannerRecipe, Purchase } from "../src/modules/planning/types";
import { DEFAULT_PREFERENCES } from "../src/modules/recipes/preferences";

const CATEGORY: Record<string, string> = {
  saumon: "poisson", poulet_filet: "volaille", boeuf_hache: "viande", courgette: "legume", poivron: "legume", tomate_conserve: "conserve",
  riz: "feculent", pates: "feculent", lentilles: "legumineuse", oeuf: "oeuf", epinard: "legume", carotte: "legume", piment: "herbe_epice",
};
const ing = (slug: string, baseQuantity: number | null = 300, over: Partial<PlannerIngredient> = {}): PlannerIngredient => ({
  slug, label: slug, category: CATEGORY[slug] ?? null, pantry: slug === "sel", quantity: baseQuantity, unit: "g", baseQuantity,
  baseUnit: baseQuantity === null ? null : "g", optional: false, scale: "linear", ...over,
});
const recipe = (id: string, mainProtein: PlannerRecipe["mainProtein"], slugs: string[], over: Partial<PlannerRecipe> = {}): PlannerRecipe => ({
  id, versionId: `v-${id}`, name: id, totalMin: 30, servings: 4, mainProtein, mealTypes: ["diner"],
  seasons: ["printemps", "ete", "automne", "hiver"], cuisine: null, tags: mainProtein === "legumineuse" || mainProtein === "oeuf" ? ["vegetarien"] : [],
  allergens: [], spiciness: 0, likes: 0, dislikes: 0, ingredients: [...slugs.map((s) => ing(s)), ing("sel", null)], ...over,
});
const buy = (slug: string, purchasedAt: string, quantity: number | null = 1000): Purchase => ({
  slug, category: CATEGORY[slug] ?? "conserve", quantity, unit: "g", purchasedAt,
});
const slot = (id: string, date: string, over: Partial<MealSlot> = {}): MealSlot => ({ id, date, mealType: "diner", maxTotalMin: null, servings: 4, ...over });
const context = (recipes: PlannerRecipe[], purchases: Purchase[], over: Partial<PlannerContext> = {}): PlannerContext => ({
  recipes, purchases, prefs: { ...DEFAULT_PREFERENCES, meatlessDinnersMin: 0, meatlessDinnersMax: 7 }, history: [], accepted: [], rejected: {}, ...over,
});

const SHOP = "2026-10-26";

describe("stock estimé d'après les tickets", () => {
  it("calcule les écarts de dates", () => {
    expect(dayDiff("2026-10-30", "2026-11-02")).toBe(3);
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });

  it("ne compte plus le poisson frais au-delà de deux jours, sauf si le foyer congèle", () => {
    const stock = Stock.fromPurchases([buy("saumon", SHOP, 600)], { freezes: false });
    expect(stock.available("saumon", "2026-10-28").present).toBe(true);
    expect(stock.available("saumon", "2026-10-29").present).toBe(false);
    const frozen = Stock.fromPurchases([buy("saumon", SHOP, 600)], { freezes: true });
    expect(frozen.available("saumon", "2026-11-10").present).toBe(true);
  });

  it("consomme les lots qui périment le plus tôt et garde une barquette de contenance inconnue pour un seul repas", () => {
    const stock = Stock.fromPurchases([buy("riz", "2026-10-01", 1000), buy("riz", SHOP, 500), buy("poulet_filet", SHOP, null)], { freezes: false });
    stock.consume("riz", 1200, "2026-10-27");
    expect(stock.available("riz", "2026-10-27").quantity).toBe(300);
    stock.consume("poulet_filet", 600, "2026-10-27");
    expect(stock.available("poulet_filet", "2026-10-27").present).toBe(false);
  });
});

describe("propositions de menus", () => {
  const curry = recipe("curry-poulet", "volaille", ["poulet_filet", "riz", "courgette"]);
  const saumon = recipe("saumon-riz", "poisson", ["saumon", "riz", "courgette"]);
  const chili = recipe("chili", "boeuf", ["boeuf_hache", "poivron", "tomate_conserve", "riz"]);
  const dahl = recipe("dahl", "legumineuse", ["lentilles", "tomate_conserve", "carotte", "riz"]);
  const omelette = recipe("omelette", "oeuf", ["oeuf", "epinard"]);
  const purchases = ["poulet_filet", "riz", "courgette", "saumon", "tomate_conserve", "lentilles", "carotte", "oeuf", "epinard"].map((s) => buy(s, SHOP));

  it("tour 1 : seulement des recettes réalisables avec les achats ; tour 2 : 1 à 3 ingrédients à acheter, avec les quantités", () => {
    const ctx = context([curry, chili, dahl], purchases);
    const [first] = planMeals(ctx, [slot("lun", "2026-10-27")]);
    expect(first!.round).toBe(1);
    expect(first!.proposals.map((p) => p.recipeId).sort()).toEqual(["curry-poulet", "dahl"]);
    const [second] = planMeals(ctx, [slot("lun", "2026-10-27")], { rounds: { lun: 2 } });
    expect(second!.proposals.map((p) => p.recipeId)).toEqual(["chili"]);
    expect(second!.proposals[0]!.missing).toEqual([
      { slug: "boeuf_hache", label: "boeuf_hache", quantity: 300, unit: "g" }, { slug: "poivron", label: "poivron", quantity: 300, unit: "g" },
    ]);
  });

  it("propose le poisson frais en premier, avant qu'il ne soit plus consommable", () => {
    const plan = planMeals(context([curry, saumon, dahl, omelette], purchases), [slot("lun", "2026-10-27"), slot("mar", "2026-10-28"), slot("mer", "2026-10-29")]);
    expect(plan[0]!.proposals[0]!.recipeId).toBe("saumon-riz");
    expect(plan[0]!.proposals[0]!.reasons.join(" ")).toMatch(/cuisiner vite/);
    expect(plan.flatMap((p) => p.proposals).filter((p) => p.recipeId === "saumon-riz" && p.round === 1)).toHaveLength(1);
  });

  it("alterne les protéines d'un jour à l'autre et ne répète pas une recette dans la semaine", () => {
    const poulet2 = recipe("poulet-courgettes", "volaille", ["poulet_filet", "courgette", "pates"]);
    const ctx = context([curry, poulet2, dahl, omelette], [...purchases, buy("pates", SHOP), buy("poulet_filet", SHOP, 2000)]);
    const plan = planMeals(ctx, [slot("lun", "2026-10-27"), slot("mar", "2026-10-28")]);
    const firsts = plan.map((p) => p.proposals[0]!);
    expect(new Set(firsts.map((p) => p.recipeId)).size).toBe(2);
    expect(firsts[0]!.mainProtein).not.toBe(firsts[1]!.mainProtein);
  });

  it("un repas accepté réserve ses ingrédients pour son jour", () => {
    const saumon2 = recipe("saumon-papillote", "poisson", ["saumon", "courgette"], { ingredients: [ing("saumon", 600), ing("courgette")] });
    const ctx = context([saumon, saumon2, dahl], [buy("saumon", SHOP, 600), buy("riz", SHOP), buy("courgette", SHOP), buy("lentilles", SHOP),
      buy("tomate_conserve", SHOP), buy("carotte", SHOP)], { accepted: [{ recipeId: "saumon-papillote", date: "2026-10-27", servings: 4, slotId: "lun" }] });
    const plan = planMeals(ctx, [slot("lun", "2026-10-27"), slot("mar", "2026-10-28")]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.proposals.map((p) => p.recipeId)).toEqual(["dahl"]);
  });

  it("respecte le temps disponible, les allergènes, le niveau d'épice, les refus et les plats servis récemment", () => {
    const piquant = recipe("piquant", "volaille", ["poulet_filet", "riz"], { spiciness: 2 });
    const long = recipe("long", "volaille", ["poulet_filet", "courgette"], { totalMin: 90 });
    const crevettes = recipe("crevettes", "fruits_de_mer", ["riz", "courgette"], { allergens: ["crustaces"] });
    const ctx = context([piquant, long, crevettes, curry, dahl, omelette], purchases, {
      prefs: { ...DEFAULT_PREFERENCES, spiceLevel: "doux", excludedAllergens: ["crustaces"] },
      rejected: { lun: ["dahl"] }, history: [{ recipeId: "omelette", date: "2026-10-20", servings: 4 }],
    });
    const [p] = planMeals(ctx, [slot("lun", "2026-10-27", { maxTotalMin: 45 })]);
    expect(p!.proposals.map((x) => x.recipeId)).toEqual(["curry-poulet"]);
  });

  it("vise le nombre de soirs sans viande demandé par le foyer", () => {
    const poulet2 = recipe("poulet-courgettes", "volaille", ["poulet_filet", "courgette", "pates"]);
    const boeuf = recipe("boeuf-carottes", "boeuf", ["boeuf_hache", "carotte", "pates"]);
    const ctx = context([curry, poulet2, boeuf, dahl], [...purchases, buy("pates", SHOP), buy("boeuf_hache", SHOP), buy("poulet_filet", SHOP, 2000)], {
      prefs: { ...DEFAULT_PREFERENCES, meatlessDinnersMin: 1, meatlessDinnersMax: 2 },
    });
    const days = ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"];
    const plan = planMeals(ctx, days.map((d) => slot(d, d)));
    const chosen = plan.map((p) => p.proposals[0]?.recipeId).filter(Boolean);
    expect(chosen).toContain("dahl");
  });
});
