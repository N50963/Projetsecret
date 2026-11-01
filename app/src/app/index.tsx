import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, Logo } from "../components/icons";
import { IngredientMenu, type IngredientMenuRequest } from "../components/IngredientMenu";
import { ReminderSheet } from "../components/ReminderSheet";
import { TimersBar } from "../components/Steps";
import { TimeWheel } from "../components/TimeWheel";
import { BottomNav, Button, ErrorText, SectionTitle, TextLink } from "../components/ui";
import { dayLabel, mealLabel, minutes } from "../lib/format";
import { illustrationUrls, pictureOf, preloadPictures, type Picture } from "../lib/images";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { BRAND_FONT, CARD_SHADOW, useColors } from "../lib/theme";
import { useTimers } from "../lib/timers";
import {
  addDays, cancelMealChoice, ensureSlot, getShoppingList, getWeekSlots, savePlan, toIsoDate, weekDates, type ShoppingItem, type SlotRequest,
  type WeekSlot,
} from "../modules/planning";
import type { MealType } from "../modules/recipes";

const MEALS: MealType[] = ["dejeuner", "diner"];
const DEFAULT_TIME = 60;
const LEVEL = ["", "Facile", "Moyen", "Difficile"];
/** Fondu de la photo vers le fond de la carte (#FDF4E9). */
const FADE = ["rgba(253,244,233,0)", "rgba(253,244,233,0.75)", "#FDF4E9"] as const;

interface DayChoice {
  dejeuner: boolean;
  diner: boolean;
  /** Temps disponible pour les repas du jour (préparation et cuisson) ; null : sans limite. */
  time: number | null;
}

/** Temps enregistré ramené aux choix de la roue (30 min, 1 h, sans limite). */
const snapTime = (t: number | null) => (t === null ? null : t <= 30 ? 30 : t <= 60 ? 60 : null);

function confirm(message: string, action: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(message)) onConfirm();
    return;
  }
  Alert.alert(message, undefined, [{ text: "Garder", style: "cancel" }, { text: action, style: "destructive", onPress: onConfirm }]);
}

/**
 * Accueil MenuMalin : en-tête au logo ; en grand, le menu du jour ou, s'il n'y en a pas, le prochain ; les menus de la
 * semaine empilés en lignes (photo en fondu, nom, jour en entier) ; les repas encore à prévoir, masqués derrière un
 * raccourci dès que des menus sont choisis ; liste de courses ; barre de navigation.
 */
export default function Accueil() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { timers } = useTimers();
  const scroll = useRef<ScrollViewInstance>(null);
  const planningY = useRef(0);
  const today = toIsoDate(new Date());
  const days = useMemo(() => weekDates(today), [today]);
  const [slots, setSlots] = useState<Record<string, WeekSlot>>({});
  const [choices, setChoices] = useState<Record<string, DayChoice>>({});
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [reminders, setReminders] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

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
      setLoaded(true);
      // Les repas enregistrés fixent la sélection de leur jour ; les autres jours gardent la sélection en cours.
      setChoices((prev) => Object.fromEntries(days.map((d) => {
        const saved = MEALS.map((m) => byKey[`${d}:${m}`]).filter((s): s is WeekSlot => s !== undefined);
        if (!saved.length) return [d, prev[d] ?? { dejeuner: false, diner: true, time: DEFAULT_TIME }];
        const wanted = (m: MealType) => (byKey[`${d}:${m}`] ? byKey[`${d}:${m}`]!.status !== "skipped" : false);
        const open = saved.find((s) => s.status !== "accepted");
        return [d, { dejeuner: wanted("dejeuner"), diner: wanted("diner"), time: open ? snapTime(open.maxTotalMin) : prev[d]?.time ?? DEFAULT_TIME }];
      })));
      // Liste des photos rafraîchie en arrière-plan (nouvelles images, photos du foyer).
      setImages(await illustrationUrls(ids.filter((id): id is string => id !== null)));
      preloadPictures(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [household.id, today, days]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const picture = (recipeId: string | null) => (recipeId ? images[recipeId] ?? pictureOf(recipeId) : null);
  const choiceOf = (d: string): DayChoice => choices[d] ?? { dejeuner: false, diner: true, time: DEFAULT_TIME };
  const update = (d: string, patch: Partial<DayChoice>) => setChoices((p) => ({ ...p, [d]: { ...choiceOf(d), ...patch } }));
  const isChosen = (d: string, m: MealType) => slots[`${d}:${m}`]?.status === "accepted";

  // Menus choisis, dans l'ordre de la semaine : le premier (aujourd'hui, sinon le prochain) s'affiche en grand.
  const menus = days.flatMap((d) => MEALS.map((m) => slots[`${d}:${m}`]).filter((s): s is WeekSlot => s?.status === "accepted"));
  const hero = menus[0];
  const others = menus.slice(1);
  const showPlanning = loaded && (planning || menus.length === 0);
  const toPlan = days.filter((d) => MEALS.some((m) => !isChosen(d, m)));

  const requests: SlotRequest[] = days.flatMap((d) => MEALS
    .filter((m) => choiceOf(d)[m] && !isChosen(d, m))
    .map((m) => ({ date: d, mealType: m, maxTotalMin: choiceOf(d).time, servings: household.defaultServings })));

  const propose = async () => {
    setBusy("plan");
    setError("");
    try {
      const { planId } = await savePlan(supabase, household.id, today, addDays(today, 6), requests);
      setPlanning(false);
      router.push({ pathname: "/propositions", params: { plan: planId, start: today } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = (s: WeekSlot) => confirm(`Annuler « ${s.name} » ?`, "Annuler ce menu", async () => {
    setBusy(s.slotId);
    setError("");
    try {
      await cancelMealChoice(supabase, s.slotId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  });

  const openPlanning = () => {
    setPlanning(true);
    setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, planningY.current - 8), animated: true }), 80);
  };

  const toBuy = shopping.filter((i) => i.active && !i.boughtAt && !i.checkedAt);
  const open = (s: WeekSlot) => router.push(`/recette/${s.recipeId}`);

  const notifications = () => setReminders(true);

  const heroPicture = hero ? picture(hero.recipeId) : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ height: insets.top, backgroundColor: c.statusBar }} />
      <ScrollView ref={scroll} contentContainerStyle={{ paddingBottom: 12 }}>
        <LinearGradient colors={["#FEF8EE", c.background]} style={styles.header}>
          <View style={styles.logo}><Logo /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.brand, { color: c.primary, fontFamily: BRAND_FONT }]}>MenuMalin</Text>
            <Text style={[styles.slogan, { color: c.muted }]}>Bien manger, sans gaspiller</Text>
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

        <View style={{ paddingHorizontal: 8 }}>
          <ErrorText>{error}</ErrorText>
          {hero && (
            <View style={[styles.hero, { backgroundColor: c.chip }]}>
              <Pressable onPress={() => open(hero)} accessibilityRole="button"
                accessibilityLabel={`${dayLabel(hero.date, today)}, ${mealLabel(hero.mealType)} : ${hero.name}`}>
                {heroPicture
                  ? <Image source={{ uri: heroPicture.uri, cacheKey: heroPicture.cacheKey }} cachePolicy="memory-disk" priority="high"
                    style={styles.heroImage} contentFit="cover" transition={0} />
                  : <View style={[styles.heroImage, styles.heroWaiting]}><Icon name="image" size={44} color={c.muted} /></View>}
                <LinearGradient colors={["rgba(20,24,12,0.66)", "rgba(20,24,12,0.34)", "rgba(20,24,12,0.08)"]} locations={[0, 0.58, 1]}
                  start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
                <View style={[styles.heroPill, { backgroundColor: c.heroPill }]}>
                  <Text style={styles.heroPillText}>{dayLabel(hero.date, today)} · {mealLabel(hero.mealType)}</Text>
                </View>
                <Text style={styles.heroTitle} numberOfLines={2}>{hero.name}</Text>
                <View style={styles.heroMeta}>
                  {hero.totalMin ? <><Icon name="clock" size={18} color="#FFFFFF" /><Text style={styles.heroMetaText}>{minutes(hero.totalMin)}</Text></> : null}
                  {hero.difficulty ? <><Icon name="toque" size={18} color="#FFFFFF" /><Text style={styles.heroMetaText}>{LEVEL[hero.difficulty]}</Text></> : null}
                </View>
              </Pressable>
              <Pressable onPress={() => cancel(hero)} disabled={busy !== null} accessibilityRole="button" style={styles.heroCancel}>
                <Text style={styles.heroCancelText}>{busy === hero.slotId ? "Annulation…" : "Annuler ce menu"}</Text>
              </Pressable>
            </View>
          )}
        </View>

        {loaded && (
          <IngredientMenu householdId={household.id} today={today} busy={busy === "today"} onFind={findTodayMenu}
            todaySlots={{ dejeuner: slots[`${today}:dejeuner`], diner: slots[`${today}:diner`] }} />
        )}

        <View style={{ paddingLeft: 13, paddingRight: 9 }}>
          <SectionTitle icon="calendar" title="Ma semaine de menus" action="Recettes" onAction={() => router.push("/recettes")} />
        </View>

        <View style={styles.list}>
          {loaded && menus.length === 0 && (
            <Text style={[styles.empty, { color: c.muted }]}>Aucun menu choisi pour la semaine : cochez les repas à prévoir ci-dessous.</Text>
          )}
          {others.map((s) => {
            const pic = picture(s.recipeId);
            return (
              <Pressable key={s.slotId} onPress={() => open(s)} accessibilityRole="button"
                accessibilityLabel={`${dayLabel(s.date, today)}, ${mealLabel(s.mealType)} : ${s.name}`}
                style={({ pressed }) => [styles.row, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.85 : 1 }, CARD_SHADOW]}>
                <View style={styles.rowPhoto}>
                  {pic
                    ? <Image source={{ uri: pic.uri, cacheKey: pic.cacheKey }} cachePolicy="memory-disk" style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
                    : <View style={[StyleSheet.absoluteFill, styles.rowWaiting, { backgroundColor: c.chip }]}><Icon name="image" size={28} color={c.muted} /></View>}
                  <LinearGradient colors={FADE} locations={[0, 0.55, 1]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.rowFade} />
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowDay, { color: s.date === today ? c.primary : c.muted }]}>{dayLabel(s.date, today)} · {mealLabel(s.mealType)}</Text>
                  <Text style={[styles.rowName, { color: c.text }]} numberOfLines={2}>{s.name}</Text>
                  <View style={styles.rowFoot}>
                    {s.totalMin ? <Text style={[styles.rowMeta, { color: c.muted }]}>{minutes(s.totalMin)}</Text> : null}
                    <TextLink title={busy === s.slotId ? "Annulation…" : "Annuler"} onPress={() => cancel(s)} disabled={busy !== null} />
                  </View>
                </View>
                <View style={styles.chevron}><Icon name="chevronRight" width={9} height={15} color={c.text} /></View>
              </Pressable>
            );
          })}
        </View>

        {showPlanning && toPlan.length > 0 && (
          <View onLayout={(e) => {
            planningY.current = e.nativeEvent.layout.y;
          }}>
            <View style={styles.planningHead}>
              <View style={{ flex: 1 }}><SectionTitle icon="calendar" title="Repas à prévoir" /></View>
              {menus.length > 0 && <TextLink title="Masquer" onPress={() => setPlanning(false)} />}
            </View>
            <View style={styles.list}>
              {toPlan.map((d) => {
                const choice = choiceOf(d);
                const planned = MEALS.filter((m) => !isChosen(d, m));
                const active = planned.some((m) => choice[m]);
                return (
                  <View key={d} style={[styles.day, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
                    <Text style={[styles.dayName, { color: d === today ? c.primary : c.text }]}>{dayLabel(d, today)}</Text>
                    <View style={styles.plan}>
                      <View style={{ flex: 1, gap: 8 }}>
                        {planned.map((m) => {
                          const on = choice[m];
                          return (
                            <Pressable key={m} onPress={() => update(d, { [m]: !on })} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                              style={({ pressed }) => [styles.mealChip, {
                                backgroundColor: on ? c.greenSoft : c.chip, borderColor: on ? c.primary : "transparent", opacity: pressed ? 0.8 : 1,
                              }]}>
                              <Icon name={on ? "checkCircle" : "circle"} size={22} color={on ? c.primary : c.text} />
                              <Text style={{ color: c.text, fontSize: 16, fontWeight: "500" }}>{mealLabel(m)}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      {active
                        ? <TimeWheel value={choice.time} onChange={(time) => update(d, { time })} />
                        : <Text style={[styles.nothing, { color: c.muted }]}>Rien de prévu</Text>}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        <Pressable onPress={() => router.navigate("/courses")} accessibilityRole="button"
          style={({ pressed }) => [styles.shopping, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.8 : 1 }, CARD_SHADOW]}>
          <View style={[styles.shoppingIcon, { backgroundColor: c.chip }]}><Icon name="cartFilled" width={24} height={22} color={c.text} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowName, { color: c.text }]}>Liste de courses</Text>
            <Text style={[styles.rowMeta, { color: toBuy.length ? c.orangeInk : c.muted, fontWeight: "500" }]}>
              {toBuy.length ? `${toBuy.length} article${toBuy.length > 1 ? "s" : ""} à acheter` : "Rien à acheter"}
            </Text>
          </View>
          <Icon name="chevronRight" width={9} height={15} color={c.text} />
        </Pressable>
      </ScrollView>

      {loaded && (
        <View style={styles.cta}>
          {showPlanning
            ? <Button icon="wand" title={requests.length ? `Proposer les menus (${requests.length} repas)` : "Cochez les repas à prévoir"}
              onPress={propose} busy={busy === "plan"} disabled={!requests.length} />
            : toPlan.length > 0 ? <Button icon="calendar" kind="secondary" title="Prévoir d'autres repas" onPress={openPlanning} /> : null}
        </View>
      )}
      <TimersBar />
      <BottomNav active="accueil" />
      <ReminderSheet visible={reminders} onClose={() => setReminders(false)} today={today} menus={menus} toBuy={toBuy.length}
        onOpenRecipe={(id) => router.push(`/recette/${id}`)} onOpenShopping={() => router.navigate("/courses")} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { height: 71, flexDirection: "row", alignItems: "center", paddingLeft: 13, paddingRight: 8, gap: 5 },
  logo: { width: 58, alignItems: "center" },
  brand: { fontSize: 26.5, lineHeight: 30 },
  slogan: { fontSize: 12.2, lineHeight: 16, fontWeight: "500" },
  round: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: 10, right: 11, width: 9, height: 9, borderRadius: 5 },
  avatar: { width: 45, height: 45, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  hero: { height: 172, borderRadius: 17, overflow: "hidden", marginBottom: 4 },
  heroImage: { width: "100%", height: 172 },
  heroWaiting: { alignItems: "center", justifyContent: "center" },
  heroPill: { position: "absolute", left: 17, top: 22, height: 28, borderRadius: 14, paddingHorizontal: 12, justifyContent: "center" },
  heroPillText: { color: "#FFFFFF", fontSize: 16, fontWeight: "500" },
  heroTitle: {
    position: "absolute", left: 19, right: 19, top: 60, color: "#FFFFFF", fontSize: 24.5, lineHeight: 28.5, fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.45)", textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 },
  },
  heroMeta: { position: "absolute", left: 18, top: 137, flexDirection: "row", alignItems: "center", gap: 7 },
  heroMetaText: {
    color: "#FFFFFF", fontSize: 16, fontWeight: "500", marginRight: 12,
    textShadowColor: "rgba(0,0,0,0.4)", textShadowRadius: 2, textShadowOffset: { width: 0, height: 1 },
  },
  heroCancel: { position: "absolute", right: 4, bottom: 0, minHeight: 48, paddingHorizontal: 12, justifyContent: "center" },
  heroCancelText: {
    color: "#FFFFFF", fontSize: 14.2, fontWeight: "500", textDecorationLine: "underline",
    textShadowColor: "rgba(0,0,0,0.7)", textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 },
  },
  list: { paddingLeft: 12.8, paddingRight: 9.2, gap: 7 },
  empty: { fontSize: 15, lineHeight: 20, paddingHorizontal: 2, paddingBottom: 4 },
  row: { minHeight: 96, borderRadius: 12, borderWidth: 1, overflow: "hidden", flexDirection: "row" },
  rowPhoto: { position: "absolute", left: 0, top: 0, bottom: 0, width: 156 },
  rowWaiting: { alignItems: "center", justifyContent: "center" },
  rowFade: { position: "absolute", top: 0, bottom: 0, right: 0, width: 78 },
  rowText: { flex: 1, minWidth: 0, marginLeft: 150, paddingTop: 10, paddingBottom: 2, paddingRight: 26, justifyContent: "center" },
  rowDay: { fontSize: 13.5, lineHeight: 17, fontWeight: "600" },
  rowName: { fontSize: 15.5, lineHeight: 19, fontWeight: "700", marginTop: 1 },
  rowFoot: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowMeta: { fontSize: 14.2, lineHeight: 18 },
  chevron: { position: "absolute", right: 10, top: 0, bottom: 0, justifyContent: "center" },
  planningHead: { flexDirection: "row", alignItems: "center", paddingLeft: 13, paddingRight: 13, marginTop: 6 },
  day: { borderRadius: 12, borderWidth: 1, paddingTop: 10, paddingLeft: 12, paddingRight: 8, paddingBottom: 8, gap: 8 },
  dayName: { fontSize: 16, lineHeight: 20, fontWeight: "700" },
  plan: { flexDirection: "row", alignItems: "center", gap: 10 },
  mealChip: { height: 48, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 10, borderRadius: 13, borderWidth: 1.5 },
  nothing: { width: 112, textAlign: "center", fontSize: 15, lineHeight: 20 },
  shopping: {
    flexDirection: "row", alignItems: "center", gap: 12, minHeight: 66, marginTop: 12, marginLeft: 12.8, marginRight: 9.2,
    paddingVertical: 8, paddingLeft: 12, paddingRight: 9, borderRadius: 12, borderWidth: 1,
  },
  shoppingIcon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  cta: { paddingTop: 8, paddingBottom: 6, paddingLeft: 14, paddingRight: 9 },
});
