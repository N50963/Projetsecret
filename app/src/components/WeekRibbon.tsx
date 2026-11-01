/**
 * Repas à prévoir en « ruban de la semaine » (maquette Claude Design « Piste A · Ruban de la semaine ») : les 7 jours en
 * pastilles (jour abrégé, numéro, deux barrettes pour le déjeuner et le dîner), puis la carte du jour choisi avec ses deux
 * repas. Un menu déjà choisi s'y affiche avec sa photo (toucher pour la fiche, croix pour l'annuler) ; un repas encore
 * libre se coche (« À proposer ») et reçoit son temps disponible : 30 min, 1 h ou sans limite.
 */

import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { dayLabel, mealLabel, minutes } from "../lib/format";
import { sourceOf, type Picture } from "../lib/images";
import { CARD_SHADOW, useColors } from "../lib/theme";
import type { WeekSlot } from "../modules/planning";
import type { MealType } from "../modules/recipes";
import { Icon } from "./icons";
import { TIME_CHOICES } from "./TimeWheel";

export interface DayPlan {
  dejeuner: boolean;
  diner: boolean;
  /** Temps disponible pour chaque repas (préparation et cuisson) ; null : sans limite. */
  time: Record<MealType, number | null>;
}

const MEALS: MealType[] = ["dejeuner", "diner"];
const SHORT_DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
/** Pastille du jour sélectionné : même dégradé que les boutons principaux de la maquette. */
const SELECTED = ["#3A5F2C", "#3C5B2D", "#385A2D"] as const;
/** Fondu de la photo d'un menu choisi vers le fond de sa ligne (#FEF3E3). */
const PHOTO_FADE = ["rgba(254,243,227,0)", "#FEF3E3"] as const;
const BAR = {
  chosen: { on: "#FFFFFF", off: "#2C5A27" },
  wanted: { on: "rgba(255,255,255,0.6)", off: "#A3AE6E" },
  free: { on: "rgba(255,255,255,0.25)", off: "#E6D6BB" },
};

const timeLabel = (t: number | null) => (t === null ? "Sans limite" : minutes(t));

/** Titre de la carte : « Aujourd'hui », « Demain » ou le jour de la semaine, puis la date (« 3 novembre »). */
function dayTitle(date: string, today: string): [string, string] {
  const [weekday, ...rest] = dayLabel(date).split(" ");
  const relative = dayLabel(date, today);
  return [relative === dayLabel(date) ? weekday! : relative, rest.join(" ")];
}

export function WeekRibbon({ days, today, planOf, slotOf, picture, busy, onChange, onOpen, onCancel }: {
  days: string[]; today: string; planOf: (date: string) => DayPlan; slotOf: (date: string, meal: MealType) => WeekSlot | undefined;
  picture: (recipeId: string | null) => Picture | null; busy: boolean;
  onChange: (date: string, patch: Partial<DayPlan>) => void; onOpen: (slot: WeekSlot) => void; onCancel: (slot: WeekSlot) => void;
}) {
  const c = useColors();
  const chosen = (d: string, m: MealType) => {
    const s = slotOf(d, m);
    return s?.status === "accepted" ? s : undefined;
  };
  // Jour affiché : celui touché, sinon le premier qui a encore un repas libre.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && days.includes(picked) ? picked : days.find((d) => MEALS.some((m) => !chosen(d, m))) ?? days[0]!;
  const [title, date] = dayTitle(selected, today);
  const plan = planOf(selected);

  const state = (d: string, m: MealType) => (chosen(d, m) ? "chosen" : planOf(d)[m] ? "wanted" : "free");
  const summary = (d: string, m: MealType) => {
    const s = chosen(d, m);
    return `${mealLabel(m).toLowerCase()} ${s ? `choisi, ${s.name}` : planOf(d)[m] ? "à proposer" : "à prévoir"}`;
  };

  return (
    <View>
      <View style={styles.ribbon}>
        {days.map((d) => {
          const active = d === selected;
          const isToday = d === today;
          const day = new Date(`${d}T12:00:00`);
          const [dTitle, dDate] = dayTitle(d, today);
          const ink = active ? "#FFFFFF" : isToday ? c.primary : c.text;
          return (
            <Pressable key={d} onPress={() => setPicked(d)} accessibilityRole="button" accessibilityState={{ selected: active }}
              accessibilityLabel={`${dTitle}, ${dDate} : ${summary(d, "dejeuner")}, ${summary(d, "diner")}`}
              style={({ pressed }) => [styles.day, active ? styles.dayActive : [{ backgroundColor: c.card, borderColor: isToday ? c.primary : c.cardLine }, CARD_SHADOW],
                { opacity: pressed ? 0.8 : 1 }]}>
              {active && <LinearGradient colors={SELECTED} locations={[0, 0.5, 1]} start={{ x: 0, y: 0.45 }} end={{ x: 1, y: 0.55 }} style={[StyleSheet.absoluteFill, styles.dayGradient]} />}
              <Text style={[styles.dayShort, { color: ink }]}>{SHORT_DAYS[day.getDay()]}</Text>
              <Text style={[styles.dayNumber, { color: ink }]}>{day.getDate()}</Text>
              <View style={styles.bars}>
                {MEALS.map((m) => <View key={m} style={[styles.bar, { backgroundColor: BAR[state(d, m)][active ? "on" : "off"] }]} />)}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]} accessibilityLabel={`${title}, ${date}`}>
        <View style={styles.cardHead}>
          <Text style={[styles.cardTitle, { color: selected === today ? c.primary : c.text }]} accessibilityRole="header">{title}</Text>
          <Text style={[styles.cardDate, { color: c.muted }]}>{date}</Text>
        </View>

        {MEALS.map((m) => {
          const slot = chosen(selected, m);
          if (slot) {
            const pic = picture(slot.recipeId);
            return (
              <View key={m} style={[styles.dish, { backgroundColor: c.background, borderColor: c.border }]}>
                <Pressable onPress={() => onOpen(slot)} accessibilityRole="button" accessibilityLabel={`Ouvrir la fiche : ${slot.name}`}
                  style={({ pressed }) => [styles.dishLink, { opacity: pressed ? 0.85 : 1 }]}>
                  <View style={styles.dishPhoto}>
                    {pic
                      ? <Image source={sourceOf(pic)} cachePolicy="memory-disk" style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
                      : <View style={[StyleSheet.absoluteFill, styles.dishWaiting, { backgroundColor: c.chip }]}><Icon name="image" size={26} color={c.muted} /></View>}
                    <LinearGradient colors={PHOTO_FADE} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.dishFade} />
                  </View>
                  <View style={styles.dishText}>
                    <Text style={[styles.dishMeta, { color: c.muted }]} numberOfLines={1}>
                      {mealLabel(m)}{slot.totalMin ? ` • ${minutes(slot.totalMin)}` : ""}
                    </Text>
                    <Text style={[styles.dishName, { color: c.text }]} numberOfLines={2}>{slot.name}</Text>
                  </View>
                </Pressable>
                <Pressable onPress={() => onCancel(slot)} disabled={busy} accessibilityRole="button" accessibilityLabel={`Annuler ce menu : ${slot.name}`}
                  style={({ pressed }) => [styles.dishClose, { opacity: pressed ? 0.6 : 1 }]}>
                  <Icon name="cross" size={16} color={c.muted} />
                </Pressable>
              </View>
            );
          }
          const on = plan[m];
          return (
            <View key={m} style={[styles.meal, { backgroundColor: on ? c.greenSoft : c.chip, borderColor: on ? c.primary : "transparent" }]}>
              <Pressable onPress={() => onChange(selected, { [m]: !on })} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                accessibilityLabel={`${mealLabel(m)} du ${date}`} style={({ pressed }) => [styles.mealToggle, { opacity: pressed ? 0.8 : 1 }]}>
                <View style={[styles.mealIcon, { backgroundColor: c.card }]}>
                  <Icon name={m === "dejeuner" ? "sun" : "moon"} size={22} color={c.greenInk} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.mealName, { color: c.text }]}>{mealLabel(m)}</Text>
                  <Text style={[styles.mealSub, { color: c.muted }]}>{on ? "À proposer" : "À prévoir"}</Text>
                </View>
                {on
                  ? <View style={[styles.mark, { backgroundColor: c.primary }]}><Icon name="tick" size={16} color="#FFFFFF" /></View>
                  : <View style={[styles.mark, styles.markOff, { borderColor: c.muted }]} />}
              </Pressable>
              {on ? (
                <View style={styles.times} accessibilityRole="radiogroup" accessibilityLabel="Temps disponible">
                  <View style={{ marginRight: 6 }}><Icon name="clock" size={20} color={c.greenInk} /></View>
                  {TIME_CHOICES.map((t) => {
                    const sel = plan.time[m] === t;
                    return (
                      <Pressable key={String(t)} onPress={() => onChange(selected, { time: { ...plan.time, [m]: t } })} accessibilityRole="radio"
                        accessibilityState={{ selected: sel }} accessibilityLabel={`${mealLabel(m)} : ${timeLabel(t)}`}
                        style={({ pressed }) => [styles.time, { borderColor: sel ? c.primary : "transparent", backgroundColor: sel ? c.card : "transparent", opacity: pressed ? 0.7 : 1 }]}>
                        <Text style={[styles.timeText, { color: c.text, fontWeight: sel ? "700" : "500" }]} numberOfLines={1}>{timeLabel(t)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ribbon: { flexDirection: "row", gap: 5, marginLeft: 12.8, marginRight: 9.2 },
  day: { flex: 1, minWidth: 0, height: 76, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  dayActive: {
    borderColor: "transparent", shadowColor: "#3C501E", shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  dayGradient: { borderRadius: 14 },
  dayShort: { fontSize: 14.2, lineHeight: 17, fontWeight: "500" },
  dayNumber: { marginTop: 1, fontSize: 20, lineHeight: 24, fontWeight: "700" },
  bars: { marginTop: 6, flexDirection: "row", gap: 3 },
  bar: { width: 16, height: 5, borderRadius: 3 },
  card: { marginTop: 10, marginLeft: 12.8, marginRight: 9.2, padding: 11, borderRadius: 17, borderWidth: 1, gap: 8 },
  cardHead: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 3 },
  cardTitle: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  cardDate: { fontSize: 14.2, lineHeight: 18 },
  dish: { height: 86, borderRadius: 13, borderWidth: 1, overflow: "hidden" },
  dishLink: { flexDirection: "row", height: 84 },
  dishPhoto: { width: 98, height: 84 },
  dishWaiting: { alignItems: "center", justifyContent: "center" },
  dishFade: { position: "absolute", right: 0, top: 0, bottom: 0, width: 26 },
  dishText: { flex: 1, minWidth: 0, paddingLeft: 6, paddingRight: 42, justifyContent: "center" },
  dishMeta: { fontSize: 14.2, lineHeight: 18 },
  dishName: { fontSize: 15.5, lineHeight: 18.5, fontWeight: "700" },
  dishClose: { position: "absolute", right: 0, top: 0, width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  meal: { borderRadius: 13, borderWidth: 1.5 },
  mealToggle: { height: 60, paddingLeft: 9, paddingRight: 12, flexDirection: "row", alignItems: "center", gap: 11 },
  mealIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  mealName: { fontSize: 15.5, lineHeight: 19, fontWeight: "700" },
  mealSub: { fontSize: 14.2, lineHeight: 18 },
  mark: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  markOff: { borderWidth: 2 },
  times: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 18, paddingRight: 8, paddingBottom: 8 },
  time: { flex: 1, minWidth: 0, height: 48, borderRadius: 12, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  timeText: { fontSize: 15 },
});
