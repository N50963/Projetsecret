import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SwipeCard, type SwipeDirection } from "../components/SwipeCard";
import { Icon } from "../components/icons";
import { Button, ErrorText, Loading, Pill, Screen, Tag } from "../components/ui";
import { dayLabel, mealLabel, minutes, proteinLabel } from "../lib/format";
import { forgetIllustration, illustrationUrls, pictureOf, preloadPictures, sourceOf, type Picture } from "../lib/images";
import { draftToInput, generateRecipes, illustrateRecipe, type Draft } from "../lib/mistral";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import {
  acceptProposal, addDays, addShoppingItems, DEFAULT_TARGETS, getPlanSlots, getSlotsFrom, ingredientsInRecipes, loadPlannerContext, loadRecipesForPlanning,
  missingForSlot, neededQuantity, planMeals, recordShown, rejectProposal, shortagesAfter, skipSlot, Stock, toIsoDate,
  type MissingIngredient, type PlannedSlot, type PlannerContext, type Proposal, type ServedMeal, type Shortage,
} from "../modules/planning";
import { createRecipe, currentSeason, type MainProtein } from "../modules/recipes";

/** Résumé de l'équilibre de la semaine pour orienter les idées de Mistral. */
function balanceBrief(ctx: PlannerContext, mealsInPlan: number): string {
  const byId = new Map(ctx.recipes.map((r) => [r.id, r]));
  const chosen = ctx.accepted.map((m) => byId.get(m.recipeId)).filter((r) => r !== undefined);
  const f = Math.max(1, mealsInPlan) / 7;
  const fish = chosen.filter((r) => r.mainProtein === "poisson" || r.mainProtein === "fruits_de_mer").length;
  const red = chosen.filter((r) => r.mainProtein === "boeuf" || r.mainProtein === "porc").length;
  const veg = chosen.filter((r) => r.tags.includes("vegetarien")).length;
  const wanted: string[] = [];
  if (fish < Math.round(DEFAULT_TARGETS.fishMin * f)) wanted.push("du poisson");
  if (veg < Math.round(ctx.prefs.meatlessDinnersMin * f)) wanted.push("un plat sans viande ni poisson");
  if (red >= Math.max(1, Math.round(DEFAULT_TARGETS.redMeatMax * f))) wanted.push("pas de viande rouge");
  return `Déjà choisis cette semaine : ${chosen.map((r) => r.name).join(", ") || "rien"}. `
    + `Poisson ${fish}, viande rouge ${red}, sans viande ${veg}. ${wanted.length ? `À privilégier : ${wanted.join(", ")}.` : ""} `
    + "Toujours des légumes, un féculent varié, rien de frit.";
}

/**
 * Trois protéines différentes pour les idées de Mistral (une demande par idée) : d'abord celles qui manquent à l'équilibre
 * de la semaine, jamais celles que le foyer exclut.
 */
function ideaProteins(ctx: PlannerContext, mealsInPlan: number): MainProtein[] {
  const byId = new Map(ctx.recipes.map((r) => [r.id, r]));
  const chosen = ctx.accepted.map((m) => byId.get(m.recipeId)).filter((r) => r !== undefined);
  const f = Math.max(1, mealsInPlan) / 7;
  const count = (proteins: MainProtein[]) => chosen.filter((r) => proteins.includes(r.mainProtein)).length;
  const needed: MainProtein[] = [];
  if (count(["poisson", "fruits_de_mer"]) < Math.round(DEFAULT_TARGETS.fishMin * f)) needed.push("poisson");
  if (count(["vegetarien", "legumineuse", "oeuf"]) < Math.round(ctx.prefs.meatlessDinnersMin * f)) needed.push("vegetarien");
  const excluded = new Set<string>(ctx.prefs.excludedFoodGroups);
  const allowed = (p: MainProtein) => !(p === "porc" && excluded.has("porc")) && !(p === "boeuf" && excluded.has("boeuf"))
    && !(p === "poisson" && excluded.has("poisson")) && !(p === "fruits_de_mer" && (excluded.has("crustaces") || excluded.has("coquillages")));
  const order: MainProtein[] = [...needed, "volaille", "vegetarien", "poisson", "legumineuse", "boeuf", "porc", "oeuf"];
  return [...new Set(order)].filter(allowed).slice(0, 3);
}

/** Idées de Mistral pour un repas : chacune arrive dès qu'elle est prête. */
interface Ideas {
  slotId: string;
  drafts: Draft[];
  pending: number;
  failed: string | null;
}

/** Écart entre les demandes d'idées envoyées ensemble (limite de débit de l'offre gratuite de Mistral). */
const IDEA_STAGGER_MS = 1500;

/** Idées de Mistral autour d'un ingrédient imposé : trois façons de le cuisiner. */
const INGREDIENT_STYLES = ["un plat mijoté ou au four", "un plat rapide à la poêle ou au wok", "une salade composée, un gratin ou une tarte"];

interface Focus {
  /** Repas du menu du jour choisi d'après un ingrédient. */
  slotId: string;
  ingredient: { slug: string; name: string } | null;
  /** L'ingrédient est à acheter : il rejoint la liste de courses avec le menu choisi. */
  toBuy: boolean;
}

/**
 * Propositions de menus, repas par repas (swipe, tours avec les courses puis quelques achats, idées de Mistral).
 * Menu du jour (paramètre `slot`, éventuellement `ingredient`) : un seul repas, d'après un ingrédient acheté ou à acheter ;
 * une fois choisi, si un repas prévu plus tard manque d'un ingrédient déjà compté, le foyer choisit de le remplacer
 * (nouvelles propositions selon ce qui reste) ou de le garder (ingrédients ajoutés à la liste de courses) ; la fiche du
 * menu du jour s'ouvre ensuite.
 */
export default function Propositions() {
  const params = useLocalSearchParams<{ plan: string; start: string; slot?: string; ingredient?: string; buy?: string }>();
  const { plan: planId, start } = params;
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const today = toIsoDate(new Date());

  const [slots, setSlots] = useState<PlannedSlot[] | null>(null);
  const [ctx, setCtx] = useState<PlannerContext | null>(null);
  const [round, setRound] = useState<1 | 2>(1);
  const [deck, setDeck] = useState<Proposal[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [ideas, setIdeas] = useState<Ideas | null>(null);
  /** Idées déjà montrées (refusées) pour le repas courant. */
  const [seen, setSeen] = useState(0);
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<Focus | null>(null);
  /** Menu du jour : repas encore à choisir (le menu du jour, puis ceux qu'on remplace). */
  const [pending, setPending] = useState<string[]>([]);
  /** Repas prévus plus tard qui manqueront d'un ingrédient, en attente d'une décision. */
  const [shortages, setShortages] = useState<Shortage[]>([]);
  /** Repas à remplacer et ce qui leur manquera s'ils sont gardés. */
  const [replacing, setReplacing] = useState<Record<string, MissingIngredient[]>>({});
  const [chosenToday, setChosenToday] = useState<string | null>(null);
  const [info, setInfo] = useState("");
  const swipe = useRef<((d: SwipeDirection) => void) | null>(null);
  // Une seule illustration demandée à la fois ; plus aucune pendant la session si Mistral refuse (quota gratuit).
  const illustrating = useRef(false);
  const imagesPaused = useRef(false);
  const ideaTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // Demandes à Mistral abandonnées dès qu'elles ne servent plus : sur Android, 5 connexions au plus vers Supabase, et une
  // demande à Mistral (20 à 60 s) en occupe une ; laissées en cours, elles retardaient l'enregistrement des choix suivants.
  const ideaAbort = useRef<AbortController | null>(null);
  const illustrateAbort = useRef<AbortController | null>(null);
  // Choix enregistrés en arrière-plan : le menu suivant s'affiche tout de suite.
  const writes = useRef<Array<Promise<unknown>>>([]);
  const failures = useRef(0);
  /** Double toucher sur « Je choisis » : le second ne choisit pas aussi le menu du repas suivant. */
  const lastChoice = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        // Menu du jour : tous les repas à partir d'aujourd'hui (un repas à remplacer peut relever d'une autre planification).
        const [s, context] = await Promise.all([
          params.slot ? getSlotsFrom(supabase, household.id, start) : getPlanSlots(supabase, planId),
          loadPlannerContext(supabase, household.id, start, planId),
        ]);
        let ready = context;
        const target = params.slot ? s.find((x) => x.id === params.slot) : undefined;
        if (target) {
          let ingredient: Focus["ingredient"] = null;
          if (params.ingredient) {
            const info = (await ingredientsInRecipes(supabase)).find((o) => o.slug === params.ingredient);
            ingredient = { slug: params.ingredient, name: info?.name ?? params.ingredient };
            // Ingrédient indiqué par le foyer (acheté hors ticket, ou à acheter) : disponible pour ce repas.
            const stock = Stock.fromPurchases(context.purchases, { freezes: context.prefs.freezesFreshMeatFish });
            if (!stock.available(params.ingredient, target.date).present) {
              ready = { ...context, purchases: [...context.purchases,
                { slug: params.ingredient, category: info?.category ?? "conserve", quantity: null, unit: null, purchasedAt: target.date }] };
            }
          }
          setFocus({ slotId: target.id, ingredient, toBuy: params.buy === "1" });
          setPending([target.id]);
        }
        setSlots(s);
        setCtx(ready);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [planId, start, household.id]);

  const ordered = useMemo(() => (slots ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.mealType === "dejeuner" ? -1 : 1)), [slots]);
  const current = focus ? (shortages.length ? null : ordered.find((s) => s.id === pending[0]) ?? null) : ordered.find((s) => s.status === "open") ?? null;
  const done = ordered.filter((s) => s.status !== "open").length;
  /** Menu du jour : repas de la semaine (déjà choisis et celui-ci), pour les repères d'équilibre. */
  const weekMeals = useMemo(() => {
    if (!focus || !ctx || !current) return ordered.length;
    return ctx.accepted.filter((m) => m.slotId !== current.id && m.date >= start && m.date <= addDays(start, 6)).length + 1;
  }, [focus, ctx, current, ordered.length, start]);
  const isFocusSlot = Boolean(focus && current && current.id === focus.slotId);

  // Paquet de propositions pour le repas courant (recalculé à chaque repas et à chaque tour).
  useEffect(() => {
    if (!ctx || !current) return;
    // Menu du jour : un seul repas ; s'il avait déjà un menu, celui-ci ne compte pas (il peut être remplacé).
    const planCtx = focus ? { ...ctx, accepted: ctx.accepted.filter((m) => m.slotId !== current.id) } : ctx;
    // Seul le repas affiché est calculé : les repas précédents sont déjà choisis ou passés, et les suivants le seront
    // d'après ce choix. Recalculer toute la semaine à chaque choix (14 repas × 144 recettes) ralentissait la validation.
    const plan = planMeals(planCtx, [current], {
      rounds: { [current.id]: round }, mealsInPlan: focus ? weekMeals : ordered.length, todayFirst: Boolean(focus),
      mustInclude: isFocusSlot && focus?.ingredient ? { [current.id]: focus.ingredient.slug } : undefined,
    });
    const entry = plan.find((p) => p.slotId === current.id);
    const proposals = entry?.proposals ?? [];
    // Photos des propositions de ce repas mises en mémoire : elles s'affichent dès que la carte apparaît.
    preloadPictures(proposals.map((p) => p.recipeId));
    if (entry && entry.round !== round) setRound(entry.round);
    setDeck(proposals);
    setExhausted(!proposals.length);
    recordShown(supabase, household.id, current.id, proposals).catch(() => undefined);
    illustrationUrls(proposals.map((p) => p.recipeId)).then((urls) => setImages((prev) => ({ ...prev, ...urls }))).catch(() => undefined);
    // Le paquet ne dépend que du repas, du tour et des choix acceptés (pas des refus en cours).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, round, ctx?.accepted.length, ctx?.recipes.length]);

  const shown = deck[0]?.recipeId;
  useEffect(() => {
    if (!shown || images[shown] !== null || illustrating.current || imagesPaused.current) return;
    illustrating.current = true;
    const ctrl = new AbortController();
    illustrateAbort.current = ctrl;
    illustrateRecipe(household.id, shown, ctrl.signal)
      .then(async () => {
        forgetIllustration(shown);
        const urls = await illustrationUrls([shown]);
        setImages((prev) => ({ ...prev, ...urls }));
      })
      .catch(() => {
        if (!ctrl.signal.aborted) imagesPaused.current = true;
      })
      .finally(() => {
        illustrating.current = false;
      });
  }, [shown, images, household.id]);
  // Autre carte : l'image de la précédente n'est plus attendue.
  useEffect(() => () => illustrateAbort.current?.abort(), [shown]);

  // Tous les repas ont leur menu : retour au calendrier de l'accueil (photos et menus de la semaine).
  useEffect(() => {
    if (!slots || !ctx || current || shortages.length) return;
    // Les choix en cours d'enregistrement sont attendus ; un échec rouvre son repas (et l'on ne quitte pas l'écran).
    let live = true;
    const failed = failures.current;
    Promise.all(writes.current).then(() => {
      if (!live || failures.current !== failed) return;
      // Menu du jour choisi : la suite est celle de tout menu, avec la fiche de préparation et ses étapes.
      if (focus && chosenToday) router.replace(`/recette/${chosenToday}`);
      else if (router.canGoBack()) router.back();
      else router.replace("/");
    });
    return () => {
      live = false;
    };
  }, [slots, ctx, current, router, shortages.length, focus, chosenToday]);

  const next = useCallback(() => {
    setDeck((d) => {
      const rest = d.slice(1);
      if (!rest.length) {
        if (round === 1) setRound(2);
        else setExhausted(true);
      }
      return rest;
    });
  }, [round]);

  const markSlot = (slotId: string, status: PlannedSlot["status"], recipeId: string | null = null) =>
    setSlots((s) => (s ?? []).map((x) => (x.id === slotId ? { ...x, status, recipeId } : x)));

  /** Enregistrement en arrière-plan ; en cas d'échec, le repas est rouvert pour être choisi de nouveau. */
  const track = (write: Promise<unknown>, slotId: string) => {
    writes.current.push(write.catch((e) => {
      failures.current += 1;
      setError(`Choix non enregistré (${e instanceof Error ? e.message : String(e)}) : choisissez de nouveau ce repas.`);
      markSlot(slotId, "open");
      setCtx((c) => (c ? { ...c, accepted: c.accepted.filter((m) => m.slotId !== slotId) } : c));
      if (focus) {
        setPending((p) => (p.includes(slotId) ? p : [slotId, ...p]));
        if (slotId === focus.slotId) setChosenToday(null);
      }
    }));
  };

  /** Menu du jour d'après un ingrédient à acheter : il rejoint la liste de courses avec les autres manques. */
  const withIngredient = (missing: MissingIngredient[], recipeId: string, context: PlannerContext): MissingIngredient[] => {
    if (!isFocusSlot || !focus?.toBuy || !focus.ingredient || !current) return missing;
    if (missing.some((m) => m.slug === focus.ingredient!.slug)) return missing;
    const recipe = context.recipes.find((r) => r.id === recipeId);
    const ing = recipe?.ingredients.find((i) => i.slug === focus.ingredient!.slug);
    const need = ing && recipe ? neededQuantity(ing, recipe.servings, current.servings) : null;
    return [...missing, { slug: focus.ingredient.slug, label: ing?.label ?? focus.ingredient.name, quantity: need ? Math.ceil(need) : null, unit: ing?.baseUnit ?? null }];
  };

  /**
   * Menu choisi : il réserve ses ingrédients. Menu du jour : les repas prévus plus tard qui n'auront plus assez d'un
   * ingrédient sont signalés, puis la fiche du menu s'ouvre.
   */
  const chosen = (recipeId: string, context: PlannerContext) => {
    if (!current) return context;
    const meal: ServedMeal = { recipeId, date: current.date, servings: current.servings, slotId: current.id, mealType: current.mealType };
    const next = { ...context, accepted: [...context.accepted.filter((m) => m.slotId !== current.id), meal] };
    setCtx(next);
    markSlot(current.id, "accepted", recipeId);
    setRound(1);
    if (focus) {
      if (current.id === focus.slotId) setChosenToday(recipeId);
      const later = shortagesAfter(next, meal).filter((x) => !pending.slice(1).includes(x.slotId));
      setShortages((prev) => [...prev.filter((x) => x.slotId !== current.id && !later.some((l) => l.slotId === x.slotId)), ...later]);
      setPending((p) => p.slice(1));
      setReplacing(({ [current.id]: _done, ...rest }) => rest);
    }
    return next;
  };

  const onSwipe = async (p: Proposal, direction: SwipeDirection) => {
    if (!current || !ctx) return;
    setError("");
    if (direction === "left") {
      setCtx({ ...ctx, rejected: { ...ctx.rejected, [current.id]: [...(ctx.rejected[current.id] ?? []), p.recipeId] } });
      next();
      rejectProposal(supabase, household.id, current.id, p).catch((e) => setError(String(e)));
      return;
    }
    if (Date.now() - lastChoice.current < 450) return;
    lastChoice.current = Date.now();
    // Le menu suivant s'affiche tout de suite ; le choix s'enregistre en arrière-plan.
    const missing = withIngredient(p.missing, p.recipeId, ctx);
    const slotId = current.id;
    chosen(p.recipeId, ctx);
    track(acceptProposal(supabase, slotId, { recipeId: p.recipeId, missing }), slotId);
  };

  /**
   * Demande 3 idées à Mistral pour un repas, une par protéine, envoyées presque ensemble : la première arrive en 20 à 30 s
   * (contre près d'une minute pour 3 idées d'un coup) et s'affiche aussitôt.
   */
  const startIdeas = useCallback((slot: PlannedSlot, context: PlannerContext) => {
    // Une seule série d'idées à la fois : la précédente est abandonnée.
    ideaAbort.current?.abort();
    ideaTimers.current.forEach(clearTimeout);
    ideaTimers.current = [];
    const ctrl = new AbortController();
    ideaAbort.current = ctrl;
    const meals = focus ? weekMeals : ordered.length;
    const ingredient = focus && slot.id === focus.slotId ? focus.ingredient : null;
    // Autour d'un ingrédient imposé, trois façons de le cuisiner (la protéine en découle) ; sinon trois protéines.
    const variants: Array<{ protein?: MainProtein; hint: string }> = ingredient
      ? INGREDIENT_STYLES.map((hint) => ({ hint: `Ingrédient imposé : ${ingredient.name} (${focus?.toBuy ? "le foyer va l'acheter" : "déjà acheté"}), `
        + `utilisé comme ingrédient principal. Façon : ${hint}. ` }))
      : ideaProteins(context, meals).map((protein) => ({ protein, hint: "" }));
    const avoid = [...(context.rejected[slot.id] ?? []), ...context.accepted.map((m) => m.recipeId)]
      .map((id) => context.recipes.find((r) => r.id === id)?.name).filter((n): n is string => Boolean(n));
    const brief = balanceBrief(context, meals);
    const season = currentSeason(new Date(`${slot.date}T12:00:00`));
    const forSlot = (update: (i: Ideas) => Ideas) => setIdeas((i) => (i?.slotId === slot.id ? update(i) : i));
    setIdeas({ slotId: slot.id, drafts: [], pending: variants.length, failed: null });
    setSeen(0);
    variants.forEach(({ protein, hint }, n) => ideaTimers.current.push(setTimeout(() => {
      generateRecipes(household.id, {
        brief: `${hint}${brief}`, count: 1, servings: slot.servings,
        constraints: { max_total_min: slot.maxTotalMin, meal_type: slot.mealType, season, main_protein: protein, avoid },
      }, ctrl.signal)
        .then(({ recipes }) => forSlot((i) => ({ ...i, pending: i.pending - 1,
          drafts: [...i.drafts, ...recipes.filter((d) => d.recipe.name && d.recipe.ingredients.length >= 3)] })))
        .catch((e) => {
          if (!ctrl.signal.aborted) forSlot((i) => ({ ...i, pending: i.pending - 1, failed: e instanceof Error ? e.message : String(e) }));
        });
    }, n * IDEA_STAGGER_MS)));
  }, [household.id, ordered.length, focus, weekMeals]);

  // Dès les propositions avec achats (ou quand il n'y a plus rien à proposer), les idées sont préparées en arrière-plan.
  useEffect(() => {
    if (current && ctx && (round === 2 || exhausted) && ideas?.slotId !== current.id) startIdeas(current, ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, round, exhausted]);

  // Repas suivant (ou écran quitté) : les idées encore en préparation pour ce repas sont abandonnées.
  useEffect(() => () => {
    ideaAbort.current?.abort();
    ideaTimers.current.forEach(clearTimeout);
    ideaTimers.current = [];
  }, [current?.id]);

  const onDraftSwipe = async (d: Draft, direction: SwipeDirection) => {
    if (!current || !ctx) return;
    if (direction === "left") {
      setSeen((n) => n + 1);
      return;
    }
    setBusy("accept");
    setError("");
    // Les autres idées en préparation ne servent plus : leurs connexions sont libérées pour l'enregistrement.
    ideaAbort.current?.abort();
    try {
      const recipeId = await createRecipe(supabase, household.id, draftToInput(d.recipe, "mistral"));
      const recipes = await loadRecipesForPlanning(supabase, household.id);
      const recipe = recipes.find((r) => r.id === recipeId);
      const base = { ...ctx, recipes, accepted: ctx.accepted.filter((m) => m.slotId !== current.id) };
      const missing = recipe ? withIngredient(missingForSlot(base, recipe, current, { todayFirst: Boolean(focus) }), recipeId, base) : [];
      await acceptProposal(supabase, current.id, { recipeId, missing });
      illustrateRecipe(household.id, recipeId).catch(() => undefined);
      chosen(recipeId, { ...ctx, recipes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const skip = () => {
    if (!current) return;
    const slotId = current.id;
    if (focus && replacing[slotId]) {
      // Repas qu'on pensait remplacer, finalement gardé : ce qui lui manquera va sur la liste de courses.
      writes.current.push(addShoppingItems(supabase, household.id, slotId, replacing[slotId]!)
        .catch((e) => setError(e instanceof Error ? e.message : String(e))));
      setReplacing(({ [slotId]: _kept, ...rest }) => rest);
    } else if (current.status === "open") {
      markSlot(slotId, "skipped");
      track(skipSlot(supabase, slotId), slotId);
    }
    if (focus) setPending((p) => p.slice(1));
    setRound(1);
  };

  /** Repas prévu plus tard qui manquera d'un ingrédient : nouvelles propositions selon ce qui reste et ce qui est prévu. */
  const replace = (s: Shortage) => {
    setShortages((list) => list.filter((x) => x.slotId !== s.slotId));
    setReplacing((r) => ({ ...r, [s.slotId]: s.missing }));
    setPending((p) => [...p, s.slotId]);
  };

  /** Repas gardé tel quel : les ingrédients qui manqueront vont sur la liste de courses. */
  const keep = async (s: Shortage) => {
    setBusy(s.slotId);
    try {
      await addShoppingItems(supabase, household.id, s.slotId, s.missing);
      setShortages((list) => list.filter((x) => x.slotId !== s.slotId));
      setInfo(`Ajouté à la liste de courses : ${s.missing.map((m) => m.label).join(", ")}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!slots || !ctx) return error ? <Screen title="Propositions"><ErrorText>{error}</ErrorText></Screen> : <Loading label="Préparation des menus…" />;

  if (focus && shortages.length) {
    const nameOf = (id: string) => ctx.recipes.find((r) => r.id === id)?.name ?? "Recette";
    return (
      <Screen title="Attention aux courses">
        <View style={[styles.alert, { backgroundColor: c.dangerSoft }]}>
          <Icon name="alert" size={26} color={c.danger} />
          <Text style={{ flex: 1, color: c.text, fontSize: 16, lineHeight: 22 }}>
            {chosenToday ? `« ${nameOf(chosenToday)} » utilise des ingrédients déjà comptés pour ` : "Ce menu utilise des ingrédients déjà comptés pour "}
            {shortages.length > 1 ? "des repas prévus plus tard" : "un repas prévu plus tard"} : il n'en restera plus assez.
          </Text>
        </View>
        <ErrorText>{error}</ErrorText>
        {info ? <Text style={{ color: c.greenInk, fontSize: 15 }}>{info}</Text> : null}
        {shortages.map((s) => (
          <View key={s.slotId} style={[styles.shortage, { backgroundColor: c.card, borderColor: c.cardLine }]}>
            <Text style={{ color: c.primary, fontSize: 14, fontWeight: "600" }}>{dayLabel(s.date, today)} · {mealLabel(s.mealType)}</Text>
            <Text style={[styles.shortageName, { color: c.text }]}>{nameOf(s.recipeId)}</Text>
            <Text style={{ color: c.orangeInk, fontSize: 15, lineHeight: 20 }}>Il manquera : {s.missing.map((m) => m.label).join(", ")}</Text>
            <Button title="Proposer un autre repas" icon="wand" onPress={() => replace(s)} disabled={busy !== null} />
            <Button title="Le garder (ingrédients sur la liste de courses)" kind="secondary" icon="cartBold" onPress={() => keep(s)}
              busy={busy === s.slotId} disabled={busy !== null} />
          </View>
        ))}
      </Screen>
    );
  }

  if (!current) return <Loading label={focus && chosenToday ? "Ouverture de la fiche…" : "Menus choisis : retour au calendrier…"} />;

  const top = deck[0];
  /** Menu du jour avec un ingrédient à acheter : il s'ajoute à ce qui manque (il rejoindra la liste de courses). */
  const extra = isFocusSlot && focus?.toBuy && focus.ingredient ? [focus.ingredient.name.toLowerCase()] : [];
  const toBuyLabels = top ? [...extra, ...top.missing.map((m) => m.label).filter((l) => !extra.includes(l.toLowerCase()))] : extra;
  const slotIdeas = ideas?.slotId === current.id ? ideas : null;
  const draft = exhausted ? slotIdeas?.drafts[seen] : undefined;
  const waiting = slotIdeas ? slotIdeas.pending : 3;
  const ready = slotIdeas ? slotIdeas.drafts.length : 0;
  const failed = exhausted && !draft && waiting === 0;
  const tag = exhausted
    ? <Tag label="idée Mistral" tone="plain" icon="sparkle" />
    : !toBuyLabels.length
      ? <Tag label="avec vos courses" tone="green" />
      : <Tag label={`${toBuyLabels.length} à acheter`} tone="orange" />;
  const card = (name: string, picture: Picture | null | undefined, duration: number, protein: string, ingredients: string, toBuy?: string) => (
    <View style={[styles.card, { backgroundColor: c.background, borderColor: c.border }]}>
      <View style={{ flex: 1, minHeight: 160, backgroundColor: c.chip }}>
        {picture
          ? <Image source={sourceOf(picture)} placeholder={picture.fallback} placeholderContentFit="cover" cachePolicy="memory-disk"
            style={StyleSheet.absoluteFill} contentFit="cover" transition={0} accessibilityLabel={name} />
          : (
            <View style={styles.placeholder} accessibilityLabel="Photo du plat en préparation">
              <Icon name="image" size={44} color={c.muted} />
              <Text style={{ color: c.muted, fontSize: 16 }}>Photo du plat en préparation</Text>
            </View>
          )}
      </View>
      <View style={styles.cardText}>
        <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{name}</Text>
        <View style={{ flexDirection: "row", gap: 7.5 }}>
          <Pill icon="timer">{minutes(duration)}</Pill>
          {protein ? <Pill icon="cutlery">{protein}</Pill> : null}
        </View>
        <Text style={{ color: c.muted, fontSize: 16, lineHeight: 21 }} numberOfLines={2}>{ingredients}</Text>
        {toBuy ? (
          <View style={[styles.toBuy, { backgroundColor: c.chip }]}>
            <Icon name="cartFilled" width={22} height={20} color={c.orangeInk} />
            <Text style={{ color: c.orangeInk, fontSize: 16, fontWeight: "500", flex: 1 }}>À acheter : {toBuy}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  return (
    <Screen title={`${dayLabel(current.date, today)} · ${mealLabel(current.mealType)}`} scroll={false} padded={false}>
      <View style={styles.line}>
        <Text style={{ color: c.muted, fontSize: 15 }}>
          {isFocusSlot ? (focus?.ingredient ? `Menu du jour avec ${focus.ingredient.name.toLowerCase()}${focus.toBuy ? " (à acheter)" : ""}` : "Menu du jour")
            : focus ? `Nouveau menu (il manquerait : ${(replacing[current.id] ?? []).map((m) => m.label).join(", ")})`
              : `Repas ${done + 1} sur ${ordered.length}`} · {current.maxTotalMin ? `${minutes(current.maxTotalMin)} au plus` : "sans limite"} ·
        </Text>
        {tag}
      </View>
      <View style={{ paddingHorizontal: 14 }}><ErrorText>{error}</ErrorText></View>

      <View style={styles.main}>
        <View style={[styles.pile, { backgroundColor: c.card, borderColor: c.border }]} />
        {top && !exhausted && (
          <SwipeCard key={`${current.id}-${top.recipeId}`} swipeRef={swipe} onSwipe={(d) => onSwipe(top, d)} style={StyleSheet.absoluteFill}
            onPress={() => router.push(`/recette/${top.recipeId}`)}>
            {card(top.name, images[top.recipeId] ?? pictureOf(top.recipeId), top.totalMin, proteinLabel(top.mainProtein, top.name),
              ctx.recipes.find((r) => r.id === top.recipeId)?.ingredients.filter((i) => !i.optional).map((i) => i.label).join(", ") ?? "",
              toBuyLabels.length ? toBuyLabels.join(", ") : undefined)}
          </SwipeCard>
        )}
        {draft && (
          <SwipeCard key={`draft-${seen}-${draft.recipe.name}`} swipeRef={swipe} onSwipe={(d) => onDraftSwipe(draft, d)} style={StyleSheet.absoluteFill}>
            {card(draft.recipe.name, null, draft.recipe.prep_min + draft.recipe.cook_min, proteinLabel(draft.recipe.main_protein, draft.recipe.name),
              draft.recipe.ingredients.filter((i) => !i.optional).map((i) => i.label).join(", "))}
          </SwipeCard>
        )}
        {exhausted && !draft && waiting > 0 && (
          <View style={[styles.state, { backgroundColor: c.card, borderColor: c.border }]} accessibilityRole="progressbar">
            <View style={{ flexDirection: "row", gap: 10 }}>
              {[0, 1, 2].map((k) => {
                const isReady = k < ready;
                return (
                  <View key={k} style={[styles.slot, { backgroundColor: isReady ? c.greenSoft : c.chip }]}>
                    <Icon name={isReady ? "check" : "sparkle"} size={30} color={isReady ? c.greenInk : c.muted} />
                  </View>
                );
              })}
            </View>
            <Text style={[styles.stateTitle, { color: c.text }]}>
              {seen ? `Mistral prépare encore ${waiting} idée${waiting > 1 ? "s" : ""}…` : "Mistral prépare 3 idées…"}
            </Text>
          </View>
        )}
        {failed && (
          <View style={[styles.state, { backgroundColor: c.card, borderColor: c.border }]} accessibilityRole="alert">
            <Icon name="alert" size={44} color={c.text} />
            <Text style={[styles.stateTitle, { color: c.text }]}>
              {slotIdeas?.drafts.length ? "Plus d'idées pour ce repas" : "Mistral ne répond pas pour le moment"}
            </Text>
            <Text style={{ color: c.muted, fontSize: 16, textAlign: "center" }}>
              {!slotIdeas?.drafts.length && slotIdeas?.failed ? slotIdeas.failed : "Les repas déjà choisis sont enregistrés."}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.footer}>
        {failed ? (
          <Button title={slotIdeas?.drafts.length ? "Demander 3 autres idées" : "Réessayer"} onPress={() => startIdeas(current, ctx)} />
        ) : (top && !exhausted) || draft ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="Autre idée" kind="secondary" icon="close" onPress={() => swipe.current?.("left")} style={{ flex: 1 }} disabled={busy !== null} />
            <Button title="Je choisis" icon="check" onPress={() => swipe.current?.("right")} style={{ flex: 1.25 }} busy={busy === "accept"} />
          </View>
        ) : <View style={{ height: 48 }} />}
        <Pressable onPress={skip} accessibilityRole="button" style={styles.skip}>
          <Text style={{ color: c.muted, fontSize: 16, fontWeight: "500", textDecorationLine: "underline" }}>
            {focus && replacing[current.id] ? "Garder l'ancien menu (manques sur la liste de courses)" : "Passer ce repas"}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 9, marginHorizontal: 19, minHeight: 28, flexWrap: "wrap" },
  main: { flex: 1, marginTop: 10, marginHorizontal: 14 },
  pile: { position: "absolute", left: 12, right: 12, top: 20, bottom: -9, borderRadius: 17, borderWidth: 1 },
  card: { flex: 1, borderRadius: 17, borderWidth: 1, overflow: "hidden" },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  cardText: { paddingTop: 7, paddingHorizontal: 14, paddingBottom: 12, gap: 9 },
  name: { fontSize: 26.5, lineHeight: 28, fontWeight: "700" },
  toBuy: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 6 },
  state: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: 17, borderWidth: 1, padding: 24, alignItems: "center", justifyContent: "center", gap: 18 },
  slot: { width: 84, height: 84, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  stateTitle: { fontSize: 19, lineHeight: 25, fontWeight: "700", textAlign: "center" },
  footer: { paddingTop: 21, paddingHorizontal: 14, paddingBottom: 6, gap: 2 },
  alert: { flexDirection: "row", gap: 12, alignItems: "flex-start", borderRadius: 12, padding: 14 },
  shortage: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  shortageName: { fontSize: 17, lineHeight: 22, fontWeight: "700" },
  skip: { height: 48, alignItems: "center", justifyContent: "center" },
});
