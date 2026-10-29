import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { Body, Button, Card, ErrorText, H1, H2, Muted, Row, Screen } from "../components/ui";
import { dateTime, dayLabel, mealLabel } from "../lib/format";
import { isLidlConnected, syncLidl } from "../lib/lidl";
import { useHousehold, useSession } from "../lib/session";
import { supabase } from "../lib/supabase";
import { getShoppingList, getUpcomingMeals, toIsoDate, type ShoppingItem, type UpcomingMeal } from "../modules/planning";

interface Overview {
  lidlConnected: boolean;
  lastReceipt: string | null;
  lastSync: string | null;
  shopping: ShoppingItem[];
  upcoming: UpcomingMeal[];
}

export default function Accueil() {
  const router = useRouter();
  const household = useHousehold();
  const { signOut } = useSession();
  const today = toIsoDate(new Date());
  const [data, setData] = useState<Overview | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [lidlConnected, receipt, sync, shopping, upcoming] = await Promise.all([
        isLidlConnected(),
        supabase.from("receipts").select("purchased_at").eq("household_id", household.id).order("purchased_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("last_sync").select("finished_at, status").eq("household_id", household.id).maybeSingle(),
        getShoppingList(supabase, household.id),
        getUpcomingMeals(supabase, household.id, today),
      ]);
      setData({ lidlConnected, lastReceipt: receipt.data?.purchased_at ?? null, lastSync: sync.data?.finished_at ?? null, shopping, upcoming });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [household.id, today]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const sync = async () => {
    if (!data?.lidlConnected) {
      router.push("/lidl");
      return;
    }
    setSyncing(true);
    setMessage("");
    setError("");
    try {
      const result = await syncLidl(household.id);
      if (result.status === "reauth_required") {
        setError("La connexion Lidl Plus a expiré : reconnectez-vous.");
        router.push("/lidl");
      } else if (result.status === "error") setError(result.message ?? "Synchronisation impossible.");
      else setMessage(result.newReceipts ? `${result.newReceipts} nouveau${result.newReceipts > 1 ? "x" : ""} ticket${result.newReceipts > 1 ? "s" : ""} enregistré${result.newReceipts > 1 ? "s" : ""}.`
        : "Aucun nouveau ticket.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const toBuy = data?.shopping.filter((i) => !i.boughtAt && !i.checkedAt) ?? [];
  const bought = data?.shopping.filter((i) => i.boughtAt) ?? [];

  return (
    <Screen title={household.name}>
      <H1>Bonjour</H1>

      <Card>
        <H2>Tickets Lidl Plus</H2>
        <Muted>Dernier ticket : {data?.lastReceipt ? dayLabel(data.lastReceipt.slice(0, 10)) : "aucun"} · vérifié {dateTime(data?.lastSync ?? null)}</Muted>
        <Button title={data && !data.lidlConnected ? "Connecter Lidl Plus" : "Récupérer les nouveaux tickets"} onPress={sync} busy={syncing} />
        {message ? <Body>{message}</Body> : null}
        <ErrorText>{error}</ErrorText>
      </Card>

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
      <Row>
        <Button title="Préférences" kind="secondary" onPress={() => router.push("/preferences")} style={{ flex: 1 }} />
        <Button title="Déconnexion" kind="secondary" onPress={signOut} style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}
