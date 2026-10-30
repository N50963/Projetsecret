import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";

import { Body, Button, Card, ErrorText, H2, Muted, Screen } from "../components/ui";
import { dateTime, dayLabel } from "../lib/format";
import { isLidlConnected, syncLidl } from "../lib/lidl";
import { useHousehold, useSession } from "../lib/session";
import { supabase } from "../lib/supabase";

interface LidlStatus {
  connected: boolean;
  lastReceipt: string | null;
  lastSync: string | null;
}

/** Paramètres (roue crantée de l'accueil) : tickets Lidl Plus, préférences du foyer, déconnexion. */
export default function Parametres() {
  const router = useRouter();
  const household = useHousehold();
  const { signOut } = useSession();
  const [lidl, setLidl] = useState<LidlStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [connected, receipt, sync] = await Promise.all([
        isLidlConnected(),
        supabase.from("receipts").select("purchased_at").eq("household_id", household.id).order("purchased_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("last_sync").select("finished_at, status").eq("household_id", household.id).maybeSingle(),
      ]);
      setLidl({ connected, lastReceipt: receipt.data?.purchased_at ?? null, lastSync: sync.data?.finished_at ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [household.id]);

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

  return (
    <Screen title="Paramètres">
      <Card>
        <H2>Tickets Lidl Plus</H2>
        <Muted>{lidl ? `Dernier ticket : ${lidl.lastReceipt ? dayLabel(lidl.lastReceipt.slice(0, 10)) : "aucun"} · vérifié ${dateTime(lidl.lastSync)}`
          : "Chargement…"}</Muted>
        <Button title={lidl && !lidl.connected ? "Connecter Lidl Plus" : "Récupérer les nouveaux tickets"} onPress={sync} busy={syncing} />
        {message ? <Body>{message}</Body> : null}
        <ErrorText>{error}</ErrorText>
      </Card>

      <Card>
        <H2>Préférences</H2>
        <Muted>Composition du foyer, épices, aliments jamais proposés, allergies, soirs sans viande, mot de passe du compte.</Muted>
        <Button title="Modifier les préférences" kind="secondary" onPress={() => router.push("/preferences")} />
      </Card>

      <Button title="Déconnexion" kind="secondary" onPress={signOut} />
    </Screen>
  );
}
