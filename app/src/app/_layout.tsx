import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Button, ErrorText, Loading, Muted, Screen } from "../components/ui";
import { warmIllustrations } from "../lib/images";
import { SessionProvider, useSession } from "../lib/session";
import { BRAND_FONT, useColors } from "../lib/theme";

/**
 * Écrans accessibles selon l'état du compte : connexion, puis code du foyer, puis l'application. Un écran dont la
 * condition est fausse n'est pas déclaré dans la pile ; Expo Router redirige alors vers `redirectTo`.
 * En-têtes : bande verte avec titre blanc (maquettes MenuBily) ; l'accueil et la connexion ont leur propre en-tête.
 */
function Gate() {
  const { ready, session, household, householdError, refreshHousehold } = useSession();
  const c = useColors();
  const member = session !== null && household !== null;
  // Dès l'ouverture : liste des photos lue sur le téléphone, puis toutes les photos téléchargées en avance.
  useEffect(() => {
    if (member) warmIllustrations();
  }, [member]);

  if (!ready) {
    if (!householdError) return <Loading label="Ouverture…" />;
    return (
      <Screen>
        <ErrorText>Impossible de charger le foyer : {householdError}</ErrorText>
        <Muted>Vérifiez la connexion Internet du téléphone.</Muted>
        <Button title="Réessayer" onPress={refreshHousehold} />
      </Screen>
    );
  }
  const signedIn = session !== null;
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: c.band }, headerTintColor: "#FFFFFF", headerShadowVisible: false,
      headerTitleStyle: { fontSize: 19, fontWeight: "700" }, contentStyle: { backgroundColor: c.background },
      headerBackButtonDisplayMode: "minimal", animation: "slide_from_right",
    }}>
      <Stack.Protected guard={!signedIn} redirectTo={member ? "/" : "/foyer"}>
        <Stack.Screen name="connexion" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !member} redirectTo={member ? "/" : "/connexion"}>
        <Stack.Screen name="foyer" options={{ title: "Votre foyer" }} />
      </Stack.Protected>
      <Stack.Protected guard={member} redirectTo={signedIn ? "/foyer" : "/connexion"}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="lidl" options={{ title: "Tickets Lidl Plus" }} />
        <Stack.Screen name="propositions" options={{ title: "Propositions" }} />
        <Stack.Screen name="courses" options={{ title: "Liste de courses", animation: "none" }} />
        <Stack.Screen name="recettes" options={{ title: "Recettes", animation: "none" }} />
        <Stack.Screen name="recette/[id]" options={{ title: "Recette", animation: "fade", animationDuration: 220 }} />
        <Stack.Screen name="ajout-recette" options={{ title: "Ajouter une recette" }} />
        <Stack.Screen name="parametres" options={{ title: "Paramètres", animation: "none" }} />
        <Stack.Screen name="preferences" options={{ title: "Préférences" }} />
        <Stack.Screen name="credits" options={{ title: "Crédits des photos" }} />
        <Stack.Screen name="meteo-recettes" options={{ title: "Recettes selon la météo" }} />
        <Stack.Screen name="produits" options={{ title: "Produits à vérifier" }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  // Police du nom MenuBily ; le reste du texte utilise Roboto, la police du système Android.
  useFonts({ [BRAND_FONT]: require("../../assets/fonts/Cabin-BoldItalic.ttf") });
  // Gestes natifs (déplacement des menus de la semaine) : la racine de l'application les reçoit.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <StatusBar style="light" />
          <Gate />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
