import { describe, expect, it } from "vitest";

import { shoppingName, wholeSentences } from "../src/lib/format";
import { shoppingLines } from "../src/lib/shopping";
import type { ShoppingItem } from "../src/modules/planning";

const item = (id: string, label: string, quantity: number | null, unit: string | null, recipeId: string | null, recipeName: string | null = recipeId): ShoppingItem => ({
  id, label, quantity, unit, createdAt: "2026-11-02T00:00:00Z", checkedAt: null, boughtAt: null, recipeId, recipeName, active: true,
});

describe("liste de courses", () => {
  it("retire la quantité de la recette du nom quand la quantité est affichée", () => {
    expect(["2 boîtes de tomates pelées", "4 tomates", "1/2 citron", "200 g de riz", "une boîte de thon", "50 cl de crème", "filets de lieu noir", "1 kg"]
      .map((l) => shoppingName(l, true))).toEqual(["tomates pelées", "tomates", "citron", "riz", "thon", "crème", "filets de lieu noir", "1 kg"]);
    expect(shoppingName("4 tomates", false)).toBe("4 tomates");
  });

  it("regroupe un même article demandé par plusieurs plats et additionne les quantités", () => {
    const lines = shoppingLines([
      item("1", "œuf", 3, "piece", "quiche", "Quiche"), item("2", "œuf", 1, "piece", "poisson", "Poisson pané"),
      item("3", "4 tomates", 600, "g", "salade", "Salade grecque"), item("4", "tomate", 200, "g", "quiche", "Quiche"),
      item("5", "sel", null, null, null, null),
    ]);
    expect(lines.map((l) => [l.name, l.quantity, l.items.length, l.recipes.map((r) => r.name).join("+")])).toEqual([
      ["Œuf", 4, 2, "Quiche+Poisson pané"], ["Tomates", 800, 2, "Salade grecque+Quiche"], ["Sel", null, 1, ""],
    ]);
  });
});

describe("résumé de Mistral", () => {
  it("garde des phrases entières quand le résumé a été coupé", () => {
    expect(wholeSentences("Ajout de crème. Équilibre amélioré tout en gardant une cuis")).toBe("Ajout de crème.");
    expect(wholeSentences("Ajout de crème fraîche épaisse pour enrichir")).toBe("Ajout de crème fraîche épaisse pour…");
    expect(wholeSentences("Tout va bien.")).toBe("Tout va bien.");
  });
});
