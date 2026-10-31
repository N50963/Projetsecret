import { Image } from "expo-image";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";

import { Icon } from "../../components/icons";
import { Illustration } from "../../components/Illustration";
import { cleanDraft, RecipeEditor } from "../../components/RecipeEditor";
import { StarRating, starsLabel } from "../../components/StarRating";
import { StepText, TimersBar } from "../../components/Steps";
import { Body, Button, Card, ErrorText, Field, H1, H2, HeaderIcon, Loading, Muted, Pill, Row, Screen } from "../../components/ui";
import { minutes, proteinLabel, quantity } from "../../lib/format";
import { ingredientPicture, ingredientPictureUrls, illustrationUrls, pictureOf, uploadRecipePhoto, type Picture } from "../../lib/images";
import { adaptRecipeDraft, draftToInput, type Draft } from "../../lib/mistral";
import { pickDishPhoto } from "../../lib/photo";
import { useHousehold } from "../../lib/session";
import { clock, stepTimer } from "../../lib/steps";
import { supabase } from "../../lib/supabase";
import { useColors } from "../../lib/theme";
import { startTimer, stopTimer, timerId, useTimers } from "../../lib/timers";
import {
  adaptRecipe, addRecipeToShoppingList, getLatestRating, getRecipe, getShoppingNeeds, isFavorite, rateRecipe, scaleIngredients, setFavorite,
  toPayload, validateRecipe, type Recipe, type RecipeRating, type ShoppingNeed, type Stars,
} from "../../modules/recipes";

type Tab = "ingredients" | "preparation";

/**
 * Fiche recette MenuMalin (ouverte en fondu) : photo, puces (temps, protéine, personnes), onglets Ingrédients (« à
 * acheter », « Ajouter à ma liste ») et Préparation (pas à pas, un minuteur par étape, écran gardé allumé ; la recette
 * faite, on peut mettre sa propre photo du plat), durées, avis sur 5 étoiles avec commentaire, « Plus d'options »
 * (adaptation par Mistral, photo du plat). Favoris et partage dans la bande verte.
 */
export default function FicheRecette() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const { timers, now } = useTimers();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  // Photo connue du téléphone affichée tout de suite ; la liste est rafraîchie au chargement.
  const [image, setImage] = useState<Picture | null>(() => pictureOf(id));
  const [servings, setServings] = useState(household.defaultServings);
  const [tab, setTab] = useState<Tab>("ingredients");
  const [needs, setNeeds] = useState<ShoppingNeed[]>([]);
  const [favorite, setFav] = useState(false);
  const [previous, setPrevious] = useState<RecipeRating | null>(null);
  const [stars, setStars] = useState<Stars | null>(null);
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState(false);
  const [more, setMore] = useState(false);
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<(Draft & { change_note: string }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  /** Étape en cours (toutes faites quand elle vaut le nombre d'étapes). */
  const [current, setCurrent] = useState(0);
  // En cuisine, l'écran ne s'éteint pas tant que la fiche est ouverte.
  useKeepAwake();

  const load = useCallback(async () => {
    try {
      const r = await getRecipe(supabase, id);
      setRecipe(r);
      const [urls, rating, fav] = await Promise.all([
        illustrationUrls([r.id]), getLatestRating(supabase, household.id, r.id), isFavorite(supabase, household.id, r.id),
      ]);
      setImage(urls[r.id] ?? null);
      setPrevious(rating);
      setStars(rating?.stars ?? null);
      setComment(rating?.comment ?? "");
      setSaved(Boolean(rating?.stars));
      setFav(fav);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, household.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Vignettes des ingrédients (gardées sur le téléphone) : nouvel affichage quand la liste est connue.
  const [, setIngredientPics] = useState(0);
  useEffect(() => {
    ingredientPictureUrls().then((m) => setIngredientPics(m.size), () => undefined);
  }, []);

  useEffect(() => {
    if (!recipe) return;
    getShoppingNeeds(supabase, household.id, recipe.id, servings).then(setNeeds, () => setNeeds([]));
  }, [recipe, servings, household.id]);

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
  // Minuteurs de cette recette qui tournent encore : le plat ne peut pas être prêt avant leur fin.
  const cooking = timers.filter((t) => t.recipeId === recipe.id && !t.done);
  const toBuy = new Set(needs.filter((n) => !n.onList).map((n) => n.slug));
  const onList = new Set(needs.filter((n) => n.onList).map((n) => n.slug));

  const share = () => {
    const text = [
      recipe.name, `${minutes(recipe.totalMin)} · ${servings} personnes`, "",
      "Ingrédients :", ...ingredients.map((i) => `- ${i.label}${i.quantity !== null ? ` : ${quantity(i.quantity, i.unit)}` : ""}`), "",
      "Préparation :", ...recipe.steps.map((s, n) => `${n + 1}. ${s}`), "", "Recette MenuMalin",
    ].join("\n");
    if (Platform.OS === "web") navigator.clipboard?.writeText(text).then(() => setInfo("Recette copiée."), () => undefined);
    else Share.share({ title: recipe.name, message: text }).catch(() => undefined);
  };
  const toggleFavorite = () => act("fav", async () => {
    await setFavorite(supabase, household.id, recipe.id, !favorite);
    setFav(!favorite);
  });
  const addToList = () => act("list", async () => {
    const added = await addRecipeToShoppingList(supabase, household.id, recipe.id, servings);
    setNeeds(await getShoppingNeeds(supabase, household.id, recipe.id, servings));
    setInfo(added ? `${added} article${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""} à la liste de courses.` : "Tout est déjà sur la liste ou acheté récemment.");
  });
  const changePhoto = (camera: boolean) => act("photo", async () => {
    const photo = await pickDishPhoto(camera);
    if (!photo) return;
    await uploadRecipePhoto(household.id, recipe.id, photo.uri, photo.width);
    setImage((await illustrationUrls([recipe.id]))[recipe.id] ?? null);
    setInfo("Votre photo remplace l'image du plat.");
  });
  const saveRating = () => act("rate", async () => {
    if (!stars) return;
    await rateRecipe(supabase, household.id, recipe, stars, comment, previous);
    setPrevious(await getLatestRating(supabase, household.id, recipe.id));
    setSaved(true);
  });
  const askAdaptation = (feedback: string) => act("adapt", async () => {
    setDraft(await adaptRecipeDraft(household.id, toPayload(recipe), feedback));
  });
  const saveAdaptation = () => act("save", async () => {
    if (!draft) return;
    const input = draftToInput(cleanDraft(draft.recipe), "mistral");
    const issues = validateRecipe(input);
    if (issues.length) throw new Error(`À corriger : ${issues.map((i) => i.message).join(" ; ")}`);
    const newId = await adaptRecipe(supabase, household.id, recipe, input, draft.change_note || "Adaptée avec Mistral");
    setDraft(null);
    setRequest("");
    setCurrent(0);
    if (newId && recipe.householdId !== household.id) router.replace(`/recette/${newId}`);
    else await load();
  });

  return (
    <Screen title="Recette" padded={false} footer={<TimersBar />} headerRight={() => (
      <View style={{ flexDirection: "row" }}>
        <HeaderIcon name="share" label="Partager" onPress={share} size={23} />
        <HeaderIcon name={favorite ? "heart" : "heartOutline"} label={favorite ? "Retirer des favoris" : "Ajouter aux favoris"} onPress={toggleFavorite} />
      </View>
    )}>
      <Illustration picture={image} height={172} rounded={0} />
      <View style={styles.head}>
        <H1>{recipe.name}</H1>
        {recipe.description ? <Body style={{ color: c.muted }}>{recipe.description}</Body> : null}
      </View>

      <View style={styles.durations}>
        {[[recipe.totalMin, "au total"], [recipe.prepMin, "préparation"], [recipe.cookMin, "cuisson"]].map(([value, label]) => (
          <View key={label as string} style={[styles.duration, { backgroundColor: c.greenSoft }]}>
            <Text style={{ color: c.greenInk, fontSize: 18, lineHeight: 21, fontWeight: "700" }}>{minutes(value as number)}</Text>
            <Text style={{ color: c.greenInk, fontSize: 14.7, lineHeight: 18 }}>{label as string}</Text>
          </View>
        ))}
      </View>
      <View style={styles.pills}>
        {proteinLabel(recipe.mainProtein) ? <Pill icon="cutlery">{proteinLabel(recipe.mainProtein)}</Pill> : null}
        <View style={[styles.stepper, { backgroundColor: c.chip }]} accessibilityLabel="Nombre de personnes">
          <Pressable onPress={() => setServings((s) => Math.max(1, s - 1))} accessibilityRole="button" accessibilityLabel="Une personne de moins" style={styles.stepperButton}>
            <Icon name="minus" size={20} color={c.text} />
          </Pressable>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: "500" }} accessibilityLiveRegion="polite">{servings} pers.</Text>
          <Pressable onPress={() => setServings((s) => Math.min(12, s + 1))} accessibilityRole="button" accessibilityLabel="Une personne de plus" style={styles.stepperButton}>
            <Icon name="plus" size={20} color={c.text} />
          </Pressable>
        </View>
      </View>

      <View style={styles.tabs} accessibilityRole="tablist">
        {(["ingredients", "preparation"] as Tab[]).map((t) => {
          const on = tab === t;
          return (
            <Pressable key={t} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityState={{ selected: on }}
              style={[styles.tab, { borderBottomColor: on ? c.primary : c.border, borderBottomWidth: on ? 2.5 : 1 }]}>
              <Text style={{ color: on ? c.primary : c.text, fontSize: 16.4, fontWeight: "700" }}>{t === "ingredients" ? "Ingrédients" : "Préparation"}</Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "ingredients" ? (
        <View style={styles.section}>
          <View>
            {ingredients.map((i, n) => (
              <View key={n} style={[styles.ingredient, n < ingredients.length - 1 && { borderBottomWidth: 1, borderBottomColor: c.border }]}>
                {ingredientPicture(i.slug)
                  ? <Image source={{ uri: ingredientPicture(i.slug)! }} cachePolicy="memory-disk" style={styles.thumb} contentFit="cover" transition={0}
                    accessibilityIgnoresInvertColors />
                  : <View style={[styles.thumb, { backgroundColor: c.chip, alignItems: "center", justifyContent: "center" }]}>
                    <Icon name="cutlery" size={18} color={c.muted} />
                  </View>}
                <Text style={{ flex: 1, color: c.muted, fontSize: 16, lineHeight: 21 }}>
                  {i.label}{i.optional ? " (facultatif)" : ""}
                  {i.slug && toBuy.has(i.slug) ? <Text style={{ color: c.orangeInk, fontSize: 15, fontWeight: "500" }}> · à acheter</Text> : null}
                  {i.slug && onList.has(i.slug) ? <Text style={{ color: c.greenInk, fontSize: 15, fontWeight: "500" }}> · sur la liste</Text> : null}
                </Text>
                <Text style={{ color: c.text, fontSize: 16, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{quantity(i.quantity, i.unit)}</Text>
              </View>
            ))}
          </View>
          <Button icon="cartFilled" title="Ajouter à ma liste" onPress={addToList} busy={busy === "list"} />
        </View>
      ) : (
        <View style={[styles.section, { gap: 10 }]}>
          <Muted>Touchez une étape pour la suivre ; chaque minuteur sonne et vibre à la fin.</Muted>
          {recipe.steps.map((s, n) => {
            const isCurrent = n === current;
            const done = n < current;
            const timer = stepTimer(s, recipe.steps.slice(0, n));
            const running = timers.find((t) => t.id === timerId(recipe.id, n + 1));
            return (
              <Pressable key={n} onPress={() => setCurrent(n)} accessibilityRole="button" accessibilityState={{ selected: isCurrent }}
                accessibilityLabel={`Étape ${n + 1}${done ? ", faite" : ""}`}
                style={[styles.step, isCurrent && { backgroundColor: c.card, borderColor: c.primary, borderWidth: 1.5 }]}>
                <View style={[styles.badge, { backgroundColor: isCurrent ? c.primary : done ? c.greenSoft : c.chip }]}>
                  {done
                    ? <Icon name="check" size={18} color={c.greenInk} />
                    : <Text style={{ fontWeight: "700", fontSize: 16, color: isCurrent ? c.primaryText : c.text }}>{n + 1}</Text>}
                </View>
                <View style={{ flex: 1, gap: 10, paddingTop: 4 }}>
                  <StepText text={s} current={isCurrent} done={done} />
                  {timer && (running ? (
                    <Pressable onPress={() => stopTimer(running.id)} accessibilityRole="button"
                      accessibilityLabel={running.done ? "Fermer le minuteur" : `Arrêter le minuteur, ${clock((running.endsAt - now) / 1000)} restantes`}
                      style={({ pressed }) => [styles.timer, { backgroundColor: running.done ? c.danger : c.primary, borderColor: running.done ? c.danger : c.primary, opacity: pressed ? 0.7 : 1 }]}>
                      <Icon name={running.done ? "bell" : "stop"} size={18} color={c.primaryText} />
                      <Text style={{ color: c.primaryText, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                        {running.done ? "Terminé" : clock((running.endsAt - now) / 1000)}
                      </Text>
                    </Pressable>
                  ) : (
                    <Pressable accessibilityRole="button" accessibilityLabel={`Lancer le minuteur : ${timer.subject}, ${timer.label}`}
                      onPress={() => startTimer({ recipeId: recipe.id, recipeName: recipe.name, step: n + 1, subject: timer.subject, detail: s }, timer.seconds)}
                      style={({ pressed }) => [styles.timer, { backgroundColor: c.greenSoft, borderColor: c.primary, opacity: pressed ? 0.6 : 1 }]}>
                      <Icon name="timer" size={18} color={c.greenInk} />
                      <Text style={{ color: c.greenInk, fontWeight: "600" }}>Minuteur {timer.label}</Text>
                    </Pressable>
                  ))}
                  {isCurrent && (
                    <Row>
                      {n > 0 && <Button title="Précédente" kind="secondary" onPress={() => setCurrent(n - 1)} style={{ flex: 1 }} />}
                      {n < recipe.steps.length - 1
                        ? <Button title="Étape suivante" onPress={() => setCurrent(n + 1)} style={{ flex: 1 }} />
                        : <Button title={cooking.length ? "Minuteurs en cours" : "C'est prêt"} onPress={() => setCurrent(n + 1)} disabled={cooking.length > 0}
                          style={{ flex: 1 }} />}
                    </Row>
                  )}
                  {isCurrent && n === recipe.steps.length - 1 && cooking.length > 0 && (
                    <Muted>
                      Le plat sera prêt à la fin {cooking.length > 1 ? "des minuteurs" : "du minuteur"} :{" "}
                      {cooking.map((t) => `${t.subject} (étape ${t.step}, ${clock((t.endsAt - now) / 1000)})`).join(", ")}.
                    </Muted>
                  )}
                </View>
              </Pressable>
            );
          })}
          {current >= recipe.steps.length && (
            <Card>
              <H2>Bon appétit !</H2>
              <Muted>Prenez votre plat en photo : elle remplacera l'image de la recette.</Muted>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button title="Prendre une photo" kind="secondary" icon="camera" onPress={() => changePhoto(true)} busy={busy === "photo"} style={{ flex: 1.6 }} />
                <Button title="Galerie" kind="secondary" icon="gallery" onPress={() => changePhoto(false)} style={{ flex: 1 }} />
              </View>
              {info ? <Body style={{ color: c.greenInk }}>{info}</Body> : null}
              <Button title="Reprendre depuis le début" kind="secondary" onPress={() => setCurrent(0)} />
            </Card>
          )}
        </View>
      )}


      <View style={[styles.section, { gap: 9 }]}>
        {info ? <Body style={{ color: c.greenInk }}>{info}</Body> : null}
        <ErrorText>{error}</ErrorText>
        <H2>Votre avis</H2>
        <StarRating value={stars} onChange={(n) => {
          setStars(n);
          setSaved(false);
        }} />
        <Muted>{stars ? starsLabel(stars) : "Touchez les étoiles pour noter le plat."}</Muted>
        <Field multiline value={comment} maxLength={1000} placeholder="Un commentaire ? (un peu fade, trop de crème, les enfants ont adoré…)"
          onChangeText={(t) => {
            setComment(t);
            setSaved(false);
          }} />
        <Button title={saved ? "Avis enregistré" : "Enregistrer mon avis"} onPress={saveRating} busy={busy === "rate"} disabled={!stars || saved} />
        {saved && comment.trim() && !draft ? (
          <Button title="Adapter la recette selon mon avis" kind="secondary" icon="sparkle" busy={busy === "adapt"}
            onPress={() => askAdaptation(`Note du foyer : ${stars ?? "?"}/5. ${comment.trim()}`)} />
        ) : null}
      </View>

      <View style={styles.section}>
        <Pressable onPress={() => setMore((m) => !m)} accessibilityRole="button" accessibilityState={{ expanded: more }}
          style={({ pressed }) => [styles.more, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.8 : 1 }]}>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>Plus d’options</Text>
          <Icon name={more ? "chevronUp" : "chevronDown"} size={18} color={c.text} />
        </Pressable>
        {more && (
          <Card>
            <H2>Adapter avec Mistral</H2>
            <Field multiline value={request} onChangeText={setRequest} placeholder="Exemple : sans oignons, plus de légumes" style={{ backgroundColor: c.background }} />
            <Button title="Adapter la recette" onPress={() => askAdaptation(request)} busy={busy === "adapt"} disabled={!request.trim()} />
            <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
            <H2>Photo du plat</H2>
            <Muted>Votre photo remplace l'image créée par Mistral.</Muted>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="Prendre une photo" kind="secondary" icon="camera" onPress={() => changePhoto(true)} busy={busy === "photo"} style={{ flex: 1.6 }} />
              <Button title="Galerie" kind="secondary" icon="gallery" onPress={() => changePhoto(false)} style={{ flex: 1 }} />
            </View>
          </Card>
        )}
      </View>

      {draft && (
        <View style={[styles.section, { gap: 12 }]}>
          <Card>
            <H2>Version proposée par Mistral</H2>
            {draft.change_note ? <Body>{draft.change_note}</Body> : null}
            <Muted>Vous avez le dernier mot : corrigez ce que vous voulez avant de garder cette version. L'ancienne version reste dans l'historique.</Muted>
            {draft.issues.length ? <Muted>Remarques de Mistral : {draft.issues.join(" ; ")}</Muted> : null}
          </Card>
          <RecipeEditor value={draft.recipe} onChange={(r) => setDraft({ ...draft, recipe: r })} />
          <Button title="Garder ma version" onPress={saveAdaptation} busy={busy === "save"} />
          <Button title="Garder la recette actuelle" kind="secondary" onPress={() => setDraft(null)} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 19, paddingTop: 8, gap: 6 },
  pills: { flexDirection: "row", gap: 7.5, marginHorizontal: 17.5, marginTop: 10 },
  stepper: { flex: 1, minWidth: 128, height: 38, borderRadius: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepperButton: { width: 40, height: 48, alignItems: "center", justifyContent: "center" },
  tabs: { flexDirection: "row", gap: 12, marginHorizontal: 18.5, marginTop: 8 },
  tab: { flex: 1, height: 42, alignItems: "center", justifyContent: "center" },
  section: { marginHorizontal: 17, marginTop: 12, gap: 10 },
  ingredient: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingVertical: 6 },
  thumb: { width: 40, height: 40, borderRadius: 10, overflow: "hidden" },
  step: { flexDirection: "row", gap: 12, borderRadius: 13, borderWidth: 1.5, borderColor: "transparent", padding: 8 },
  badge: { width: 32, height: 32, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  timer: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, alignSelf: "flex-start" },
  durations: { flexDirection: "row", gap: 5.5, marginLeft: 17.5, marginRight: 13, marginTop: 10 },
  duration: { flex: 1, height: 56, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  more: { height: 48, borderRadius: 24, borderWidth: 1.5, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
});
