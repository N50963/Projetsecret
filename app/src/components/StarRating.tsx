/** Barre de 5 étoiles à remplir. */

import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, View } from "react-native";

import { useColors } from "../lib/theme";
import type { Stars } from "../modules/recipes";

const LABELS = ["Pas aimé du tout", "Pas aimé", "Moyen", "Bon", "Excellent"];

export const starsLabel = (stars: number) => LABELS[stars - 1] ?? "";

export function StarRating({ value, onChange, size = 38 }: { value: number | null; onChange?: (stars: Stars) => void; size?: number }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 6 }} accessibilityRole="adjustable" accessibilityLabel="Note"
      accessibilityValue={{ min: 0, max: 5, now: value ?? 0, text: value ? `${value} sur 5, ${starsLabel(value)}` : "Pas encore noté" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable key={n} onPress={onChange ? () => onChange(n as Stars) : undefined} disabled={!onChange} hitSlop={4}
          accessibilityRole="button" accessibilityLabel={`${n} étoile${n > 1 ? "s" : ""} : ${starsLabel(n)}`}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
          <Ionicons name={value !== null && n <= value ? "star" : "star-outline"} size={size} color={value !== null && n <= value ? c.accent : c.muted} />
        </Pressable>
      ))}
    </View>
  );
}
