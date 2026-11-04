/**
 * Météo d'un jour à Rochefort-du-Gard : en une ligne discrète (icône du temps, température maximale, minimale en gris),
 * ou en bandeau sur la carte du jour choisi dans le calendrier, avec un conseil pour choisir le plat.
 */

import { StyleSheet, Text, View } from "react-native";

import { weatherAdvice, weatherText, type DayWeather, type WeatherTone } from "../modules/planning";
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

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Bandeau météo de la carte du jour : temps et températures, et (s'il reste un repas à choisir) le plat que le temps
 * suggère, comme le font les propositions.
 */
export function WeatherBand({ day, advice = true }: { day: DayWeather | undefined; advice?: boolean }) {
  const c = useColors();
  if (!day) return null;
  const { label, icon } = weatherText(day.code);
  const tip = weatherAdvice(day);
  const t = toneColors(tip.tone, c);
  const temps = `${Math.round(day.tMin)} à ${Math.round(day.tMax)} °C`;
  return (
    <View style={[styles.band, { backgroundColor: t.bg }]} accessible
      accessibilityLabel={`Météo à Rochefort-du-Gard : ${label}, de ${Math.round(day.tMin)} à ${Math.round(day.tMax)} degrés.${advice ? ` ${tip.advice}` : ""}`}>
      <View style={[styles.bandIcon, { backgroundColor: c.card }]}><Icon name={icon} size={22} color={t.ink} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.bandTitle, { color: t.ink }]}>{capitalized(label)} · {temps}</Text>
        {advice ? <Text style={[styles.bandText, { color: c.text }]}>{tip.advice}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  band: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 13, paddingVertical: 8, paddingLeft: 8, paddingRight: 12 },
  bandIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  bandTitle: { fontSize: 15, lineHeight: 19, fontWeight: "700", fontVariant: ["tabular-nums"] },
  bandText: { fontSize: 14.2, lineHeight: 18.5, marginTop: 1 },
  max: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  min: { fontVariant: ["tabular-nums"] },
});
