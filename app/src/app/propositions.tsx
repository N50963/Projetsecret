import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { Illustration } from "../components/Illustration";
import { SwipeCard, type SwipeDirection } from "../components/SwipeCard";
import { Body, Button, Card, ErrorText, H1, H2, Loading, Muted, Row, Screen } from "../components/ui";
import { dayLabel, mealLabel, minutes, PROTEIN_LABEL } from "../lib/format";
import { illustrationUrls } from "../lib/images";
import { draftToInput, generateRecipes, illustrateRecipe, type Draft } from "../lib/mistral";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import {
  acceptProposal, DEFAULT_TARGETS, getPlanSlots, getShoppingList, loadPlannerContext, loadRecipesForPlanning, missingForSlot, planMeals,
  recordShown, rejectProposal, skipSlot, toIsoDate, type PlannedSlot, type PlannerContext, type Proposal, type ShoppingItem,
} from "../modules/planning";
import { createRecipe, currentSeason } from "../modules/recipes";

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
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const swipe = useRef<((d: SwipeDirection) => void) | null>(null);

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
    setDrafts(null);
    recordShown(supabase, household.id, current.id, proposals).catch(() => undefined);
    illustrationUrls(proposals.map((p) => p.recipeId)).then((urls) => setImages((prev) => ({ ...prev, ...urls }))).catch(() => undefined);
    // Le paquet ne dépend que du repas, du tour et des choix acceptés (pas des refus en cours).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, round, ctx?.accepted.length, ctx?.recipes.length]);

  useEffect(() => {
    if (slots && !current) getShoppingList(supabase, household.id).then(setShopping).catch(() => undefined);
  }, [slots, current, household.id]);

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

  const askMistral = async () => {
    if (!current || !ctx) return;
    setBusy("mistral");
    setError("");
    try {
      const avoid = [...(ctx.rejected[current.id] ?? []), ...ctx.accepted.map((m) => m.recipeId)]
        .map((id) => ctx.recipes.find((r) => r.id === id)?.name).filter((n): n is string => Boolean(n));
      const { recipes } = await generateRecipes(household.id, {
        brief: balanceBrief(ctx, ordered.length), count: 3, servings: current.servings,
        constraints: { max_total_min: current.maxTotalMin, meal_type: current.mealType, season: currentSeason(new Date(`${current.date}T12:00:00`)), avoid },
      });
      setDrafts(recipes.filter((d) => d.recipe.name && d.recipe.ingredients.length >= 3));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDraftSwipe = async (d: Draft, direction: SwipeDirection) => {
    if (!current || !ctx) return;
    if (direction === "left") {
      setDrafts((list) => (list ?? []).slice(1));
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

  if (!current) {
    const names = new Map(ctx.recipes.map((r) => [r.id, r.name]));
    const planSlotIds = new Set(ordered.map((s) => s.id));
    const missing = shopping.filter((i) => !i.boughtAt && !i.checkedAt);
    return (
      <Screen title="Menus de la semaine">
        <H1>Menus prêts</H1>
        <Card>
          {ordered.map((s) => (
            <Body key={s.id} onPress={s.recipeId ? () => router.push(`/recette/${s.recipeId}`) : undefined}>
              {dayLabel(s.date, today)} · {mealLabel(s.mealType)} : {s.recipeId ? names.get(s.recipeId) ?? "Recette" : "—"}
            </Body>
          ))}
        </Card>
        {missing.length > 0 && (
          <Card>
            <H2>À acheter</H2>
            {missing.map((i) => <Body key={i.id}>• {i.label}</Body>)}
            <Muted>{planSlotIds.size} repas prévus · la liste se met à jour avec vos prochains tickets.</Muted>
          </Card>
        )}
        <Button title="Liste de courses" onPress={() => router.push("/courses")} />
        <Button title="Accueil" kind="secondary" onPress={() => router.replace("/")} />
      </Screen>
    );
  }

  const top = deck[0];
  const draft = drafts?.[0];
  return (
    <Screen title="Propositions">
      <Muted>Repas {done + 1} sur {ordered.length}</Muted>
      <H2>{dayLabel(current.date, today)} · {mealLabel(current.mealType)} · ⏱ {minutes(current.maxTotalMin)}</H2>
      <Muted>{drafts ? "Idées de Mistral (nouvelles recettes)" : round === 1 ? "Avec vos courses" : "Avec quelques achats (1 à 3 ingrédients)"}</Muted>
      <ErrorText>{error}</ErrorText>

      {top && !drafts && (
        <>
          <SwipeCard key={`${current.id}-${top.recipeId}`} swipeRef={swipe} onSwipe={(d) => onSwipe(top, d)} onPress={() => router.push(`/recette/${top.recipeId}`)}>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <Illustration uri={images[top.recipeId]} mainProtein={top.mainProtein}
                slugs={ctx.recipes.find((r) => r.id === top.recipeId)?.ingredients.map((i) => i.slug) ?? []} height={210} rounded={0} />
              <View style={{ padding: 16, gap: 6 }}>
                <H2>{top.name}</H2>
                <Muted>⏱ {minutes(top.totalMin)} · {PROTEIN_LABEL[top.mainProtein] ?? top.mainProtein}</Muted>
                {top.reasons.filter((r) => !r.startsWith("À acheter")).slice(0, 3).map((r) => <Body key={r}>• {r}</Body>)}
                {top.missing.length > 0 && <Body style={{ color: c.accent, fontWeight: "600" }}>🛒 À acheter : {top.missing.map((m) => m.label).join(", ")}</Body>}
                <Muted>Touchez la carte pour voir la fiche</Muted>
              </View>
            </Card>
          </SwipeCard>
          <Row>
            <Button title="✕ Autre idée" kind="secondary" onPress={() => swipe.current?.("left")} style={{ flex: 1 }} disabled={busy !== null} />
            <Button title="✓ Je choisis" onPress={() => swipe.current?.("right")} style={{ flex: 1 }} busy={busy === "accept"} />
          </Row>
          <Muted>{deck.length - 1} autre{deck.length > 2 ? "s" : ""} proposition{deck.length > 2 ? "s" : ""} pour ce repas.</Muted>
        </>
      )}

      {draft && (
        <>
          <SwipeCard key={`draft-${draft.recipe.name}`} swipeRef={swipe} onSwipe={(d) => onDraftSwipe(draft, d)}>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <Illustration uri={null} mainProtein={draft.recipe.main_protein} slugs={draft.recipe.ingredients.map((i) => i.slug)} height={180} rounded={0} />
              <View style={{ padding: 16, gap: 6 }}>
                <H2>{draft.recipe.name}</H2>
                <Muted>⏱ {minutes(draft.recipe.prep_min + draft.recipe.cook_min)} · {PROTEIN_LABEL[draft.recipe.main_protein]}</Muted>
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

      {exhausted && !draft && (
        <Card>
          <Body>{drafts ? "Plus d'idées pour ce repas." : "Plus d'autre proposition pour ce repas parmi vos recettes."}</Body>
          <Button title="Demander 3 idées à Mistral" onPress={askMistral} busy={busy === "mistral"} />
          <Button title="Passer ce repas" kind="secondary" onPress={skip} />
        </Card>
      )}
    </Screen>
  );
}
