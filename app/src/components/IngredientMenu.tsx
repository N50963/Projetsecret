/**
 * Fonction principale de l'accueil : le menu du jour choisi d'après un ingrédient que le foyer a acheté ou compte acheter.
 * Le foyer indique l'ingrédient (achats récents proposés), le repas et le temps disponible ; les propositions suivent
 * ensuite les mêmes règles que les menus de la semaine.
 */

import { Image } from "expo-image";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { mealLabel } from "../lib/format";
import { ingredientSource } from "../lib/images";
import { fold } from "../lib/products";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { addDays, ingredientsInRecipes, loadPurchases, type RecipeIngredientOption, type WeekSlot } from "../modules/planning";
import type { MealType } from "../modules/recipes";
import { Icon } from "./icons";
import { TimeWheel } from "./TimeWheel";
import { Button, Chip, ErrorText, Field } from "./ui";

export interface IngredientMenuRequest {
  ingredient: RecipeIngredientOption;
  toBuy: boolean;
  mealType: MealType;
  maxTotalMin: number | null;
}

function Thumb({ slug, size = 26 }: { slug: string; size?: number }) {
  const c = useColors();
  const source = ingredientSource(slug);
  return source
    ? <Image source={source} style={{ width: size, height: size, borderRadius: size / 2 }} contentFit="cover" transition={0} />
    : <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.chipActive }} />;
}

export function IngredientMenu({ householdId, today, todaySlots, busy, onFind }: {
  householdId: string; today: string; todaySlots: Partial<Record<MealType, WeekSlot>>; busy: boolean;
  onFind: (request: IngredientMenuRequest) => void;
}) {
  const c = useColors();
  const [options, setOptions] = useState<RecipeIngredientOption[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<RecipeIngredientOption | null>(null);
  const [toBuy, setToBuy] = useState(false);
  const [mealType, setMealType] = useState<MealType>(new Date().getHours() < 14 ? "dejeuner" : "diner");
  const [time, setTime] = useState<number | null>(60);
  const [error, setError] = useState("");

  useEffect(() => {
    ingredientsInRecipes(supabase).then(setOptions, (e) => setError(e instanceof Error ? e.message : String(e)));
    // Achats des 7 derniers jours, du plus récent au plus ancien : les premières suggestions.
    loadPurchases(supabase, householdId, addDays(today, -7))
      .then((list) => setRecent([...new Set(list.sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt)).map((p) => p.slug))]))
      .catch(() => undefined);
  }, [householdId, today]);

  const suggestions = useMemo(() => {
    const q = fold(query.trim());
    if (q.length >= 2) return options.filter((o) => fold(o.name).includes(q)).slice(0, 8);
    const bySlug = new Map(options.map((o) => [o.slug, o]));
    // Achats récents utilisés par des recettes (hors condiments et produits de base), sinon les plus cuisinés.
    const bought = recent.map((s) => bySlug.get(s)).filter((o): o is RecipeIngredientOption => Boolean(o))
      .filter((o) => !["condiment", "herbe_epice", "matiere_grasse", "epicerie_sucree"].includes(o.category));
    return (bought.length ? bought : options).slice(0, 8);
  }, [query, options, recent]);

  const pick = (o: RecipeIngredientOption) => {
    setPicked(o);
    setQuery("");
    setToBuy(!recent.includes(o.slug));
  };

  const existing = todaySlots[mealType]?.status === "accepted" ? todaySlots[mealType] : undefined;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.primary }, CARD_SHADOW]}>
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: c.greenSoft }]}><Icon name="wand" size={22} color={c.greenInk} /></View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">Menu du jour avec un ingrédient</Text>
          <Text style={{ color: c.muted, fontSize: 14.2, lineHeight: 18 }}>Acheté ou à acheter : MenuMalin vous propose quoi cuisiner.</Text>
        </View>
      </View>
      <ErrorText>{error}</ErrorText>

      {picked ? (
        <Pressable onPress={() => setPicked(null)} accessibilityRole="button" accessibilityLabel={`Ingrédient choisi : ${picked.name}. Toucher pour changer`}
          style={[styles.picked, { backgroundColor: c.chipActive, borderColor: c.primary }]}>
          <Thumb slug={picked.slug} size={34} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.text, fontSize: 16.5, fontWeight: "700" }}>{picked.name}</Text>
            <Text style={{ color: c.muted, fontSize: 13.5 }}>{picked.recipes} recette{picked.recipes > 1 ? "s" : ""} · toucher pour changer</Text>
          </View>
          <Icon name="close" size={20} color={c.text} />
        </Pressable>
      ) : (
        <View style={{ gap: 8 }}>
          <View>
            <Field value={query} onChangeText={setQuery} placeholder="Un ingrédient (ex. poulet, courgette)" style={{ paddingLeft: 44 }}
              accessibilityLabel="Ingrédient du menu du jour" />
            <View style={styles.searchIcon} pointerEvents="none"><Icon name="search" size={20} color={c.muted} /></View>
          </View>
          {!query.trim() && recent.length > 0 ? <Text style={{ color: c.muted, fontSize: 13.5 }}>Achetés ces derniers jours :</Text> : null}
          <View style={styles.wrap}>
            {suggestions.map((o) => (
              <Pressable key={o.slug} onPress={() => pick(o)} accessibilityRole="button" accessibilityLabel={o.name}
                style={({ pressed }) => [styles.option, { backgroundColor: c.chip, opacity: pressed ? 0.8 : 1 }]}>
                <Thumb slug={o.slug} />
                <Text style={{ color: c.text, fontSize: 15, fontWeight: "500" }}>{o.name}</Text>
              </Pressable>
            ))}
            {query.trim().length >= 2 && !suggestions.length ? <Text style={{ color: c.muted }}>Aucune recette avec cet ingrédient.</Text> : null}
          </View>
        </View>
      )}

      {picked ? (
        <View style={{ gap: 10 }}>
          <View style={styles.wrap}>
            <Chip label="Je l'ai acheté" active={!toBuy} onPress={() => setToBuy(false)} />
            <Chip label="Je vais l'acheter" icon="cartBold" active={toBuy} onPress={() => setToBuy(true)} />
          </View>
          <View style={styles.plan}>
            <View style={{ flex: 1, gap: 8 }}>
              {(["dejeuner", "diner"] as MealType[]).map((m) => {
                const on = mealType === m;
                return (
                  <Pressable key={m} onPress={() => setMealType(m)} accessibilityRole="radio" accessibilityState={{ checked: on }}
                    style={({ pressed }) => [styles.mealChip, { backgroundColor: on ? c.greenSoft : c.chip, borderColor: on ? c.primary : "transparent", opacity: pressed ? 0.8 : 1 }]}>
                    <Icon name={on ? "checkCircle" : "circle"} size={22} color={on ? c.primary : c.text} />
                    <Text style={{ color: c.text, fontSize: 16, fontWeight: "500" }}>{mealLabel(m)}</Text>
                  </Pressable>
                );
              })}
            </View>
            <TimeWheel value={time} onChange={setTime} />
          </View>
          {existing ? (
            <Text style={{ color: c.orangeInk, fontSize: 14.2, lineHeight: 19 }}>
              Déjà prévu ce {mealLabel(mealType).toLowerCase()} : « {existing.name} ». Il sera remplacé si vous choisissez un autre menu.
            </Text>
          ) : null}
          <Button title="Trouver le menu du jour" icon="wand" busy={busy} disabled={busy}
            onPress={() => onFind({ ingredient: picked, toBuy, mealType, maxTotalMin: time })} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, marginLeft: 12.8, marginRight: 9.2, borderRadius: 14, borderWidth: 1.5, padding: 14, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  badge: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 17.5, lineHeight: 22, fontWeight: "700" },
  searchIcon: { position: "absolute", left: 14, top: 0, bottom: 0, justifyContent: "center" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingLeft: 6, paddingRight: 12, borderRadius: 22 },
  picked: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1.5 },
  plan: { flexDirection: "row", alignItems: "center", gap: 10 },
  mealChip: { height: 48, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 10, borderRadius: 13, borderWidth: 1.5 },
});
