import { Image } from "expo-image";
import { useKeepAwake } from "expo-keep-awake";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, Share, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";

import { Icon } from "../../components/icons";
import { Illustration } from "../../components/Illustration";
import { cleanDraft, RecipeEditor } from "../../components/RecipeEditor";
import { StarRating, starsLabel } from "../../components/StarRating";
import { StepText, TimersBar } from "../../components/Steps";
import { Body, Button, Card, ErrorText, Field, H1, H2, HeaderIcon, Loading, Muted, Pill, Row, Screen } from "../../components/ui";
import { minutes, proteinLabel, quantity } from "../../lib/format";
import { ingredientPictureUrls, ingredientSource, illustrationUrls, pictureOf, uploadRecipePhoto, type Picture } from "../../lib/images";
import { adaptRecipeDraft, draftToInput, type DraftRecipe } from "../../lib/mistral";
import { pickDishPhoto } from "../../lib/photo";
import { useHousehold } from "../../lib/session";
import { clock, stepTimer } from "../../lib/steps";
import { supabase } from "../../lib/supabase";
import { toIsoDate } from "../../modules/planning";
import { CARD_SHADOW, useColors } from "../../lib/theme";
import { startTimer, stopTimer, timerId, useTimers } from "../../lib/timers";
import {
  adaptRecipe, addRecipeToShoppingList, addRecipeVersion, archiveRecipe, getLatestRating, getRecipe, getShoppingNeeds, isFavorite, rateRecipe,
  scaleIngredients, setFavorite, toPayload, validateRecipe, type Recipe, type RecipeRating, type ShoppingNeed, type Stars,
} from "../../modules/recipes";

type Tab = "ingredients" | "preparation";

/** Brouillon affiché dans l'éditeur : version proposée par Mistral après un avis, ou modification par le foyer. */
interface Revision {
  kind: "mistral" | "edit";
  recipe: DraftRecipe;
  issues: string[];
  change_note: string;
}

/** Jour où la recette a été faite sur ce téléphone (« C'est prêt ») : l'avis ne se donne que ce jour-là. */
const cookedKey = (recipeId: string) => `recette-faite:${recipeId}`;

function confirm(message: string, action: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(message)) onConfirm();
    return;
  }
  Alert.alert(message, undefined, [{ text: "Garder", style: "cancel" }, { text: action, style: "destructive", onPress: onConfirm }]);
}

/**
 * Fiche recette MenuBily (ouverte en fondu) : photo, durées, puces (protéine, personnes), onglets Ingrédients (« à
 * acheter », « Ajouter à ma liste ») et Préparation (pas à pas, un minuteur par étape, écran gardé allumé). La recette
 * faite (« C'est prêt »), et ce jour-là seulement : photo du plat et avis sur 5 étoiles avec une remarque ; l'avis
 * enregistré part à Mistral, qui propose une version améliorée si la recette est améliorable (l'utilisateur la corrige
 * et la garde, ou garde la recette actuelle). Photo du plat : icône blanche discrète en haut de la photo (appareil photo ou
 * galerie). « Plus d'options » (recettes ajoutées par le foyer) : modifier ou supprimer. Favoris et partage dans la bande
 * verte.
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
  const [photoMenu, setPhotoMenu] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const [draft, setDraft] = useState<Revision | null>(null);
  const [cookedOn, setCookedOn] = useState<string | null>(null);
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
      // L'avis du jour seulement (l'avis se donne le jour où la recette est faite).
      const ratedToday = rating?.stars && toIsoDate(new Date(rating.ratedAt)) === toIsoDate(new Date());
      setStars(ratedToday ? rating.stars : null);
      setComment(ratedToday ? rating.comment ?? "" : "");
      setSaved(Boolean(ratedToday));
      setFav(fav);
      AsyncStorage.getItem(cookedKey(r.id)).then(setCookedOn, () => undefined);
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
      "Préparation :", ...recipe.steps.map((s, n) => `${n + 1}. ${s}`), "", "Recette MenuBily",
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
  const today = toIsoDate(new Date());
  const cookedToday = cookedOn === today;
  const own = recipe.householdId === household.id;

  const finish = () => {
    setCurrent(recipe.steps.length);
    setCookedOn(today);
    AsyncStorage.setItem(cookedKey(recipe.id), today).catch(() => undefined);
  };
  // Avis enregistré, puis envoyé à Mistral : il propose une version améliorée si la recette est améliorable.
  const saveRating = () => act("rate", async () => {
    if (!stars) return;
    await rateRecipe(supabase, household.id, recipe, stars, comment, previous);
    setPrevious(await getLatestRating(supabase, household.id, recipe.id));
    setSaved(true);
    if (stars === 5 && !comment.trim()) {
      setInfo("Merci pour votre avis.");
      return;
    }
    const result = await adaptRecipeDraft(household.id, toPayload(recipe), `Note : ${stars}/5.${comment.trim() ? ` ${comment.trim()}` : ""}`);
    if (!result.improvable) {
      setInfo("Merci pour votre avis : Mistral ne voit rien à améliorer dans cette recette.");
      return;
    }
    setDraft({ kind: "mistral", recipe: result.recipe, issues: result.issues, change_note: result.change_note });
  });
  const editRecipe = () => {
    setMore(false);
    setDraft({ kind: "edit", recipe: toPayload(recipe) as unknown as DraftRecipe, issues: [], change_note: "" });
  };
  const deleteRecipe = () => confirm(`Supprimer « ${recipe.name} » ?`, "Supprimer", () => act("delete", async () => {
    await archiveRecipe(supabase, recipe.id);
    router.back();
  }));
  const saveRevision = () => act("save", async () => {
    if (!draft) return;
    const input = draftToInput(cleanDraft(draft.recipe), draft.kind === "edit" ? recipe.source : "mistral");
    const issues = validateRecipe(input);
    if (issues.length) throw new Error(`À corriger : ${issues.map((i) => i.message).join(" ; ")}`);
    if (draft.kind === "edit") {
      await addRecipeVersion(supabase, recipe.id, input, "Modifiée à la main");
      setDraft(null);
      await load();
      return;
    }
    const newId = await adaptRecipe(supabase, household.id, recipe, input, draft.change_note || "Améliorée par Mistral après un avis");
    setDraft(null);
    setCurrent(0);
    if (newId && recipe.householdId !== household.id) router.replace(`/recette/${newId}`);
    else await load();
  });

  return (
    <Screen title="Recette" padded={false} footer={<TimersBar />} scrollRef={scroll} headerRight={() => (
      <View style={{ flexDirection: "row" }}>
        <HeaderIcon name="share" label="Partager" onPress={share} size={23} />
        <HeaderIcon name={favorite ? "heart" : "heartOutline"} label={favorite ? "Retirer des favoris" : "Ajouter aux favoris"} onPress={toggleFavorite} />
      </View>
    )}>
      <View>
        <Illustration picture={image} height={210} rounded={0} />
        {/* Fondu du bas : la photo se fond dans le fond de la fiche, sans démarcation nette. */}
        <LinearGradient colors={["rgba(254,243,227,0)", "rgba(254,243,227,0.7)", c.background]} locations={[0, 0.6, 1]}
          style={styles.photoFade} pointerEvents="none" />
        <Pressable onPress={() => setPhotoMenu((m) => !m)} disabled={busy === "photo"} hitSlop={8} accessibilityRole="button"
          accessibilityLabel="Ajouter ou changer la photo du plat" style={({ pressed }) => [styles.photoButton, { opacity: pressed ? 0.7 : 1 }]}>
          {busy === "photo" ? <ActivityIndicator color="#FFFFFF" /> : <Icon name="camera" size={21} color="#FFFFFF" />}
        </Pressable>
        {photoMenu && (
          <View style={[styles.photoMenu, { backgroundColor: c.card, borderColor: c.border }, CARD_SHADOW]}>
            {([["camera", "Prendre une photo", true], ["gallery", "Choisir dans la galerie", false]] as const).map(([icon, label, camera]) => (
              <Pressable key={icon} accessibilityRole="button" onPress={() => {
                setPhotoMenu(false);
                changePhoto(camera);
              }} style={({ pressed }) => [styles.photoMenuItem, { opacity: pressed ? 0.7 : 1 }]}>
                <Icon name={icon} size={20} color={c.text} />
                <Text style={{ color: c.text, fontSize: 15.5, fontWeight: "500" }}>{label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      <View style={styles.head}>
        <H1>{recipe.name}</H1>
        {recipe.description ? <Body style={{ color: c.muted }}>{recipe.description}</Body> : null}
        {/* Note de la recette, modifiable à tout moment (les observations, elles, se donnent en fin de recette faite). */}
        <View style={styles.note}>
          <Text style={{ color: c.muted, fontSize: 14.2 }}>{previous?.stars ? "Votre note" : "Noter"}</Text>
          <StarRating value={previous?.stars ?? null} size={26} onChange={(n) => {
            if (n === previous?.stars) return;
            act("note", async () => {
              await rateRecipe(supabase, household.id, recipe, n, previous?.comment ?? null, previous);
              setPrevious(await getLatestRating(supabase, household.id, recipe.id));
            });
          }} />
          {busy === "note" ? <ActivityIndicator color={c.primary} /> : null}
        </View>
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
        {proteinLabel(recipe.mainProtein, recipe.name) ? <Pill icon="cutlery">{proteinLabel(recipe.mainProtein, recipe.name)}</Pill> : null}
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
                {ingredientSource(i.slug)
                  ? <Image source={ingredientSource(i.slug)!} cachePolicy="memory-disk" style={styles.thumb} contentFit="cover" transition={0}
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
                        : <Button title={cooking.length ? "Minuteurs en cours" : "C'est prêt"} onPress={finish} disabled={cooking.length > 0}
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
              <Button title="Reprendre depuis le début" kind="secondary" onPress={() => setCurrent(0)} />
            </Card>
          )}
        </View>
      )}

      {cookedToday && (
        <View style={[styles.section, { gap: 9 }]}>
          <H2>Votre avis sur le plat d'aujourd'hui</H2>
          <StarRating value={stars} onChange={(n) => {
            setStars(n);
            setSaved(false);
          }} />
          <Muted>{stars ? starsLabel(stars) : "Touchez les étoiles pour noter le plat."}</Muted>
          <Field multiline value={comment} maxLength={1000} placeholder="Une remarque pour améliorer la recette ? (un peu fade, trop de crème…)"
            onChangeText={(t) => {
              setComment(t);
              setSaved(false);
            }} />
          <Button title={saved ? "Avis enregistré" : "Enregistrer mon avis"} onPress={saveRating} busy={busy === "rate"} disabled={!stars || saved} />
          {busy === "rate" ? <Muted>Mistral relit la recette avec votre avis…</Muted> : null}
        </View>
      )}

      <View style={[styles.section, { gap: 9 }]}>
        {info ? <Body style={{ color: c.greenInk }}>{info}</Body> : null}
        <ErrorText>{error}</ErrorText>
      </View>

      {own && (
        <View style={styles.section}>
          <Pressable onPress={() => {
            setMore((m) => !m);
            // Le contenu déplié est en bas de la fiche : il est amené à l'écran.
            if (!more) setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
          }} accessibilityRole="button" accessibilityState={{ expanded: more }}
            style={({ pressed }) => [styles.more, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.8 : 1 }]}>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>Plus d’options</Text>
            <Icon name={more ? "chevronUp" : "chevronDown"} size={18} color={c.text} />
          </Pressable>
          {more && (
            <Card>
              <H2>Fiche recette</H2>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button title="Modifier" kind="secondary" onPress={editRecipe} style={{ flex: 1 }} />
                <Button title="Supprimer" kind="danger" icon="trash" onPress={deleteRecipe} busy={busy === "delete"} style={{ flex: 1 }} />
              </View>
            </Card>
          )}
        </View>
      )}

      {draft && (
        <View style={[styles.section, { gap: 12 }]}>
          <Card>
            <H2>{draft.kind === "edit" ? "Modifier la recette" : "Version améliorée par Mistral"}</H2>
            {draft.change_note ? <Body>{draft.change_note}</Body> : null}
            <Muted>
              {draft.kind === "edit"
                ? "Corrigez le nom, les temps, les ingrédients ou les étapes. L'ancienne version reste dans l'historique."
                : "D'après votre avis. Vous avez le dernier mot : corrigez ce que vous voulez avant de garder cette version ; l'ancienne reste dans l'historique."}
            </Muted>
            {draft.issues.length ? <Muted>Remarques de Mistral : {draft.issues.join(" ; ")}</Muted> : null}
          </Card>
          <RecipeEditor value={draft.recipe} onChange={(r) => setDraft({ ...draft, recipe: r })} />
          <Button title={draft.kind === "edit" ? "Enregistrer les modifications" : "Garder ma version"} onPress={saveRevision} busy={busy === "save"} />
          <Button title={draft.kind === "edit" ? "Annuler" : "Garder la recette actuelle"} kind="secondary" onPress={() => setDraft(null)} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 19, paddingTop: 2, gap: 6 },
  note: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  photoFade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 64 },
  // Icône discrète : blanche sur un rond sombre translucide, lisible sur une photo claire comme foncée.
  photoButton: {
    position: "absolute", top: 10, right: 10, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,24,12,0.32)",
  },
  photoMenu: { position: "absolute", top: 56, right: 10, borderRadius: 12, borderWidth: 1, paddingVertical: 4 },
  photoMenuItem: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 14 },
  pills: { flexDirection: "row", gap: 7.5, marginHorizontal: 17.5, marginTop: 10 },
  stepper: { flex: 1, minWidth: 128, height: 38, borderRadius: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepperButton: { width: 40, height: 48, alignItems: "center", justifyContent: "center" },
  tabs: { flexDirection: "row", gap: 12, marginHorizontal: 18.5, marginTop: 8 },
  tab: { flex: 1, height: 42, alignItems: "center", justifyContent: "center" },
  section: { marginHorizontal: 17, marginTop: 12, gap: 10 },
  ingredient: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingVertical: 6 },
  // Vignette d'ingrédient sur fond blanc, bordée pour se détacher du fond crème de la fiche.
  thumb: { width: 42, height: 42, borderRadius: 10, overflow: "hidden", backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E9DCC6" },
  step: { flexDirection: "row", gap: 12, borderRadius: 13, borderWidth: 1.5, borderColor: "transparent", padding: 8 },
  badge: { width: 32, height: 32, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  timer: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, alignSelf: "flex-start" },
  durations: { flexDirection: "row", gap: 5.5, marginLeft: 17.5, marginRight: 13, marginTop: 10 },
  duration: { flex: 1, height: 56, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  more: { height: 48, borderRadius: 24, borderWidth: 1.5, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
});
