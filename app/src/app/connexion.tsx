import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Logo } from "../components/icons";
import { Button, ErrorText, Field, Muted } from "../components/ui";
import { useSession } from "../lib/session";
import { useColors } from "../lib/theme";
import { errorText } from "../lib/errors";
import { sideMargin, useLayout } from "../lib/layout";

/**
 * Connexion MenuBily : photo d'un plat en haut, panneau crème avec le logo, l'e-mail et le mot de passe du compte du foyer.
 * Clavier ouvert : la photo se replie et le panneau remonte au-dessus du clavier (Android affiche l'application sous les
 * barres du système : la fenêtre n'est plus réduite par le clavier, l'écran doit lui laisser la place lui-même).
 */
export default function Connexion() {
  const { signIn } = useSession();
  const c = useColors();
  const { width } = useLayout();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Saisie en cours (clavier ouvert) : photo repliée, champs et bouton au-dessus du clavier. */
  const [typing, setTyping] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    const shown = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => {
      setTyping(true);
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60);
    });
    const hidden = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setTyping(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

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
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.background }} behavior="padding">
      <View style={{ height: insets.top, backgroundColor: c.statusBar }} />
      <ScrollView ref={scroll} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" bounces={false}>
        <Image source={require("../../assets/connexion.webp")} style={typing ? styles.photoFolded : styles.photo} contentFit="cover" accessibilityIgnoresInvertColors />
        {/* Grand écran (Z Fold déplié) : le formulaire garde une largeur de téléphone, centré. */}
        <View style={[styles.sheet, { backgroundColor: c.background, paddingHorizontal: sideMargin(width, 480, 17), paddingBottom: (typing ? 16 : 26) + (typing ? 0 : insets.bottom) }]}>
          <View style={styles.brand}><Logo height={84} /></View>
          <ErrorText>{error}</ErrorText>
          <View style={styles.group}>
            <Text style={[styles.label, { color: c.text }]} nativeID="courriel">E-mail</Text>
            <Field accessibilityLabelledBy="courriel" placeholder="prenom@exemple.fr" onFocus={() => setTyping(true)} autoCapitalize="none" autoComplete="email" keyboardType="email-address"
              value={email} onChangeText={setEmail} style={error ? { borderColor: c.danger } : undefined} />
          </View>
          <View style={styles.group}>
            <Text style={[styles.label, { color: c.text }]} nativeID="secret">Mot de passe</Text>
            <Field accessibilityLabelledBy="secret" onFocus={() => setTyping(true)} secureTextEntry autoComplete="password" value={password} onChangeText={setPassword}
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
  // Clavier ouvert : un bandeau de photo seulement, sous le haut arrondi du panneau.
  photoFolded: { height: 44, marginBottom: -24 },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12, paddingHorizontal: 17, gap: 13 },
  brand: { alignItems: "center", paddingTop: 4 },
  group: { gap: 6 },
  label: { fontSize: 16, fontWeight: "500" },
});
