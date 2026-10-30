import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { WebView } from "react-native-webview";

import { Body, Button, Card, ErrorText, Loading, Muted, Screen } from "../components/ui";
import { finishLidlLogin, startLidlLogin, type PkceLogin } from "../lib/lidl";
import { extractCode, isLidlCallback } from "../modules/lidl-sync";

/**
 * Connexion Lidl Plus : la page officielle de Lidl s'ouvre dans l'application, la personne s'y connecte elle-même
 * (y compris la vérification anti-robot éventuelle) ; au retour, le code est échangé contre le jeton, gardé sur ce téléphone.
 */
export default function LidlConnexion() {
  const router = useRouter();
  const [login, setLogin] = useState<PkceLogin | null>(null);
  const [state, setState] = useState<"page" | "exchange" | "done">("page");
  const [error, setError] = useState("");
  const handled = useRef(false);

  useEffect(() => {
    startLidlLogin().then(setLogin).catch((e) => setError(String(e)));
  }, []);

  const onCallback = (url: string) => {
    if (handled.current || !login) return;
    handled.current = true;
    const code = extractCode(url);
    if (!code) {
      setError("Lidl n'a pas renvoyé de code de connexion. Réessayez.");
      return;
    }
    setState("exchange");
    finishLidlLogin(code, login.verifier)
      .then(() => setState("done"))
      .catch((e) => {
        handled.current = false;
        setState("page");
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  if (Platform.OS === "web") {
    return (
      <Screen title="Lidl Plus">
        <Card><Body>La connexion à Lidl Plus se fait depuis l'application sur le téléphone.</Body></Card>
      </Screen>
    );
  }
  if (state === "done") {
    return (
      <Screen title="Lidl Plus">
        <Card>
          <Body>Lidl Plus est connecté sur ce téléphone. Les tickets seront récupérés directement depuis Lidl.</Body>
          <Button title="Revenir aux paramètres" onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }
  if (!login || state === "exchange") return <Loading label={state === "exchange" ? "Finalisation de la connexion…" : undefined} />;

  return (
    <Screen title="Connexion Lidl Plus" scroll={false}>
      <Muted>Connectez-vous avec le compte Lidl Plus du foyer. Votre mot de passe reste sur la page de Lidl.</Muted>
      <ErrorText>{error}</ErrorText>
      <View style={{ flex: 1, borderRadius: 12, overflow: "hidden" }}>
        <WebView
          source={{ uri: login.url }}
          originWhitelist={["https://*", "com.lidlplus.app://*"]}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(req) => {
            if (isLidlCallback(req.url)) {
              onCallback(req.url);
              return false;
            }
            return true;
          }}
          onNavigationStateChange={(nav) => {
            if (isLidlCallback(nav.url)) onCallback(nav.url);
          }}
        />
      </View>
    </Screen>
  );
}
