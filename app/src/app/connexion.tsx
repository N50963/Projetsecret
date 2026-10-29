import { useState } from "react";
import { StyleSheet, TextInput } from "react-native";

import { Body, Button, Card, ErrorText, H1, Muted, Screen } from "../components/ui";
import { useSession } from "../lib/session";
import { useColors } from "../lib/theme";

export default function Connexion() {
  const { signIn, signUp } = useSession();
  const c = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"in" | "up" | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const input = [styles.input, { backgroundColor: c.card, borderColor: c.border, color: c.text }];

  const run = async (kind: "in" | "up") => {
    setError("");
    setInfo("");
    if (!email.includes("@") || password.length < 8) {
      setError("Saisissez un e-mail valide et un mot de passe d'au moins 8 caractères.");
      return;
    }
    setBusy(kind);
    try {
      if (kind === "in") await signIn(email, password);
      else if (await signUp(email, password)) setInfo("Compte créé. Ouvrez l'e-mail de confirmation, puis revenez vous connecter.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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
        {info ? <Body>{info}</Body> : null}
        <Button title="Se connecter" onPress={() => run("in")} busy={busy === "in"} disabled={busy !== null} />
        <Button title="Créer le compte du foyer" kind="secondary" onPress={() => run("up")} busy={busy === "up"} disabled={busy !== null} />
      </Card>
      <Muted>Le compte de l'application est distinct du compte Lidl Plus, que vous connecterez ensuite.</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 50, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 17 },
});
