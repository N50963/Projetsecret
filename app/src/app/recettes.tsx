import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../components/icons";
import { Illustration } from "../components/Illustration";
import { Button, Chip, ErrorText, Field, Muted, Screen } from "../components/ui";
import { minutes, PROTEIN_LABEL } from "../lib/format";
import { illustrationUrls, type Picture } from "../lib/images";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { listFavorites, listRecipes, type RecipeSummary } from "../modules/recipes";

/** Recettes : recherche, favoris du foyer, une carte par recette avec sa photo. */
export default function Recettes() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const [search, setSearch] = useState("");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [error, setError] = useState("");

  const load = useCallback(async (text: string) => {
    try {
      const [list, favs] = await Promise.all([listRecipes(supabase, { search: text.trim() || undefined, limit: 300 }), listFavorites(supabase, household.id)]);
      setRecipes(list);
      setFavorites(favs);
      setImages(await illustrationUrls(list.map((r) => r.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [household.id]);

  useFocusEffect(useCallback(() => {
    load(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]));

  const shown = onlyFavorites ? recipes.filter((r) => favorites.has(r.id)) : recipes;

  return (
    <Screen title="Recettes">
      <Button icon="plus" title="Ajouter une recette" onPress={() => router.push("/ajout-recette")} />
      <View>
        <Field value={search} placeholder="Rechercher une recette" style={{ paddingLeft: 44 }} onChangeText={(t) => {
          setSearch(t);
          load(t);
        }} />
        <View style={styles.searchIcon} pointerEvents="none"><Icon name="search" size={20} color={c.muted} /></View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip label="Toutes" active={!onlyFavorites} onPress={() => setOnlyFavorites(false)} />
        <Chip label={`Favoris (${favorites.size})`} icon="heartOutline" active={onlyFavorites} onPress={() => setOnlyFavorites(true)} />
      </View>
      <ErrorText>{error}</ErrorText>
      <View style={{ gap: 7 }}>
        {shown.map((r) => (
          <Pressable key={r.id} onPress={() => router.push(`/recette/${r.id}`)} accessibilityRole="button" accessibilityLabel={`Ouvrir la fiche : ${r.name}`}
            style={({ pressed }) => [styles.item, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.8 : 1 }, CARD_SHADOW]}>
            <Illustration picture={images[r.id]} height={66} width={86} rounded={9} />
            <View style={styles.text}>
              <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{r.name}</Text>
              <Text style={[styles.meta, { color: c.muted }]}>
                {PROTEIN_LABEL[r.mainProtein]} • {minutes(r.totalMin)}{r.householdId ? " • du foyer" : ""}
              </Text>
            </View>
            {favorites.has(r.id) ? <Icon name="heart" width={18} height={16} color={c.primary} /> : null}
            <Icon name="chevronRight" width={9} height={15} color={c.text} />
          </Pressable>
        ))}
        {!shown.length && <Muted>{onlyFavorites ? "Aucune recette en favori : touchez le cœur sur une fiche." : "Aucune recette."}</Muted>}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchIcon: { position: "absolute", left: 14, top: 0, bottom: 0, justifyContent: "center" },
  item: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 66, paddingRight: 12, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  text: { flex: 1, minWidth: 0, paddingLeft: 4 },
  name: { fontSize: 15.5, lineHeight: 18, fontWeight: "700" },
  meta: { marginTop: 2, fontSize: 14.2, lineHeight: 18 },
});
