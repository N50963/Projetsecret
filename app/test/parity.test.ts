/**
 * Parité avec le parseur Python sur de vrais tickets. Les données sont personnelles et ne sont pas versionnées :
 * le test ne s'exécute que si LIDL_PARITY_DIR pointe vers un dossier contenant receipts.json et quantities.json
 * (générés à partir de services/lidl/lidl_parse.py et services/catalog/quantity.py).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseQuantity } from "../src/modules/lidl-sync/quantity";
import { parseReceipt, payableCents } from "../src/modules/lidl-sync/receiptParser";

const dir = process.env.LIDL_PARITY_DIR;
const available = !!dir && existsSync(join(dir, "receipts.json"));

describe.skipIf(!available)("parité avec Python sur les tickets réels", () => {
  it("donne les mêmes lignes, libellés et montants pour chaque ticket", () => {
    const expected = JSON.parse(readFileSync(join(dir as string, "receipts.json"), "utf8")) as Record<string, any>;
    let checked = 0;
    for (const [id, exp] of Object.entries(expected)) {
      const html = JSON.parse(readFileSync(exp.file, "utf8")).htmlPrintedReceipt as string;
      const { items, problems } = parseReceipt(html);
      expect(problems.length, id).toBe(exp.problems);
      expect(payableCents(html), id).toBe(exp.payable);
      expect(items, id).toEqual(exp.items);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("lit les mêmes contenances pour chaque libellé de produit", () => {
    const expected = JSON.parse(readFileSync(join(dir as string, "quantities.json"), "utf8")) as Record<string, any>;
    const mismatches = Object.entries(expected).filter(([name, q]) => JSON.stringify(parseQuantity(name)) !== JSON.stringify(q));
    expect(mismatches).toEqual([]);
  });
});
