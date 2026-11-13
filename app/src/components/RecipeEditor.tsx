/**
 * Éditeur de recette : le brouillon proposé par Mistral (import, adaptation) ou la recette à corriger est entièrement
 * modifiable avant d'être enregistré ; c'est la version de l'utilisateur qui compte. Chaque étape montre le minuteur
 * qu'elle aura ; les étapes et les ingrédients se déplacent, s'insèrent où l'on veut et se retirent. Chaque ingrédient
 * se relie au référentiel (recherche, suggestions, liaison d'office quand le libellé est clair) : la fiche affiche alors
 * sa photo et le compare aux achats.
 */

import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ingredientSource } from "../lib/images";
import { autoLink, baseQuantity, parseQuantity, searchIngredients, suggestIngredients } from "../lib/ingredientMatch";
import type { DraftRecipe } from "../lib/mistral";
import { ingredientOptions, type IngredientOption } from "../lib/products";
import { plain, stepTimer } from "../lib/steps";
import { useColors } from "../lib/theme";
import { RECIPE_UNITS, type RecipeUnit } from "../modules/recipes";
import { Icon, type IconName } from "./icons";
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

/** Petit bouton d'outil (monter, descendre, insérer, retirer) sous une étape ou un ingrédient. */
function Tool({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={4} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [styles.tool, { backgroundColor: c.chip, opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}>
      <Icon name={icon} size={16} color={c.text} />
    </Pressable>
  );
}

const toRecipeUnit = (u: string | null | undefined): RecipeUnit | null => (u === "g" || u === "ml" || u === "piece" ? u : null);

export function RecipeEditor({ value, onChange }: { value: DraftRecipe; onChange: (recipe: DraftRecipe) => void }) {
  const c = useColors();
  const input = [styles.input, { borderColor: c.field, color: c.text, backgroundColor: c.card }];
  const set = (patch: Partial<DraftRecipe>) => onChange({ ...value, ...patch });
  const setIngredient = (n: number, patch: Partial<Ingredient>) =>
    set({ ingredients: value.ingredients.map((i, k) => (k === n ? { ...i, ...patch } : i)) });
  const setStep = (n: number, text: string) => set({ steps: value.steps.map((s, k) => (k === n ? text : s)) });

  // Référentiel des ingrédients : photo, comparaison avec les achats, panier « à acheter » sur la fiche.
  const [options, setOptions] = useState<IngredientOption[]>([]);
  useEffect(() => {
    ingredientOptions().then(setOptions, () => undefined);
  }, []);
  const bySlug = useMemo(() => new Map(options.map((o) => [o.slug, o])), [options]);

  // Clés stables des lignes : insérer, déplacer ou retirer une étape ne mélange pas les champs en cours de saisie.
  const counter = useRef(0);
  const newKey = () => `k${counter.current++}`;
  const stepKeys = useRef<string[]>([]);
  if (stepKeys.current.length !== value.steps.length) stepKeys.current = value.steps.map(() => newKey());
  const ingKeys = useRef<string[]>([]);
  if (ingKeys.current.length !== value.ingredients.length) ingKeys.current = value.ingredients.map(() => newKey());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** Ingrédient dont la recherche dans le référentiel est ouverte, et le texte cherché. */
  const [searching, setSearching] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  /** Quantité de référence (comparaison avec les achats, en g, ml ou pièces) qui suit la quantité affichée. */
  const baseFor = (i: Ingredient, unit: RecipeUnit | null, q: number | null) => {
    const ref = i.slug ? bySlug.get(i.slug) : undefined;
    if (ref) return baseQuantity(unit, q, ref.default_unit);
    if (q === null || unit === null) return { base_quantity: null, base_unit: null };
    if (unit === i.unit && i.base_quantity !== null && i.quantity) return { base_quantity: i.base_quantity * (q / i.quantity), base_unit: i.base_unit };
    return BASE_UNITS.includes(unit) ? { base_quantity: q, base_unit: unit } : { base_quantity: null, base_unit: null };
  };
  const changeQuantity = (i: Ingredient, n: number, q: number | null) => {
    const unit: RecipeUnit | null = i.unit ?? (q !== null ? toRecipeUnit(i.slug ? bySlug.get(i.slug)?.default_unit : null) ?? "piece" : null);
    setIngredient(n, { quantity: q, unit, ...baseFor(i, unit, q) });
  };
  const cycleUnit = (i: Ingredient, n: number) => {
    const units: Array<RecipeUnit | null> = [...RECIPE_UNITS, null];
    const unit = units[(units.indexOf(i.unit) + 1) % units.length] ?? null;
    const quantity = unit === null ? null : i.quantity;
    setIngredient(n, { unit, quantity, ...baseFor(i, unit, quantity) });
  };

  /** Relie un ingrédient au référentiel (ou retire le lien) : la fiche affichera sa photo et le comparera aux achats. */
  const link = (n: number, o: IngredientOption | null, list = value.ingredients) => {
    const i = list[n]!;
    if (!o) return { ...i, slug: null, base_quantity: null, base_unit: null };
    const unit: RecipeUnit | null = i.unit ?? (i.quantity !== null ? toRecipeUnit(o.default_unit) : null);
    return { ...i, slug: o.slug, label: i.label.trim() || o.name.toLowerCase(), unit, ...baseQuantity(unit, i.quantity, o.default_unit) };
  };
  const choose = (n: number, o: IngredientOption | null) => {
    set({ ingredients: value.ingredients.map((x, k) => (k === n ? link(n, o) : x)) });
    setSearching(null);
    setQuery("");
  };

  // Ingrédients non reliés (brouillon de la réflexion approfondie, recette ancienne) : reliés d'office quand le libellé
  // désigne sans ambiguïté un ingrédient du référentiel ; sinon des suggestions s'affichent sous la ligne.
  const linkedOnce = useRef(false);
  useEffect(() => {
    if (!options.length || linkedOnce.current) return;
    linkedOnce.current = true;
    let changed = false;
    // Un ingrédient du référentiel ne figure qu'une fois par recette.
    const used = new Set(value.ingredients.map((i) => i.slug).filter(Boolean));
    const next = value.ingredients.map((i, n) => {
      if (i.slug || !i.label.trim()) return i;
      const o = autoLink(i.label, options.filter((x) => !used.has(x.slug)));
      if (!o) return i;
      used.add(o.slug);
      changed = true;
      return link(n, o);
    });
    if (changed) set({ ingredients: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);
  /**
   * Fin de saisie d'un libellé : une quantité tapée en tête (« 200 g de lardons ») passe dans les cases quantité et
   * unité, puis l'ingrédient est relié tout seul s'il désigne clairement un ingrédient du référentiel.
   */
  const autoLinkRow = (n: number) => {
    let i = value.ingredients[n];
    if (!i) return;
    let patch: Partial<Ingredient> = {};
    const typed = i.quantity === null ? parseQuantity(i.label) : null;
    if (typed) {
      patch = { label: typed.label, quantity: typed.quantity, unit: typed.unit };
      i = { ...i, ...patch };
    }
    const o = !i.slug && options.length ? autoLink(i.label, freeFor(n)) : null;
    if (o) {
      patch = link(n, o, value.ingredients.map((x, k) => (k === n ? i! : x)));
      if (searching === ingKeys.current[n]) setSearching(null);
    } else if (typed) patch = { ...patch, ...baseFor(i, i.unit, i.quantity) };
    if (Object.keys(patch).length) setIngredient(n, patch);
  };

  const move = <T,>(list: T[], from: number, to: number): T[] => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
  };
  const moveIngredient = (n: number, d: -1 | 1) => {
    ingKeys.current = move(ingKeys.current, n, n + d);
    set({ ingredients: move(value.ingredients, n, n + d) });
  };
  const removeIngredient = (n: number) => {
    ingKeys.current = ingKeys.current.filter((_, k) => k !== n);
    set({ ingredients: value.ingredients.filter((_, k) => k !== n) });
  };
  const addIngredient = () => {
    const key = newKey();
    ingKeys.current = [...ingKeys.current, key];
    set({ ingredients: [...value.ingredients, { slug: null, label: "", quantity: null, unit: null, base_quantity: null, base_unit: null, optional: false, scale: "linear" }] });
    // La recherche dans le référentiel s'ouvre aussitôt : on choisit l'ingrédient, puis on règle la quantité.
    setSearching(key);
    setQuery("");
  };
  const insertStep = (at: number) => {
    const key = newKey();
    stepKeys.current = [...stepKeys.current.slice(0, at), key, ...stepKeys.current.slice(at)];
    setFocusKey(key);
    set({ steps: [...value.steps.slice(0, at), "", ...value.steps.slice(at)] });
  };
  const moveStep = (n: number, d: -1 | 1) => {
    stepKeys.current = move(stepKeys.current, n, n + d);
    set({ steps: move(value.steps, n, n + d) });
  };
  const removeStep = (n: number) => {
    stepKeys.current = stepKeys.current.filter((_, k) => k !== n);
    set({ steps: value.steps.filter((_, k) => k !== n) });
  };

  const unlinked = value.ingredients.filter((i) => !i.slug && i.label.trim()).length;
  /** Ingrédients du référentiel pas encore utilisés par une autre ligne (un ingrédient ne figure qu'une fois). */
  function freeFor(n: number) {
    const used = new Set(value.ingredients.filter((_, k) => k !== n).map((i) => i.slug).filter(Boolean));
    return used.size ? options.filter((o) => !used.has(o.slug)) : options;
  }

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
        <Muted>Chaque ingrédient relié à vos achats a sa photo sur la fiche, le panier « à acheter » et compte dans les menus proposés. Touchez l'unité pour la changer.</Muted>
        {unlinked ? (
          <Text style={{ color: c.orangeInk, fontSize: 14.5 }}>
            {unlinked} ingrédient{unlinked > 1 ? "s" : ""} pas encore relié{unlinked > 1 ? "s" : ""} à vos achats : choisissez sous la ligne.
          </Text>
        ) : null}
        {value.ingredients.map((i, n) => {
          const key = ingKeys.current[n]!;
          const ref = i.slug ? bySlug.get(i.slug) : undefined;
          const pic = ingredientSource(i.slug);
          const free = !i.slug || searching === key ? freeFor(n) : options;
          const suggestions = !i.slug && i.label.trim() ? suggestIngredients(i.label, free) : [];
          // Reconnu, mais déjà sur une autre ligne de la recette (un ingrédient n'y figure qu'une fois).
          const already = !i.slug && !suggestions.length && i.label.trim() ? autoLink(i.label, options) : null;
          const open = searching === key;
          // Recherche tapée, sinon les ingrédients reconnus dans le libellé.
          const results = !open ? [] : query.trim() ? searchIngredients(query, free) : suggestIngredients(i.label, free, 8);
          return (
            <View key={key} style={[styles.ingBlock, { borderColor: i.slug ? c.cardLine : c.warmSoft, backgroundColor: c.background }]}>
              <View style={styles.ingredient}>
                <Pressable onPress={() => { setSearching(open ? null : key); setQuery(""); }} accessibilityRole="button"
                  accessibilityLabel={ref ? `Relié à ${ref.name} : changer` : "Relier à un ingrédient de vos achats"}
                  style={[styles.thumb, { backgroundColor: "#FFFFFF", borderColor: c.border }]}>
                  {pic ? <Image source={pic} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} /> : <Icon name="link" size={18} color={c.muted} />}
                </Pressable>
                <TextInput value={i.label} onChangeText={(label) => setIngredient(n, { label })} onEndEditing={() => autoLinkRow(n)} onBlur={() => autoLinkRow(n)}
                  placeholder="Ingrédient" placeholderTextColor={c.muted} style={[input, { flex: 1, minWidth: 0 }]} />
                <NumberField value={i.quantity} decimals onChange={(q) => changeQuantity(i, n, q)} placeholder="qté" style={{ width: 58 }} />
                <Pressable onPress={() => cycleUnit(i, n)} accessibilityRole="button" accessibilityLabel={`Unité : ${i.unit ? UNIT_LABEL[i.unit as RecipeUnit] : "aucune"}`}
                  style={[styles.unit, { backgroundColor: c.chip }]}>
                  <Text style={{ color: c.text, fontSize: 14 }}>{i.unit ? UNIT_LABEL[i.unit as RecipeUnit] : "—"}</Text>
                </Pressable>
              </View>
              <View style={styles.linkLine}>
                <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {ref ? (
                    <Pressable onPress={() => { setSearching(open ? null : key); setQuery(""); }} hitSlop={4} accessibilityRole="button" style={{ flexShrink: 1 }}>
                      <Text style={{ color: c.greenInk, fontSize: 13.5, flexShrink: 1 }}>Relié à « {ref.name} » · <Text style={{ textDecorationLine: "underline" }}>changer</Text></Text>
                    </Pressable>
                  ) : (
                    <>
                      <Text style={{ color: c.orangeInk, fontSize: 13.5, flexShrink: 1 }}>
                        {suggestions.length ? "Relier à :" : already ? `« ${already.name} » est déjà dans la recette : changez plutôt sa quantité.` : "Pas relié à vos achats"}
                      </Text>
                      {suggestions.map((o) => (
                        <Pressable key={o.slug} onPress={() => choose(n, o)} accessibilityRole="button" accessibilityLabel={`Relier à ${o.name}`}
                          style={({ pressed }) => [styles.suggest, { backgroundColor: c.chipActive, opacity: pressed ? 0.7 : 1 }]}>
                          <Text style={{ color: c.text, fontSize: 13.5, fontWeight: "600" }}>{o.name}</Text>
                        </Pressable>
                      ))}
                      <Pressable onPress={() => { setSearching(open ? null : key); setQuery(""); }} hitSlop={4} accessibilityRole="button">
                        <Text style={{ color: c.primary, fontSize: 13.5, textDecorationLine: "underline" }}>chercher</Text>
                      </Pressable>
                    </>
                  )}
                </View>
                <Tool icon="chevronUp" label={`Monter ${i.label || "l'ingrédient"}`} disabled={n === 0} onPress={() => moveIngredient(n, -1)} />
                <Tool icon="chevronDown" label={`Descendre ${i.label || "l'ingrédient"}`} disabled={n === value.ingredients.length - 1} onPress={() => moveIngredient(n, 1)} />
                <Tool icon="close" label={`Retirer ${i.label || "l'ingrédient"}`} onPress={() => removeIngredient(n)} />
              </View>
              {open ? (
                <View style={{ gap: 8 }}>
                  <TextInput value={query} onChangeText={setQuery} autoFocus placeholder="Chercher : courgette, lardons, crème…" placeholderTextColor={c.muted}
                    style={input} />
                  <View style={styles.results}>
                    {results.map((o) => (
                      <Pressable key={o.slug} onPress={() => choose(n, o)} accessibilityRole="button" accessibilityLabel={`Relier à ${o.name}`}
                        style={({ pressed }) => [styles.result, { backgroundColor: o.slug === i.slug ? c.chipActive : c.card, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}>
                        <View style={styles.resultThumb}>
                          {ingredientSource(o.slug) ? <Image source={ingredientSource(o.slug)!} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} /> : null}
                        </View>
                        <Text style={{ color: c.text, fontSize: 14.5 }} numberOfLines={1}>{o.name}</Text>
                      </Pressable>
                    ))}
                    {!results.length ? <Muted style={{ fontSize: 13.5 }}>{query || i.label ? "Aucun ingrédient de vos achats ne correspond." : "Tapez le début du nom."}</Muted> : null}
                  </View>
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    {i.slug ? <Text onPress={() => choose(n, null)} style={{ color: c.muted, fontSize: 13.5, textDecorationLine: "underline" }}>Retirer le lien</Text> : null}
                    <Text onPress={() => setSearching(null)} style={{ color: c.muted, fontSize: 13.5, textDecorationLine: "underline" }}>Fermer</Text>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
        <Button title="Ajouter un ingrédient" kind="secondary" icon="plus" onPress={addIngredient} />
      </Card>

      <Card>
        <H2>Étapes</H2>
        <Muted>Une durée par étape (« Cuire le riz 11 min ») devient un minuteur. Les flèches changent l'ordre ; « + » ajoute une étape juste après.</Muted>
        {value.steps.length ? (
          <Pressable onPress={() => insertStep(0)} hitSlop={4} accessibilityRole="button" style={styles.insertTop}>
            <Icon name="plus" size={15} color={c.primary} />
            <Text style={{ color: c.primary, fontSize: 14.5, fontWeight: "600" }}>Ajouter une étape au début</Text>
          </Pressable>
        ) : null}
        {value.steps.map((s, n) => {
          const key = stepKeys.current[n]!;
          const timer = stepTimer(s, value.steps.slice(0, n));
          return (
            <View key={key} style={{ gap: 6 }}>
              <View style={styles.ingredient}>
                <View style={[styles.badge, { backgroundColor: c.chip }]}><Text style={{ fontWeight: "700", color: c.text }}>{n + 1}</Text></View>
                <TextInput value={s} onChangeText={(t) => setStep(n, t)} multiline placeholder="Décrivez l'étape" placeholderTextColor={c.muted}
                  autoFocus={focusKey === key} style={[input, { flex: 1, minHeight: 70 }]} />
              </View>
              <View style={[styles.linkLine, { marginLeft: 40 }]}>
                <View style={[styles.timerLine, { flex: 1, minWidth: 0 }]}>
                  <Icon name={timer ? "timer" : "minus"} size={16} color={timer ? c.primary : c.muted} />
                  {timer
                    ? <Body style={{ color: c.primary, fontSize: 13.5, flexShrink: 1 }} numberOfLines={2}>Minuteur : {timer.subject} · {timer.label}</Body>
                    : <Muted style={{ fontSize: 13 }}>Sans minuteur</Muted>}
                </View>
                <Tool icon="chevronUp" label={`Monter l'étape ${n + 1}`} disabled={n === 0} onPress={() => moveStep(n, -1)} />
                <Tool icon="chevronDown" label={`Descendre l'étape ${n + 1}`} disabled={n === value.steps.length - 1} onPress={() => moveStep(n, 1)} />
                <Tool icon="plus" label={`Ajouter une étape après l'étape ${n + 1}`} onPress={() => insertStep(n + 1)} />
                <Tool icon="close" label={`Retirer l'étape ${n + 1}`} onPress={() => removeStep(n)} />
              </View>
            </View>
          );
        })}
        <Button title="Ajouter une étape à la fin" kind="secondary" icon="plus" onPress={() => insertStep(value.steps.length)} />
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
  // Le libellé rétrécit (minWidth 0) : quantité, unité et croix restent dans l'écran.
  ingredient: { flexDirection: "row", alignItems: "center", gap: 6 },
  unit: { minWidth: 58, height: 48, borderRadius: 13, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badge: { width: 32, height: 32, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  timerLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  ingBlock: { borderWidth: 1.5, borderRadius: 13, padding: 8, gap: 8 },
  thumb: { width: 44, height: 44, borderRadius: 10, borderWidth: 1, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  linkLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  suggest: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  tool: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  results: { gap: 6 },
  result: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 10, padding: 6 },
  resultThumb: { width: 30, height: 30, borderRadius: 6, overflow: "hidden", backgroundColor: "#FFFFFF" },
  insertTop: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 4 },
});
