import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { ErrorText, Muted, Screen } from "../components/ui";
import { ingredientCredit, ingredientCredits, ingredientPictureUrls, type IngredientCredit } from "../lib/images";
import { CARD_SHADOW, useColors } from "../lib/theme";

/**
 * Crédits des photos d'ingrédients : images sous licence libre de Wikimedia Commons (auteur, licence, lien vers la
 * page de l'image), comme le demandent les licences Creative Commons.
 */
export default function Credits() {
  const c = useColors();
  const [credits, setCredits] = useState<IngredientCredit[] | null>(null);
  const [pictures, setPictures] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");

  useEffect(() => {
    ingredientCredits().then(setCredits, (e) => setError(e instanceof Error ? e.message : String(e)));
    ingredientPictureUrls().then(setPictures, () => undefined);
  }, []);

  return (
    <Screen title="Crédits des photos">
      <Muted>
        Les photos des ingrédients viennent de Wikimedia Commons, sous licence libre (domaine public, CC0, Creative Commons, GFDL).
        Touchez une ligne pour voir l'image d'origine et sa licence. Les photos des plats sont créées par Mistral ou prises par le foyer.
      </Muted>
      <ErrorText>{error}</ErrorText>
      {credits === null && !error ? <Muted>Chargement…</Muted> : null}
      <View style={{ gap: 7 }}>
        {(credits ?? []).map((credit) => (
          <Pressable key={credit.slug} onPress={() => Linking.openURL(credit.sourceUrl).catch(() => undefined)} accessibilityRole="link"
            accessibilityLabel={`${credit.name} : ${ingredientCredit(credit)}`}
            style={({ pressed }) => [styles.row, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.8 : 1 }, CARD_SHADOW]}>
            {pictures.get(credit.slug)
              ? <Image source={{ uri: pictures.get(credit.slug)! }} style={styles.thumb} contentFit="cover" transition={0} />
              : <View style={[styles.thumb, { backgroundColor: c.chip }]} />}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>{credit.name}</Text>
              <Text style={{ color: c.muted, fontSize: 13.5, lineHeight: 17 }} numberOfLines={2}>{ingredientCredit(credit)}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, padding: 8, borderRadius: 12, borderWidth: 1 },
  thumb: { width: 44, height: 44, borderRadius: 10 },
  name: { fontSize: 15.5, lineHeight: 19, fontWeight: "700" },
});
