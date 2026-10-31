/**
 * Éditeur de recette : le brouillon proposé par Mistral (import, adaptation) est entièrement modifiable avant d'être
 * enregistré ; c'est la version de l'utilisateur qui compte. Chaque étape montre le minuteur qu'elle aura.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { DraftRecipe } from "../lib/mistral";
import { plain, stepTimer } from "../lib/steps";
import { useColors } from "../lib/theme";
import { RECIPE_UNITS, type RecipeUnit } from "../modules/recipes";
import { Icon } from "./icons";
import { Body, Button, Card, H2, Muted, Row } from "./ui";

type Ingredient = DraftRecipe["ingredients"][number];

const UNIT_LABEL: Record<RecipeUnit, string> = { g: "g", ml: "ml", piece: "pièce", cs: "c. à s.", cc: "c. à c.", pincee: "pincée" };
const BASE_UNITS = ["g", "ml", "piece"];

/** Champ numérique qui garde ce qui est tapé (« 1, » en cours de saisie) et ne transmet que des nombres. */
function NumberField({ value, onChange, decimals, placeholder, style }: {
  value: number | null; onChange: (n: number | null) => void; decimals?: boolean; placeholder?: string; style?: object;
}) {
  const c = useColors();
  const [text, setText] = useState(value === null ? "" : String(value).replace(".", ","));
  useEffect(() => {
    const parsed = Number(text.replace(",", "."));
    if (value === null ? text !== "" : parsed !== value) setText(value === null ? "" : String(value).replace(".", ","));
    // Seule une valeur venue de l'extérieur (autre brouillon) remplace la saisie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <TextInput value={text} placeholder={placeholder} placeholderTextColor={c.muted} keyboardType={decimals ? "decimal-pad" : "number-pad"}
      onChangeText={(t) => {
        const clean = t.replace(decimals ? /[^0-9.,]/g : /[^0-9]/g, "");
        setText(clean);
        const n = Number(clean.replace(",", "."));
        onChange(clean === "" || !Number.isFinite(n) ? null : n);
      }}
      style={[styles.input, { borderColor: c.field, color: c.text, backgroundColor: c.card, textAlign: "center" }, style]} />
  );
}

export function RecipeEditor({ value, onChange }: { value: DraftRecipe; onChange: (recipe: DraftRecipe) => void }) {
  const c = useColors();
  const input = [styles.input, { borderColor: c.field, color: c.text, backgroundColor: c.card }];
  const set = (patch: Partial<DraftRecipe>) => onChange({ ...value, ...patch });
  const setIngredient = (n: number, patch: Partial<Ingredient>) =>
    set({ ingredients: value.ingredients.map((i, k) => (k === n ? { ...i, ...patch } : i)) });
  const setStep = (n: number, text: string) => set({ steps: value.steps.map((s, k) => (k === n ? text : s)) });

  /** Quantité de référence (comparaison avec les achats, en g, ml ou pièces) qui suit la quantité affichée. */
  const baseFor = (i: Ingredient, unit: RecipeUnit | null, q: number | null) => {
    if (q === null || unit === null) return { base_quantity: null, base_unit: null };
    if (unit === i.unit && i.base_quantity !== null && i.quantity) return { base_quantity: i.base_quantity * (q / i.quantity), base_unit: i.base_unit };
    return BASE_UNITS.includes(unit) ? { base_quantity: q, base_unit: unit } : { base_quantity: null, base_unit: null };
  };
  const changeQuantity = (i: Ingredient, n: number, q: number | null) => {
    const unit: RecipeUnit | null = i.unit ?? (q !== null ? "piece" : null);
    setIngredient(n, { quantity: q, unit, ...baseFor(i, unit, q) });
  };
  const cycleUnit = (i: Ingredient, n: number) => {
    const units: Array<RecipeUnit | null> = [...RECIPE_UNITS, null];
    const unit = units[(units.indexOf(i.unit) + 1) % units.length] ?? null;
    const quantity = unit === null ? null : i.quantity;
    setIngredient(n, { unit, quantity, ...baseFor(i, unit, quantity) });
  };

  return (
    <View style={{ gap: 14 }}>
      <Card>
        <H2>La recette</H2>
        <TextInput value={value.name} onChangeText={(name) => set({ name })} placeholder="Nom du plat" placeholderTextColor={c.muted} style={input} />
        <TextInput value={value.description ?? ""} onChangeText={(d) => set({ description: d || null })} multiline placeholder="Description (facultatif)"
          placeholderTextColor={c.muted} style={[input, { minHeight: 60 }]} />
        <Row>
          <Muted style={{ width: 96 }}>Préparation</Muted>
          <NumberField value={value.prep_min} onChange={(n) => set({ prep_min: Math.round(n ?? 0) })} style={{ width: 70 }} />
          <Muted>min</Muted>
        </Row>
        <Row>
          <Muted style={{ width: 96 }}>Cuisson</Muted>
          <NumberField value={value.cook_min} onChange={(n) => set({ cook_min: Math.round(n ?? 0) })} style={{ width: 70 }} />
          <Muted>min</Muted>
        </Row>
      </Card>

      <Card>
        <H2>Ingrédients ({value.servings} pers.)</H2>
        <Muted>Touchez l'unité pour la changer.</Muted>
        {value.ingredients.map((i, n) => (
          <View key={n} style={{ gap: 4 }}>
            <View style={styles.ingredient}>
              <TextInput value={i.label} onChangeText={(label) => setIngredient(n, { label })} placeholder="Ingrédient" placeholderTextColor={c.muted}
                style={[input, { flex: 1 }]} />
              <NumberField value={i.quantity} decimals onChange={(q) => changeQuantity(i, n, q)} placeholder="qté" style={{ width: 62 }} />
              <Pressable onPress={() => cycleUnit(i, n)} accessibilityRole="button" accessibilityLabel={`Unité : ${i.unit ? UNIT_LABEL[i.unit as RecipeUnit] : "aucune"}`}
                style={[styles.unit, { backgroundColor: c.chip }]}>
                <Text style={{ color: c.text, fontSize: 14 }}>{i.unit ? UNIT_LABEL[i.unit as RecipeUnit] : "—"}</Text>
              </Pressable>
              <Pressable onPress={() => set({ ingredients: value.ingredients.filter((_, k) => k !== n) })} hitSlop={8}
                accessibilityRole="button" accessibilityLabel={`Retirer ${i.label}`}>
                <Icon name="close" size={22} color={c.muted} />
              </Pressable>
            </View>
            {!i.slug && <Muted style={{ fontSize: 13 }}>Pas relié à vos achats : il ne sera pas comparé aux tickets Lidl.</Muted>}
          </View>
        ))}
        <Button title="Ajouter un ingrédient" kind="secondary" onPress={() => set({
          ingredients: [...value.ingredients, { slug: null, label: "", quantity: null, unit: null, base_quantity: null, base_unit: null, optional: false, scale: "linear" }],
        })} />
      </Card>

      <Card>
        <H2>Étapes</H2>
        <Muted>Une durée par étape (« Cuire le riz 11 min ») devient un minuteur.</Muted>
        {value.steps.map((s, n) => {
          const timer = stepTimer(s, value.steps.slice(0, n));
          return (
            <View key={n} style={{ gap: 6 }}>
              <View style={styles.ingredient}>
                <View style={[styles.badge, { backgroundColor: c.chip }]}><Text style={{ fontWeight: "700", color: c.text }}>{n + 1}</Text></View>
                <TextInput value={s} onChangeText={(t) => setStep(n, t)} multiline placeholder="Décrivez l'étape" placeholderTextColor={c.muted}
                  style={[input, { flex: 1, minHeight: 70 }]} />
                <Pressable onPress={() => set({ steps: value.steps.filter((_, k) => k !== n) })} hitSlop={8}
                  accessibilityRole="button" accessibilityLabel={`Retirer l'étape ${n + 1}`}>
                  <Icon name="close" size={22} color={c.muted} />
                </Pressable>
              </View>
              <View style={[styles.timerLine, { marginLeft: 40 }]}>
                <Icon name={timer ? "timer" : "minus"} size={16} color={timer ? c.primary : c.muted} />
                {timer
                  ? <Body style={{ color: c.primary, fontSize: 14 }}>Minuteur : {timer.subject} · {timer.label}</Body>
                  : <Muted style={{ fontSize: 13 }}>Sans minuteur</Muted>}
              </View>
            </View>
          );
        })}
        <Button title="Ajouter une étape" kind="secondary" onPress={() => set({ steps: [...value.steps, ""] })} />
      </Card>
    </View>
  );
}

/** Le brouillon modifié par l'utilisateur, nettoyé avant validation (lignes vides retirées). */
export function cleanDraft(d: DraftRecipe): DraftRecipe {
  return {
    ...d,
    name: d.name.trim(),
    description: d.description?.trim() || null,
    steps: d.steps.map(plain).filter(Boolean),
    ingredients: d.ingredients.filter((i) => i.label.trim() || i.slug).map((i) => ({ ...i, label: i.label.trim() })),
  };
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1.5, borderRadius: 13, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, textAlignVertical: "top" },
  ingredient: { flexDirection: "row", alignItems: "center", gap: 8 },
  unit: { minWidth: 58, height: 48, borderRadius: 13, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badge: { width: 32, height: 32, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  timerLine: { flexDirection: "row", alignItems: "center", gap: 6 },
});
