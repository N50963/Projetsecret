import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../components/icons";
import { Body, Button, ErrorText, Muted, Screen, SectionTitle } from "../components/ui";
import { dateTime, dayLabel } from "../lib/format";
import { isLidlConnected, syncLidl } from "../lib/lidl";
import { countToReview } from "../lib/products";
import { useHousehold, useSession } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { getHouseholdPreferences, type HouseholdPreferences } from "../modules/recipes";
import { errorText } from "../lib/errors";

interface LidlStatus {
  connected: boolean;
  lastReceipt: string | null;
  lastSync: string | null;
}

const SPICE: Record<string, string> = { aucun: "Jamais épicé", doux: "Jamais piquant", tout: "Tout" };
const GROUP: Record<string, string> = {
  abats: "abats", coquillages: "coquillages", crustaces: "crustacés", porc: "porc", boeuf: "bœuf", agneau: "agneau", poisson: "poisson",
  champignons: "champignons",
};
const ALLERGEN: Record<string, string> = {
  gluten: "gluten", lait: "lait", oeuf: "œuf", fruits_a_coque: "fruits à coque", poisson: "poisson", crustaces: "crustacés", soja: "soja", sesame: "sésame",
};
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function household(p: HouseholdPreferences) {
  return [p.adults && plural(p.adults, "adulte", "adultes"), p.teens && plural(p.teens, "ado", "ados"), p.children && plural(p.children, "enfant", "enfants")]
    .filter(Boolean).join(", ");
}

/** Profil MenuBily : tickets Lidl Plus, préférences du foyer (résumé ligne par ligne), déconnexion. */
export default function Parametres() {
  const router = useRouter();
  const home = useHousehold();
  const { signOut } = useSession();
  const c = useColors();
  const [lidl, setLidl] = useState<LidlStatus | null>(null);
  const [prefs, setPrefs] = useState<HouseholdPreferences | null>(null);
  const [toReview, setToReview] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [connected, receipt, sync, preferences, review] = await Promise.all([
        isLidlConnected(home.id),
        supabase.from("receipts").select("purchased_at").eq("household_id", home.id).order("purchased_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("last_sync").select("finished_at, status").eq("household_id", home.id).maybeSingle(),
        getHouseholdPreferences(supabase, home.id),
        countToReview(home.id),
      ]);
      setToReview(review);
      setLidl({ connected, lastReceipt: receipt.data?.purchased_at ?? null, lastSync: sync.data?.finished_at ?? null });
      setPrefs(preferences);
    } catch (e) {
      setError(errorText(e));
    }
  }, [home.id]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const sync = async () => {
    if (!lidl?.connected) {
      router.push("/lidl");
      return;
    }
    setSyncing(true);
    setMessage("");
    setError("");
    try {
      const result = await syncLidl(home.id);
      if (result.status === "reauth_required") {
        setError("La connexion à Lidl Plus a expiré. Reconnectez le compte pour récupérer les tickets.");
        router.push("/lidl");
      } else if (result.status === "error") setError(result.message ?? "Synchronisation impossible.");
      else setMessage(result.newReceipts ? `${result.newReceipts} nouveau${result.newReceipts > 1 ? "x" : ""} ticket${result.newReceipts > 1 ? "s" : ""} enregistré${result.newReceipts > 1 ? "s" : ""}.`
        : "Aucun nouveau ticket.");
      await load();
      // Import terminé : les nouveaux produits non vérifiés s'ouvrent dans le module de correction.
      if (result.status !== "error" && result.status !== "reauth_required" && (await countToReview(home.id)) > 0) router.push("/produits");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSyncing(false);
    }
  };

  const rows: Array<[string, string]> = prefs ? [
    ["Composition du foyer", household(prefs) || "À renseigner"],
    ["Épices", SPICE[prefs.spiceLevel] ?? ""],
    ["Aliments exclus", prefs.excludedFoodGroups.length ? capitalize(prefs.excludedFoodGroups.map((g) => GROUP[g] ?? g).join(", ")) : "Aucun"],
    ["Allergies", prefs.excludedAllergens.length ? capitalize(prefs.excludedAllergens.map((a) => ALLERGEN[a] ?? a).join(", ")) : "Aucune"],
    ["Mot de passe", ""],
  ] : [];

  return (
    <Screen title="Paramètres" nav="profil" padded={false}>
      <View style={styles.head}><SectionTitle icon="receipt" title="Tickets et achats" /></View>
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
        {lidl === null
          ? <Muted>Chargement…</Muted>
          : lidl.connected
            ? <Body style={{ color: c.muted }}>Dernier ticket : {lidl.lastReceipt ? dayLabel(lidl.lastReceipt.slice(0, 10)).toLowerCase() : "aucun"} · vérifié {dateTime(lidl.lastSync)}</Body>
            : <ErrorText>Lidl Plus n'est pas connecté sur ce téléphone. Connectez le compte pour récupérer les tickets.</ErrorText>}
        <ErrorText>{error}</ErrorText>
        {message ? <Body style={{ color: c.greenInk }}>{message}</Body> : null}
        <Button title={syncing ? "Récupération en cours…" : lidl && !lidl.connected ? "Connecter Lidl Plus" : "Récupérer les nouveaux tickets"}
          onPress={sync} disabled={syncing} />
        <Button title={toReview ? `Vérifier ${toReview} nouveau${toReview > 1 ? "x" : ""} produit${toReview > 1 ? "s" : ""}` : "Corriger un produit acheté"}
          kind="secondary" icon={toReview ? "alert" : "search"} onPress={() => router.push("/produits")} />
        {/* Achats sans ticket Lidl (marché, primeur, autre magasin) : ils comptent comme ceux des tickets. */}
        <Button title="Fruits et légumes d'un autre magasin" kind="secondary" icon="cart" onPress={() => router.push("/achats-magasin")} />
      </View>

      <View style={[styles.head, { marginTop: 2 }]}><SectionTitle icon="sliders" title="Préférences" /></View>
      <View style={[styles.card, styles.list, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
        {prefs === null ? <View style={{ padding: 14 }}><Muted>Chargement…</Muted></View> : rows.map(([name, value], i) => (
          <Pressable key={name} onPress={() => router.push("/preferences")} accessibilityRole="button" accessibilityLabel={`${name}${value ? ` : ${value}` : ""}`}
            style={({ pressed }) => [styles.row, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }, { opacity: pressed ? 0.7 : 1 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowName, { color: c.text }]}>{name}</Text>
              {value ? <Text style={[styles.rowValue, { color: c.muted }]}>{value}</Text> : null}
            </View>
            <Icon name="chevronRight" width={9} height={15} color={c.text} />
          </Pressable>
        ))}
      </View>

      <Pressable onPress={() => router.push("/commune")} accessibilityRole="button" accessibilityLabel={`Commune pour la météo : ${home.place.name}`}
        style={({ pressed }) => [styles.card, styles.list, { backgroundColor: c.card, borderColor: c.cardLine, marginTop: 14, opacity: pressed ? 0.7 : 1 }, CARD_SHADOW]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowName, { color: c.text }]}>Commune pour la météo</Text>
            <Text style={[styles.rowValue, { color: c.muted }]}>{home.place.name}</Text>
          </View>
          <Icon name="chevronRight" width={9} height={15} color={c.text} />
        </View>
      </Pressable>

      <Pressable onPress={() => router.push("/meteo-recettes")} accessibilityRole="button"
        style={({ pressed }) => [styles.card, styles.list, { backgroundColor: c.card, borderColor: c.cardLine, marginTop: 14, opacity: pressed ? 0.7 : 1 }, CARD_SHADOW]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowName, { color: c.text }]}>Recettes selon la météo</Text>
            <Text style={[styles.rowValue, { color: c.muted }]}>Classer chaque plat : temps froid, tout temps ou temps chaud</Text>
          </View>
          <Icon name="chevronRight" width={9} height={15} color={c.text} />
        </View>
      </Pressable>

      <Pressable onPress={() => router.push("/credits")} accessibilityRole="button"
        style={({ pressed }) => [styles.card, styles.list, { backgroundColor: c.card, borderColor: c.cardLine, marginTop: 14, opacity: pressed ? 0.7 : 1 }, CARD_SHADOW]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowName, { color: c.text }]}>Crédits des photos</Text>
            <Text style={[styles.rowValue, { color: c.muted }]}>Photos des plats et des ingrédients : Wikimedia Commons, licences libres</Text>
          </View>
          <Icon name="chevronRight" width={9} height={15} color={c.text} />
        </View>
      </Pressable>

      <View style={{ marginTop: 14, marginLeft: 14, marginRight: 11 }}>
        <Button title="Déconnexion" kind="secondary" icon="logout" onPress={signOut} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingLeft: 13, paddingRight: 13, paddingTop: 4 },
  card: { marginLeft: 12.8, marginRight: 9.2, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingTop: 13, paddingBottom: 14, gap: 11 },
  list: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 7, paddingLeft: 14, paddingRight: 12 },
  rowName: { fontSize: 15.5, lineHeight: 19, fontWeight: "700" },
  rowValue: { fontSize: 14.2, lineHeight: 18 },
});
