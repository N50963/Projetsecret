import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { Body, Button, Card, ErrorText, Muted, Screen } from "../components/ui";
import { minutes, PROTEIN_LABEL } from "../lib/format";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import { listRecipes, type RecipeSummary } from "../modules/recipes";

export default function Recettes() {
  const router = useRouter();
  const c = useColors();
  const [search, setSearch] = useState("");
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [error, setError] = useState("");

  const load = useCallback((text: string) => {
    listRecipes(supabase, { search: text.trim() || undefined, limit: 300 }).then(setRecipes).catch((e) => setError(String(e)));
  }, []);

  useFocusEffect(useCallback(() => {
    load(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]));

  return (
    <Screen title="Recettes">
      <Button title="＋ Ajouter une recette" onPress={() => router.push("/ajout-recette")} />
      <TextInput value={search} onChangeText={(t) => {
        setSearch(t);
        load(t);
      }} placeholder="Rechercher" placeholderTextColor={c.muted}
        style={[styles.search, { backgroundColor: c.card, borderColor: c.border, color: c.text }]} />
      <ErrorText>{error}</ErrorText>
      <Card style={{ gap: 0, paddingVertical: 4 }}>
        {recipes.map((r) => (
          <Pressable key={r.id} onPress={() => router.push(`/recette/${r.id}`)} style={[styles.item, { borderBottomColor: c.border }]}>
            <View style={{ flex: 1 }}>
              <Body>{r.name}</Body>
              <Muted>{PROTEIN_LABEL[r.mainProtein]} · {minutes(r.totalMin)}{r.householdId ? " · recette du foyer" : ""}</Muted>
            </View>
          </Pressable>
        ))}
        {!recipes.length && <Muted style={{ padding: 12 }}>Aucune recette.</Muted>}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { minHeight: 46, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 16 },
  item: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
