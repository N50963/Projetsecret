import { describe, expect, it } from "vitest";

import { foldText, matchesSearch } from "../src/modules/recipes/search";

describe("recherche de recettes sans casse ni accents", () => {
  it("ignore majuscules, accents et ligatures", () => {
    expect(matchesSearch("Bœuf bourguignon", "boeuf")).toBe(true);
    expect(matchesSearch("Bœuf bourguignon", "BOEUF")).toBe(true);
    expect(matchesSearch("Boeuf carottes", "bœuf")).toBe(true);
    expect(matchesSearch("Crème brûlée", "creme brulee")).toBe(true);
    expect(matchesSearch("Gratin dauphinois", "GRATIN DAUPHINOIS")).toBe(true);
    expect(matchesSearch("Pâtes à l'ail", "pates a l ail")).toBe(true);
    expect(matchesSearch("Œufs mollets", "oeufs")).toBe(true);
  });

  it("apostrophes et tirets : comme des espaces", () => {
    expect(matchesSearch("Bavette à l’échalote", "l'echalote")).toBe(true);
    expect(matchesSearch("Soupe poireaux-pommes de terre", "poireaux pommes")).toBe(true);
    expect(matchesSearch("Soupe poireaux pommes de terre", "poireaux-pommes")).toBe(true);
  });

  it("garde une recherche précise", () => {
    expect(matchesSearch("Blanquette de veau", "boeuf")).toBe(false);
    expect(matchesSearch("Blanquette de veau", "")).toBe(true);
    expect(matchesSearch("Blanquette de veau", "   ")).toBe(true);
    expect(foldText("Ça ÉTÉ Œuvre")).toBe("ca ete oeuvre");
  });
});
