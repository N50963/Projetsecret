/**
 * Moteur de menus : pour chaque repas demandé, propose d'abord jusqu'à 5 recettes réalisables avec les achats (tour 1),
 * puis des recettes avec 1 à 3 ingrédients à acheter (tour 2), en respectant les préférences du foyer et en visant
 * l'équilibre et la variété de la semaine. Fonctions pures, testées sans base.
 */

import { maxSpicinessFor } from "../recipes/preferences";
import { currentSeason } from "../recipes/repository";
import type { MainProtein } from "../recipes/types";
import { addDays, AVAILABLE_RATIO, dayDiff, neededQuantity, Stock, TIGHT_RATIO } from "./stock";
import type {
  BalanceTargets, IsoDate, MealSlot, MissingIngredient, PlannerContext, PlannerRecipe, Proposal, ServedMeal,
} from "./types";

/** Repères pour 7 repas : poisson 2 fois, viande rouge 2 fois au plus, légumineuses au moins une fois. */
export const DEFAULT_TARGETS: BalanceTargets = { fishMin: 2, redMeatMax: 2, poultryMax: 3, legumesMin: 1, repeatDays: 21 };
/** Tour 1 : jusqu'à 5 plats réalisables avec les achats, avant tout plat qui demande des courses. */
export const PROPOSALS_FROM_STOCK = 5;
/** Tour 2 : plats avec quelques ingrédients à acheter. */
export const PROPOSALS_PER_ROUND = 3;
/** Au tour 2, nombre maximal d'ingrédients à acheter. */
export const MAX_MISSING = 3;

const FISH: MainProtein[] = ["poisson", "fruits_de_mer"];
const RED_MEAT: MainProtein[] = ["boeuf", "porc"];
const STARCH_FAMILY: Record<string, string> = {
  pates: "pates", pates_fraiches: "pates", pates_farcies: "pates", lasagne: "pates", gnocchi: "gnocchi", riz: "riz",
  pomme_de_terre: "pomme_de_terre", frites_surgelees: "pomme_de_terre", couscous: "semoule", cereale_cuisson: "semoule",
  nouilles: "nouilles", feuille_riz: "nouilles", pain: "pain", pain_de_mie: "pain", pain_burger_pita: "pain",
  tortilla_wrap: "pain", galette_sarrasin: "pain",
};
/** Groupes exclus par le foyer, reconnus d'après la protéine principale ou les ingrédients. */
/** Ingrédients du référentiel qui contiennent du porc (charcuterie, saucisses, cordon bleu au jambon…) ou du bœuf / veau. */
const PORK = /^(porc_|jambon_|lardons|chorizo|saucisson|saucisse|rillettes|charcuterie_tranchee|boudin_blanc|cordon_bleu)/;
const BEEF = /^(boeuf_|corned_beef|veau_)/;
const uses = (r: PlannerRecipe, pattern: RegExp) => r.ingredients.some((i) => !i.optional && pattern.test(i.slug ?? ""));

/**
 * Aliments que le foyer ne veut jamais : la viande principale du plat, mais aussi ses ingrédients (un cordon bleu de
 * volaille contient du jambon, une quiche des lardons). Un ingrédient facultatif peut être laissé de côté.
 */
const FOOD_GROUP_TEST: Record<string, (r: PlannerRecipe) => boolean> = {
  porc: (r) => r.mainProtein === "porc" || uses(r, PORK),
  boeuf: (r) => r.mainProtein === "boeuf" || uses(r, BEEF),
  poisson: (r) => r.mainProtein === "poisson" || r.allergens.includes("poisson"),
  crustaces: (r) => r.allergens.includes("crustaces"),
  champignons: (r) => r.ingredients.some((i) => !i.optional && (i.slug ?? "").startsWith("champignon")),
  agneau: (r) => r.ingredients.some((i) => !i.optional && (i.slug ?? "").startsWith("agneau")),
  abats: (r) => r.ingredients.some((i) => !i.optional && /^(foie|rognon|abat)/.test(i.slug ?? "")),
  coquillages: (r) => r.ingredients.some((i) => !i.optional && /^(moule|coque|saint_jacques|coquillage|palourde|huitre)/.test(i.slug ?? "")),
};

/** Ordre des repas : par date, le déjeuner avant le dîner. */
const mealKey = (m: { date: IsoDate; mealType?: string }) => `${m.date}:${m.mealType === "dejeuner" ? 0 : 1}`;

export interface SlotPlan {
  slotId: string;
  round: 1 | 2;
  proposals: Proposal[];
}

export interface PlanOptions {
  /** Tour demandé par repas (2 après refus de toutes les propositions du tour 1). */
  rounds?: Record<string, 1 | 2>;
  count?: number;
  /** Ingrédient imposé par repas (menu du jour choisi d'après un ingrédient acheté ou à acheter). */
  mustInclude?: Record<string, string>;
  /** Nombre de repas de la semaine pour les repères d'équilibre (par défaut : les repas demandés). */
  mealsInPlan?: number;
  /**
   * Menu du jour prioritaire : il puise dans ce qui est à la maison, même ce qui est compté pour un repas prévu plus
   * tard (le foyer est prévenu ensuite, voir `shortagesAfter`). Par défaut, les repas choisis réservent leurs ingrédients.
   */
  todayFirst?: boolean;
}

interface Evaluation {
  recipe: PlannerRecipe;
  missing: MissingIngredient[];
  usesPurchased: string[];
  urgent: string[];
  tight: string[];
}

function targetsFor(ctx: PlannerContext, mealsInPlan: number): BalanceTargets & { meatlessMin: number; meatlessMax: number } {
  const t = { ...DEFAULT_TARGETS, ...ctx.targets };
  const f = Math.max(1, mealsInPlan) / 7;
  return {
    ...t,
    fishMin: Math.round(t.fishMin * f),
    redMeatMax: Math.max(1, Math.round(t.redMeatMax * f)),
    poultryMax: Math.max(1, Math.round(t.poultryMax * f)),
    legumesMin: mealsInPlan >= 4 ? t.legumesMin : 0,
    meatlessMin: Math.round(ctx.prefs.meatlessDinnersMin * f),
    meatlessMax: Math.max(ctx.prefs.meatlessDinnersMax > 0 ? 1 : 0, Math.round(ctx.prefs.meatlessDinnersMax * f)),
  };
}

function starchOf(r: PlannerRecipe): string | null {
  for (const i of r.ingredients) if (!i.optional && i.slug && STARCH_FAMILY[i.slug]) return STARCH_FAMILY[i.slug]!;
  return null;
}

const isMeatless = (r: PlannerRecipe) => r.tags.includes("vegetarien");

/** Recette compatible avec le repas et les préférences (contraintes strictes). */
function allowed(ctx: PlannerContext, r: PlannerRecipe, slot: MealSlot, excluded: Set<string>): boolean {
  if (!r.mealTypes.includes(slot.mealType)) return false;
  if (slot.maxTotalMin !== null && r.totalMin > slot.maxTotalMin) return false;
  if (r.allergens.some((a) => ctx.prefs.excludedAllergens.includes(a))) return false;
  if (r.spiciness > maxSpicinessFor(ctx.prefs.spiceLevel)) return false;
  if (ctx.prefs.excludedFoodGroups.some((g) => FOOD_GROUP_TEST[g]?.(r))) return false;
  if (r.ingredients.some((i) => !i.optional && i.slug && ctx.prefs.dislikedIngredients.includes(i.slug))) return false;
  if (r.dislikes > r.likes) return false;
  return !excluded.has(r.id);
}

function evaluate(r: PlannerRecipe, slot: MealSlot, stock: Stock): Evaluation {
  const missing: MissingIngredient[] = [];
  const usesPurchased: string[] = [];
  const urgent: string[] = [];
  const tight: string[] = [];
  for (const ing of r.ingredients) {
    if (ing.optional || !ing.slug || ing.pantry) continue;
    const need = neededQuantity(ing, r.servings, slot.servings);
    const a = stock.available(ing.slug, slot.date);
    const enough = a.present && (need === null || a.quantity === null || a.quantity >= need * AVAILABLE_RATIO);
    if (!enough) {
      const toBuy = need === null ? null : Math.ceil(need - (a.present ? a.quantity ?? 0 : 0));
      missing.push({ slug: ing.slug, label: ing.label, quantity: toBuy && toBuy > 0 ? toBuy : null, unit: ing.baseUnit });
      continue;
    }
    usesPurchased.push(ing.label);
    if (need !== null && a.quantity !== null && a.quantity < need * TIGHT_RATIO) tight.push(ing.label);
    if (a.expiresAt && dayDiff(slot.date, a.expiresAt) <= 1) urgent.push(ing.label);
  }
  return { recipe: r, missing, usesPurchased, urgent, tight };
}

function consumeRecipe(stock: Stock, r: PlannerRecipe, meal: { date: IsoDate; servings: number }) {
  for (const ing of r.ingredients) {
    if (ing.optional || !ing.slug || ing.pantry) continue;
    stock.consume(ing.slug, neededQuantity(ing, r.servings, meal.servings), meal.date);
  }
}

interface WeekState {
  /** Repas de la planification déjà fixés (acceptés ou retenus provisoirement), avec leur date. */
  meals: Array<{ recipe: PlannerRecipe; date: IsoDate; slotId?: string }>;
  /** Repas servis avant la planification (pour l'enchaînement avec les jours précédents). */
  recent: Array<{ recipe: PlannerRecipe; date: IsoDate }>;
}

function score(ctx: PlannerContext, e: Evaluation, slot: MealSlot, week: WeekState, mealsInPlan: number): { score: number; reasons: string[] } {
  const r = e.recipe;
  const t = targetsFor(ctx, mealsInPlan);
  const others = week.meals.filter((m) => m.slotId !== slot.id);
  const count = (test: (x: PlannerRecipe) => boolean) => others.filter((m) => test(m.recipe)).length;
  const reasons: string[] = [];
  let s = 0;

  // Utiliser les courses, en commençant par ce qui se conserve le moins.
  s += Math.min(5, e.usesPurchased.length);
  if (e.urgent.length) {
    s += 3 * e.urgent.length;
    reasons.push(`À cuisiner vite : ${e.urgent.join(", ")}`);
  } else if (e.usesPurchased.length >= 3) {
    reasons.push(`Utilise vos courses : ${e.usesPurchased.slice(0, 3).join(", ")}`);
  }

  // Équilibre de la semaine.
  if (FISH.includes(r.mainProtein) && count((x) => FISH.includes(x.mainProtein)) < t.fishMin) {
    s += 3;
    reasons.push("Poisson : conseillé deux fois par semaine");
  }
  if (RED_MEAT.includes(r.mainProtein) && count((x) => RED_MEAT.includes(x.mainProtein)) >= t.redMeatMax) s -= 6;
  if (r.mainProtein === "volaille" && count((x) => x.mainProtein === "volaille") >= t.poultryMax) s -= 3;
  if (isMeatless(r)) {
    const n = count(isMeatless);
    if (n < t.meatlessMin) {
      s += 3;
      reasons.push("Soir sans viande (1 à 2 par semaine)");
    } else if (n >= t.meatlessMax) s -= 6;
  }
  if (r.mainProtein === "legumineuse" && count((x) => x.mainProtein === "legumineuse") < t.legumesMin) {
    s += 2;
    reasons.push("Légumineuses : au moins une fois par semaine");
  }
  const vegetables = new Set(r.ingredients.filter((i) => !i.optional && i.category === "legume" && i.slug !== "pomme_de_terre").map((i) => i.slug));
  if (vegetables.size === 0) s -= 3;
  else if (vegetables.size >= 2) {
    s += 1.5;
    if (reasons.length < 2) reasons.push("Riche en légumes");
  }

  // Variété : pas la même protéine, le même féculent ou la même cuisine qu'un repas voisin.
  const neighbours = [...others, ...week.recent].filter((m) => Math.abs(dayDiff(slot.date, m.date)) <= 1);
  if (neighbours.some((m) => m.recipe.mainProtein === r.mainProtein)) s -= 4;
  const starch = starchOf(r);
  if (starch && neighbours.some((m) => starchOf(m.recipe) === starch)) s -= 2;
  if (r.cuisine && r.cuisine !== "francaise" && neighbours.some((m) => m.recipe.cuisine === r.cuisine)) s -= 1;

  // Goûts du foyer.
  if (r.likes > 0) {
    s += Math.min(6, 2 * r.likes);
    reasons.unshift("Vous avez aimé");
  }
  s -= Math.min(3, ctx.rejectionCounts?.[r.id] ?? 0);
  if (!r.seasons.includes(currentSeason(new Date(`${slot.date}T12:00:00`)))) s -= 4;

  if (e.tight.length) {
    s -= e.tight.length;
    reasons.push(`Quantité un peu juste : ${e.tight.join(", ")}`);
  }
  s -= 1.5 * e.missing.length;
  if (e.missing.length) reasons.push(`À acheter : ${e.missing.map((m) => m.label).join(", ")}`);
  return { score: Math.round(s * 10) / 10, reasons };
}

/**
 * Choisit les propositions en évitant d'en montrer plusieurs avec la même protéine principale. La variété se cherche
 * parmi les recettes retenues en premier (`first`) : une recette qui déséquilibre la semaine ne passe pas devant.
 */
function pickDiverse<T extends { recipe: PlannerRecipe }>(ranked: T[], count: number, first: (c: T) => boolean = () => true): T[] {
  const picked: T[] = [];
  for (const c of ranked) {
    if (picked.length >= count) break;
    if (first(c) && !picked.some((p) => p.recipe.mainProtein === c.recipe.mainProtein)) picked.push(c);
  }
  for (const c of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}

/**
 * Propositions pour tous les repas demandés, dans l'ordre du calendrier. Les repas acceptés réservent leurs ingrédients ;
 * pour les autres, la première proposition est retenue provisoirement pour équilibrer la suite de la semaine.
 */
export function planMeals(ctx: PlannerContext, slots: MealSlot[], options: PlanOptions = {}): SlotPlan[] {
  const byId = new Map(ctx.recipes.map((r) => [r.id, r]));
  const t = { ...DEFAULT_TARGETS, ...ctx.targets };
  const ordered = [...slots].sort((a, b) => a.date.localeCompare(b.date) || (a.mealType === "dejeuner" ? -1 : 1));
  const start = ordered[0]?.date;
  if (!start) return [];

  const stock = Stock.fromPurchases(ctx.purchases, { freezes: ctx.prefs.freezesFreshMeatFish });
  const known = (m: ServedMeal) => {
    const recipe = byId.get(m.recipeId);
    return recipe ? { ...m, recipe } : null;
  };
  const history = ctx.history.map(known).filter((m) => m !== null).sort((a, b) => a.date.localeCompare(b.date));
  const accepted = ctx.accepted.map(known).filter((m) => m !== null);
  for (const m of [...history, ...accepted]) {
    if (!options.todayFirst || mealKey(m) < mealKey(ordered[0]!)) consumeRecipe(stock, m.recipe, m);
  }

  const week: WeekState = {
    meals: accepted.map((m) => ({ recipe: m.recipe, date: m.date, slotId: m.slotId })),
    recent: history.filter((m) => dayDiff(m.date, start) <= 7),
  };
  const servedRecently = (date: IsoDate) => new Set(
    history.filter((m) => dayDiff(m.date, date) < t.repeatDays).map((m) => m.recipeId));
  const acceptedSlots = new Set(accepted.map((m) => m.slotId));

  const plans: SlotPlan[] = [];
  const mealsInPlan = options.mealsInPlan ?? ordered.length;
  for (const slot of ordered) {
    if (acceptedSlots.has(slot.id)) continue;
    const must = options.mustInclude?.[slot.id];
    const excluded = new Set([...servedRecently(slot.date), ...week.meals.map((m) => m.recipe.id), ...(ctx.rejected[slot.id] ?? [])]);
    const requested = options.rounds?.[slot.id] ?? 1;
    const candidates = (round: 1 | 2) => ctx.recipes
      .filter((r) => allowed(ctx, r, slot, excluded))
      .filter((r) => !must || r.ingredients.some((i) => !i.optional && i.slug === must))
      .map((r) => evaluate(r, slot, stock))
      .map((e) => ({ ...e, ...score(ctx, e, slot, week, mealsInPlan) }))
      // Tour 1 : tout ce qui se cuisine avec les achats, les recettes qui équilibrent la semaine en tête (celles qui la
      // déséquilibrent passent après, mais avant tout plat qui demande des courses). Tour 2 : 1 à 3 ingrédients à acheter.
      .filter((c) => (round === 1 ? c.missing.length === 0 : c.missing.length >= 1 && c.missing.length <= MAX_MISSING))
      .sort((a, b) => b.score - a.score || a.recipe.totalMin - b.recipe.totalMin);

    let round: 1 | 2 = requested;
    let ranked = candidates(round);
    if (!ranked.length && round === 1) {
      round = 2;
      ranked = candidates(2);
    }
    const count = options.count ?? (round === 1 ? PROPOSALS_FROM_STOCK : PROPOSALS_PER_ROUND);
    const proposals: Proposal[] = pickDiverse(ranked, count, round === 1 ? (c) => c.score >= 0 : undefined).map((c) => ({
      recipeId: c.recipe.id, versionId: c.recipe.versionId, name: c.recipe.name, totalMin: c.recipe.totalMin,
      mainProtein: c.recipe.mainProtein, round, score: c.score, missing: c.missing, usesPurchased: c.usesPurchased, reasons: c.reasons,
    }));
    plans.push({ slotId: slot.id, round, proposals });

    const first = proposals[0] && byId.get(proposals[0].recipeId);
    if (first) {
      consumeRecipe(stock, first, slot);
      week.meals.push({ recipe: first, date: slot.date, slotId: slot.id });
    }
  }
  return plans;
}

/** Ingrédients à acheter pour cuisiner une recette donnée à ce repas (recette ajoutée ou proposée par Mistral). */
export function missingForSlot(ctx: PlannerContext, recipe: PlannerRecipe, slot: MealSlot, options: { todayFirst?: boolean } = {}): MissingIngredient[] {
  const byId = new Map([...ctx.recipes, recipe].map((r) => [r.id, r]));
  const stock = Stock.fromPurchases(ctx.purchases, { freezes: ctx.prefs.freezesFreshMeatFish });
  for (const m of [...ctx.history, ...ctx.accepted].sort((a, b) => a.date.localeCompare(b.date))) {
    const r = byId.get(m.recipeId);
    if (r && m.slotId !== slot.id && (!options.todayFirst || mealKey(m) < mealKey(slot))) consumeRecipe(stock, r, m);
  }
  return evaluate(recipe, slot, stock).missing;
}

/** Repas choisi plus tard qui n'aura plus assez d'ingrédients une fois le nouveau repas cuisiné. */
export interface Shortage {
  slotId: string;
  recipeId: string;
  date: IsoDate;
  mealType: MealSlot["mealType"];
  /** Ingrédients qui manqueront (en plus de ce qui manquait déjà). */
  missing: MissingIngredient[];
}

/**
 * Repas déjà choisis pour plus tard qui manqueront d'un ingrédient si l'on cuisine `chosen` : les courses de la semaine
 * sont consommées repas après repas, dans l'ordre du calendrier, avec et sans ce repas (mêmes règles que les propositions).
 */
export function shortagesAfter(ctx: PlannerContext, chosen: ServedMeal): Shortage[] {
  const byId = new Map(ctx.recipes.map((r) => [r.id, r]));
  const added = byId.get(chosen.recipeId);
  if (!added) return [];
  const meals = [...ctx.history, ...ctx.accepted.filter((m) => m.slotId !== chosen.slotId)]
    .filter((m) => byId.has(m.recipeId)).sort((a, b) => mealKey(a).localeCompare(mealKey(b)));
  const run = (withChosen: boolean) => {
    const stock = Stock.fromPurchases(ctx.purchases, { freezes: ctx.prefs.freezesFreshMeatFish });
    const missing = new Map<string, MissingIngredient[]>();
    let pending = withChosen;
    for (const m of meals) {
      const later = mealKey(m) > mealKey(chosen);
      if (pending && later) {
        consumeRecipe(stock, added, chosen);
        pending = false;
      }
      const recipe = byId.get(m.recipeId)!;
      if (later && m.slotId) {
        const slot: MealSlot = { id: m.slotId, date: m.date, mealType: m.mealType ?? "diner", maxTotalMin: null, servings: m.servings };
        missing.set(m.slotId, evaluate(recipe, slot, stock).missing);
      }
      consumeRecipe(stock, recipe, m);
    }
    return missing;
  };
  const before = run(false);
  const after = run(true);
  const shortages: Shortage[] = [];
  for (const m of meals) {
    if (!m.slotId || !after.has(m.slotId)) continue;
    const had = new Set((before.get(m.slotId) ?? []).map((x) => x.slug));
    const lacking = after.get(m.slotId)!.filter((x) => !had.has(x.slug));
    if (lacking.length) shortages.push({ slotId: m.slotId, recipeId: m.recipeId, date: m.date, mealType: m.mealType ?? "diner", missing: lacking });
  }
  return shortages;
}

/** Les jours d'une semaine de planification, à partir d'une date. */
export function weekDates(start: IsoDate, days = 7): IsoDate[] {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}
