import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { Illustration } from "../components/Illustration";
import { SwipeCard, type SwipeDirection } from "../components/SwipeCard";
import { Body, Button, Card, ErrorText, H2, Loading, Muted, Row, Screen } from "../components/ui";
import { dayLabel, mealLabel, minutes, PROTEIN_LABEL } from "../lib/format";
import { forgetIllustration, illustrationUrls, type Picture } from "../lib/images";
import { draftToInput, generateRecipes, illustrateRecipe, type Draft } from "../lib/mistral";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import {
  acceptProposal, DEFAULT_TARGETS, getPlanSlots, loadPlannerContext, loadRecipesForPlanning, missingForSlot, planMeals,
  recordShown, rejectProposal, skipSlot, toIsoDate, type PlannedSlot, type PlannerContext, type Proposal,
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

export default function Propositions() {
  const { plan: planId, start } = useLocalSearchParams<{ plan: string; start: string }>();
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
  const swipe = useRef<((d: SwipeDirection) => void) | null>(null);
  // Une seule illustration demandée à la fois ; plus aucune pendant la session si Mistral refuse (quota gratuit).
  const illustrating = useRef(false);
  const imagesPaused = useRef(false);
  const ideaTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    (async () => {
      try {
        const [s, context] = await Promise.all([getPlanSlots(supabase, planId), loadPlannerContext(supabase, household.id, start, planId)]);
        setSlots(s);
        setCtx(context);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [planId, start, household.id]);

  const ordered = useMemo(() => (slots ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.mealType === "dejeuner" ? -1 : 1)), [slots]);
  const current = ordered.find((s) => s.status === "open") ?? null;
  const done = ordered.filter((s) => s.status !== "open").length;

  // Paquet de propositions pour le repas courant (recalculé à chaque repas et à chaque tour).
  useEffect(() => {
    if (!ctx || !current) return;
    const entry = planMeals(ctx, ordered, { rounds: { [current.id]: round } }).find((p) => p.slotId === current.id);
    const proposals = entry?.proposals ?? [];
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
    illustrateRecipe(household.id, shown)
      .then(async () => {
        forgetIllustration(shown);
        const urls = await illustrationUrls([shown]);
        setImages((prev) => ({ ...prev, ...urls }));
      })
      .catch(() => {
        imagesPaused.current = true;
      })
      .finally(() => {
        illustrating.current = false;
      });
  }, [shown, images, household.id]);

  // Tous les repas ont leur menu : retour au calendrier de l'accueil (photos et menus de la semaine).
  useEffect(() => {
    if (!slots || !ctx || current) return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [slots, ctx, current, router]);

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

  const onSwipe = async (p: Proposal, direction: SwipeDirection) => {
    if (!current || !ctx) return;
    setError("");
    if (direction === "left") {
      setCtx({ ...ctx, rejected: { ...ctx.rejected, [current.id]: [...(ctx.rejected[current.id] ?? []), p.recipeId] } });
      next();
      rejectProposal(supabase, household.id, current.id, p).catch((e) => setError(String(e)));
      return;
    }
    setBusy("accept");
    try {
      await acceptProposal(supabase, current.id, p);
      setCtx({ ...ctx, accepted: [...ctx.accepted, { recipeId: p.recipeId, date: current.date, servings: current.servings, slotId: current.id }] });
      markSlot(current.id, "accepted", p.recipeId);
      setRound(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Demande 3 idées à Mistral pour un repas, une par protéine, envoyées presque ensemble : la première arrive en 20 à 30 s
   * (contre près d'une minute pour 3 idées d'un coup) et s'affiche aussitôt.
   */
  const startIdeas = useCallback((slot: PlannedSlot, context: PlannerContext) => {
    const proteins = ideaProteins(context, ordered.length);
    const avoid = [...(context.rejected[slot.id] ?? []), ...context.accepted.map((m) => m.recipeId)]
      .map((id) => context.recipes.find((r) => r.id === id)?.name).filter((n): n is string => Boolean(n));
    const brief = balanceBrief(context, ordered.length);
    const season = currentSeason(new Date(`${slot.date}T12:00:00`));
    const forSlot = (update: (i: Ideas) => Ideas) => setIdeas((i) => (i?.slotId === slot.id ? update(i) : i));
    setIdeas({ slotId: slot.id, drafts: [], pending: proteins.length, failed: null });
    setSeen(0);
    proteins.forEach((protein, n) => ideaTimers.current.push(setTimeout(() => {
      generateRecipes(household.id, {
        brief, count: 1, servings: slot.servings,
        constraints: { max_total_min: slot.maxTotalMin, meal_type: slot.mealType, season, main_protein: protein, avoid },
      })
        .then(({ recipes }) => forSlot((i) => ({ ...i, pending: i.pending - 1,
          drafts: [...i.drafts, ...recipes.filter((d) => d.recipe.name && d.recipe.ingredients.length >= 3)] })))
        .catch((e) => forSlot((i) => ({ ...i, pending: i.pending - 1, failed: e instanceof Error ? e.message : String(e) })));
    }, n * IDEA_STAGGER_MS)));
  }, [household.id, ordered.length]);

  // Dès les propositions avec achats (ou quand il n'y a plus rien à proposer), les idées sont préparées en arrière-plan.
  useEffect(() => {
    if (current && ctx && (round === 2 || exhausted) && ideas?.slotId !== current.id) startIdeas(current, ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, round, exhausted]);

  useEffect(() => () => ideaTimers.current.forEach(clearTimeout), []);

  const onDraftSwipe = async (d: Draft, direction: SwipeDirection) => {
    if (!current || !ctx) return;
    if (direction === "left") {
      setSeen((n) => n + 1);
      return;
    }
    setBusy("accept");
    setError("");
    try {
      const recipeId = await createRecipe(supabase, household.id, draftToInput(d.recipe, "mistral"));
      const recipes = await loadRecipesForPlanning(supabase, household.id);
      const recipe = recipes.find((r) => r.id === recipeId);
      const missing = recipe ? missingForSlot({ ...ctx, recipes }, recipe, current) : [];
      await acceptProposal(supabase, current.id, { recipeId, missing });
      illustrateRecipe(household.id, recipeId).catch(() => undefined);
      setCtx({ ...ctx, recipes, accepted: [...ctx.accepted, { recipeId, date: current.date, servings: current.servings, slotId: current.id }] });
      markSlot(current.id, "accepted", recipeId);
      setRound(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    if (!current) return;
    try {
      await skipSlot(supabase, current.id);
      markSlot(current.id, "skipped");
      setRound(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!slots || !ctx) return error ? <Screen title="Propositions"><ErrorText>{error}</ErrorText></Screen> : <Loading label="Préparation des menus…" />;

  if (!current) return <Loading label="Menus choisis : retour au calendrier…" />;

  const top = deck[0];
  const slotIdeas = ideas?.slotId === current.id ? ideas : null;
  const draft = exhausted ? slotIdeas?.drafts[seen] : undefined;
  const waiting = slotIdeas ? slotIdeas.pending : 3;
  return (
    <Screen title="Propositions">
      <H2>{dayLabel(current.date, today)} · {mealLabel(current.mealType)}</H2>
      <Muted>
        Repas {done + 1} sur {ordered.length} · {minutes(current.maxTotalMin)}{current.maxTotalMin ? " au plus" : ""} · {exhausted
          ? "idées de Mistral" : round === 1 ? "avec vos courses" : "avec 1 à 3 ingrédients à acheter"}
      </Muted>
      <ErrorText>{error}</ErrorText>

      {top && !exhausted && (
        <>
          <SwipeCard key={`${current.id}-${top.recipeId}`} swipeRef={swipe} onSwipe={(d) => onSwipe(top, d)} onPress={() => router.push(`/recette/${top.recipeId}`)}>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <Illustration picture={images[top.recipeId]} height={230} rounded={0} />
              <View style={{ padding: 16, gap: 6 }}>
                <H2>{top.name}</H2>
                <Muted>{minutes(top.totalMin)} · {PROTEIN_LABEL[top.mainProtein] ?? top.mainProtein}</Muted>
                <Body>{ctx.recipes.find((r) => r.id === top.recipeId)?.ingredients.filter((i) => !i.optional).map((i) => i.label).join(" · ")}</Body>
                {top.missing.length > 0 && <Body style={{ color: c.accent, fontWeight: "600" }}>À acheter : {top.missing.map((m) => m.label).join(", ")}</Body>}
                <Muted>Touchez la photo pour la recette complète</Muted>
              </View>
            </Card>
          </SwipeCard>
          <Row>
            <Button title="✕ Autre idée" kind="secondary" onPress={() => swipe.current?.("left")} style={{ flex: 1 }} disabled={busy !== null} />
            <Button title="✓ Je choisis" onPress={() => swipe.current?.("right")} style={{ flex: 1 }} busy={busy === "accept"} />
          </Row>
        </>
      )}

      {draft && (
        <>
          <SwipeCard key={`draft-${seen}-${draft.recipe.name}`} swipeRef={swipe} onSwipe={(d) => onDraftSwipe(draft, d)}>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <Illustration picture={null} height={180} rounded={0} />
              <View style={{ padding: 16, gap: 6 }}>
                <H2>{draft.recipe.name}</H2>
                <Muted>{minutes(draft.recipe.prep_min + draft.recipe.cook_min)} · {PROTEIN_LABEL[draft.recipe.main_protein]}</Muted>
                {draft.recipe.description ? <Body>{draft.recipe.description}</Body> : null}
                <Muted>{draft.recipe.ingredients.filter((i) => !i.optional).map((i) => i.label).join(" · ")}</Muted>
              </View>
            </Card>
          </SwipeCard>
          <Row>
            <Button title="✕ Non" kind="secondary" onPress={() => swipe.current?.("left")} style={{ flex: 1 }} disabled={busy !== null} />
            <Button title="✓ Je choisis" onPress={() => swipe.current?.("right")} style={{ flex: 1 }} busy={busy === "accept"} />
          </Row>
          <Muted>Choisie, la recette est ajoutée à vos recettes ; ses ingrédients manquants vont sur la liste de courses.</Muted>
        </>
      )}

      {exhausted && !draft && waiting > 0 && (
        <Card>
          <Loading label={seen ? `Mistral prépare encore ${waiting} idée${waiting > 1 ? "s" : ""}…` : "Mistral prépare de nouvelles idées…"} />
        </Card>
      )}
      {exhausted && !draft && waiting === 0 && (
        <Card>
          <Body>{slotIdeas?.drafts.length ? "Plus d'idées pour ce repas." : "Les idées de Mistral n'ont pas pu être préparées."}</Body>
          {!slotIdeas?.drafts.length && slotIdeas?.failed ? <Muted>{slotIdeas.failed}</Muted> : null}
          <Button title={slotIdeas?.drafts.length ? "Demander 3 autres idées" : "Réessayer"} onPress={() => startIdeas(current, ctx)} />
          <Button title="Passer ce repas" kind="secondary" onPress={skip} />
        </Card>
      )}
    </Screen>
  );
}
