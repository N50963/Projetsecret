import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { Body, Button, Card, ErrorText, H1, H2, HeaderIcon, Muted, Row, Screen } from "../components/ui";
import { dayLabel, mealLabel } from "../lib/format";
import { useHousehold, useSession } from "../lib/session";
import { supabase } from "../lib/supabase";
import { getShoppingList, getUpcomingMeals, toIsoDate, type ShoppingItem, type UpcomingMeal } from "../modules/planning";

interface Overview {
  shopping: ShoppingItem[];
  upcoming: UpcomingMeal[];
}

export default function Accueil() {
  const router = useRouter();
  const household = useHousehold();
  const { signOut } = useSession();
  const today = toIsoDate(new Date());
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [shopping, upcoming] = await Promise.all([
        getShoppingList(supabase, household.id),
        getUpcomingMeals(supabase, household.id, today),
      ]);
      setData({ shopping, upcoming });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [household.id, today]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const toBuy = data?.shopping.filter((i) => !i.boughtAt && !i.checkedAt) ?? [];
  const bought = data?.shopping.filter((i) => i.boughtAt) ?? [];

  return (
    <Screen title={household.name}
      headerRight={() => <HeaderIcon name="settings-outline" label="Paramètres" onPress={() => router.push("/parametres")} />}>
      <H1>Bonjour</H1>
      <ErrorText>{error}</ErrorText>

      {data && data.shopping.length > 0 && (
        <Card>
          <H2>Liste de courses</H2>
          <Body>{bought.length} article{bought.length > 1 ? "s" : ""} retrouvé{bought.length > 1 ? "s" : ""} sur les tickets, {toBuy.length} encore à acheter.</Body>
          {toBuy.slice(0, 5).map((i) => <Muted key={i.id}>• {i.label}</Muted>)}
          <Button title="Voir la liste" kind="secondary" onPress={() => router.push("/courses")} />
        </Card>
      )}

      <Card>
        <H2>Menus</H2>
        {data?.upcoming.length ? data.upcoming.map((m) => (
          <View key={m.slotId}>
            <Body onPress={() => router.push(`/recette/${m.recipeId}`)}>{dayLabel(m.date, today)} · {mealLabel(m.mealType)} : {m.name}</Body>
          </View>
        )) : <Muted>Aucun menu prévu pour les jours à venir.</Muted>}
        <Button title="Préparer les menus de la semaine" onPress={() => router.push("/semaine")} />
      </Card>

      <Row>
        <Button title="Recettes" kind="secondary" onPress={() => router.push("/recettes")} style={{ flex: 1 }} />
        <Button title="Courses" kind="secondary" onPress={() => router.push("/courses")} style={{ flex: 1 }} />
      </Row>
      <Button title="Déconnexion" kind="secondary" onPress={signOut} />
    </Screen>
  );
}
