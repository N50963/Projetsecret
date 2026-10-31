/** Étapes de recette « pas à pas » : texte avec durées, températures et feu en évidence ; barre des minuteurs. */

import { Pressable, StyleSheet, Text, View } from "react-native";

import { clock, stepSegments } from "../lib/steps";
import { stopTimer, useTimers } from "../lib/timers";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { Icon } from "./icons";

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

/**
 * Minuteurs en cours, toujours visibles en bas de l'écran ; chacun dit ce qu'il minute et à quelle étape. Un minuteur
 * terminé reste affiché jusqu'à ce qu'on le ferme.
 */
export function TimersBar() {
  const { timers, now } = useTimers();
  const c = useColors();
  if (!timers.length) return null;
  return (
    <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
      {timers.map((t) => (
        <View key={t.id} style={styles.item}>
          <View style={[styles.icon, { backgroundColor: t.done ? c.dangerSoft : c.greenSoft }]}>
            <Icon name={t.done ? "bell" : "timer"} size={20} color={t.done ? c.danger : c.greenInk} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: c.text }]} numberOfLines={1}>{t.subject}</Text>
            <Text style={[styles.detail, { color: c.muted }]} numberOfLines={1}>Étape {t.step} · {t.recipeName}</Text>
          </View>
          <Text style={[styles.clock, { color: t.done ? c.danger : c.text }]}>{t.done ? "Terminé" : clock((t.endsAt - now) / 1000)}</Text>
          <Pressable onPress={() => stopTimer(t.id)} hitSlop={10} accessibilityRole="button"
            accessibilityLabel={t.done ? "Fermer le minuteur" : "Arrêter le minuteur"}>
            <Icon name="close" size={24} color={c.muted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { marginHorizontal: 10, marginBottom: 6, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, gap: 4 },
  item: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  icon: { width: 36, height: 36, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 15.5, fontWeight: "700" },
  detail: { fontSize: 14.2 },
  clock: { fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
