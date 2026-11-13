import { describe, expect, it } from "vitest";

import { autoLink, baseQuantity, searchIngredients, suggestIngredients, type ReferenceIngredient } from "../src/lib/ingredientMatch";

const ref: ReferenceIngredient[] = [
  ["pomme", "Pomme", "g"], ["pomme_de_terre", "Pomme de terre", "g"], ["courgette", "Courgette", "g"], ["lardons", "Lardons / allumettes", "g"],
  ["huile_olive", "Huile d'olive", "ml"], ["huile_neutre", "Huile neutre", "ml"], ["creme_epaisse", "Crème fraîche épaisse", "g"],
  ["creme_liquide", "Crème liquide", "ml"], ["poisson_blanc", "Poisson blanc (cabillaud, lieu, colin...)", "g"], ["oeuf", "Œuf", "piece"],
  ["ail", "Ail", "g"], ["chou_fleur", "Chou-fleur", "piece"], ["sel", "Sel", "g"],
].map(([slug, name, default_unit]) => ({ slug: slug!, name: name!, default_unit }));

describe("rattachement des ingrédients d'une recette au référentiel", () => {
  it("reconnaît l'ingrédient dans un libellé libre, au pluriel, avec quantités et articles", () => {
    expect(autoLink("2 courgettes", ref)?.slug).toBe("courgette");
    expect(autoLink("800 g de pommes de terre", ref)?.slug).toBe("pomme_de_terre");
    expect(autoLink("3 pommes", ref)?.slug).toBe("pomme");
    expect(autoLink("lardons fumés", ref)?.slug).toBe("lardons");
    expect(autoLink("2 cuillères à soupe d'huile d'olive", ref)?.slug).toBe("huile_olive");
    expect(autoLink("4 dos de cabillaud", ref)?.slug).toBe("poisson_blanc");
    expect(autoLink("2 gousses d'ail", ref)?.slug).toBe("ail");
    expect(autoLink("6 œufs", ref)?.slug).toBe("oeuf");
    expect(autoLink("1 chou-fleur", ref)?.slug).toBe("chou_fleur");
  });

  it("ne relie pas tout seul quand c'est ambigu ou inconnu, mais propose des choix", () => {
    expect(autoLink("crème", ref)).toBeNull();
    expect(suggestIngredients("crème", ref).map((o) => o.slug).sort()).toEqual(["creme_epaisse", "creme_liquide"]);
    expect(autoLink("pousses de bambou", ref)).toBeNull();
    expect(suggestIngredients("pousses de bambou", ref)).toEqual([]);
  });

  it("cherche dans le référentiel, les noms qui commencent par le texte d'abord", () => {
    expect(searchIngredients("pom", ref).map((o) => o.slug)).toEqual(["pomme", "pomme_de_terre"]);
    expect(searchIngredients("huile", ref).map((o) => o.slug)).toEqual(["huile_olive", "huile_neutre"]);
  });

  it("calcule la quantité comparée aux achats dans l'unité du référentiel", () => {
    expect(baseQuantity("g", 300, "g")).toEqual({ base_quantity: 300, base_unit: "g" });
    expect(baseQuantity("cs", 2, "ml")).toEqual({ base_quantity: 30, base_unit: "ml" });
    expect(baseQuantity("g", 300, "piece")).toEqual({ base_quantity: null, base_unit: null });
  });
});

describe("quantité tapée dans le libellé", () => {
  it("range la quantité et l'unité dans leurs cases", async () => {
    const { parseQuantity } = await import("../src/lib/ingredientMatch");
    expect(parseQuantity("200 g de lardons")).toEqual({ quantity: 200, unit: "g", label: "lardons" });
    expect(parseQuantity("1,5 kg de pommes de terre")).toEqual({ quantity: 1500, unit: "g", label: "pommes de terre" });
    expect(parseQuantity("2 courgettes")).toEqual({ quantity: 2, unit: "piece", label: "courgettes" });
    expect(parseQuantity("2 cuillères à soupe d'huile d'olive")).toEqual({ quantity: 2, unit: "cs", label: "huile d'olive" });
    expect(parseQuantity("20 cl de crème liquide")).toEqual({ quantity: 200, unit: "ml", label: "crème liquide" });
    expect(parseQuantity("1 pincée de sel")).toEqual({ quantity: 1, unit: "pincee", label: "sel" });
    expect(parseQuantity("lardons")).toBeNull();
  });
});
