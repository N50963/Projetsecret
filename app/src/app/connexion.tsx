import { useState } from "react";
import { StyleSheet, TextInput } from "react-native";

import { Button, Card, ErrorText, H1, Muted, Screen } from "../components/ui";
import { useSession } from "../lib/session";
import { useColors } from "../lib/theme";

export default function Connexion() {
  const { signIn } = useSession();
  const c = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = [styles.input, { backgroundColor: c.card, borderColor: c.border, color: c.text }];

  const run = async () => {
    setError("");
    if (!email.includes("@") || !password) {
      setError("Saisissez l'e-mail et le mot de passe du compte du foyer.");
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Connexion">
      <H1>Menus du foyer</H1>
      <Muted>Un compte partagé, utilisé sur les deux téléphones du foyer.</Muted>
      <Card>
        <TextInput style={input} placeholder="E-mail du compte" placeholderTextColor={c.muted} autoCapitalize="none"
          autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <TextInput style={input} placeholder="Mot de passe" placeholderTextColor={c.muted} secureTextEntry
          autoComplete="password" value={password} onChangeText={setPassword} />
        <ErrorText>{error}</ErrorText>
        <Button title="Se connecter" onPress={run} busy={busy} />
      </Card>
      <Muted>Le compte de l'application est distinct du compte Lidl Plus, que vous connecterez ensuite.</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 50, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 17 },
});
