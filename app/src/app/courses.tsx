import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../components/icons";
import { Illustration } from "../components/Illustration";
import { ErrorText, Muted, Screen, SectionTitle } from "../components/ui";
import { quantity } from "../lib/format";
import { illustrationUrls, type Picture } from "../lib/images";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { getShoppingList, setShoppingItemChecked, type ShoppingItem } from "../modules/planning";

/**
 * Liste de courses MenuMalin : « À acheter » (article, plat concerné et sa photo, quantité) et « Trouvés sur vos tickets »
 * (cochés tout seuls quand ils apparaissent sur un nouveau ticket, ou à la main).
 */
export default function Courses() {
  const household = useHousehold();
  const c = useColors();
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getShoppingList(supabase, household.id)
      .then(async (list) => {
        setItems(list);
        setImages(await illustrationUrls(list.map((i) => i.recipeId).filter((id): id is string => id !== null)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [household.id]);
  useFocusEffect(load);

  const toggle = async (item: ShoppingItem) => {
    const checked = !item.checkedAt;
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, checkedAt: checked ? new Date().toISOString() : null } : i)));
    setShoppingItemChecked(supabase, item.id, checked).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const toBuy = items.filter((i) => !i.boughtAt && !i.checkedAt);
  const found = items.filter((i) => i.boughtAt || i.checkedAt);

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
        {toBuy.length === 0 && <Muted style={{ paddingHorizontal: 4 }}>Rien à acheter pour les menus choisis.</Muted>}
        {toBuy.map((i) => (
          <View key={i.id} style={[styles.item, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
            <Pressable onPress={() => toggle(i)} accessibilityRole="checkbox" accessibilityState={{ checked: false }} accessibilityLabel={`Cocher : ${i.label}`}
              style={styles.check}>
              <Icon name="circle" size={26} color={c.orangeInk} />
            </Pressable>
            {i.recipeId ? <Illustration picture={images[i.recipeId]} height={64} width={74} rounded={9} /> : (
              <View style={[styles.noPhoto, { backgroundColor: c.chip }]}><Icon name="image" size={24} color={c.muted} /></View>
            )}
            <View style={styles.text}>
              <Text style={[styles.name, { color: c.text }]}>{i.label}</Text>
              {i.recipeName ? <Text style={[styles.dish, { color: c.muted }]} numberOfLines={1}>{i.recipeName}</Text> : null}
            </View>
            <Text style={[styles.qty, { color: c.text }]}>{quantity(i.quantity, i.unit)}</Text>
          </View>
        ))}
      </View>

      {found.length > 0 && (
        <>
          <View style={[styles.head, { marginTop: 2 }]}><SectionTitle icon="receipt" title="Trouvés sur vos tickets" /></View>
          <View style={styles.list}>
            {found.map((i) => (
              <View key={i.id} style={[styles.item, styles.foundItem, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
                <Pressable onPress={() => toggle(i)} disabled={Boolean(i.boughtAt)} accessibilityRole="checkbox" accessibilityState={{ checked: true }}
                  accessibilityLabel={`Décocher : ${i.label}`} style={styles.check}>
                  <Icon name="checkCircle" size={26} color={c.primary} />
                </Pressable>
                <Text style={{ flex: 1, color: c.muted, fontSize: 16, textDecorationLine: "line-through" }}>{i.label}</Text>
                <Text style={{ color: c.muted, fontSize: 16, paddingLeft: 8 }}>{quantity(i.quantity, i.unit)}</Text>
              </View>
            ))}
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
});
