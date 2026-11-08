import { describe, expect, it } from "vitest";

import { BUNCH, defaultQuantity, quantityLabel, stepQuantity, type FreshProduct } from "../src/lib/freshQuantity";

const product = (slug: string, unit: "g" | "piece", category: FreshProduct["category"] = "legume"): FreshProduct => ({ id: slug, slug, name: slug, category, unit });

describe("achats de fruits et légumes d'un autre magasin", () => {
  it("propose une quantité de départ selon le produit", () => {
    expect(defaultQuantity(product("tomate", "g"))).toBe(500);
    expect(defaultQuantity(product("ail", "g"))).toBe(100);
    expect(defaultQuantity(product("persil", "g", "herbe"))).toBe(30);
    expect(defaultQuantity(product("salade_verte", "piece"))).toBe(1);
    expect(defaultQuantity(product("avocat", "piece"))).toBe(2);
  });

  it("monte et descend par paliers ; sous le plus petit, le produit est retiré", () => {
    const tomate = product("tomate", "g");
    expect(stepQuantity(tomate, 500, 1)).toBe(750);
    expect(stepQuantity(tomate, 750, -1)).toBe(500);
    expect(stepQuantity(tomate, 5000, 1)).toBe(5000);
    expect(stepQuantity(tomate, 100, -1)).toBeNull();
    expect(stepQuantity(product("persil", "g", "herbe"), 30, 1)).toBe(50);
    const salade = product("salade_verte", "piece");
    expect(stepQuantity(salade, 1, 1)).toBe(2);
    expect(stepQuantity(salade, 1, -1)).toBeNull();
  });

  it("affiche grammes, kilos, pièces et bottes", () => {
    expect(quantityLabel("tomate", "g", 750)).toBe("750 g");
    expect(quantityLabel("tomate", "g", 1500)).toBe("1,5 kg");
    expect(quantityLabel("salade_verte", "piece", 2)).toBe("2 pièces");
    expect(quantityLabel("radis", "piece", 1)).toBe("1 botte");
    // Enregistrée en radis (une botte en compte 15), la quantité se relit en bottes.
    expect(quantityLabel("radis", "piece", 2 * BUNCH.radis!, true)).toBe("2 bottes");
  });
});
