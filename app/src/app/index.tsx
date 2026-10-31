import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, Logo } from "../components/icons";
import { Illustration } from "../components/Illustration";
import { TimersBar } from "../components/Steps";
import { TimeWheel } from "../components/TimeWheel";
import { BottomNav, Button, ErrorText, SectionTitle, TextLink } from "../components/ui";
import { mealLabel, minutes } from "../lib/format";
import { illustrationUrls, type Picture } from "../lib/images";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { BRAND_FONT, CARD_SHADOW, useColors } from "../lib/theme";
import { useTimers } from "../lib/timers";
import {
  addDays, cancelMealChoice, getShoppingList, getWeekSlots, savePlan, toIsoDate, weekDates, type ShoppingItem, type SlotRequest, type WeekSlot,
} from "../modules/planning";
import type { MealType } from "../modules/recipes";

const MEALS: MealType[] = ["dejeuner", "diner"];
const DEFAULT_TIME = 60;
const SHORT_DAYS = ["Dim.", "Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam."];
const LEVEL = ["", "Facile", "Moyen", "Difficile"];

interface DayChoice {
  dejeuner: boolean;
  diner: boolean;
  /** Temps disponible pour les repas du jour (préparation et cuisson) ; null : sans limite. */
  time: number | null;
}

/** Temps enregistré ramené aux choix de la roue (30 min, 1 h, sans limite). */
const snapTime = (t: number | null) => (t === null ? null : t <= 30 ? 30 : t <= 60 ? 60 : null);

const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return { day: SHORT_DAYS[d.getDay()] ?? "", date: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}` };
};

function confirm(message: string, action: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(message)) onConfirm();
    return;
  }
  Alert.alert(message, undefined, [{ text: "Garder", style: "cancel" }, { text: action, style: "destructive", onPress: onConfirm }]);
}

/**
 * Accueil MenuMalin : en-tête au logo, plat du jour, « Ma semaine de menus » (une carte par jour : repas choisis, repas
 * à prévoir et temps disponible), bouton « Proposer les menus », liste de courses, barre de navigation.
 */
export default function Accueil() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { timers } = useTimers();
  const today = toIsoDate(new Date());
  const days = useMemo(() => weekDates(today), [today]);
  const [slots, setSlots] = useState<Record<string, WeekSlot>>({});
  const [choices, setChoices] = useState<Record<string, DayChoice>>({});
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [week, list] = await Promise.all([
        getWeekSlots(supabase, household.id, today, addDays(today, 6)),
        getShoppingList(supabase, household.id),
      ]);
      const byKey: Record<string, WeekSlot> = Object.fromEntries(week.map((s) => [`${s.date}:${s.mealType}`, s]));
      setSlots(byKey);
      setShopping(list);
      // Les repas enregistrés fixent la sélection de leur jour ; les autres jours gardent la sélection en cours.
      setChoices((prev) => Object.fromEntries(days.map((d) => {
        const saved = MEALS.map((m) => byKey[`${d}:${m}`]).filter((s): s is WeekSlot => s !== undefined);
        if (!saved.length) return [d, prev[d] ?? { dejeuner: false, diner: true, time: DEFAULT_TIME }];
        const wanted = (m: MealType) => (byKey[`${d}:${m}`] ? byKey[`${d}:${m}`]!.status !== "skipped" : false);
        const open = saved.find((s) => s.status !== "accepted");
        return [d, { dejeuner: wanted("dejeuner"), diner: wanted("diner"), time: open ? snapTime(open.maxTotalMin) : prev[d]?.time ?? DEFAULT_TIME }];
      })));
      // Toujours appelé : lance aussi le téléchargement en avance de toutes les photos des plats.
      setImages(await illustrationUrls(week.map((s) => s.recipeId).filter((id): id is string => id !== null)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [household.id, today, days]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const choiceOf = (d: string): DayChoice => choices[d] ?? { dejeuner: false, diner: true, time: DEFAULT_TIME };
  const update = (d: string, patch: Partial<DayChoice>) => setChoices((p) => ({ ...p, [d]: { ...choiceOf(d), ...patch } }));
  const isChosen = (d: string, m: MealType) => slots[`${d}:${m}`]?.status === "accepted";
  const chosenOf = (d: string) => MEALS.map((m) => slots[`${d}:${m}`]).filter((s): s is WeekSlot => s?.status === "accepted");

  const requests: SlotRequest[] = days.flatMap((d) => MEALS
    .filter((m) => choiceOf(d)[m] && !isChosen(d, m))
    .map((m) => ({ date: d, mealType: m, maxTotalMin: choiceOf(d).time, servings: household.defaultServings })));

  const propose = async () => {
    setBusy("plan");
    setError("");
    try {
      const { planId } = await savePlan(supabase, household.id, today, addDays(today, 6), requests);
      router.push({ pathname: "/propositions", params: { plan: planId, start: today } });
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

  const toBuy = shopping.filter((i) => !i.boughtAt && !i.checkedAt);
  // Plat du jour : le premier repas choisi pour aujourd'hui, en grand.
  const hero = chosenOf(today)[0];

  const notifications = () => {
    const lines = [
      ...chosenOf(today).map((s) => `${mealLabel(s.mealType)} : ${s.name}`),
      ...timers.filter((t) => !t.done).map((t) => `Minuteur en cours : ${t.subject}`),
      ...timers.filter((t) => t.done).map((t) => `Minuteur terminé : ${t.subject}`),
      toBuy.length ? `${toBuy.length} article${toBuy.length > 1 ? "s" : ""} à acheter` : "",
    ].filter(Boolean);
    const text = lines.length ? lines.join("\n") : "Rien de prévu aujourd'hui.";
    if (Platform.OS === "web") window.alert(text);
    else Alert.alert("Aujourd'hui", text);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ height: insets.top, backgroundColor: c.statusBar }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
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

        <View style={{ paddingHorizontal: 8, gap: 0 }}>
          <ErrorText>{error}</ErrorText>
          {hero && (
            <View style={styles.hero}>
              <Pressable onPress={() => router.push(`/recette/${hero.recipeId}`)} accessibilityRole="button"
                accessibilityLabel={`Plat du jour : ${hero.name}${hero.totalMin ? `, ${minutes(hero.totalMin)}` : ""}`}>
                {images[hero.recipeId!]
                  ? <Image source={{ uri: images[hero.recipeId!]!.uri, cacheKey: images[hero.recipeId!]!.cacheKey }} cachePolicy="memory-disk"
                    style={styles.heroImage} contentFit="cover" transition={0} />
                  : <Illustration picture={null} height={172} rounded={0} />}
                <LinearGradient colors={["rgba(20,24,12,0.66)", "rgba(20,24,12,0.34)", "rgba(20,24,12,0.08)"]} locations={[0, 0.58, 1]}
                  start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
                <View style={[styles.heroPill, { backgroundColor: c.heroPill }]}>
                  <Text style={styles.heroPillText}>Aujourd’hui · {mealLabel(hero.mealType)}</Text>
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

        <View style={{ paddingLeft: 13, paddingRight: 9 }}>
          <SectionTitle icon="calendar" title="Ma semaine de menus" action="Recettes" onAction={() => router.push("/recettes")} />
        </View>

        <View style={styles.week}>
          {days.map((d) => {
            const choice = choiceOf(d);
            const isToday = d === today;
            const chosen = chosenOf(d).filter((s) => s.slotId !== hero?.slotId);
            const planned = MEALS.filter((m) => !isChosen(d, m));
            const active = planned.some((m) => choice[m]);
            const { day, date } = shortDate(d);
            if (!chosen.length && !planned.length) return null;
            return (
              <View key={d} style={[styles.day, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
                <View style={styles.dayLabel}>
                  <Text style={[styles.dayName, { color: isToday ? c.primary : c.text }]}>{day}</Text>
                  <Text style={[styles.dayDate, { color: isToday ? c.primary : c.text }]}>{date}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {chosen.map((s, i) => (
                    <View key={s.slotId} style={[styles.meal, i > 0 && { marginTop: 4 }]}>
                      <Pressable onPress={() => router.push(`/recette/${s.recipeId}`)} accessibilityRole="button" accessibilityLabel={`Ouvrir la fiche : ${s.name}`}>
                        <Illustration picture={images[s.recipeId!]} height={88} width={86} rounded={9} />
                      </Pressable>
                      <View style={styles.mealText}>
                        <Pressable onPress={() => router.push(`/recette/${s.recipeId}`)} accessibilityRole="link">
                          <Text style={[styles.mealName, { color: c.text }]} numberOfLines={2}>{s.name}</Text>
                          <Text style={[styles.mealMeta, { color: c.muted }]}>
                            {mealLabel(s.mealType)}{s.totalMin ? ` • ${minutes(s.totalMin)}` : ""}
                          </Text>
                        </Pressable>
                        <TextLink title={busy === s.slotId ? "Annulation…" : "Annuler ce menu"} onPress={() => cancel(s)} disabled={busy !== null} />
                      </View>
                      <View style={styles.chevron}><Icon name="chevronRight" width={9} height={15} color={c.text} /></View>
                    </View>
                  ))}
                  {chosen.length > 0 && planned.length > 0 && <View style={[styles.separator, { backgroundColor: c.border }]} />}
                  {planned.length > 0 && (
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
                  )}
                </View>
              </View>
            );
          })}
        </View>

        <Pressable onPress={() => router.navigate("/courses")} accessibilityRole="button"
          style={({ pressed }) => [styles.shopping, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.8 : 1 }, CARD_SHADOW]}>
          <View style={[styles.shoppingIcon, { backgroundColor: c.chip }]}><Icon name="cartFilled" width={24} height={22} color={c.text} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.mealName, { color: c.text }]}>Liste de courses</Text>
            <Text style={[styles.mealMeta, { color: toBuy.length ? c.orangeInk : c.muted, fontWeight: "500" }]}>
              {toBuy.length ? `${toBuy.length} article${toBuy.length > 1 ? "s" : ""} à acheter` : "Rien à acheter"}
            </Text>
          </View>
          <Icon name="chevronRight" width={9} height={15} color={c.text} />
        </Pressable>
      </ScrollView>

      <View style={styles.cta}>
        <Button icon="wand" title={requests.length ? `Proposer les menus (${requests.length} repas)` : "Tous les repas cochés ont un menu"}
          onPress={propose} busy={busy === "plan"} disabled={!requests.length} />
      </View>
      <TimersBar />
      <BottomNav active="accueil" />
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
  week: { paddingLeft: 12.8, paddingRight: 9.2, gap: 7 },
  day: { flexDirection: "row", borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  dayLabel: { width: 73, paddingLeft: 10, justifyContent: "center" },
  dayName: { fontSize: 16, lineHeight: 18, fontWeight: "700" },
  dayDate: { fontSize: 16.5, lineHeight: 18, fontWeight: "700", letterSpacing: -1.1 },
  meal: { flexDirection: "row", minHeight: 88 },
  mealText: { flex: 1, minWidth: 0, paddingTop: 9, paddingLeft: 14, paddingRight: 22 },
  mealName: { fontSize: 15.5, lineHeight: 18, fontWeight: "700" },
  mealMeta: { marginTop: 2, fontSize: 14.2, lineHeight: 18 },
  chevron: { position: "absolute", right: 10, top: 0, bottom: 0, justifyContent: "center" },
  separator: { height: 1, marginRight: 10 },
  plan: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingRight: 8 },
  mealChip: { height: 48, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 10, borderRadius: 13, borderWidth: 1.5 },
  nothing: { width: 112, textAlign: "center", fontSize: 15, lineHeight: 20 },
  shopping: {
    flexDirection: "row", alignItems: "center", gap: 12, minHeight: 66, marginTop: 12, marginLeft: 12.8, marginRight: 9.2,
    paddingVertical: 8, paddingLeft: 12, paddingRight: 9, borderRadius: 12, borderWidth: 1,
  },
  shoppingIcon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  cta: { paddingTop: 8, paddingBottom: 6, paddingLeft: 14, paddingRight: 9 },
});
