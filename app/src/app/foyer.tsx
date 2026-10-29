import { useState } from "react";
import { StyleSheet, TextInput } from "react-native";

import { Button, Card, ErrorText, H1, Muted, Screen } from "../components/ui";
import { useSession } from "../lib/session";
import { useColors } from "../lib/theme";

export default function Foyer() {
  const { joinHousehold, signOut } = useSession();
  const c = useColors();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const join = async () => {
    setBusy(true);
    setError("");
    try {
      await joinHousehold(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Foyer">
      <H1>Rejoindre le foyer</H1>
      <Muted>Saisissez le code du foyer : il relie ce compte aux tickets, recettes et menus déjà enregistrés.</Muted>
      <Card>
        <TextInput style={[styles.input, { backgroundColor: c.card, borderColor: c.border, color: c.text }]} placeholder="Code du foyer"
          placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} value={code} onChangeText={setCode} />
        <ErrorText>{error}</ErrorText>
        <Button title="Rejoindre" onPress={join} busy={busy} disabled={code.trim().length < 6} />
      </Card>
      <Button title="Se déconnecter" kind="secondary" onPress={signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 50, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 18, letterSpacing: 1 },
});
