import Ionicons from "@expo/vector-icons/Ionicons";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Illustration } from "../../components/Illustration";
import { cleanDraft, RecipeEditor } from "../../components/RecipeEditor";
import { StarRating, starsLabel } from "../../components/StarRating";
import { StepText, TimersBar } from "../../components/Steps";
import { Body, Button, Card, Chip, ErrorText, H1, H2, Loading, Muted, Row, Screen } from "../../components/ui";
import { minutes, PROTEIN_LABEL, quantity } from "../../lib/format";
import { illustrationUrls, uploadRecipePhoto, type Picture } from "../../lib/images";
import { adaptRecipeDraft, draftToInput, type Draft } from "../../lib/mistral";
import { chooseDishPhoto } from "../../lib/photo";
import { useHousehold } from "../../lib/session";
import { clock, stepTimer } from "../../lib/steps";
import { supabase } from "../../lib/supabase";
import { useColors } from "../../lib/theme";
import { startTimer, stopTimer, timerId, useTimers } from "../../lib/timers";
import {
  adaptRecipe, getLatestRating, getRecipe, rateRecipe, scaleIngredients, toPayload, validateRecipe, type Recipe, type RecipeRating, type Stars,
} from "../../modules/recipes";

const ALLERGEN: Record<string, string> = {
  gluten: "gluten", lait: "lait", oeuf: "œuf", poisson: "poisson", crustaces: "crustacés", fruits_a_coque: "fruits à coque",
  soja: "soja", moutarde: "moutarde", celeri: "céleri", sesame: "sésame",
};

/**
 * Fiche recette : photo (remplaçable par la photo du foyer), quantités pour le nombre de personnes, étapes « pas à pas »
 * (étape en cours mise en avant, un minuteur par étape, écran gardé allumé), avis sur 5 étoiles avec commentaire, qui peut
 * servir à faire adapter la recette par Mistral ; l'utilisateur relit et corrige la version proposée avant de la garder.
 */
export default function FicheRecette() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const { timers, now } = useTimers();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [image, setImage] = useState<Picture | null>(null);
  const [servings, setServings] = useState(household.defaultServings);
  const [previous, setPrevious] = useState<RecipeRating | null>(null);
  const [stars, setStars] = useState<Stars | null>(null);
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<(Draft & { change_note: string }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** Étape en cours (toutes faites quand elle vaut le nombre d'étapes). */
  const [current, setCurrent] = useState(0);
  // En cuisine, l'écran ne s'éteint pas tant que la fiche est ouverte.
  useKeepAwake();

  const load = useCallback(async () => {
    try {
      const r = await getRecipe(supabase, id);
      setRecipe(r);
      const [urls, rating] = await Promise.all([illustrationUrls([r.id]), getLatestRating(supabase, household.id, r.id)]);
      setImage(urls[r.id] ?? null);
      setPrevious(rating);
      setStars(rating?.stars ?? null);
      setComment(rating?.comment ?? "");
      setSaved(Boolean(rating?.stars));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, household.id]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError("");
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

  const changePhoto = () => act("photo", async () => {
    const photo = await chooseDishPhoto();
    if (!photo) return;
    await uploadRecipePhoto(household.id, recipe.id, photo.uri, photo.width);
    setImage((await illustrationUrls([recipe.id]))[recipe.id] ?? null);
  });
  const saveRating = () => act("rate", async () => {
    if (!stars) return;
    await rateRecipe(supabase, household.id, recipe, stars, comment, previous);
    setPrevious(await getLatestRating(supabase, household.id, recipe.id));
    setSaved(true);
  });
  const askAdaptation = () => act("adapt", async () => {
    const feedback = `Note du foyer : ${stars ?? "?"}/5. ${comment.trim()}`;
    setDraft(await adaptRecipeDraft(household.id, toPayload(recipe), feedback));
  });
  const saveAdaptation = () => act("save", async () => {
    if (!draft) return;
    const input = draftToInput(cleanDraft(draft.recipe), "mistral");
    const issues = validateRecipe(input);
    if (issues.length) throw new Error(`À corriger : ${issues.map((i) => i.message).join(" ; ")}`);
    const newId = await adaptRecipe(supabase, household.id, recipe, input, draft.change_note || `Adaptée selon l'avis : ${comment.trim()}`);
    setDraft(null);
    setCurrent(0);
    if (newId && recipe.householdId !== household.id) router.replace(`/recette/${newId}`);
    else await load();
  });

  return (
    <Screen title={recipe.name} footer={<TimersBar />}>
      <View>
        <Illustration picture={image} height={240} />
        <Pressable onPress={changePhoto} disabled={busy === "photo"} accessibilityRole="button" accessibilityLabel="Mettre ma photo du plat"
          style={({ pressed }) => [styles.photoButton, { backgroundColor: c.card, opacity: pressed || busy === "photo" ? 0.7 : 0.95 }]}>
          <Ionicons name={busy === "photo" ? "hourglass-outline" : "camera"} size={20} color={c.text} />
          <Text style={{ color: c.text, fontWeight: "600" }}>{busy === "photo" ? "Envoi…" : "Ma photo"}</Text>
        </Pressable>
      </View>
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
        <Muted>Touchez une étape pour la suivre ; chaque minuteur sonne et vibre à la fin.</Muted>
        {recipe.steps.map((s, n) => {
          const isCurrent = n === current;
          const done = n < current;
          const timer = stepTimer(s, recipe.steps.slice(0, n));
          const running = timers.find((t) => t.id === timerId(recipe.id, n + 1));
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
                {timer && (
                  running ? (
                    <Pressable onPress={() => stopTimer(running.id)} accessibilityRole="button"
                      accessibilityLabel={running.done ? "Fermer le minuteur" : `Arrêter le minuteur, ${clock((running.endsAt - now) / 1000)} restantes`}
                      style={({ pressed }) => [styles.timer, { borderColor: running.done ? c.danger : c.primary, backgroundColor: running.done ? c.danger : c.primary, opacity: pressed ? 0.7 : 1 }]}>
                      <Ionicons name={running.done ? "alarm" : "stop-circle-outline"} size={18} color={c.primaryText} />
                      <Text style={{ color: c.primaryText, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                        {running.done ? "Terminé" : clock((running.endsAt - now) / 1000)}
                      </Text>
                    </Pressable>
                  ) : (
                    <Pressable accessibilityRole="button" accessibilityLabel={`Lancer le minuteur : ${timer.subject}, ${timer.label}`}
                      onPress={() => startTimer({ recipeId: recipe.id, recipeName: recipe.name, step: n + 1, subject: timer.subject, detail: s }, timer.seconds)}
                      style={({ pressed }) => [styles.timer, { borderColor: c.primary, opacity: pressed ? 0.6 : 1 }]}>
                      <Ionicons name="timer-outline" size={18} color={c.primary} />
                      <Text style={{ color: c.primary, fontWeight: "600" }}>Minuteur {timer.label}</Text>
                    </Pressable>
                  )
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
        <StarRating value={stars} onChange={(n) => {
          setStars(n);
          setSaved(false);
        }} />
        {stars ? <Muted>{starsLabel(stars)}</Muted> : <Muted>Touchez les étoiles pour noter le plat.</Muted>}
        <TextInput multiline value={comment} onChangeText={(t) => {
          setComment(t);
          setSaved(false);
        }} maxLength={1000} placeholderTextColor={c.muted}
          placeholder="Un commentaire ? (ex. un peu fade, trop de crème, les enfants ont adoré)"
          style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.background }]} />
        <Button title={saved ? "Avis enregistré" : "Enregistrer mon avis"} onPress={saveRating} busy={busy === "rate"} disabled={!stars || saved} />
        {saved && comment.trim() && !draft ? (
          <>
            <Muted>Mistral peut proposer une version de la recette qui tient compte de votre commentaire ; vous la relirez avant de la garder.</Muted>
            <Button title="Adapter la recette selon mon avis" kind="secondary" onPress={askAdaptation} busy={busy === "adapt"} />
          </>
        ) : null}
        {saved && !comment.trim() && stars !== null && stars <= 3 ? (
          <Muted>Dites ce qui n'a pas plu : Mistral pourra adapter la recette.</Muted>
        ) : null}
      </Card>

      {draft && (
        <>
          <Card>
            <H2>Version proposée par Mistral</H2>
            {draft.change_note ? <Body>{draft.change_note}</Body> : null}
            <Muted>Vous avez le dernier mot : corrigez ce que vous voulez avant de garder cette version. L'ancienne version reste dans l'historique.</Muted>
            {draft.issues.length ? <Muted>Remarques de Mistral : {draft.issues.join(" ; ")}</Muted> : null}
          </Card>
          <RecipeEditor value={draft.recipe} onChange={(r) => setDraft({ ...draft, recipe: r })} />
          <Button title="Garder ma version" onPress={saveAdaptation} busy={busy === "save"} />
          <Button title="Garder la recette actuelle" kind="secondary" onPress={() => setDraft(null)} />
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", gap: 12, paddingVertical: 4 },
  step: { flexDirection: "row", gap: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent", padding: 10 },
  badge: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  timer: {
    flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
    alignSelf: "flex-start",
  },
  input: { minHeight: 70, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, fontSize: 16, textAlignVertical: "top" },
  photoButton: {
    position: "absolute", right: 10, bottom: 10, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 8, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 3,
  },
});
