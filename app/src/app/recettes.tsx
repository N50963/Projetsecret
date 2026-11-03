import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Icon } from "../components/icons";
import { Illustration } from "../components/Illustration";
import { Button, Chip, ErrorText, Field, Muted, Screen } from "../components/ui";
import { minutes, proteinLabel } from "../lib/format";
import { illustrationUrls, pictureOf, type Picture } from "../lib/images";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { latestStars, listFavorites, listRecipes, type RecipeSummary, type Stars } from "../modules/recipes";
import { errorText } from "../lib/errors";

/** Filtre par note : toutes, au moins N étoiles, ou pas encore notées. */
type RatingFilter = "toutes" | 5 | 4 | 3 | "non_notees";
const RATING_FILTERS: Array<{ value: RatingFilter; label: string }> = [
  { value: "toutes", label: "Toutes les notes" }, { value: 5, label: "5" }, { value: 4, label: "4 et +" }, { value: 3, label: "3 et +" },
  { value: "non_notees", label: "Non notées" },
];

function SmallStars({ value }: { value: number }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 1 }} accessibilityLabel={`${value} étoile${value > 1 ? "s" : ""} sur 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Icon key={n} name={n <= value ? "star" : "starOutline"} size={13} color={n <= value ? c.accent : c.field} />)}
    </View>
  );
}

/** Recettes (onglet de la barre du bas) : recherche, favoris, filtre par note, une carte par recette avec sa photo et sa note. */
export default function Recettes() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const [search, setSearch] = useState("");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [rating, setRating] = useState<RatingFilter>("toutes");
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [stars, setStars] = useState<Map<string, Stars>>(new Map());
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [error, setError] = useState("");

  /** Numéro de la dernière recherche : une réponse plus ancienne, arrivée après, n'écrase pas les résultats. */
  const latest = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async (text: string) => {
    const n = ++latest.current;
    try {
      const [list, favs, notes] = await Promise.all([
        listRecipes(supabase, { search: text.trim() || undefined }), listFavorites(supabase, household.id), latestStars(supabase, household.id),
      ]);
      if (n !== latest.current) return;
      setError("");
      setRecipes(list);
      setFavorites(favs);
      setStars(notes);
      const urls = await illustrationUrls(list.map((r) => r.id));
      if (n === latest.current) setImages(urls);
    } catch (e) {
      setError(errorText(e));
    }
  }, [household.id]);

  useFocusEffect(useCallback(() => {
    load(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]));

  const shown = recipes.filter((r) => {
    if (onlyFavorites && !favorites.has(r.id)) return false;
    const note = stars.get(r.id);
    if (rating === "non_notees") return note === undefined;
    if (typeof rating === "number") return note !== undefined && note >= rating;
    return true;
  });

  const header = (
    <View style={styles.header}>
      <Button icon="plus" title="Ajouter une recette" onPress={() => router.push("/ajout-recette")} />
      <View>
        <Field value={search} placeholder="Rechercher une recette" style={{ paddingLeft: 44 }} onChangeText={(t) => {
          setSearch(t);
          // Recherche lancée quand la saisie marque une pause (pas une requête par lettre tapée).
          if (typing.current) clearTimeout(typing.current);
          typing.current = setTimeout(() => load(t), 250);
        }} />
        <View style={styles.searchIcon} pointerEvents="none"><Icon name="search" size={20} color={c.muted} /></View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip label="Toutes" active={!onlyFavorites} onPress={() => setOnlyFavorites(false)} />
        <Chip label={`Favoris (${favorites.size})`} icon="heartOutline" active={onlyFavorites} onPress={() => setOnlyFavorites(true)} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel="Filtre par note">
        {RATING_FILTERS.map((f) => (
          <Chip key={String(f.value)} label={f.label} icon={typeof f.value === "number" ? "star" : undefined} active={rating === f.value}
            onPress={() => setRating(f.value)} />
        ))}
      </ScrollView>
      <ErrorText>{error}</ErrorText>
    </View>
  );

  // Liste virtualisée : seules les cartes visibles (et quelques-unes autour) sont dessinées, ce qui garde l'onglet fluide
  // et léger en mémoire avec des centaines de recettes et leurs photos.
  return (
    <Screen title="Recettes" nav="recettes" scroll={false} padded={false}>
      <FlatList
        data={shown}
        style={styles.fill}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={Gap}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        renderItem={({ item: r }) => {
          const note = stars.get(r.id);
          return (
            <Pressable onPress={() => router.push(`/recette/${r.id}`)} accessibilityRole="button" accessibilityLabel={`Ouvrir la fiche : ${r.name}`}
              style={({ pressed }) => [styles.item, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.8 : 1 }, CARD_SHADOW]}>
              <Illustration picture={images[r.id] ?? pictureOf(r.id)} height={66} width={86} rounded={9} />
              <View style={styles.text}>
                <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{r.name}</Text>
                <View style={styles.meta}>
                  <Text style={[styles.metaText, { color: c.muted }]}>{[proteinLabel(r.mainProtein, r.name), minutes(r.totalMin)].filter(Boolean).join(" • ")}</Text>
                  {note !== undefined ? <SmallStars value={note} /> : null}
                </View>
              </View>
              {favorites.has(r.id) ? <Icon name="heart" width={18} height={16} color={c.primary} /> : null}
              <Icon name="chevronRight" width={9} height={15} color={c.text} />
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <Muted>
            {onlyFavorites ? "Aucune recette en favori avec ce filtre : touchez le cœur sur une fiche."
              : rating === "toutes" ? "Aucune recette." : "Aucune recette avec cette note."}
          </Muted>
        }
      />
    </Screen>
  );
}

function Gap() {
  return <View style={{ height: 7 }} />;
}

const styles = StyleSheet.create({
  // Mêmes marges que les autres écrans (Screen) : 12 px autour, 12 px entre les blocs du haut.
  // Screen garde 20 px sous un contenu fixe : la liste, elle, défile jusqu'à la barre du bas.
  fill: { flex: 1, marginBottom: -20 },
  list: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 20 },
  header: { gap: 12, marginBottom: 12 },
  searchIcon: { position: "absolute", left: 14, top: 0, bottom: 0, justifyContent: "center" },
  item: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 66, paddingRight: 12, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  text: { flex: 1, minWidth: 0, paddingLeft: 4 },
  name: { fontSize: 15.5, lineHeight: 18, fontWeight: "700" },
  meta: { marginTop: 3, flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  metaText: { fontSize: 14.2, lineHeight: 18 },
});
