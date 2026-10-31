import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { clock, stepSegments, stepTimer } from "../src/lib/steps";

const timer = (text: string, previous: string[] = []) => {
  const t = stepTimer(text, previous);
  return t && [t.label, t.subject];
};

describe("minuteur des étapes", () => {
  it("lit minutes, plages, heures et secondes", () => {
    expect(stepTimer("Cuire 11 min dans l'eau bouillante.")).toEqual({ label: "11 min", seconds: 660, subject: "Cuire" });
    expect(stepTimer("Cuire 8 à 10 min (temps du paquet).")?.seconds).toBe(480);
    expect(stepTimer("Couvrir et laisser mijoter 2 h à feu très doux.")?.seconds).toBe(7200);
    expect(stepTimer("Cuire 1 h 30 à 160 °C.")?.label).toBe("1 h 30");
    expect(stepTimer("Réchauffer les wraps 30 secondes de chaque côté.")?.label).toBe("30 s");
  });

  it("ne donne qu'un minuteur par étape : la cuisson la plus longue", () => {
    expect(timer("Faire revenir l'oignon 3 min, ajouter l'ail et remuer 1 min, puis 3 min encore.")).toEqual(["3 min", "Faire revenir l'oignon"]);
    expect(timer("Cuire le riz 11 min et les haricots verts 10 min dans deux casseroles d'eau bouillante salée.")).toEqual(["11 min", "Cuire le riz"]);
    expect(timer("Mijoter 35 min à feu doux, en remuant toutes les 10 min.")?.[0]).toBe("35 min");
    expect(timer("Ajouter le maïs égoutté 5 min avant la fin. Pendant ce temps, cuire le riz 11 min.")).toEqual(["11 min", "Cuire le riz"]);
  });

  it("dit ce que l'on minute, pour s'y retrouver entre plusieurs minuteurs", () => {
    expect(timer("Chauffer l'huile à feu vif dans une cocotte. Dorer le poulet 5 min en le retournant, puis le réserver.")?.[1]).toBe("Dorer le poulet");
    expect(timer("Rincer le riz basmati, le cuire 11 min dans une grande casserole d'eau bouillante salée.")?.[1]).toBe("Cuire le riz basmati");
    expect(timer("Détailler le brocoli en fleurettes et les cuire 4 min dans l'eau bouillante salée.")?.[1]).toBe("Cuire le brocoli");
    expect(timer("Monter à feu vif, ajouter la viande et la faire dorer 5 min en l'émiettant.")?.[1]).toBe("Faire dorer la viande");
    expect(timer("Ajouter le brocoli, mélanger 1 min, parsemer de sésame.")?.[1]).toBe("Mélanger le brocoli");
    expect(timer("Faire revenir l'oignon, l'ail et le gingembre avec le curry 3 min.")?.[1]).toBe("Faire revenir l'oignon, l'ail et le gingembre");
    expect(timer("Étaler les tranches sur des plaques, les badigeonner d'huile, saler et les rôtir 15 min à 200 °C.")?.[1]).toBe("Rôtir les tranches");
    expect(timer("Le poser dans un plat et le cuire 20 min à 200 °C.", ["Saler et poivrer le filet mignon. Le saisir 5 min."])?.[1])
      .toBe("Cuire le filet mignon");
    expect(timer("Ajouter le bouillon chaud louche par louche, en remuant souvent, pendant 18 min.")?.[1]).toBe("Ajouter le bouillon chaud louche par louche");
    expect(timer("Dans une grande poêle, faire fondre le sucre avec un peu d'eau à feu moyen, sans remuer, 4 à 5 min.")?.[1]).toBe("Faire fondre le sucre");
  });

  it("lit les étapes mises en forme par Mistral (gras, parenthèses)", () => {
    expect(timer("Faire revenir **1 oignon** dans **2 cuillères d'huile** (30 ml) à feu moyen **5 à 7 min**.")).toEqual(["5 min", "Faire revenir 1 oignon"]);
    expect(timer("Cuire les pâtes (10 min).")?.[0]).toBe("10 min");
    expect(timer("Pendant ce temps, cuire **400 g de pâtes (penne)** dans l'eau bouillante salée **11 min**.")?.[1]).toBe("Cuire 400 g de pâtes");
  });

  it("ne prend pas les quantités pour des durées", () => {
    expect(stepTimer("Couper en dés de 2 cm, ajouter 60 cl d'eau, four à 200 °C.")).toBeNull();
    expect(stepTimer("Ajouter 2 haricots.")).toBeNull();
  });

  it("trouve un minuteur, avec son sujet, dans chaque recette qui comporte une cuisson", () => {
    const seed = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/recipes/seed.json", import.meta.url)), "utf8")) as any[];
    const withoutTimer = seed.filter((r) => r.cook_min > 0 && !r.steps.some((s: string) => stepTimer(s))).map((r) => r.slug);
    expect(withoutTimer).toEqual([]);
    const subjects = seed.flatMap((r) => r.steps.map((s: string, n: number) => stepTimer(s, r.steps.slice(0, n))?.subject)).filter(Boolean) as string[];
    expect(subjects.filter((s) => s.length > 47 || !/^[A-ZÀ-Ý]/.test(s))).toEqual([]);
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
