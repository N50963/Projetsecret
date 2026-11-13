import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, Vibration, View } from "react-native";

import { useConfirm } from "../components/ConfirmSheet";
import { Icon } from "../components/icons";
import { Illustration } from "../components/Illustration";
import { Button, Chip, ErrorText, Field, Muted, Screen } from "../components/ui";
import { minutes, proteinLabel } from "../lib/format";
import { illustrationUrls, pictureOf, usePictures, type Picture } from "../lib/images";
import { columnsFor, useLayout } from "../lib/layout";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { latestStars, listFavorites, listRecipes, removeRecipe, type RecipeSummary, type Stars } from "../modules/recipes";
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

/**
 * Recettes (onglet de la barre du bas) : recherche, favoris, filtre par note, une carte par recette avec sa photo et sa note.
 * Toucher une recette ouvre sa fiche ; un appui long propose de la supprimer.
 */
export default function Recettes() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const { width } = useLayout();
  const [search, setSearch] = useState("");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [rating, setRating] = useState<RatingFilter>("toutes");
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [stars, setStars] = useState<Map<string, Stars>>(new Map());
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [error, setError] = useState("");
  const [ask, confirmSheet] = useConfirm();
  const pictures = usePictures();

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

  /** Appui long : demande de suppression ; la recette quitte la liste dès la confirmation (remise si la base refuse). */
  const remove = (r: RecipeSummary) => {
    Vibration.vibrate(30);
    ask({
      title: "Supprimer cette recette ?", picture: pictureOf(r.id) ?? images[r.id], name: r.name,
      detail: r.householdId === household.id ? "Recette du foyer" : "Recette de MenuBily",
      message: "Elle ne sera plus proposée et n'apparaîtra plus dans l'onglet Recettes. Les menus déjà prévus avec elle restent.",
      confirmLabel: "Supprimer la recette", cancelLabel: "Garder la recette", icon: "trash",
      onConfirm: () => {
        latest.current += 1;
        setRecipes((list) => list.filter((x) => x.id !== r.id));
        removeRecipe(supabase, r.id, household.id).catch((e) => {
          setError(errorText(e));
          load(search);
        });
      },
    });
  };

  const shown = recipes.filter((r) => {
    if (onlyFavorites && !favorites.has(r.id)) return false;
    const note = stars.get(r.id);
    if (rating === "non_notees") return note === undefined;
    if (typeof rating === "number") return note !== undefined && note >= rating;
    return true;
  });

  // Cartes d'au moins 420 points de large : une colonne sur téléphone, deux sur le Z Fold déplié.
  const listWidth = width - 24;
  const cols = columnsFor(listWidth, 420, 3);
  const itemWidth = (listWidth - 8 * (cols - 1)) / cols;

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
    <Screen title="Recettes" nav="recettes" scroll={false} padded={false} width="full">
      <FlatList
        // Grand écran (Z Fold déplié) : 2 ou 3 colonnes de cartes ; la liste est recréée quand le nombre change.
        key={`colonnes-${cols}`}
        numColumns={cols}
        columnWrapperStyle={cols > 1 ? { gap: 8 } : undefined}
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
        extraData={pictures}
        renderItem={({ item: r }) => {
          const note = stars.get(r.id);
          return (
            <Pressable onPress={() => router.push(`/recette/${r.id}`)} onLongPress={() => remove(r)} delayLongPress={450}
              accessibilityRole="button" accessibilityLabel={`Ouvrir la fiche : ${r.name}`} accessibilityHint="Appui long pour supprimer la recette"
              style={({ pressed }) => [styles.item, cols > 1 && { width: itemWidth }, { backgroundColor: c.card, borderColor: c.cardLine, opacity: pressed ? 0.8 : 1 }, CARD_SHADOW]}>
              <Illustration picture={pictureOf(r.id) ?? images[r.id]} height={66} width={86} rounded={9} />
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
      {confirmSheet}
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
