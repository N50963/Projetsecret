import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Body, Card, ErrorText, H2, Muted, Screen } from "../components/ui";
import { dayLabel, quantity } from "../lib/format";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import { getShoppingList, setShoppingItemChecked, type ShoppingItem } from "../modules/planning";

/** Liste de courses comparée aux tickets : ce qui a été retrouvé sur un ticket est coché tout seul. */
export default function Courses() {
  const household = useHousehold();
  const c = useColors();
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getShoppingList(supabase, household.id).then(setItems).catch((e) => setError(String(e)));
  }, [household.id]);
  useFocusEffect(load);

  const toggle = async (item: ShoppingItem) => {
    const checked = !item.checkedAt;
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, checkedAt: checked ? new Date().toISOString() : null } : i)));
    setShoppingItemChecked(supabase, item.id, checked).catch((e) => setError(String(e)));
  };

  const toBuy = items.filter((i) => !i.boughtAt && !i.checkedAt);
  const done = items.filter((i) => i.boughtAt || i.checkedAt);
  const line = (i: ShoppingItem) => (
    <Pressable key={i.id} onPress={() => toggle(i)} style={[styles.line, { borderBottomColor: c.border }]}>
      <Body>{i.boughtAt || i.checkedAt ? "☑" : "☐"}</Body>
      <View style={{ flex: 1 }}>
        <Body style={i.boughtAt || i.checkedAt ? { textDecorationLine: "line-through", color: c.muted } : undefined}>{i.label}</Body>
        <Muted>{quantity(i.quantity, i.unit)}{i.boughtAt ? ` · sur le ticket du ${dayLabel(i.boughtAt.slice(0, 10))}` : ""}</Muted>
      </View>
    </Pressable>
  );

  return (
    <Screen title="Liste de courses">
      <ErrorText>{error}</ErrorText>
      <Card>
        <H2>À acheter ({toBuy.length})</H2>
        {toBuy.length ? toBuy.map(line) : <Muted>Rien à acheter pour les menus choisis.</Muted>}
      </Card>
      {done.length > 0 && (
        <Card>
          <H2>Déjà achetés</H2>
          {done.map(line)}
        </Card>
      )}
      <Muted>Les articles achetés sont reconnus sur les tickets Lidl récupérés après leur ajout à la liste.</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
});
