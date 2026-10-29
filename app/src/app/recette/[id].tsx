import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { Illustration } from "../../components/Illustration";
import { Body, Button, Card, Chip, ErrorText, H1, H2, Loading, Muted, Row, Screen } from "../../components/ui";
import { minutes, PROTEIN_LABEL, quantity } from "../../lib/format";
import { forgetIllustration, illustrationUrls, uploadRecipePhoto } from "../../lib/images";
import { adaptRecipeDraft, draftToInput, illustrateRecipe, type Draft } from "../../lib/mistral";
import { useHousehold } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import { useColors } from "../../lib/theme";
import { adaptRecipe, getRecipe, rateRecipe, scaleIngredients, toPayload, type Rating, type Recipe } from "../../modules/recipes";

const ALLERGEN: Record<string, string> = {
  gluten: "gluten", lait: "lait", oeuf: "œuf", poisson: "poisson", crustaces: "crustacés", fruits_a_coque: "fruits à coque",
  soja: "soja", moutarde: "moutarde", celeri: "céleri", sesame: "sésame",
};

/** Fiche recette : illustration, quantités pour le nombre de personnes, étapes, avis, adaptation. */
export default function FicheRecette() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [servings, setServings] = useState(household.defaultServings);
  const [rated, setRated] = useState<Rating | null>(null);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<(Draft & { change_note: string }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

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
    await uploadRecipePhoto(household.id, recipe.id, asset.uri, asset.mimeType ?? "image/jpeg");
    setImage((await illustrationUrls([recipe.id]))[recipe.id] ?? null);
  });
  const createImage = () => act("image", async () => {
    await illustrateRecipe(household.id, recipe.id);
    forgetIllustration(recipe.id);
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
    <Screen title={recipe.name}>
      <Illustration uri={image} mainProtein={recipe.mainProtein} slugs={recipe.ingredients.map((i) => i.slug)} height={220} />
      <H1>{recipe.name}</H1>
      {recipe.description ? <Body>{recipe.description}</Body> : null}
      <Muted>
        ⏱ {minutes(recipe.totalMin)} (préparation {minutes(recipe.prepMin)}, cuisson {minutes(recipe.cookMin)}) · {PROTEIN_LABEL[recipe.mainProtein]}
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
        <H2>Étapes</H2>
        {recipe.steps.map((s, n) => (
          <View key={n} style={styles.step}>
            <Body style={{ fontWeight: "700", color: c.primary }}>{n + 1}.</Body>
            <Body style={{ flex: 1 }}>{s}</Body>
          </View>
        ))}
      </Card>

      <Card>
        <H2>Votre avis</H2>
        <Row>
          <Chip label="😋 J'aime" active={rated === "like"} onPress={() => rate("like")} />
          <Chip label="😐 Bof" active={rated === "neutral"} onPress={() => rate("neutral")} />
          <Chip label="🙁 Pas aimé" active={rated === "dislike"} onPress={() => rate("dislike")} />
        </Row>
        {info ? <Body>{info}</Body> : null}
      </Card>

      <Card>
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
      </Card>

      <Card>
        <H2>Illustration</H2>
        <Row>
          <Button title="📷 Photo" kind="secondary" onPress={() => pickPhoto(true)} busy={busy === "photo"} style={{ flex: 1 }} />
          <Button title="🖼️ Galerie" kind="secondary" onPress={() => pickPhoto(false)} style={{ flex: 1 }} />
        </Row>
        {!image && <Button title="Créer l'image avec Mistral" kind="secondary" onPress={createImage} busy={busy === "image"} />}
      </Card>
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", gap: 12, paddingVertical: 4 },
  step: { flexDirection: "row", gap: 10 },
  input: { minHeight: 70, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, fontSize: 16, textAlignVertical: "top" },
});
