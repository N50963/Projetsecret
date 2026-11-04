import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../components/icons";
import { Illustration } from "../components/Illustration";
import { ErrorText, Muted, Screen, SectionTitle } from "../components/ui";
import { quantity } from "../lib/format";
import { illustrationUrls, pictureOf, usePictures, type Picture } from "../lib/images";
import { shoppingLines, type ShoppingLine } from "../lib/shopping";
import { setShoppingCount, toBuyLines } from "../lib/shoppingCount";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { getShoppingList, setShoppingItemChecked, setShoppingItemsRemoved, type ShoppingItem } from "../modules/planning";
import { errorText } from "../lib/errors";

/**
 * Liste de courses MenuBily : « À acheter » (article, plat concerné et sa photo, quantité) et « Trouvés sur vos tickets »
 * (cochés tout seuls quand ils apparaissent sur un nouveau ticket, ou à la main).
 */
export default function Courses() {
  const household = useHousehold();
  const c = useColors();
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  usePictures();
  const [error, setError] = useState("");
  /** Dernier article retiré : bandeau « Annuler » pendant quelques secondes. */
  const [undo, setUndo] = useState<{ name: string; ids: string[] } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    getShoppingList(supabase, household.id)
      .then(async (list) => {
        setItems(list);
        setImages(await illustrationUrls(list.map((i) => i.recipeId).filter((id): id is string => id !== null)));
      })
      .catch((e) => setError(errorText(e)));
  }, [household.id]);
  useFocusEffect(load);

  /** Coche (ou décoche) une ligne : tous les articles qu'elle regroupe. */
  const toggle = async (line: ShoppingLine, checked: boolean) => {
    const ids = new Set(line.items.filter((i) => !i.boughtAt).map((i) => i.id));
    const at = checked ? new Date().toISOString() : null;
    setItems((list) => list.map((i) => (ids.has(i.id) ? { ...i, checkedAt: at } : i)));
    Promise.all([...ids].map((id) => setShoppingItemChecked(supabase, id, checked)))
      .catch((e) => setError(errorText(e)));
  };

  /**
   * Retire une ligne de la liste (tous ses articles) : elle n'est plus à acheter ; la fiche de la recette le signale et
   * permet de la remettre. Le bandeau « Annuler » la remet tout de suite en cas d'erreur.
   */
  const remove = (line: ShoppingLine) => {
    const ids = line.items.map((i) => i.id);
    const at = new Date().toISOString();
    setItems((list) => list.map((i) => (ids.includes(i.id) ? { ...i, removedAt: at, active: false } : i)));
    setShoppingItemsRemoved(supabase, ids, true).catch((e) => setError(errorText(e)));
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ name: line.name, ids });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  };
  const restore = () => {
    if (!undo) return;
    const ids = undo.ids;
    setUndo(null);
    setShoppingItemsRemoved(supabase, ids, false).then(load, (e) => setError(errorText(e)));
  };
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  // Seuls les articles des menus choisis à venir (ou d'une recette ajoutée depuis sa fiche) restent à acheter.
  const toBuy = toBuyLines(items);
  const found = shoppingLines(items.filter((i) => !i.removedAt && (i.boughtAt || i.checkedAt)));
  // Pastille de l'onglet Courses : même décompte que la liste affichée (à jour à chaque article coché).
  useEffect(() => {
    setShoppingCount(toBuy.length);
  }, [toBuy.length]);

  return (
    <Screen title="Liste de courses" nav="courses" padded={false}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}><SectionTitle icon="cartBold" title="À acheter" /></View>
        <Text style={{ color: c.orangeInk, fontSize: 14.2, fontWeight: "500" }}>
          {toBuy.length} article{toBuy.length > 1 ? "s" : ""} à acheter
        </Text>
      </View>
      <View style={styles.list}>
        <ErrorText>{error}</ErrorText>
        {undo ? (
          <View style={[styles.undo, { backgroundColor: c.text }]} accessibilityLiveRegion="polite">
            <Text style={{ flex: 1, color: "#FFFFFF", fontSize: 14.5 }} numberOfLines={2}>« {undo.name} » retiré de la liste.</Text>
            <Pressable onPress={restore} accessibilityRole="button" hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <Text style={{ color: "#F3D9A4", fontSize: 14.5, fontWeight: "700" }}>Annuler</Text>
            </Pressable>
          </View>
        ) : null}
        {toBuy.length === 0 && <Muted style={{ paddingHorizontal: 4 }}>Rien à acheter pour les menus choisis.</Muted>}
        {toBuy.map((line) => {
          const photo = line.recipes[0]?.id;
          return (
            <View key={line.key} style={[styles.item, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
              <Pressable onPress={() => toggle(line, true)} accessibilityRole="checkbox" accessibilityState={{ checked: false }}
                accessibilityLabel={`Cocher : ${line.name}`} style={styles.check}>
                <Icon name="circle" size={26} color={c.orangeInk} />
              </Pressable>
              {photo ? <Illustration picture={pictureOf(photo) ?? images[photo]} height={64} width={74} rounded={9} /> : (
                <View style={[styles.noPhoto, { backgroundColor: c.chip }]}><Icon name="image" size={24} color={c.muted} /></View>
              )}
              <View style={styles.text}>
                <Text style={[styles.name, { color: c.text }]}>{line.name}</Text>
                {line.recipes.length ? (
                  <Text style={[styles.dish, { color: c.muted }]} numberOfLines={line.recipes.length > 1 ? 2 : 1}>
                    {line.recipes.map((r) => r.name).join(" · ")}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.qty, { color: c.text }]}>{quantity(line.quantity, line.unit)}</Text>
              {/* Retirer de la liste : pas besoin de l'acheter (déjà à la maison, remplacé…). */}
              <Pressable onPress={() => remove(line)} accessibilityRole="button" accessibilityLabel={`Retirer de la liste : ${line.name}`}
                hitSlop={4} style={({ pressed }) => [styles.remove, { opacity: pressed ? 0.5 : 1 }]}>
                <Icon name="cross" size={14} color={c.muted} />
              </Pressable>
            </View>
          );
        })}
      </View>

      {found.length > 0 && (
        <>
          <View style={[styles.head, { marginTop: 2 }]}><SectionTitle icon="receipt" title="Trouvés sur vos tickets" /></View>
          <View style={styles.list}>
            {found.map((line) => {
              const bought = line.items.every((i) => i.boughtAt);
              return (
                <View key={line.key} style={[styles.item, styles.foundItem, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
                  <Pressable onPress={() => toggle(line, false)} disabled={bought} accessibilityRole="checkbox" accessibilityState={{ checked: true }}
                    accessibilityLabel={`Décocher : ${line.name}`} style={styles.check}>
                    <Icon name="checkCircle" size={26} color={c.primary} />
                  </Pressable>
                  <Text style={{ flex: 1, color: c.muted, fontSize: 16, textDecorationLine: "line-through" }}>{line.name}</Text>
                  <Text style={{ color: c.muted, fontSize: 16, paddingLeft: 8 }}>{quantity(line.quantity, line.unit)}</Text>
                </View>
              );
            })}
          </View>
        </>
      )}
      <Muted style={{ marginHorizontal: 16, marginTop: 11, fontSize: 15 }}>
        Les articles se cochent tout seuls quand ils apparaissent sur un nouveau ticket.
      </Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", paddingLeft: 13, paddingRight: 13, paddingTop: 4 },
  list: { paddingLeft: 12.8, paddingRight: 9.2, gap: 7 },
  item: { flexDirection: "row", alignItems: "center", minHeight: 66, paddingRight: 12, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  foundItem: { minHeight: 54 },
  check: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  noPhoto: { width: 74, height: 64, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0, paddingLeft: 13 },
  name: { fontSize: 15.5, lineHeight: 18, fontWeight: "700" },
  dish: { marginTop: 1.5, fontSize: 14.2, lineHeight: 18 },
  qty: { paddingLeft: 8, fontSize: 16, fontWeight: "500" },
  remove: { width: 36, height: 44, alignItems: "center", justifyContent: "center", marginRight: -8 },
  undo: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11 },
});
