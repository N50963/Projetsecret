import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Illustration } from "../../components/Illustration";
import { StepText, TimersBar } from "../../components/Steps";
import { Body, Button, Card, Chip, ErrorText, H1, H2, Loading, Muted, Row, Screen } from "../../components/ui";
import { minutes, PROTEIN_LABEL, quantity } from "../../lib/format";
import { illustrationUrls, uploadRecipePhoto, type Picture } from "../../lib/images";
import { adaptRecipeDraft, draftToInput, type Draft } from "../../lib/mistral";
import { useHousehold } from "../../lib/session";
import { stepTimers } from "../../lib/steps";
import { supabase } from "../../lib/supabase";
import { useColors } from "../../lib/theme";
import { startTimer } from "../../lib/timers";
import { adaptRecipe, getRecipe, rateRecipe, scaleIngredients, toPayload, type Rating, type Recipe } from "../../modules/recipes";

const ALLERGEN: Record<string, string> = {
  gluten: "gluten", lait: "lait", oeuf: "œuf", poisson: "poisson", crustaces: "crustacés", fruits_a_coque: "fruits à coque",
  soja: "soja", moutarde: "moutarde", celeri: "céleri", sesame: "sésame",
};

/**
 * Fiche recette : photo, quantités pour le nombre de personnes, étapes « pas à pas » (étape en cours mise en avant, minuteurs,
 * écran gardé allumé), avis ; adaptation et photo dans « Plus d'options ».
 */
export default function FicheRecette() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [image, setImage] = useState<Picture | null>(null);
  const [servings, setServings] = useState(household.defaultServings);
  const [rated, setRated] = useState<Rating | null>(null);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<(Draft & { change_note: string }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [more, setMore] = useState(false);
  /** Étape en cours (toutes faites quand elle vaut le nombre d'étapes). */
  const [current, setCurrent] = useState(0);
  // En cuisine, l'écran ne s'éteint pas tant que la fiche est ouverte.
  useKeepAwake();

  const load = useCallback(async () => {
    try {
      const r = await getRecipe(supabase, id);
      setRecipe(r);
      const urls = await illustrationUrls([r.id]);
      setImage(urls[r.id] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError("");
    setInfo("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!recipe) return error ? <Screen title="Recette"><ErrorText>{error}</ErrorText></Screen> : <Loading />;
  const ingredients = scaleIngredients(recipe.ingredients, recipe.servings, servings);

  const rate = (r: Rating) => act("rate", async () => {
    await rateRecipe(supabase, household.id, recipe, r);
    setRated(r);
    setInfo(r === "dislike" ? "Noté. Vous pouvez demander à Mistral une version qui plaira davantage." : "Merci, c'est noté.");
  });
  const pickPhoto = (camera: boolean) => act("photo", async () => {
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [4, 3], quality: 0.7 };
    if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error("Accès à l'appareil photo refusé.");
    const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return;
    await uploadRecipePhoto(household.id, recipe.id, asset.uri, asset.width);
    setImage((await illustrationUrls([recipe.id]))[recipe.id] ?? null);
  });
  const askAdaptation = () => act("adapt", async () => {
    setDraft(await adaptRecipeDraft(household.id, toPayload(recipe), feedback));
  });
  const saveAdaptation = () => act("save", async () => {
    if (!draft) return;
    const newId = await adaptRecipe(supabase, household.id, recipe, draftToInput(draft.recipe, "mistral"), draft.change_note);
    setDraft(null);
    setFeedback("");
    if (newId && recipe.householdId !== household.id) router.replace(`/recette/${newId}`);
    else await load();
  });

  return (
    <Screen title={recipe.name} footer={<TimersBar />}>
      <Illustration picture={image} height={240} />
      <H1>{recipe.name}</H1>
      {recipe.description ? <Body>{recipe.description}</Body> : null}
      <Muted>
        {minutes(recipe.totalMin)} (préparation {minutes(recipe.prepMin)}, cuisson {minutes(recipe.cookMin)}) · {PROTEIN_LABEL[recipe.mainProtein]}
        {recipe.allergens.length ? ` · Allergènes : ${recipe.allergens.map((a) => ALLERGEN[a] ?? a).join(", ")}` : ""}
      </Muted>

      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <H2>Ingrédients</H2>
          <Row>
            <Chip label="−" onPress={() => setServings((s) => Math.max(1, s - 1))} />
            <Body>{servings} pers.</Body>
            <Chip label="+" onPress={() => setServings((s) => Math.min(12, s + 1))} />
          </Row>
        </Row>
        {ingredients.map((i, n) => (
          <View key={n} style={styles.line}>
            <Body style={{ flex: 1 }}>{i.label}{i.optional ? " (facultatif)" : ""}</Body>
            <Body style={{ color: c.muted }}>{quantity(i.quantity, i.unit)}</Body>
          </View>
        ))}
      </Card>

      <Card>
        <H2>Pas à pas</H2>
        <Muted>Touchez une étape pour la suivre ; les minuteurs sonnent et vibrent à la fin.</Muted>
        {recipe.steps.map((s, n) => {
          const isCurrent = n === current;
          const done = n < current;
          const timers = stepTimers(s);
          return (
            <Pressable key={n} onPress={() => setCurrent(n)} accessibilityRole="button" accessibilityState={{ selected: isCurrent }}
              accessibilityLabel={`Étape ${n + 1}${done ? ", faite" : ""}`}
              style={[styles.step, isCurrent && { borderColor: c.primary, backgroundColor: c.overlay, borderWidth: 2 }]}>
              <View style={[styles.badge, { backgroundColor: isCurrent ? c.primary : c.chip }]}>
                {done
                  ? <Ionicons name="checkmark" size={18} color={c.muted} />
                  : <Text style={{ fontWeight: "700", color: isCurrent ? c.primaryText : c.text }}>{n + 1}</Text>}
              </View>
              <View style={{ flex: 1, gap: 10 }}>
                <StepText text={s} current={isCurrent} done={done} />
                {timers.length > 0 && (
                  <Row>
                    {timers.map((t) => (
                      <Pressable key={t.seconds} accessibilityRole="button" accessibilityLabel={`Lancer un minuteur de ${t.label}`}
                        onPress={() => startTimer(recipe.id, `Étape ${n + 1} · ${t.label}`, s, t.seconds)}
                        style={({ pressed }) => [styles.timer, { borderColor: c.primary, opacity: pressed ? 0.6 : 1 }]}>
                        <Ionicons name="timer-outline" size={18} color={c.primary} />
                        <Text style={{ color: c.primary, fontWeight: "600" }}>{t.label}</Text>
                      </Pressable>
                    ))}
                  </Row>
                )}
                {isCurrent && (
                  <Row>
                    {n > 0 && <Button title="Précédente" kind="secondary" onPress={() => setCurrent(n - 1)} style={{ flex: 1 }} />}
                    <Button title={n < recipe.steps.length - 1 ? "Étape suivante" : "C'est prêt"} onPress={() => setCurrent(n + 1)} style={{ flex: 1 }} />
                  </Row>
                )}
              </View>
            </Pressable>
          );
        })}
        {current >= recipe.steps.length && (
          <View style={{ gap: 8 }}>
            <Body style={{ fontWeight: "700" }}>Bon appétit !</Body>
            <Button title="Reprendre depuis le début" kind="secondary" onPress={() => setCurrent(0)} />
          </View>
        )}
      </Card>

      <Card>
        <H2>Votre avis</H2>
        <Row>
          <Chip label="J'aime" active={rated === "like"} onPress={() => rate("like")} />
          <Chip label="Bof" active={rated === "neutral"} onPress={() => rate("neutral")} />
          <Chip label="Pas aimé" active={rated === "dislike"} onPress={() => rate("dislike")} />
        </Row>
        {info ? <Body>{info}</Body> : null}
      </Card>

      <Button title={more ? "Moins d'options" : "Plus d'options"} kind="secondary" onPress={() => setMore((m) => !m)} />
      {more && <Card>
        <H2>Adapter avec Mistral</H2>
        <TextInput multiline value={feedback} onChangeText={setFeedback} placeholderTextColor={c.muted}
          placeholder="Ex. : plus de légumes, sans champignons, plus rapide…"
          style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.background }]} />
        <Button title="Proposer une version adaptée" onPress={askAdaptation} busy={busy === "adapt"} disabled={!feedback.trim()} />
        {draft && (
          <View style={{ gap: 6 }}>
            <Body style={{ fontWeight: "700" }}>{draft.recipe.name}</Body>
            <Muted>{draft.change_note}</Muted>
            {draft.recipe.ingredients.map((i, n) => <Muted key={n}>• {i.label} {quantity(i.quantity, i.unit)}</Muted>)}
            {draft.recipe.steps.map((s, n) => <Muted key={`s${n}`}>{n + 1}. {s}</Muted>)}
            {draft.issues.length ? <Muted>À vérifier : {draft.issues.join(" ; ")}</Muted> : null}
            <Row>
              <Button title="Garder cette version" onPress={saveAdaptation} busy={busy === "save"} style={{ flex: 1 }} />
              <Button title="Annuler" kind="secondary" onPress={() => setDraft(null)} style={{ flex: 1 }} />
            </Row>
          </View>
        )}
      </Card>}

      {more && <Card>
        <H2>Photo du plat</H2>
        <Muted>Remplace l'image par votre propre photo.</Muted>
        <Row>
          <Button title="Prendre une photo" kind="secondary" onPress={() => pickPhoto(true)} busy={busy === "photo"} style={{ flex: 1 }} />
          <Button title="Galerie" kind="secondary" onPress={() => pickPhoto(false)} style={{ flex: 1 }} />
        </Row>
      </Card>}
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", gap: 12, paddingVertical: 4 },
  step: { flexDirection: "row", gap: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent", padding: 10 },
  badge: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  timer: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  input: { minHeight: 70, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, fontSize: 16, textAlignVertical: "top" },
});
