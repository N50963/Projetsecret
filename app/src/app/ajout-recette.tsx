import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Icon } from "../components/icons";
import { cleanDraft, RecipeEditor } from "../components/RecipeEditor";
import { Button, Card, Chip, ErrorText, H2, Muted, Row, Screen } from "../components/ui";
import { uploadRecipePhoto } from "../lib/images";
import { draftToInput, illustrateRecipe, importRecipe, type Draft } from "../lib/mistral";
import { pickDishPhoto, type PickedPhoto } from "../lib/photo";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import { createRecipe, validateRecipe } from "../modules/recipes";

/** Photo du plat, facultative : appareil photo ou galerie. Sans photo, Mistral crée une illustration. */
function PhotoPicker({ photo, onChange, onError }: { photo: PickedPhoto | null; onChange: (p: PickedPhoto | null) => void; onError: (m: string) => void }) {
  const c = useColors();
  const pick = (camera: boolean) => pickDishPhoto(camera).then((p) => p && onChange(p), (e) => onError(e instanceof Error ? e.message : String(e)));
  return (
    <Card>
      <H2>Photo du plat</H2>
      {photo ? (
        <View>
          <Image source={{ uri: photo.uri }} style={styles.photo} contentFit="cover" />
          <Pressable onPress={() => onChange(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retirer la photo"
            style={[styles.remove, { backgroundColor: c.card }]}>
            <Icon name="close" size={20} color={c.text} />
          </Pressable>
        </View>
      ) : (
        <Muted>Facultatif : sans photo, Mistral crée une illustration du plat. Vous pourrez la remplacer plus tard.</Muted>
      )}
      <Row>
        <Button title={photo ? "Reprendre" : "Prendre une photo"} kind="secondary" onPress={() => pick(true)} style={{ flex: 1 }} />
        <Button title="Galerie" kind="secondary" onPress={() => pick(false)} style={{ flex: 1 }} />
      </Row>
    </Card>
  );
}

/**
 * Ajouter une recette : texte collé (site, livre, message) ou saisie libre, mis en forme par Mistral (durées et minuteurs
 * compris), puis relu et corrigé par l'utilisateur, qui a le dernier mot ; photo du plat facultative.
 */
export default function AjoutRecette() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const [mode, setMode] = useState<"coller" | "saisir">("coller");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [time, setTime] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [steps, setSteps] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const input = [styles.input, { borderColor: c.field, color: c.text, backgroundColor: c.card }];

  const source = mode === "coller" ? text
    : `${name}\nTemps : ${time}\nIngrédients pour ${household.defaultServings} personnes :\n${ingredients}\nÉtapes :\n${steps}`;

  const format = async () => {
    setBusy("format");
    setError("");
    try {
      setDraft(await importRecipe(household.id, source, household.defaultServings));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    const recipe = draftToInput(cleanDraft(draft.recipe), mode === "coller" ? "import_text" : "manual");
    const issues = validateRecipe(recipe);
    if (issues.length) {
      setError(`À corriger : ${issues.map((i) => i.message).join(" ; ")}`);
      return;
    }
    setBusy("save");
    setError("");
    try {
      const id = await createRecipe(supabase, household.id, recipe);
      if (photo) {
        try {
          await uploadRecipePhoto(household.id, id, photo.uri, photo.width);
        } catch {
          // La recette est enregistrée ; la photo pourra être remise depuis sa fiche.
          illustrateRecipe(household.id, id).catch(() => undefined);
        }
      } else {
        illustrateRecipe(household.id, id).catch(() => undefined);
      }
      router.replace(`/recette/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (draft) {
    return (
      <Screen title="Vérifier la recette">
        <Muted>
          Mistral a mis la recette en forme et précisé les durées de cuisson. Vous avez le dernier mot : corrigez ce que vous voulez,
          c'est votre version qui sera enregistrée.
        </Muted>
        {draft.issues.length ? <Muted>Remarques de Mistral : {draft.issues.join(" ; ")}</Muted> : null}
        <RecipeEditor value={draft.recipe} onChange={(r) => setDraft({ ...draft, recipe: r })} />
        <PhotoPicker photo={photo} onChange={setPhoto} onError={setError} />
        <ErrorText>{error}</ErrorText>
        <Button title="Enregistrer la recette" onPress={save} busy={busy === "save"} />
        <Button title="Revenir au texte" kind="secondary" onPress={() => setDraft(null)} />
      </Screen>
    );
  }

  return (
    <Screen title="Ajouter une recette">
      <Row>
        <Chip label="Coller un texte" active={mode === "coller"} onPress={() => setMode("coller")} />
        <Chip label="Saisir" active={mode === "saisir"} onPress={() => setMode("saisir")} />
      </Row>
      {mode === "coller" ? (
        <>
          <Muted>Collez la recette (site, message, livre) : Mistral la met en forme et relie les ingrédients à vos achats.</Muted>
          <TextInput multiline value={text} onChangeText={setText} placeholder="Coller ici" placeholderTextColor={c.muted}
            style={[input, { minHeight: 220 }]} />
        </>
      ) : (
        <View style={{ gap: 10 }}>
          <TextInput value={name} onChangeText={setName} placeholder="Nom du plat" placeholderTextColor={c.muted} style={input} />
          <TextInput value={time} onChangeText={setTime} placeholder="Temps (ex. 15 min de préparation, 30 min de cuisson)" placeholderTextColor={c.muted} style={input} />
          <TextInput multiline value={ingredients} onChangeText={setIngredients} placeholder={"Ingrédients, un par ligne\n600 g de poulet\n2 courgettes"}
            placeholderTextColor={c.muted} style={[input, { minHeight: 120 }]} />
          <TextInput multiline value={steps} onChangeText={setSteps} placeholder={"Étapes, une par ligne, avec les durées\nCuire le riz 11 min"}
            placeholderTextColor={c.muted} style={[input, { minHeight: 120 }]} />
        </View>
      )}
      <PhotoPicker photo={photo} onChange={setPhoto} onError={setError} />
      <ErrorText>{error}</ErrorText>
      <Button title="Mettre en forme" onPress={format} busy={busy === "format"} disabled={source.trim().length < 40} />
      <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>
        Vous relirez et corrigerez la recette avant de l'enregistrer ; chaque étape avec une durée aura son minuteur.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderRadius: 13, borderWidth: 1.5, padding: 12, fontSize: 16, textAlignVertical: "top" },
  photo: { width: "100%", height: 200, borderRadius: 12 },
  remove: { position: "absolute", top: 8, right: 8, width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
