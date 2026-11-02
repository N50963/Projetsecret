import { Image } from "expo-image";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Logo } from "../components/icons";
import { Button, ErrorText, Field, Muted } from "../components/ui";
import { useSession } from "../lib/session";
import { BRAND_FONT, useColors } from "../lib/theme";
import { errorText } from "../lib/errors";

/** Connexion MenuBily : photo d'un plat en haut, panneau crème avec le logo, l'e-mail et le mot de passe du compte du foyer. */
export default function Connexion() {
  const { signIn } = useSession();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      const message = errorText(e);
      setError(/invalid|credentials|incorrect/i.test(message) ? "E-mail ou mot de passe incorrect." : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.background }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={{ height: insets.top, backgroundColor: c.statusBar }} />
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" bounces={false}>
        <Image source={require("../../assets/connexion.webp")} style={styles.photo} contentFit="cover" accessibilityIgnoresInvertColors />
        <View style={[styles.sheet, { backgroundColor: c.background, paddingBottom: 26 + insets.bottom }]}>
          <View style={styles.brand}>
            <Logo />
            <View>
              <Text style={[styles.name, { color: c.primary, fontFamily: BRAND_FONT }]}>MenuBily</Text>
              <Text style={[styles.slogan, { color: c.muted }]}>Bien manger, même sans idée</Text>
            </View>
          </View>
          <ErrorText>{error}</ErrorText>
          <View style={styles.group}>
            <Text style={[styles.label, { color: c.text }]} nativeID="courriel">E-mail</Text>
            <Field accessibilityLabelledBy="courriel" placeholder="prenom@exemple.fr" autoCapitalize="none" autoComplete="email" keyboardType="email-address"
              value={email} onChangeText={setEmail} style={error ? { borderColor: c.danger } : undefined} />
          </View>
          <View style={styles.group}>
            <Text style={[styles.label, { color: c.text }]} nativeID="secret">Mot de passe</Text>
            <Field accessibilityLabelledBy="secret" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword}
              onSubmitEditing={run} style={error ? { borderColor: c.danger } : undefined} />
          </View>
          <Button title="Se connecter" onPress={run} busy={busy} style={{ marginTop: 4 }} />
          <Muted style={{ textAlign: "center" }}>Un compte partagé par le foyer, distinct du compte Lidl Plus.</Muted>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  photo: { flex: 1, minHeight: 260, marginBottom: -24 },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12, paddingHorizontal: 17, gap: 13 },
  brand: { flexDirection: "row", alignItems: "center", gap: 12, height: 62 },
  name: { fontSize: 26.5, lineHeight: 30 },
  slogan: { fontSize: 12.2, lineHeight: 16, fontWeight: "500" },
  group: { gap: 6 },
  label: { fontSize: 16, fontWeight: "500" },
});
