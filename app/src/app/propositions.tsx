import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SwipeCard, type SwipeDirection } from "../components/SwipeCard";
import { Icon } from "../components/icons";
import { Button, ErrorText, Loading, Pill, Screen, Tag } from "../components/ui";
import { dayLabel, mealLabel, minutes, proteinLabel } from "../lib/format";
import { forgetIllustration, illustrationUrls, pictureOf, preloadPictures, type Picture } from "../lib/images";
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
    const plan = planMeals(ctx, ordered, { rounds: { [current.id]: round } });
    const entry = plan.find((p) => p.slotId === current.id);
    const proposals = entry?.proposals ?? [];
    // Photos de ce repas et des repas suivants mises en mémoire : elles s'affichent dès que la carte apparaît.
    preloadPictures([...proposals, ...plan.flatMap((p) => p.proposals)].map((p) => p.recipeId));
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
  const ready = slotIdeas ? slotIdeas.drafts.length : 0;
  const failed = exhausted && !draft && waiting === 0;
  const tag = exhausted
    ? <Tag label="idée Mistral" tone="plain" icon="sparkle" />
    : round === 1 || !top?.missing.length
      ? <Tag label="avec vos courses" tone="green" />
      : <Tag label={`${top.missing.length} à acheter`} tone="orange" />;
  const card = (name: string, picture: Picture | null | undefined, duration: number, protein: string, ingredients: string, toBuy?: string) => (
    <View style={[styles.card, { backgroundColor: c.background, borderColor: c.border }]}>
      <View style={{ flex: 1, minHeight: 160, backgroundColor: c.chip }}>
        {picture
          ? <Image source={{ uri: picture.uri, cacheKey: picture.cacheKey }} cachePolicy="memory-disk" style={StyleSheet.absoluteFill} contentFit="cover"
            transition={0} accessibilityLabel={name} />
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
          Repas {done + 1} sur {ordered.length} · {current.maxTotalMin ? `${minutes(current.maxTotalMin)} au plus` : "sans limite"} ·
        </Text>
        {tag}
      </View>
      <View style={{ paddingHorizontal: 14 }}><ErrorText>{error}</ErrorText></View>

      <View style={styles.main}>
        <View style={[styles.pile, { backgroundColor: c.card, borderColor: c.border }]} />
        {top && !exhausted && (
          <SwipeCard key={`${current.id}-${top.recipeId}`} swipeRef={swipe} onSwipe={(d) => onSwipe(top, d)} style={StyleSheet.absoluteFill}
            onPress={() => router.push(`/recette/${top.recipeId}`)}>
            {card(top.name, images[top.recipeId] ?? pictureOf(top.recipeId), top.totalMin, proteinLabel(top.mainProtein),
              ctx.recipes.find((r) => r.id === top.recipeId)?.ingredients.filter((i) => !i.optional).map((i) => i.label).join(", ") ?? "",
              top.missing.length ? top.missing.map((m) => m.label).join(", ") : undefined)}
          </SwipeCard>
        )}
        {draft && (
          <SwipeCard key={`draft-${seen}-${draft.recipe.name}`} swipeRef={swipe} onSwipe={(d) => onDraftSwipe(draft, d)} style={StyleSheet.absoluteFill}>
            {card(draft.recipe.name, null, draft.recipe.prep_min + draft.recipe.cook_min, proteinLabel(draft.recipe.main_protein),
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
          <Text style={{ color: c.muted, fontSize: 16, fontWeight: "500", textDecorationLine: "underline" }}>Passer ce repas</Text>
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
  skip: { height: 48, alignItems: "center", justifyContent: "center" },
});
