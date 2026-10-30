import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, View } from "react-native";

import { Illustration } from "../components/Illustration";
import { TimeWheel } from "../components/TimeWheel";
import { Body, Button, Card, Chip, ErrorText, H2, HeaderIcon, Muted, Row, Screen } from "../components/ui";
import { dayLabel, mealLabel } from "../lib/format";
import { illustrationUrls, type Picture } from "../lib/images";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import {
  addDays, cancelMealChoice, getShoppingList, getWeekSlots, savePlan, toIsoDate, weekDates, type ShoppingItem, type SlotRequest, type WeekSlot,
} from "../modules/planning";
import type { MealType } from "../modules/recipes";

const MEALS: MealType[] = ["dejeuner", "diner"];
const DEFAULT_TIME = 60;

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

/** Accueil : la semaine jour par jour, avec les menus choisis (photo, nom) et les repas à prévoir. */
export default function Accueil() {
  const router = useRouter();
  const household = useHousehold();
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
      const ids = week.map((s) => s.recipeId).filter((id): id is string => id !== null);
      if (ids.length) setImages(await illustrationUrls(ids));
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

  const cancel = (s: WeekSlot) => confirm(`Annuler « ${s.name} » pour ${dayLabel(s.date, today).toLowerCase()} ?`, "Annuler ce menu", async () => {
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

  return (
    <Screen title={household.name}
      headerRight={() => <HeaderIcon name="settings-outline" label="Paramètres" onPress={() => router.push("/parametres")} />}>
      <ErrorText>{error}</ErrorText>

      {days.map((d) => {
        const choice = choiceOf(d);
        const chosen = MEALS.map((m) => slots[`${d}:${m}`]).filter((s): s is WeekSlot => s?.status === "accepted");
        const open = MEALS.filter((m) => !isChosen(d, m));
        return (
          <Card key={d}>
            <H2>{dayLabel(d, today)}</H2>
            {chosen.map((s) => (
              <View key={s.slotId} style={styles.meal}>
                <Pressable onPress={() => router.push(`/recette/${s.recipeId}`)} style={styles.thumb} accessibilityRole="button"
                  accessibilityLabel={`Voir la recette ${s.name}`}>
                  <Illustration picture={images[s.recipeId!]} height={88} rounded={12} />
                </Pressable>
                <View style={{ flex: 1, gap: 2 }}>
                  <Muted>{mealLabel(s.mealType)}</Muted>
                  <Body onPress={() => router.push(`/recette/${s.recipeId}`)} style={{ fontWeight: "700" }}>{s.name}</Body>
                  <Pressable onPress={() => cancel(s)} hitSlop={8} disabled={busy !== null} accessibilityRole="button">
                    <Muted style={{ textDecorationLine: "underline" }}>{busy === s.slotId ? "Annulation…" : "Annuler ce menu"}</Muted>
                  </Pressable>
                </View>
              </View>
            ))}
            {open.length > 0 && (
              <View style={styles.plan}>
                <View style={{ flex: 1, gap: 8, alignItems: "flex-start" }}>
                  {open.map((m) => <Chip key={m} label={mealLabel(m)} active={choice[m]} onPress={() => update(d, { [m]: !choice[m] })} />)}
                </View>
                {open.some((m) => choice[m]) && (
                  <View style={{ width: 118 }}>
                    <TimeWheel value={choice.time} onChange={(time) => update(d, { time })} />
                  </View>
                )}
              </View>
            )}
          </Card>
        );
      })}

      <Button title={requests.length ? `Proposer les menus (${requests.length} repas)` : "Tous les repas cochés ont un menu"}
        onPress={propose} busy={busy === "plan"} disabled={!requests.length} />

      {toBuy.length > 0 && (
        <Card>
          <H2>Liste de courses</H2>
          <Body>{toBuy.length} article{toBuy.length > 1 ? "s" : ""} à acheter pour les menus choisis.</Body>
          <Button title="Voir la liste" kind="secondary" onPress={() => router.push("/courses")} />
        </Card>
      )}
      <Row>
        <Button title="Recettes" kind="secondary" onPress={() => router.push("/recettes")} style={{ flex: 1 }} />
        <Button title="Courses" kind="secondary" onPress={() => router.push("/courses")} style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}

const styles = StyleSheet.create({
  meal: { flexDirection: "row", gap: 12, alignItems: "center" },
  thumb: { width: 88, height: 88 },
  plan: { flexDirection: "row", gap: 12, alignItems: "center" },
});
