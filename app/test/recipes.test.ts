import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adaptRecipe, createRecipe, currentSeason, RecipeValidationError, slugify, toPayload } from "../src/modules/recipes/repository";
import { scaleIngredient, scaleIngredients } from "../src/modules/recipes/scale";
import type { Recipe, RecipeIngredient, RecipeInput } from "../src/modules/recipes/types";
import { validateRecipe } from "../src/modules/recipes/validate";

const ing = (over: Partial<RecipeIngredient>): RecipeIngredient => ({
  slug: "riz", label: "riz", quantity: 200, unit: "g", baseQuantity: 200, baseUnit: "g", optional: false, scale: "linear", ...over,
});

// Jeu initial exporté par services/recipes/seed.py (format de la base) converti au format de l'application.
const seedPath = fileURLToPath(new URL("../../data/recipes/seed.json", import.meta.url));
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as any[];
const fromSeed = (r: any): RecipeInput => ({
  slug: r.slug, name: r.name, description: r.description, servings: r.servings, prepMin: r.prep_min, cookMin: r.cook_min, restMin: r.rest_min,
  difficulty: r.difficulty, mealTypes: r.meal_types, mainProtein: r.main_protein, cuisine: r.cuisine, seasons: r.seasons, tags: r.tags,
  steps: r.steps, source: "seed",
  ingredients: r.ingredients.map((i: any) => ({ slug: i.slug, label: i.label, quantity: i.quantity, unit: i.unit, baseQuantity: i.base_quantity,
    baseUnit: i.base_unit, optional: i.optional, scale: i.scale })),
});

describe("adaptation au nombre de personnes", () => {
  it("double proportionnellement les ingrédients principaux (200 g de riz pour 2 -> 400 g pour 4)", () => {
    expect(scaleIngredient(ing({}), 2, 4)).toMatchObject({ quantity: 400, baseQuantity: 400 });
  });

  it("augmente moins vite les épices et laisse fixes les ingrédients marqués comme tels", () => {
    const [cumin, laurier] = scaleIngredients([
      ing({ slug: "cumin", quantity: 2, unit: "cc", baseQuantity: null, baseUnit: null, scale: "sublinear" }),
      ing({ slug: "laurier", quantity: 1, unit: "piece", baseQuantity: null, baseUnit: null, scale: "fixed" }),
    ], 4, 8);
    expect(cumin?.quantity).toBe(3); // 2 × 2^0,7 ≈ 3,25 -> 3 (arrondi à la demi-cuillère)
    expect(laurier?.quantity).toBe(1);
  });

  it("arrondit à des quantités de cuisine et garde les pièces entières", () => {
    expect(scaleIngredient(ing({ slug: "oeuf", quantity: 3, unit: "piece", baseQuantity: 3, baseUnit: "piece" }), 4, 6).quantity).toBe(5); // 4,5 -> 5
    expect(scaleIngredient(ing({ quantity: 300, baseQuantity: 300 }), 4, 3).quantity).toBe(230); // 225 -> 230
    expect(scaleIngredient(ing({ slug: "citron", quantity: 0.5, unit: "piece" }), 4, 2).quantity).toBe(0.5);
    expect(scaleIngredient(ing({ quantity: null, unit: null, baseQuantity: null, baseUnit: null }), 4, 8).quantity).toBeNull();
  });

  it("refuse un nombre de portions nul", () => {
    expect(() => scaleIngredient(ing({}), 4, 0)).toThrow();
  });
});

describe("validation d'une recette", () => {
  it("accepte les 84 recettes du jeu initial", () => {
    expect(seed).toHaveLength(84);
    const invalid = seed.map(fromSeed).map((r) => [r.slug, validateRecipe(r)] as const).filter(([, issues]) => issues.length);
    expect(invalid).toEqual([]);
  });

  it("refuse une recette générée incohérente, avec un message par problème", () => {
    const bad = { ...fromSeed(seed[0]), servings: 0, mainProtein: "licorne", seasons: [], steps: [" "],
      ingredients: [ing({ quantity: -3 }), ing({ unit: "tasse" as any }), ing({ quantity: 1 })] } as unknown as RecipeInput;
    const fields = validateRecipe(bad).map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["servings", "mainProtein", "seasons", "steps", "ingredients[0]", "ingredients[1]", "ingredients[2]"]));
  });
});

describe("enregistrement", () => {
  const calls: Array<{ fn: string; args: any }> = [];
  const supabase = {
    rpc: async (fn: string, args: any) => (calls.push({ fn, args }), { data: "nouvel-id", error: null }),
  } as any;

  it("n'appelle pas la base si la recette est invalide", async () => {
    await expect(createRecipe(supabase, "foyer", { ...fromSeed(seed[0]), steps: [] })).rejects.toBeInstanceOf(RecipeValidationError);
    expect(calls).toHaveLength(0);
  });

  it("crée une variante dans le foyer pour adapter une recette commune, une nouvelle version pour une recette du foyer", async () => {
    const commune = { ...fromSeed(seed[0]), id: "r-commune", householdId: null, versionId: "v1", versionNo: 1, totalMin: 40, allergens: [], source: "seed" } as Recipe;
    await adaptRecipe(supabase, "foyer", commune, { servings: 2 }, "Pour deux");
    expect(calls.at(-1)).toMatchObject({ fn: "create_recipe", args: { p_household: "foyer", p: { parent_recipe_id: "r-commune", servings: 2, source: "manual" } } });
    const duFoyer = { ...commune, id: "r-foyer", householdId: "foyer" };
    await adaptRecipe(supabase, "foyer", duFoyer, { name: "Poulet curry coco (moins épicé)" }, "Moins de curry");
    expect(calls.at(-1)).toMatchObject({ fn: "add_recipe_version", args: { p_recipe_id: "r-foyer", p_change_note: "Moins de curry" } });
  });

  it("prépare un identifiant lisible et le format attendu par la base", () => {
    expect(slugify("Œufs brouillés, avocat & tartines !")).toBe("ufs-brouilles-avocat-tartines");
    const payload = toPayload(fromSeed(seed[0]));
    expect(payload).toMatchObject({ prep_min: 15, meal_types: ["diner"], main_protein: "volaille" });
    expect(payload.ingredients[0]).toMatchObject({ slug: "poulet_filet", base_quantity: 600, base_unit: "g" });
  });

  it("détermine la saison courante", () => {
    expect(currentSeason(new Date("2026-10-29"))).toBe("automne");
    expect(currentSeason(new Date("2026-01-15"))).toBe("hiver");
  });
});
