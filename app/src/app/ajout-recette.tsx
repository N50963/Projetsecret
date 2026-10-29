import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { Body, Button, Card, Chip, ErrorText, H2, Muted, Row, Screen } from "../components/ui";
import { minutes, PROTEIN_LABEL, quantity } from "../lib/format";
import { draftToInput, illustrateRecipe, importRecipe, type Draft } from "../lib/mistral";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import { createRecipe, validateRecipe } from "../modules/recipes";

/** Ajouter une recette : texte collé (site, livre, message) ou saisie libre, mis en forme par Mistral puis vérifié. */
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const input = [styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.card }];

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
    const recipe = draftToInput(draft.recipe, mode === "coller" ? "import_text" : "manual");
    const issues = validateRecipe(recipe);
    if (issues.length) {
      setError(`À corriger : ${issues.map((i) => i.message).join(" ; ")}`);
      return;
    }
    setBusy("save");
    setError("");
    try {
      const id = await createRecipe(supabase, household.id, recipe);
      illustrateRecipe(household.id, id).catch(() => undefined);
      router.replace(`/recette/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (draft) {
    const r = draft.recipe;
    return (
      <Screen title="Vérifier la recette">
        <H2>{r.name}</H2>
        <Muted>⏱ {minutes(r.prep_min + r.cook_min + r.rest_min)} · {PROTEIN_LABEL[r.main_protein]} · {r.servings} pers.</Muted>
        <Card>
          <H2>Ingrédients</H2>
          {r.ingredients.map((i, n) => (
            <Row key={n} style={{ justifyContent: "space-between" }}>
              <Body style={{ flex: 1 }}>{i.slug ? "" : "⚠️ "}{i.label}{i.optional ? " (facultatif)" : ""}</Body>
              <Muted>{quantity(i.quantity, i.unit)}</Muted>
            </Row>
          ))}
          <Muted>⚠️ : ingrédient non reconnu, il ne sera pas comparé à vos achats.</Muted>
        </Card>
        <Card>
          <H2>Étapes</H2>
          {r.steps.map((s, n) => <Body key={n}>{n + 1}. {s}</Body>)}
        </Card>
        {draft.issues.length ? <Muted>À vérifier : {draft.issues.join(" ; ")}</Muted> : null}
        <ErrorText>{error}</ErrorText>
        <Button title="Enregistrer la recette" onPress={save} busy={busy === "save"} />
        <Button title="Modifier le texte" kind="secondary" onPress={() => setDraft(null)} />
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
          <TextInput multiline value={steps} onChangeText={setSteps} placeholder={"Étapes, une par ligne"} placeholderTextColor={c.muted}
            style={[input, { minHeight: 120 }]} />
        </View>
      )}
      <ErrorText>{error}</ErrorText>
      <Button title="Mettre en forme" onPress={format} busy={busy === "format"} disabled={source.trim().length < 40} />
      <Muted>La recette est vérifiée avant d'être enregistrée ; une illustration est ensuite créée si votre offre Mistral le permet.</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, fontSize: 16, textAlignVertical: "top" },
});
