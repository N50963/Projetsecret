/**
 * Illustration d'une recette : photo du foyer ou image créée par Mistral. Les images manquantes sont créées à l'avance
 * par une tâche planifiée ; en attendant, un cadre neutre l'indique (pas de dessin de remplacement).
 */

import Ionicons from "@expo/vector-icons/Ionicons";
import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import type { Picture } from "../lib/images";
import { useColors } from "../lib/theme";

export function Illustration({ picture, height = 180, rounded = 16 }: { picture: Picture | null | undefined; height?: number; rounded?: number }) {
  const c = useColors();
  if (picture) {
    // Clé de cache stable : l'image est gardée sur le téléphone même quand le lien d'accès change.
    return <Image source={{ uri: picture.uri, cacheKey: picture.cacheKey }} cachePolicy="disk"
      style={{ height, borderRadius: rounded, width: "100%", backgroundColor: c.chip }} contentFit="cover" transition={150}
      accessibilityLabel="Photo du plat" />;
  }
  return (
    <View style={[styles.waiting, { height, borderRadius: rounded, backgroundColor: c.chip }]} accessibilityLabel="Photo du plat en préparation">
      <Ionicons name="image-outline" size={Math.round(height * (height < 120 ? 0.36 : 0.22))} color={c.muted} />
      {height >= 120 && <Text style={[styles.label, { color: c.muted }]}>Photo du plat en préparation</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  waiting: { width: "100%", alignItems: "center", justifyContent: "center", gap: 8 },
  label: { fontSize: 14 },
});
