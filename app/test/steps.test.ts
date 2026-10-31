import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { clock, stepSegments, stepTimers } from "../src/lib/steps";

describe("minuteurs des étapes", () => {
  it("lit minutes, plages, heures et secondes", () => {
    expect(stepTimers("Cuire 11 min dans l'eau bouillante.")).toEqual([{ label: "11 min", seconds: 660 }]);
    expect(stepTimers("Cuire 8 à 10 min (temps du paquet).")).toEqual([{ label: "8 min", seconds: 480 }]);
    expect(stepTimers("Couvrir et laisser mijoter 2 h à feu très doux.")).toEqual([{ label: "2 h", seconds: 7200 }]);
    expect(stepTimers("Cuire 1 h 30 à 160 °C.")).toEqual([{ label: "1 h 30", seconds: 5400 }]);
    expect(stepTimers("Réchauffer les wraps 30 secondes de chaque côté.")).toEqual([{ label: "30 s", seconds: 30 }]);
  });

  it("donne chaque durée d'une étape, sans doublon ni rappel régulier", () => {
    expect(stepTimers("Faire revenir l'oignon 3 min, ajouter l'ail et remuer 1 min, puis 3 min encore.").map((t) => t.label))
      .toEqual(["3 min", "1 min"]);
    expect(stepTimers("Mijoter 35 min à feu doux, en remuant toutes les 10 min.").map((t) => t.label)).toEqual(["35 min"]);
  });

  it("ne prend pas les quantités pour des durées", () => {
    expect(stepTimers("Couper en dés de 2 cm, ajouter 60 cl d'eau, four à 200 °C.")).toEqual([]);
    expect(stepTimers("Ajouter 2 haricots.")).toEqual([]);
  });

  it("trouve au moins un minuteur dans chaque recette qui comporte une cuisson", () => {
    const seed = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/recipes/seed.json", import.meta.url)), "utf8")) as any[];
    const withoutTimer = seed.filter((r) => r.cook_min > 0 && !r.steps.some((s: string) => stepTimers(s).length)).map((r) => r.slug);
    expect(withoutTimer).toEqual([]);
  });
});

describe("mise en évidence", () => {
  it("souligne durées, températures et intensité du feu", () => {
    const strong = stepSegments("Chauffer l'huile à feu moyen, cuire 5 min puis enfourner à 200 °C.").filter((s) => s.strong).map((s) => s.text);
    expect(strong).toEqual(["feu moyen", "5 min", "200 °C"]);
    expect(stepSegments("Couper les légumes.").map((s) => s.text).join("")).toBe("Couper les légumes.");
  });
});

describe("affichage du temps restant", () => {
  it("formate minutes et heures", () => {
    expect(clock(480)).toBe("8:00");
    expect(clock(65.2)).toBe("1:06");
    expect(clock(5400)).toBe("1:30:00");
    expect(clock(-3)).toBe("0:00");
  });
});
