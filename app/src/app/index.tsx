import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
// Défilement qui s'accorde avec les gestes natifs : un menu détaché n'est jamais repris par la page.
import { ScrollView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, Logo } from "../components/icons";
import { useConfirm } from "../components/ConfirmSheet";
import { IngredientMenu, type IngredientMenuRequest } from "../components/IngredientMenu";
import { ReminderSheet } from "../components/ReminderSheet";
import { TimersBar } from "../components/Steps";
import { WeekRibbon } from "../components/WeekRibbon";
import { BottomNav, Button, ErrorText } from "../components/ui";
import { dayLabel, mealLabel, minutes } from "../lib/format";
import { illustrationUrls, pictureOf, preloadPictures, placeholderOf, sourceOf, usePictures, type Picture } from "../lib/images";
import { useWeather } from "../lib/weather";
import { setShoppingCount, toBuyLines } from "../lib/shoppingCount";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { BRAND_FONT, useColors } from "../lib/theme";
import { useTimers } from "../lib/timers";
import {
  addDays, cancelMealChoice, ensureSlot, getShoppingList, getWeekSlots, moveMealChoice, savePlan, setMealWanted, toIsoDate, weekDates, type ShoppingItem, type SlotRequest,
  type WeekSlot,
} from "../modules/planning";
import type { MealType } from "../modules/recipes";
import { errorText } from "../lib/errors";

const MEALS: MealType[] = ["dejeuner", "diner"];
const DEFAULT_TIME = 60;
const LEVEL = ["", "Facile", "Moyen", "Difficile"];
/** Heures à partir desquelles le déjeuner et le dîner du jour sont passés : plus rien à prévoir pour eux. */
const OVER_HOUR: Record<MealType, number> = { dejeuner: 14, diner: 20 };

interface DayChoice {
  dejeuner: boolean;
  diner: boolean;
  /** Temps disponible pour chaque repas (préparation et cuisson) ; null : sans limite. */
  time: Record<MealType, number | null>;
}

/**
 * Sélection d'un jour sans repas enregistré : le dîner coché quand la semaine est encore vide (on la prévoit) ; rien une
 * fois des menus choisis (le foyer coche lui-même un repas de plus).
 */
/** Semaine vide par défaut : aucun repas coché, le foyer coche ceux à proposer. */
const defaultChoice = (): DayChoice => ({ dejeuner: false, diner: false, time: { dejeuner: DEFAULT_TIME, diner: DEFAULT_TIME } });

/** Temps enregistré ramené aux choix de la roue (30 min, 1 h, sans limite). */
const snapTime = (t: number | null) => (t === null ? null : t <= 30 ? 30 : t <= 60 ? 60 : null);


/**
 * Accueil MenuBily : en-tête au logo ; en grand, le prochain repas (menu du jour, sinon le prochain de la semaine) ;
 * recherche de menu par ingrédient ; les repas de la semaine en ruban (7 jours, puis la carte du jour choisi : menus
 * choisis et repas à cocher avec leur temps), toujours affichés ; liste de courses ; barre de navigation.
 */
export default function Accueil() {
  const router = useRouter();
  const household = useHousehold();
  const [ask, confirmSheet] = useConfirm();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { timers } = useTimers();
  const today = toIsoDate(new Date());
  const days = useMemo(() => weekDates(today), [today]);
  const [slots, setSlots] = useState<Record<string, WeekSlot>>({});
  const [choices, setChoices] = useState<Record<string, DayChoice>>({});
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  usePictures();
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reminders, setReminders] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Heure courante (relue chaque minute) : les repas du jour passés disparaissent d'eux-mêmes. */
  const [hour, setHour] = useState(() => new Date().getHours());
  /** Repas à prévoir affichés à la demande, une fois la semaine choisie (« Prévoir un autre repas »). */
  const [planning, setPlanning] = useState(false);
  /** Menu en cours de déplacement : la page ne défile pas pendant le glisser-déposer. */
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  /** Repas cochés ou décochés en cours d'enregistrement (un enregistrement à la fois par repas, dans l'ordre des touchers). */
  const writes = useRef(new Map<string, Promise<void>>());

  const load = useCallback(async () => {
    try {
      const [week, list] = await Promise.all([
        getWeekSlots(supabase, household.id, today, addDays(today, 6)),
        getShoppingList(supabase, household.id),
      ]);
      const byKey: Record<string, WeekSlot> = Object.fromEntries(week.map((s) => [`${s.date}:${s.mealType}`, s]));
      const ids = week.filter((s) => s.status === "accepted").map((s) => s.recipeId);
      // Photos des menus mises en mémoire avant l'affichage des lignes.
      preloadPictures(ids);
      setSlots(byKey);
      setShopping(list);
      setShoppingCount(toBuyLines(list).length);
      setLoaded(true);
      // Repas cochés : ceux enregistrés « à proposer » (chaque toucher est enregistré tout de suite) ; aucun par défaut.
      // Un repas dont l'enregistrement est en cours garde la sélection affichée.
      setChoices((prev) => Object.fromEntries(days.map((d) => {
        const base = prev[d] ?? defaultChoice();
        const next: DayChoice = { ...base, time: { ...base.time } };
        for (const m of MEALS) {
          if (writes.current.has(`${d}:${m}`)) continue;
          const slot = byKey[`${d}:${m}`];
          next[m] = slot ? slot.status !== "skipped" : false;
          // Temps propre à chaque repas : celui du repas à proposer enregistré, sinon la sélection en cours.
          if (slot?.status === "open") next.time[m] = snapTime(slot.maxTotalMin);
        }
        return [d, next];
      })));
      // Liste des photos rafraîchie en arrière-plan (nouvelles images, photos du foyer).
      setImages(await illustrationUrls(ids.filter((id): id is string => id !== null)));
      preloadPictures(ids);
    } catch (e) {
      setError(errorText(e));
    }
  }, [household.id, today, days]);

  // Prévision de Rochefort-du-Gard lue à l'ouverture de l'application : météo sur les cartes des jours.
  const weather = useWeather();

  useFocusEffect(useCallback(() => {
    load();
    // Retour à l'accueil : les repas à prévoir dévoilés se replient (sauf repas cochés, qui restent à proposer).
    setPlanning(false);
    setHour(new Date().getHours());
    const tick = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(tick);
  }, [load]));

  const picture = (recipeId: string | null) => (recipeId ? pictureOf(recipeId) ?? images[recipeId] ?? null : null);
  const choiceOf = (d: string): DayChoice => choices[d] ?? defaultChoice();
  /** Repas du jour passé : le déjeuner après 14 h, le dîner après 20 h. */
  const isPast = (d: string, m: MealType) => d === today && hour >= OVER_HOUR[m];
  const isChosen = (d: string, m: MealType) => slots[`${d}:${m}`]?.status === "accepted";
  /** Enregistre un repas coché (avec son temps disponible) ou décoché, après les enregistrements déjà en cours pour lui. */
  const persist = (d: string, m: MealType, choice: DayChoice) => {
    const key = `${d}:${m}`;
    const request: SlotRequest = { date: d, mealType: m, maxTotalMin: choice.time[m], servings: household.defaultServings };
    const run: Promise<void> = (writes.current.get(key) ?? Promise.resolve())
      .then(() => setMealWanted(supabase, household.id, request, choice[m]))
      .catch((e) => setError(errorText(e)))
      .finally(() => {
        if (writes.current.get(key) === run) writes.current.delete(key);
      });
    writes.current.set(key, run);
  };
  /** Repas coché, décoché ou temps changé : affiché tout de suite et enregistré, pour être gardé. */
  const update = (d: string, patch: Partial<DayChoice>) => {
    const before = choiceOf(d);
    const next = { ...before, ...patch };
    setChoices((p) => ({ ...p, [d]: next }));
    for (const m of MEALS) {
      if (isChosen(d, m)) continue;
      if (next[m] !== before[m] || (next[m] && next.time[m] !== before.time[m])) persist(d, m, next);
    }
  };

  // Menus choisis, dans l'ordre de la semaine : le premier (aujourd'hui, sinon le prochain) s'affiche en grand en tête ;
  // tous les menus choisis se retrouvent ensuite jour par jour dans le ruban de la semaine.
  const menus = days.flatMap((d) => MEALS.map((m) => slots[`${d}:${m}`]).filter((s): s is WeekSlot => s?.status === "accepted"));
  // Le déjeuner du jour passé (après 14 h), le menu en tête est le suivant : le dîner, ou le prochain jour.
  const hero = menus.find((s) => !(s.mealType === "dejeuner" && isPast(s.date, s.mealType))) ?? menus[0];

  const requests: SlotRequest[] = days.flatMap((d) => MEALS
    .filter((m) => choiceOf(d)[m] && !isChosen(d, m) && !isPast(d, m))
    .map((m) => ({ date: d, mealType: m, maxTotalMin: choiceOf(d).time[m], servings: household.defaultServings })));

  // Semaine choisie (des menus, plus rien à proposer) : les repas à prévoir sont repliés, un lien discret les rouvre.
  const compact = menus.length > 0 && requests.length === 0 && !planning;

  const propose = async () => {
    setBusy("plan");
    setError("");
    try {
      // Cases touchées juste avant : enregistrées d'abord.
      await Promise.all(writes.current.values());
      const { planId } = await savePlan(supabase, household.id, today, addDays(today, 6), requests);
      router.push({ pathname: "/propositions", params: { plan: planId, start: today } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /** Menu du jour d'après un ingrédient : même écran de propositions, limité à ce repas et à cet ingrédient. */
  const findTodayMenu = async (r: IngredientMenuRequest) => {
    setBusy("today");
    setError("");
    try {
      const slot = await ensureSlot(supabase, household.id, { date: today, mealType: r.mealType, maxTotalMin: r.maxTotalMin, servings: household.defaultServings });
      router.push({ pathname: "/propositions", params: {
        plan: slot.planId, start: today, slot: slot.id, ingredient: r.ingredient.slug, buy: r.toBuy ? "1" : "0",
      } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = (s: WeekSlot) => ask({
    title: "Annuler ce menu ?", picture: picture(s.recipeId), name: s.name ?? "", detail: `${dayLabel(s.date, today)} · ${mealLabel(s.mealType)}`,
    message: "Le repas redevient à prévoir. Les ingrédients ajoutés à la liste de courses pour ce menu, et pas encore achetés, en sont retirés.",
    confirmLabel: "Annuler ce menu", cancelLabel: "Garder ce menu",
    onConfirm: async () => {
      setBusy(s.slotId);
      setError("");
      try {
        await cancelMealChoice(supabase, s.slotId);
        // Le repas redevient à prévoir : décoché, comme le reste de la semaine par défaut.
        await setMealWanted(supabase, household.id, { date: s.date, mealType: s.mealType, maxTotalMin: s.maxTotalMin, servings: household.defaultServings }, false);
        await load();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    },
  });

  /**
   * Menu déposé sur un autre jour ou un autre repas : affiché aussitôt à sa nouvelle place (échange avec le menu qui s'y
   * trouvait), puis enregistré ; la semaine est relue ensuite.
   */
  const move = async (s: WeekSlot, date: string, meal: MealType) => {
    const from = `${s.date}:${s.mealType}`;
    const to = `${date}:${meal}`;
    setSlots((prev) => {
      const next = { ...prev };
      const other = prev[to];
      next[to] = { ...s, date, mealType: meal, maxTotalMin: other?.maxTotalMin ?? s.maxTotalMin };
      if (other) next[from] = { ...other, date: s.date, mealType: s.mealType, maxTotalMin: s.maxTotalMin };
      else delete next[from];
      return next;
    });
    setError("");
    try {
      await moveMealChoice(supabase, s.slotId, date, meal);
    } catch (e) {
      setError(errorText(e));
    }
    await load();
  };

  // Même décompte que la liste de courses : un article demandé par deux plats compte une fois.
  const toBuy = toBuyLines(shopping);
  const open = (s: WeekSlot) => router.push(`/recette/${s.recipeId}`);

  const notifications = () => setReminders(true);

  const heroPicture = hero ? picture(hero.recipeId) : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ height: insets.top, backgroundColor: c.statusBar }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 12 }} scrollEnabled={!dragging}>
        <LinearGradient colors={["#FEF8EE", c.background]} style={styles.header}>
          <View style={styles.logo}><Logo /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.brand, { color: c.primary, fontFamily: BRAND_FONT }]}>MenuBily</Text>
            <Text style={[styles.slogan, { color: c.muted }]}>Bien manger, même sans idée</Text>
          </View>
          <Pressable onPress={notifications} accessibilityRole="button" accessibilityLabel="Notifications" hitSlop={4}
            style={({ pressed }) => [styles.round, { opacity: pressed ? 0.6 : 1 }]}>
            <Icon name="bell" width={24} height={25} color={c.text} />
            {timers.some((t) => t.done) && <View style={[styles.badge, { backgroundColor: c.danger }]} />}
          </Pressable>
          <Pressable onPress={() => router.navigate("/parametres")} accessibilityRole="button" accessibilityLabel="Profil et paramètres"
            style={({ pressed }) => [styles.round, { opacity: pressed ? 0.6 : 1 }]}>
            <View style={[styles.avatar, { backgroundColor: c.greenSoft }]}>
              <Text style={{ color: c.greenInk, fontSize: 19, fontWeight: "700" }}>{(household.name.trim()[0] ?? "M").toUpperCase()}</Text>
            </View>
          </Pressable>
        </LinearGradient>

        <View>
          <View style={{ paddingHorizontal: 8 }}><ErrorText>{error}</ErrorText></View>
          {hero && (
            <View style={[styles.hero, { backgroundColor: c.chip }]}>
              <Pressable onPress={() => open(hero)} accessibilityRole="button"
                accessibilityLabel={`${dayLabel(hero.date, today)}, ${mealLabel(hero.mealType)} : ${hero.name}`}>
                {heroPicture
                  ? <Image source={sourceOf(heroPicture)} placeholder={placeholderOf(heroPicture)} placeholderContentFit="cover" cachePolicy="memory-disk" priority="high"
                    style={styles.heroImage} contentFit="cover" transition={0} />
                  : <View style={[styles.heroImage, styles.heroWaiting]}><Icon name="image" size={44} color={c.muted} /></View>}
                <LinearGradient colors={["rgba(20,24,12,0.66)", "rgba(20,24,12,0.34)", "rgba(20,24,12,0.08)"]} locations={[0, 0.58, 1]}
                  start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
                {/* Fondu du bord droit vers le fond de l'accueil. */}
                <LinearGradient colors={["rgba(254,243,227,0)", "rgba(254,243,227,0.75)", c.background]} locations={[0, 0.6, 1]}
                  start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.heroFade} pointerEvents="none" />
                <View style={[styles.heroPill, { backgroundColor: c.heroPill }]}>
                  <Text style={styles.heroPillText}>{dayLabel(hero.date, today)} · {mealLabel(hero.mealType)}</Text>
                </View>
                <Text style={styles.heroTitle} numberOfLines={2}>{hero.name}</Text>
                <View style={styles.heroMeta}>
                  {hero.totalMin ? <><Icon name="clock" size={18} color="#FFFFFF" /><Text style={styles.heroMetaText}>{minutes(hero.totalMin)}</Text></> : null}
                  {hero.difficulty ? <><Icon name="toque" size={18} color="#FFFFFF" /><Text style={styles.heroMetaText}>{LEVEL[hero.difficulty]}</Text></> : null}
                </View>
              </Pressable>
              <Pressable onPress={() => cancel(hero)} disabled={busy !== null} accessibilityRole="button" accessibilityLabel={`Annuler « ${hero.name} »`}
                hitSlop={6} style={({ pressed }) => [styles.close, { opacity: pressed ? 0.6 : 1 }]}>
                <Icon name="close" size={22} color={c.text} />
              </Pressable>
            </View>
          )}
        </View>

        {loaded && (
          <IngredientMenu householdId={household.id} today={today} busy={busy === "today"} onFind={findTodayMenu}
            todaySlots={{ dejeuner: slots[`${today}:dejeuner`], diner: slots[`${today}:diner`] }} />
        )}

        {/* Ruban de la semaine, toujours affiché, sans titre. */}
        {loaded && (
          <View style={styles.planning}>
            <WeekRibbon days={days} today={today} planOf={choiceOf} slotOf={(d, m) => slots[`${d}:${m}`]} picture={picture}
              busy={busy !== null} onChange={update} onOpen={open} onCancel={cancel} onMove={move} onDragChange={setDragging}
              isPast={isPast} compact={compact} onPlanMore={() => setPlanning(true)} weather={weather} />
          </View>
        )}

      </ScrollView>

      {/* Bouton des propositions : seulement s'il y a des repas à prévoir affichés. */}
      {loaded && !compact && (
        <View style={styles.cta}>
          <Button icon="wand" title={requests.length ? `Proposer les menus (${requests.length} repas)` : "Cochez les repas"}
            onPress={propose} busy={busy === "plan"} disabled={!requests.length} />
        </View>
      )}
      <TimersBar />
      <BottomNav active="accueil" />
      {confirmSheet}
      <ReminderSheet visible={reminders} onClose={() => setReminders(false)} today={today} menus={menus} toBuy={toBuy.length}
        onOpenRecipe={(id) => router.push(`/recette/${id}`)} onOpenShopping={() => router.navigate("/courses")} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { height: 71, flexDirection: "row", alignItems: "center", paddingLeft: 13, paddingRight: 8, gap: 5 },
  // Logo centré sur le nom et le slogan, avec une marge avant le texte.
  logo: { marginLeft: 2, marginRight: 9, alignItems: "center", justifyContent: "center" },
  brand: { fontSize: 26.5, lineHeight: 30 },
  slogan: { fontSize: 12.2, lineHeight: 16, fontWeight: "500" },
  round: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: 10, right: 11, width: 9, height: 9, borderRadius: 5 },
  avatar: { width: 45, height: 45, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  hero: { height: 172, overflow: "hidden", marginBottom: 4 },
  heroFade: { position: "absolute", top: 0, bottom: 0, right: 0, width: "30%" },
  close: { position: "absolute", top: 6, right: 6, width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  heroImage: { width: "100%", height: 172 },
  heroWaiting: { alignItems: "center", justifyContent: "center" },
  heroPill: { position: "absolute", left: 17, top: 22, height: 28, borderRadius: 14, paddingHorizontal: 12, justifyContent: "center" },
  heroPillText: { color: "#FFFFFF", fontSize: 16, fontWeight: "500" },
  heroTitle: {
    position: "absolute", left: 19, right: "24%", top: 60, color: "#FFFFFF", fontSize: 24.5, lineHeight: 28.5, fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.45)", textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 },
  },
  heroMeta: { position: "absolute", left: 18, top: 137, flexDirection: "row", alignItems: "center", gap: 7 },
  heroMetaText: {
    color: "#FFFFFF", fontSize: 16, fontWeight: "500", marginRight: 12,
    textShadowColor: "rgba(0,0,0,0.4)", textShadowRadius: 2, textShadowOffset: { width: 0, height: 1 },
  },
  planning: { marginTop: 12 },
  cta: { paddingTop: 8, paddingBottom: 6, paddingLeft: 14, paddingRight: 9 },
});
