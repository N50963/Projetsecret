/**
 * Repas à prévoir en grille : une case par jour (trois par ligne, deux sur un petit écran). Dans chaque case : le jour en
 * entier, le déjeuner et le dîner à cocher, et le temps disponible (30 min, 1 h, sans limite) qui change à chaque toucher.
 */

import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { dayLabel, mealLabel, minutes } from "../lib/format";
import { CARD_SHADOW, useColors } from "../lib/theme";
import type { MealType } from "../modules/recipes";
import { Icon } from "./icons";
import { TIME_CHOICES } from "./TimeWheel";

export interface DayPlan {
  dejeuner: boolean;
  diner: boolean;
  /** Temps disponible pour les repas du jour (préparation et cuisson) ; null : sans limite. */
  time: number | null;
}

const MEALS: MealType[] = ["dejeuner", "diner"];
const GAP = 8;
const SIDE = 22;

const timeLabel = (t: number | null) => (t === null ? "Sans limite" : minutes(t));

/** « Aujourd'hui » / « Demain » / jour de la semaine, puis la date en entier (« 1er novembre »). */
function dayLines(date: string, today: string): [string, string] {
  const full = dayLabel(date);
  const [weekday, ...rest] = full.split(" ");
  const relative = dayLabel(date, today);
  return [relative === full ? weekday! : relative, rest.join(" ")];
}

function DayCell({ date, today, width, plan, chosen, onChange }: {
  date: string; today: string; width: number; plan: DayPlan; chosen: Record<MealType, boolean>; onChange: (patch: Partial<DayPlan>) => void;
}) {
  const c = useColors();
  const [top, sub] = dayLines(date, today);
  const active = MEALS.some((m) => !chosen[m] && plan[m]);
  const next = TIME_CHOICES[(Math.max(0, TIME_CHOICES.indexOf(plan.time)) + 1) % TIME_CHOICES.length] ?? null;
  return (
    <View style={[styles.cell, { width, backgroundColor: c.card, borderColor: active ? c.primary : c.cardLine }, CARD_SHADOW]}>
      <View>
        <Text style={[styles.day, { color: date === today ? c.primary : c.text }]} numberOfLines={1}>{top}</Text>
        <Text style={[styles.date, { color: c.muted }]} numberOfLines={1}>{sub}</Text>
      </View>
      {MEALS.map((m) => {
        if (chosen[m]) {
          return (
            <View key={m} style={styles.meal} accessibilityLabel={`${mealLabel(m)} déjà choisi`}>
              <Icon name="checkCircle" size={18} color={c.muted} />
              <Text style={[styles.mealText, { color: c.muted }]} numberOfLines={1}>{mealLabel(m)} choisi</Text>
            </View>
          );
        }
        const on = plan[m];
        return (
          <Pressable key={m} onPress={() => onChange({ [m]: !on })} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
            accessibilityLabel={`${top} ${sub}, ${mealLabel(m)}`} hitSlop={{ top: 3, bottom: 3 }}
            style={({ pressed }) => [styles.meal, styles.toggle, {
              backgroundColor: on ? c.greenSoft : c.chip, borderColor: on ? c.primary : "transparent", opacity: pressed ? 0.8 : 1,
            }]}>
            <Icon name={on ? "checkCircle" : "circle"} size={18} color={on ? c.primary : c.text} />
            <Text style={[styles.mealText, { color: c.text }]} numberOfLines={1}>{mealLabel(m)}</Text>
          </Pressable>
        );
      })}
      {active ? (
        <Pressable onPress={() => onChange({ time: next })} accessibilityRole="button"
          accessibilityLabel={`Temps disponible : ${timeLabel(plan.time)}. Toucher pour passer à ${timeLabel(next)}`}
          style={({ pressed }) => [styles.time, { backgroundColor: c.background, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}>
          <Icon name="clock" size={14} color={c.greenInk} />
          <Text style={[styles.timeText, { color: c.greenInk }]} numberOfLines={1}>{timeLabel(plan.time)}</Text>
        </Pressable>
      ) : (
        <View style={styles.time}><Text style={[styles.timeText, { color: c.muted, fontWeight: "400" }]} numberOfLines={1}>Rien de prévu</Text></View>
      )}
    </View>
  );
}

export function PlanningGrid({ days, today, planOf, isChosen, onChange }: {
  days: string[]; today: string; planOf: (date: string) => DayPlan; isChosen: (date: string, meal: MealType) => boolean;
  onChange: (date: string, patch: Partial<DayPlan>) => void;
}) {
  const { width } = useWindowDimensions();
  const inner = width - SIDE;
  // Trois cases par ligne, deux si l'écran est trop étroit pour « Déjeuner » et « Sans limite » sans coupure.
  const columns = (inner - 2 * GAP) / 3 >= 108 ? 3 : 2;
  const cell = Math.floor((inner - (columns - 1) * GAP) / columns);
  return (
    <View style={styles.grid}>
      {days.map((d) => (
        <DayCell key={d} date={d} today={today} width={cell} plan={planOf(d)}
          chosen={{ dejeuner: isChosen(d, "dejeuner"), diner: isChosen(d, "diner") }} onChange={(patch) => onChange(d, patch)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP, paddingLeft: 12.8, paddingRight: 9.2 },
  cell: { borderRadius: 12, borderWidth: 1, padding: 7, gap: 5 },
  day: { fontSize: 15, lineHeight: 19, fontWeight: "700" },
  date: { fontSize: 12.8, lineHeight: 16 },
  meal: { flexDirection: "row", alignItems: "center", gap: 5, height: 36, paddingHorizontal: 5 },
  toggle: { borderRadius: 9, borderWidth: 1.5 },
  mealText: { flexShrink: 1, fontSize: 14, fontWeight: "500" },
  time: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, height: 32, borderRadius: 9, borderWidth: 1, borderColor: "transparent", paddingHorizontal: 4 },
  timeText: { fontSize: 13, fontWeight: "700" },
});
