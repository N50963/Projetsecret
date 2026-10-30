import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Button, ErrorText, Loading, Muted, Screen } from "../components/ui";
import { SessionProvider, useSession } from "../lib/session";
import { useColors } from "../lib/theme";

/**
 * Écrans accessibles selon l'état du compte : connexion, puis code du foyer, puis l'application. Un écran dont la
 * condition est fausse n'est pas déclaré dans la pile ; Expo Router redirige alors vers `redirectTo`.
 */
function Gate() {
  const { ready, session, household, householdError, refreshHousehold } = useSession();
  const c = useColors();

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
  const member = signedIn && household !== null;
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: c.background }, headerTintColor: c.text, headerShadowVisible: false,
      contentStyle: { backgroundColor: c.background }, headerBackTitle: "Retour",
    }}>
      <Stack.Protected guard={!signedIn} redirectTo={member ? "/" : "/foyer"}>
        <Stack.Screen name="connexion" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !member} redirectTo={member ? "/" : "/connexion"}>
        <Stack.Screen name="foyer" />
      </Stack.Protected>
      <Stack.Protected guard={member} redirectTo={signedIn ? "/foyer" : "/connexion"}>
        <Stack.Screen name="index" />
        <Stack.Screen name="lidl" />
        <Stack.Screen name="propositions" />
        <Stack.Screen name="courses" />
        <Stack.Screen name="recettes" />
        <Stack.Screen name="recette/[id]" />
        <Stack.Screen name="ajout-recette" />
        <Stack.Screen name="parametres" />
        <Stack.Screen name="preferences" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <Gate />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
