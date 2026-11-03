/**
 * Météo d'un jour à Rochefort-du-Gard, en une ligne discrète : icône du temps, température maximale, minimale en gris.
 */

import { StyleSheet, Text, View } from "react-native";

import { weatherText, type DayWeather } from "../modules/planning";
import { useColors } from "../lib/theme";
import { Icon } from "./icons";

export function WeatherChip({ day, size = 14 }: { day: DayWeather | undefined; size?: number }) {
  const c = useColors();
  if (!day) return null;
  const { label, icon } = weatherText(day.code);
  return (
    <View style={styles.row} accessibilityLabel={`Météo : ${label}, de ${Math.round(day.tMin)} à ${Math.round(day.tMax)} degrés`}>
      <Icon name={icon} size={size + 4} color={c.muted} />
      <Text style={[styles.max, { color: c.text, fontSize: size }]}>{Math.round(day.tMax)}°</Text>
      <Text style={[styles.min, { color: c.muted, fontSize: size - 1 }]}>{Math.round(day.tMin)}°</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  max: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  min: { fontVariant: ["tabular-nums"] },
});
