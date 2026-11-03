import { Image, type ImageSource } from "expo-image";
import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { ErrorText, Muted, Screen, SectionTitle } from "../components/ui";
import {
  dishCredits, illustrationUrls, ingredientCredit, ingredientCredits, ingredientPictureUrls, ingredientSource, pictureOf, sourceOf, type DishCredit,
  type IngredientCredit, type Picture,
} from "../lib/images";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { errorText } from "../lib/errors";

const credit = (c: { author: string | null; license: string }) => `Photo : ${c.author ? `${c.author} · ` : ""}${c.license} · Wikimedia Commons`;

function CreditRow({ name, text, source, url }: { name: string; text: string; source: ImageSource | null; url: string }) {
  const c = useColors();
  return (
    <Pressable onPress={() => Linking.openURL(url).catch(() => undefined)} accessibilityRole="link" accessibilityLabel={`${name} : ${text}`}
      style={({ pressed }) => [styles.row, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.8 : 1 }, CARD_SHADOW]}>
      {source ? <Image source={source} style={styles.thumb} contentFit="cover" transition={0} /> : <View style={[styles.thumb, { backgroundColor: c.chip }]} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>{name}</Text>
        <Text style={{ color: c.muted, fontSize: 13.5, lineHeight: 17 }} numberOfLines={2}>{text}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Crédits des photos libres de Wikimedia Commons (plats sans illustration, ingrédients) : auteur, licence, lien vers la
 * page de l'image, comme le demandent les licences Creative Commons.
 */
export default function Credits() {
  const [dishes, setDishes] = useState<DishCredit[] | null>(null);
  const [dishPictures, setDishPictures] = useState<Record<string, Picture | null>>({});
  const [credits, setCredits] = useState<IngredientCredit[] | null>(null);
  // Vignettes en ligne des ingrédients sans image embarquée : un nouveau rendu quand la liste arrive.
  const [, setPictures] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");

  useEffect(() => {
    const fail = (e: unknown) => setError(errorText(e));
    dishCredits().then((list) => {
      setDishes(list);
      illustrationUrls(list.map((d) => d.recipeId)).then(setDishPictures, () => undefined);
    }, fail);
    ingredientCredits().then(setCredits, fail);
    ingredientPictureUrls().then(setPictures, () => undefined);
  }, []);

  return (
    <Screen title="Crédits des photos">
      <Muted>
        Photos libres de Wikimedia Commons (domaine public, CC0, Creative Commons, GFDL) : touchez une ligne pour voir l'image
        d'origine et sa licence. Les photos des ingrédients ont été modifiées : détourées ou telles quelles, posées sur fond
        blanc. Les autres photos des plats sont créées par Mistral ou prises avec votre téléphone.
      </Muted>
      <ErrorText>{error}</ErrorText>
      {dishes?.length ? (
        <View style={{ gap: 7 }}>
          <SectionTitle icon="cutlery" title="Photos des plats" />
          {dishes.map((d) => <CreditRow key={d.recipeId} name={d.name} text={credit(d)} source={(() => { const p = dishPictures[d.recipeId] ?? pictureOf(d.recipeId); return p ? sourceOf(p, true) : null; })()} url={d.sourceUrl} />)}
        </View>
      ) : null}
      <View style={{ gap: 7 }}>
        <SectionTitle icon="image" title="Photos des ingrédients" />
        {credits === null && !error ? <Muted>Chargement…</Muted> : null}
        {(credits ?? []).map((c) => (
          <CreditRow key={c.slug} name={c.name} text={ingredientCredit(c)} source={ingredientSource(c.slug)} url={c.sourceUrl} />
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
