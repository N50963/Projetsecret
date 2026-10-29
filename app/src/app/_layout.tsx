import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Loading } from "../components/ui";
import { SessionProvider, useSession } from "../lib/session";
import { useColors } from "../lib/theme";

/** Redirige vers la connexion ou le choix du foyer tant que le compte n'est pas prêt. */
function Gate() {
  const { ready, session, household } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const c = useColors();
  const first = segments[0] as string | undefined;

  useEffect(() => {
    if (!ready) return;
    if (!session && first !== "connexion") router.replace("/connexion");
    else if (session && !household && first !== "foyer") router.replace("/foyer");
    else if (session && household && (first === "connexion" || first === "foyer")) router.replace("/");
  }, [ready, session, household, first, router]);

  if (!ready) return <Loading label="Ouverture…" />;
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: c.background }, headerTintColor: c.text, headerShadowVisible: false,
      contentStyle: { backgroundColor: c.background }, headerBackTitle: "Retour",
    }} />
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
