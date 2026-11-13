import { describe, expect, it } from "vitest";

import { planMeals, shortagesAfter } from "../src/modules/planning/engine";
import { addDays, dayDiff, purchaseQuantity, Stock } from "../src/modules/planning/stock";
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

  it("compte le contenu d'un paquet vendu à l'unité (boîte d'œufs, jambon en tranches)", () => {
    expect(purchaseQuantity("oeuf", "piece", 1, "unit_sale")).toBe(6);
    expect(purchaseQuantity("jambon_cuit", "piece", 2, "unit_sale")).toBe(8);
    // Contenance lue sur l'étiquette, ou ingrédient vendu à la pièce : inchangé.
    expect(purchaseQuantity("oeuf", "piece", 12, "label")).toBe(12);
    expect(purchaseQuantity("citron", "piece", 1, "unit_sale")).toBe(1);
    expect(purchaseQuantity("surimi", "piece", null, null)).toBeNull();
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
    // Tour 2, une fois les plats du tour 1 refusés.
    const [second] = planMeals({ ...ctx, rejected: { lun: ["curry-poulet", "dahl"] } }, [slot("lun", "2026-10-27")], { rounds: { lun: 2 } });
    expect(second!.proposals.map((p) => p.recipeId)).toEqual(["chili"]);
    expect(second!.proposals[0]!.missing).toEqual([
      { slug: "boeuf_hache", label: "boeuf_hache", quantity: 300, unit: "g" }, { slug: "poivron", label: "poivron", quantity: 300, unit: "g" },
    ]);
  });

  it("tour 1 : jusqu'à 5 plats avec les achats, ceux qui équilibrent la semaine d'abord, avant tout plat à acheter", () => {
    const stockOnly = ["a", "b", "c", "d", "e", "f"].map((k) => recipe(`poulet-${k}`, "volaille", ["poulet_filet", "riz", "courgette"]));
    const steak = recipe("steak", "boeuf", ["boeuf_hache", "riz", "courgette"]);
    const ctx = context([...stockOnly, steak, chili], [...purchases, buy("boeuf_hache", SHOP)], {
      accepted: [
        { recipeId: "chili", date: "2026-10-28", servings: 4, slotId: "mer", mealType: "diner" },
        { recipeId: "chili", date: "2026-10-29", servings: 4, slotId: "jeu", mealType: "diner" },
      ],
    });
    const [first] = planMeals(ctx, [slot("lun", "2026-10-26")], { mealsInPlan: 7 });
    expect(first!.round).toBe(1);
    expect(first!.proposals).toHaveLength(5);
    expect(first!.proposals.every((p) => p.missing.length === 0)).toBe(true);
    // Le steak (3e viande rouge de la semaine) n'est proposé qu'après les plats équilibrés.
    expect(first!.proposals.map((p) => p.recipeId)).not.toContain("steak");
    const [few] = planMeals(context([stockOnly[0]!, steak, chili], [...purchases, buy("boeuf_hache", SHOP)], { accepted: ctx.accepted }), [slot("lun", "2026-10-26")], { mealsInPlan: 7 });
    expect(few!.proposals.map((p) => p.recipeId)).toEqual(["poulet-a", "steak"]);
    expect(few!.round).toBe(1);
  });

  it("20 recettes proposées pour un repas avant la réflexion approfondie : 5 avec les achats, puis 15 autres", () => {
    const stockReady = Array.from({ length: 8 }, (_, n) => recipe(`stock-${n}`, n % 2 ? "volaille" : "poisson", ["poulet_filet", "riz", "courgette"]));
    const fewToBuy = Array.from({ length: 6 }, (_, n) => recipe(`achat-${n}`, "boeuf", ["boeuf_hache", "riz"]));
    const manyToBuy = Array.from({ length: 10 }, (_, n) => recipe(`courses-${n}`, "porc", ["porc_tranche", "poivron", "aubergine", "feta", "mais"]));
    const ctx = context([...stockReady, ...fewToBuy, ...manyToBuy], purchases);
    const [first] = planMeals(ctx, [slot("lun", "2026-10-27")]);
    expect(first!.proposals).toHaveLength(5);
    const refused = first!.proposals.map((p) => p.recipeId);
    const [second] = planMeals({ ...ctx, rejected: { lun: refused } }, [slot("lun", "2026-10-27")], { rounds: { lun: 2 } });
    expect(second!.round).toBe(2);
    expect(second!.proposals).toHaveLength(15);
    const ids = second!.proposals.map((p) => p.recipeId);
    expect(ids.some((id) => refused.includes(id))).toBe(false);
    // Tous les plats faisables avec les achats non encore montrés (3) et ceux à 1 ingrédient à acheter (6) sont proposés ;
    // les plats qui demandent 5 ingrédients complètent jusqu'à 20.
    expect(ids.filter((id) => id.startsWith("stock-"))).toHaveLength(3);
    expect(ids.filter((id) => id.startsWith("achat-"))).toHaveLength(6);
    expect(ids.filter((id) => id.startsWith("courses-"))).toHaveLength(6);
    // Déjà 18 refus pour ce repas : au moins 3 recettes encore, puis la réflexion approfondie.
    const [late] = planMeals({ ...ctx, rejected: { lun: [...refused, ...ids.slice(0, 13)] } }, [slot("lun", "2026-10-27")], { rounds: { lun: 2 } });
    expect(late!.proposals).toHaveLength(3);
  });

  it("carrousel : les 20 recettes d'un repas dans un seul paquet, celles avec les achats d'abord", () => {
    const stockReady = Array.from({ length: 8 }, (_, n) => recipe(`stock-${n}`, n % 2 ? "volaille" : "poisson", ["poulet_filet", "riz", "courgette"]));
    const fewToBuy = Array.from({ length: 6 }, (_, n) => recipe(`achat-${n}`, "boeuf", ["boeuf_hache", "riz"]));
    const manyToBuy = Array.from({ length: 10 }, (_, n) => recipe(`courses-${n}`, "porc", ["porc_tranche", "poivron", "aubergine", "feta", "mais"]));
    const ctx = context([...stockReady, ...fewToBuy, ...manyToBuy], purchases);
    const [deck] = planMeals(ctx, [slot("lun", "2026-10-27")], { combined: true });
    expect(deck!.round).toBe(1);
    expect(deck!.proposals).toHaveLength(20);
    expect(new Set(deck!.proposals.map((p) => p.recipeId)).size).toBe(20);
    // Les 5 premières se font avec les achats (tour 1), les 15 suivantes gardent leur tour (2).
    expect(deck!.proposals.slice(0, 5).every((p) => p.round === 1 && p.missing.length === 0)).toBe(true);
    expect(deck!.proposals.slice(5).every((p) => p.round === 2)).toBe(true);
    const ids = deck!.proposals.map((p) => p.recipeId);
    expect(ids.filter((id) => id.startsWith("stock-"))).toHaveLength(8);
    expect(ids.filter((id) => id.startsWith("achat-"))).toHaveLength(6);
    expect(ids.filter((id) => id.startsWith("courses-"))).toHaveLength(6);
    // Sans le carrousel, le tour 1 reste limité à 5 recettes.
    expect(planMeals(ctx, [slot("lun", "2026-10-27")])[0]!.proposals).toHaveLength(5);
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

describe("menu du jour d'après un ingrédient", () => {
  const curry = recipe("curry-poulet", "volaille", ["poulet_filet", "riz", "courgette"]);
  const poelee = recipe("poelee-poulet", "volaille", ["poulet_filet", "poivron"]);
  const saumon = recipe("saumon-riz", "poisson", ["saumon", "riz", "courgette"]);
  const dahl = recipe("dahl", "legumineuse", ["lentilles", "tomate_conserve", "carotte", "riz"]);

  it("ne propose que des recettes avec l'ingrédient indiqué, selon les mêmes tours", () => {
    const ctx = context([curry, poelee, saumon, dahl], ["poulet_filet", "riz", "courgette", "saumon", "lentilles", "tomate_conserve", "carotte"].map((s) => buy(s, SHOP)));
    const [first] = planMeals(ctx, [slot("jour", "2026-10-27")], { mustInclude: { jour: "poulet_filet" } });
    expect(first!.proposals.map((p) => p.recipeId)).toEqual(["curry-poulet"]);
    const [second] = planMeals({ ...ctx, rejected: { jour: ["curry-poulet"] } }, [slot("jour", "2026-10-27")], { mustInclude: { jour: "poulet_filet" }, rounds: { jour: 2 } });
    expect(second!.proposals.map((p) => p.recipeId)).toEqual(["poelee-poulet"]);
    // Carrousel du menu du jour : les deux recettes au poulet dans le même paquet, celle sans achat d'abord.
    const [deck] = planMeals(ctx, [slot("jour", "2026-10-27")], { mustInclude: { jour: "poulet_filet" }, combined: true });
    expect(deck!.proposals.map((p) => [p.recipeId, p.round])).toEqual([["curry-poulet", 1], ["poelee-poulet", 2]]);
  });

  it("prévient quand un repas prévu plus tard n'aura plus assez d'un ingrédient déjà compté", () => {
    // 400 g de courgette : assez pour le saumon de mercredi, plus assez si le curry de ce soir en prend déjà 300 g.
    const purchases = [buy("saumon", "2026-10-27", 600), buy("riz", SHOP, 2000), buy("courgette", SHOP, 400), buy("poulet_filet", SHOP, 600)];
    const ctx = context([curry, saumon, dahl], purchases, {
      accepted: [{ recipeId: "saumon-riz", date: "2026-10-28", servings: 4, slotId: "mer", mealType: "diner" }],
    });
    const shortages = shortagesAfter(ctx, { recipeId: "curry-poulet", date: "2026-10-27", servings: 4, slotId: "mar", mealType: "diner" });
    expect(shortages).toHaveLength(1);
    expect(shortages[0]!.slotId).toBe("mer");
    expect(shortages[0]!.missing.map((m) => m.slug)).toEqual(["courgette"]);
    // Un repas plus tôt dans la semaine n'est pas concerné, et un repas sans ingrédient commun non plus.
    expect(shortagesAfter(ctx, { recipeId: "dahl", date: "2026-10-27", servings: 4, slotId: "mar", mealType: "diner" })).toEqual([]);
    expect(shortagesAfter(ctx, { recipeId: "curry-poulet", date: "2026-10-29", servings: 4, slotId: "jeu", mealType: "diner" })).toEqual([]);
  });

  it("le menu du jour puise d'abord dans ce qui est à la maison, même compté pour un repas suivant", () => {
    const purchases = [buy("saumon", "2026-10-27", 600), buy("riz", SHOP, 2000), buy("courgette", SHOP, 400), buy("poulet_filet", SHOP, 600)];
    const ctx = context([curry, saumon], purchases, {
      accepted: [{ recipeId: "saumon-riz", date: "2026-10-28", servings: 4, slotId: "mer", mealType: "diner" }],
    });
    // Repas réservés d'abord (menus de la semaine) : la courgette est gardée pour mercredi, le curry demande d'en acheter.
    const [weekly] = planMeals(ctx, [slot("mar", "2026-10-27")], { rounds: { mar: 2 } });
    expect(weekly!.proposals[0]!.missing.map((m) => m.slug)).toEqual(["courgette"]);
    // Menu du jour : le curry se fait avec la courgette de la maison ; mercredi est signalé ensuite.
    const [today] = planMeals(ctx, [slot("mar", "2026-10-27")], { todayFirst: true, mustInclude: { mar: "poulet_filet" } });
    expect(today!.round).toBe(1);
    expect(today!.proposals.map((p) => p.recipeId)).toEqual(["curry-poulet"]);
  });

  it("avec un ingrédient imposé, les recettes sans achat qui déséquilibrent la semaine restent au tour 1", () => {
    const omelette = recipe("omelette", "oeuf", ["oeuf", "epinard"]);
    const ctx = context([omelette, dahl], ["oeuf", "epinard", "lentilles", "tomate_conserve", "carotte", "riz"].map((s) => buy(s, SHOP)), {
      prefs: { ...DEFAULT_PREFERENCES, meatlessDinnersMin: 0, meatlessDinnersMax: 1 },
      accepted: [{ recipeId: "dahl", date: "2026-10-28", servings: 4, slotId: "mer", mealType: "diner" }],
    });
    const options = { mustInclude: { mar: "oeuf" }, mealsInPlan: 7, todayFirst: true };
    expect(planMeals(ctx, [slot("mar", "2026-10-27")], options)[0]!.round).toBe(1);
    expect(planMeals(ctx, [slot("mar", "2026-10-27")], options)[0]!.proposals.map((p) => p.recipeId)).toEqual(["omelette"]);
  });
});

describe("aliments exclus par le foyer", () => {
  it("écarte le porc caché dans un plat de volaille (cordon bleu au jambon), mais pas un ingrédient facultatif", () => {
    const cordon = recipe("cordon-bleu", "volaille", ["cordon_bleu", "riz"]);
    const quiche = recipe("quiche-legumes", "vegetarien", ["oeuf", "courgette"], { ingredients: [ing("oeuf"), ing("courgette"), ing("lardons", 100, { optional: true })] });
    const curry = recipe("curry-poulet", "volaille", ["poulet_filet", "riz"]);
    const ctx = context([cordon, quiche, curry], ["cordon_bleu", "riz", "oeuf", "courgette", "poulet_filet"].map((s) => buy(s, SHOP)));
    const noPork = { ...ctx, prefs: { ...ctx.prefs, excludedFoodGroups: ["porc"] as typeof ctx.prefs.excludedFoodGroups } };
    const ids = (c: PlannerContext) => planMeals(c, [slot("s1", "2026-10-27")])[0]!.proposals.map((p) => p.recipeId).sort();
    expect(ids(ctx)).toContain("cordon-bleu");
    expect(ids(noPork)).toEqual(["curry-poulet", "quiche-legumes"]);
  });
});
