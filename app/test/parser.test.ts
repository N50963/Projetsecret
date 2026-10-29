import { describe, expect, it } from "vitest";

import { decodeHtmlEntities } from "../src/modules/lidl-sync/htmlEntities";
import { parseQuantity } from "../src/modules/lidl-sync/quantity";
import { cents, parseReceipt, payableCents } from "../src/modules/lidl-sync/receiptParser";

const line = (n: number, cls: string, attrs: string, text: string) => `<span id="purchase_list_line_${n}" class="${cls}"${attrs}>${text}</span>\n`;

// Même ticket synthétique que tests/test_lidl_parse.py (aucune donnée personnelle).
const TICKET =
  '<span class="purchase_list">' +
  line(1, "currency", ' data-currency="EUR"', "Article P.U.EUR Qt&eacute; EUR") +
  line(2, "article", ' data-art-id="0000001" data-unit-price="1,17" data-tax-type="A" data-art-description="M�che"', "M&acirc;che                  1,17 x  2    2,34 A T") +
  line(3, "css_bold", "", "Prix en baisse") + line(3, "css_bold", "", "-0,10") +
  line(4, "discount", ' data-promotion-id="X"', "R&eacute;duction Lidl Plus") + line(4, "discount", ' data-promotion-id="X"', "-0,24") +
  line(5, "article", ' data-art-id="0000002" data-unit-price="3,20" data-tax-type="A" data-art-description="Tomate"', "Tomate allong&eacute;e 6,67 A T") +
  line(6, "article", ' data-art-id="0000002" data-art-quantity="1,336" data-unit-price="4,99"', "1,336 kg x 4,99 EUR/kg") +
  line(7, "article", ' data-art-id="0000003" data-unit-price="2,49" data-tax-type="B" data-art-description="Fromage"', "Fromage ch&egrave;vre pyram  2,49 1    2,49 B") +
  "</span> A payer 11,16 ";

describe("parseReceipt", () => {
  it("lit les articles, les remises et les pesées, au centime près", () => {
    const { items, problems } = parseReceipt(TICKET);
    expect(problems).toEqual([]);
    expect(items.map((i) => i.labelRaw)).toEqual(["Mâche", "Tomate allongée", "Fromage chèvre pyram"]);
    const [mache, tomate, fromage] = items;
    expect([mache?.quantity, mache?.unitPriceCents, mache?.lineTotalCents]).toEqual([2, 117, 234]);
    expect(mache?.discountCents).toBe(-34);
    expect(mache?.discountLabels).toEqual(["Prix en baisse", "Réduction Lidl Plus"]);
    expect([tomate?.weightG, tomate?.unitPriceCents, tomate?.lineTotalCents]).toEqual([1336, 499, 667]);
    expect(fromage?.tax).toBe("B");
    expect(items.reduce((s, i) => s + i.lineTotalCents + i.discountCents, 0)).toBe(payableCents(TICKET));
    expect(payableCents(TICKET)).toBe(1116);
  });

  it("convertit les montants sans erreur d'arrondi", () => {
    expect(cents("1,17")).toBe(117);
    expect(cents("-0,24")).toBe(-24);
    expect(cents("0,29")).toBe(29);
  });

  it("signale une remise sans article au lieu de l'ignorer", () => {
    const { problems } = parseReceipt(line(1, "discount", "", "R&eacute;duction") + line(1, "discount", "", "-0,50"));
    expect(problems[0]?.reason).toBe("remise sans article");
  });
});

describe("decodeHtmlEntities", () => {
  it("décode comme html.unescape de Python, en une seule passe", () => {
    expect(decodeHtmlEntities("Huile d&#39;olive")).toBe("Huile d'olive");
    expect(decodeHtmlEntities("St M&ocirc;ret ligne &amp; pla")).toBe("St Môret ligne & pla");
    expect(decodeHtmlEntities("&amp;#320457510")).toBe("&#320457510");
    expect(decodeHtmlEntities("&#320457510")).toBe("�");
    expect(decodeHtmlEntities("&eacutepice")).toBe("épice");
    expect(decodeHtmlEntities("&inconnu;")).toBe("&inconnu;");
  });
});

describe("parseQuantity", () => {
  // Mêmes cas que tests/test_catalog.py.
  it.each([
    ["Pomme de terre 1,5kg", { value: 1500, unit: "g" }],
    ["Pomme de terre 2.5 kg", { value: 2500, unit: "g" }],
    ["Vittel 6x1,5l", { value: 9000, unit: "ml" }],
    ["Maïs doux 3x140 g", { value: 420, unit: "g" }],
    ["Oasis sorbet 12x50ml", { value: 600, unit: "ml" }],
    ["Steaks x 2 charolais 300 g", { value: 300, unit: "g" }],
    ["Oeufs plein air x12", { value: 12, unit: "piece" }],
    ["Herta LBP 4+2T", { value: 6, unit: "piece" }],
    ["FM Jambon Sup 4T", { value: 4, unit: "piece" }],
    ["Fleury Michon surimi 28 bâtonnets", { value: 28, unit: "piece" }],
    ["Tortilla wraps 6x25", { value: 6, unit: "piece" }],
    ["4 pavés de saumon", { value: 4, unit: "piece" }],
    ["Nems Porc *4", { value: 4, unit: "piece" }],
    ["Avocat 3 fruits", { value: 3, unit: "piece" }],
    ["400 g e", { value: 400, unit: "g" }],
    ["1 l", { value: 1000, unit: "ml" }],
    ["Bier Abbaye 6,2%", null],
    ["Crème fraîche 30%", null],
    ["Concombre", null],
  ])("%s", (text, expected) => {
    expect(parseQuantity(text)).toEqual(expected);
  });
});
