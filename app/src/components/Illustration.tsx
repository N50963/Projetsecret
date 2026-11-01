/**
 * Illustration d'une recette : photo du foyer ou image créée par Mistral. Les images manquantes sont créées à l'avance
 * par une tâche planifiée ; en attendant, un cadre neutre l'indique (pas de dessin de remplacement).
 */

import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import { sourceOf, type Picture } from "../lib/images";
import { useColors } from "../lib/theme";
import { Icon } from "./icons";

export function Illustration({ picture, height = 180, rounded = 16, width = "100%" }: {
  picture: Picture | null | undefined; height?: number; rounded?: number; width?: number | "100%";
}) {
  const c = useColors();
  if (picture) {
    // Image embarquée (miniature pour un petit affichage : décodage rapide des listes) ou téléchargée en avance, sans
    // fondu ; une image en ligne plus récente s'affiche à la place de l'image embarquée dès qu'elle est arrivée.
    return <Image source={sourceOf(picture, height < 120)} placeholder={picture.fallback} placeholderContentFit="cover"
      cachePolicy="memory-disk" style={{ height, borderRadius: rounded, width, backgroundColor: c.chip }} contentFit="cover"
      transition={0} accessibilityLabel="Photo du plat" />;
  }
  return (
    <View style={[styles.waiting, { height, width, borderRadius: rounded, backgroundColor: c.chip, borderColor: c.border, borderWidth: height < 120 ? 1 : 0 }]}
      accessibilityLabel="Photo du plat en préparation">
      <Icon name="image" size={height < 120 ? 30 : 44} color={c.muted} />
      {height >= 120 && <Text style={[styles.label, { color: c.muted }]}>Photo du plat en préparation</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  waiting: { alignItems: "center", justifyContent: "center", gap: 12, borderStyle: "dashed" },
  label: { fontSize: 16 },
});
