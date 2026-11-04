/**
 * Météo d'un jour à Rochefort-du-Gard : en une ligne discrète (icône du temps, température maximale, minimale en gris),
 * ou en bandeau sur la carte du jour choisi dans le calendrier (icône du temps et températures).
 */

import { StyleSheet, Text, View } from "react-native";

import { weatherText, weatherTone, type DayWeather, type WeatherTone } from "../modules/planning";
import { useColors, type Colors } from "../lib/theme";
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

/** Couleurs du bandeau : abricot quand il fait chaud, bleu-gris quand il fait frais ou froid, vert par temps doux. */
function toneColors(tone: WeatherTone, c: Colors) {
  if (tone === "hot" || tone === "warm") return { bg: c.warmSoft, ink: c.orangeInk };
  if (tone === "cold" || tone === "cool") return { bg: c.coldSoft, ink: c.coldInk };
  return { bg: c.greenSoft, ink: c.greenInk };
}

/** Bandeau météo de la carte du jour : icône du temps, températures minimale et maximale. */
export function WeatherBand({ day }: { day: DayWeather | undefined }) {
  const c = useColors();
  if (!day) return null;
  const { label, icon } = weatherText(day.code);
  const t = toneColors(weatherTone(day), c);
  return (
    <View style={[styles.band, { backgroundColor: t.bg }]} accessible
      accessibilityLabel={`Météo à Rochefort-du-Gard : ${label}, de ${Math.round(day.tMin)} à ${Math.round(day.tMax)} degrés`}>
      <Icon name={icon} size={24} color={t.ink} />
      <Text style={[styles.bandTitle, { color: t.ink }]}>{Math.round(day.tMin)} à {Math.round(day.tMax)} °C</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  band: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 13, paddingVertical: 9, paddingHorizontal: 14 },
  bandTitle: { fontSize: 16, lineHeight: 20, fontWeight: "700", fontVariant: ["tabular-nums"] },
  max: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  min: { fontVariant: ["tabular-nums"] },
});
