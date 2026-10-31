/** Étapes de recette « pas à pas » : texte avec durées, températures et feu en évidence ; barre des minuteurs. */

import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { clock, stepSegments } from "../lib/steps";
import { stopTimer, useTimers } from "../lib/timers";
import { useColors } from "../lib/theme";

export function StepText({ text, current, done }: { text: string; current?: boolean; done?: boolean }) {
  const c = useColors();
  const color = done ? c.muted : c.text;
  return (
    <Text style={{ fontSize: current ? 18 : 16, lineHeight: current ? 26 : 22, color }}>
      {stepSegments(text).map((s, i) => (s.strong
        ? <Text key={i} style={{ fontWeight: "700", color: done ? c.muted : c.primary }}>{s.text}</Text>
        : s.text))}
    </Text>
  );
}

/** Minuteurs en cours, toujours visibles en bas de l'écran ; un minuteur terminé reste affiché jusqu'à ce qu'on le ferme. */
export function TimersBar() {
  const { timers, now } = useTimers();
  const c = useColors();
  if (!timers.length) return null;
  return (
    <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.border }]}>
      {timers.map((t) => (
        <View key={t.id} style={styles.item}>
          <Ionicons name={t.done ? "alarm" : "timer-outline"} size={22} color={t.done ? c.danger : c.primary} />
          <Text style={[styles.label, { color: c.text }]} numberOfLines={1}>{t.label}</Text>
          <Text style={[styles.clock, { color: t.done ? c.danger : c.text }]}>{t.done ? "Terminé" : clock((t.endsAt - now) / 1000)}</Text>
          <Pressable onPress={() => stopTimer(t.id)} hitSlop={10} accessibilityRole="button"
            accessibilityLabel={t.done ? "Fermer le minuteur" : "Arrêter le minuteur"}>
            <Ionicons name="close-circle" size={26} color={c.muted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  item: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40 },
  label: { flex: 1, fontSize: 15 },
  clock: { fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
