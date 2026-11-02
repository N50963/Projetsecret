/**
 * Nombre d'articles à acheter (lignes de la liste de courses, un article demandé par deux plats compte une fois),
 * affiché en pastille sur l'onglet Courses de la barre du bas. L'accueil et la liste le mettent à jour à chaque lecture ;
 * la fiche recette le relit après un ajout.
 */
import { useSyncExternalStore } from "react";

import { getShoppingList, type ShoppingItem } from "../modules/planning";
import { shoppingLines } from "./shopping";
import { supabase } from "./supabase";

let count = 0;
const listeners = new Set<() => void>();

export function setShoppingCount(n: number) {
  if (n === count) return;
  count = n;
  listeners.forEach((l) => l());
}

/** Lignes encore à acheter : articles des menus à venir (ou ajoutés depuis une fiche), ni cochés ni trouvés sur un ticket. */
export const toBuyLines = (items: ShoppingItem[]) => shoppingLines(items.filter((i) => i.active && !i.boughtAt && !i.checkedAt));

export async function refreshShoppingCount(householdId: string) {
  setShoppingCount(toBuyLines(await getShoppingList(supabase, householdId)).length);
}

export function useShoppingCount(): number {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => count, () => count);
}
