/**
 * Recherche de recettes sans tenir compte de la casse ni des accents : « boeuf » trouve « Bœuf bourguignon », « creme »
 * trouve « Crème brûlée », « ECHALOTE » trouve « Bavette à l'échalote ». Fonctions pures (testées sans réseau).
 */

/** Texte sans accents ni majuscules, ligatures séparées (œ → oe, æ → ae), apostrophes typographiques unifiées. */
export function foldText(s: string): string {
  return s
    .replace(/[œŒ]/g, "oe").replace(/[æÆ]/g, "ae")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’‘`´]/g, "'")
    .toLowerCase();
}

/** Clé de recherche : texte replié, tirets et apostrophes comptés comme des espaces (« poireaux-pommes » = « poireaux pommes »). */
function searchKey(s: string): string {
  return foldText(s).replace(/[-'_.,;:!?()]/g, " ").replace(/\s+/g, " ").trim();
}

/** Le nom contient-il le texte cherché (sans tenir compte de la casse ni des accents) ? Texte vide : toujours vrai. */
export function matchesSearch(name: string, query: string): boolean {
  const q = searchKey(query);
  return !q || searchKey(name).includes(q);
}
