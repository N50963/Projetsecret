/**
 * Recettes selon la météo (Profil) : toutes les recettes, chacune avec un sélecteur à cinq boutons — temps froid, plutôt
 * froid, tout temps, plutôt chaud, temps chaud. Le choix est enregistré pour le foyer et guide les propositions selon la
 * météo prévue dans la commune du foyer. Sans choix, la suggestion déduite du nom du plat s'affiche en pointillés.
 */

import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Illustration } from "../components/Illustration";
import { Icon, type IconName } from "../components/icons";
import { Chip, ErrorText, Field, Muted, Screen } from "../components/ui";
import { errorText } from "../lib/errors";
import { illustrationUrls, pictureOf, usePictures, type Picture } from "../lib/images";
import { getWeatherLevels, setWeatherLevel } from "../lib/recipeWeather";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors, type Colors } from "../lib/theme";
import { useWeatherPlace } from "../lib/weather";
import { autoLevel, WEATHER_LEVELS, type WeatherLevel } from "../modules/planning";
import { listRecipes, matchesSearch, type RecipeSummary } from "../modules/recipes";

/** Libellé court (deux lignes) et icône de chaque bouton. */
const BUTTONS: Record<WeatherLevel, { short: string; icon: IconName }> = {
  [-2]: { short: "Temps\nfroid", icon: "snow" },
  [-1]: { short: "Plutôt\nfroid", icon: "cloud" },
  0: { short: "Tout\ntemps", icon: "cloudSun" },
  1: { short: "Plutôt\nchaud", icon: "sun" },
  2: { short: "Temps\nchaud", icon: "sun" },
};

/** Couleurs d'un bouton choisi : bleu-gris pour le froid, vert pour tout temps, abricot pour le chaud. */
function tone(level: WeatherLevel, c: Colors) {
  if (level < 0) return { bg: c.coldSoft, ink: c.coldInk };
  if (level > 0) return { bg: c.warmSoft, ink: c.orangeInk };
  return { bg: c.chipActive, ink: c.greenInk };
}

type Filter = "toutes" | "a_verifier" | WeatherLevel;

export default function MeteoRecettes() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const town = useWeatherPlace();
  const [recipes, setRecipes] = useState<RecipeSummary[] | null>(null);
  const [chosen, setChosen] = useState<Map<string, WeatherLevel>>(new Map());
  const [images, setImages] = useState<Record<string, Picture | null>>({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("toutes");
  const [error, setError] = useState("");
  /** Recettes dont l'enregistrement est en cours (bouton à l'opacité réduite). */
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const latest = useRef(new Map<string, number>());
  const pictures = usePictures();

  useEffect(() => {
    (async () => {
      try {
        const [list, levels] = await Promise.all([listRecipes(supabase), getWeatherLevels(household.id).catch(() => new Map<string, WeatherLevel>())]);
        setRecipes(list);
        setChosen(levels);
        illustrationUrls(list.map((r) => r.id)).then(setImages, () => undefined);
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, [household.id]);

  const levelOf = useCallback((r: RecipeSummary): { level: WeatherLevel; mine: boolean } => {
    const mine = chosen.get(r.id);
    return mine !== undefined ? { level: mine, mine: true } : { level: autoLevel(r), mine: false };
  }, [chosen]);

  /** Choix d'un bouton : affiché tout de suite, enregistré ensuite (rétabli si l'enregistrement échoue). */
  const choose = (r: RecipeSummary, level: WeatherLevel) => {
    const before = chosen.get(r.id);
    const n = (latest.current.get(r.id) ?? 0) + 1;
    latest.current.set(r.id, n);
    setChosen((m) => new Map(m).set(r.id, level));
    setSaving((s) => new Set(s).add(r.id));
    setError("");
    setWeatherLevel(household.id, r.id, level)
      .catch((e) => {
        if (latest.current.get(r.id) !== n) return;
        setChosen((m) => {
          const next = new Map(m);
          if (before === undefined) next.delete(r.id);
          else next.set(r.id, before);
          return next;
        });
        setError(errorText(e));
      })
      .finally(() => {
        if (latest.current.get(r.id) === n) setSaving((s) => {
          const next = new Set(s);
          next.delete(r.id);
          return next;
        });
      });
  };

  const counts = useMemo(() => {
    const out = { toutes: 0, a_verifier: 0, [-2]: 0, [-1]: 0, 0: 0, 1: 0, 2: 0 } as Record<string, number>;
    for (const r of recipes ?? []) {
      const { level, mine } = levelOf(r);
      out.toutes! += 1;
      out[level]! += 1;
      if (!mine) out.a_verifier! += 1;
    }
    return out;
  }, [recipes, levelOf]);

  const shown = useMemo(() => {
    return (recipes ?? []).filter((r) => {
      const { level, mine } = levelOf(r);
      if (filter === "a_verifier" && mine) return false;
      if (typeof filter === "number" && level !== filter) return false;
      // Sans tenir compte de la casse ni des accents (« boeuf » trouve « Bœuf bourguignon »).
      return matchesSearch(r.name, search);
    });
  }, [recipes, levelOf, filter, search]);

  const filters: Array<{ value: Filter; label: string }> = [
    { value: "toutes", label: `Toutes (${counts.toutes})` },
    { value: "a_verifier", label: `À vérifier (${counts.a_verifier})` },
    ...WEATHER_LEVELS.map((l) => ({ value: l.value as Filter, label: `${l.label} (${counts[l.value]})` })),
  ];

  const header = (
    <View style={styles.header}>
      <Muted>
        Les menus proposés suivent ce classement selon la météo prévue à {town} : par temps froid, les plats
        « temps froid », « plutôt froid » et « tout temps » sont proposés, les plats chauds reculent ; inversement par temps
        chaud. En pointillés : suggestion d'après le nom du plat, en attendant votre choix.
      </Muted>
      <View>
        <Field value={search} placeholder="Rechercher une recette" style={{ paddingLeft: 44 }} onChangeText={setSearch} />
        <View style={styles.searchIcon} pointerEvents="none"><Icon name="search" size={20} color={c.muted} /></View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel="Filtre par temps">
        {filters.map((f) => <Chip key={String(f.value)} label={f.label} active={filter === f.value} onPress={() => setFilter(f.value)} />)}
      </ScrollView>
      <ErrorText>{error}</ErrorText>
    </View>
  );

  return (
    <Screen title="Recettes selon la météo" scroll={false} padded={false}>
      {recipes === null && !error ? <View style={styles.list}><Muted>Chargement des recettes…</Muted></View> : (
        <FlatList
          data={shown}
          keyExtractor={(r) => r.id}
          ListHeaderComponent={header}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={Gap}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          extraData={[chosen, saving, pictures]}
          ListEmptyComponent={<Muted>Aucune recette avec ce filtre.</Muted>}
          renderItem={({ item: r }) => {
            const { level, mine } = levelOf(r);
            return (
              <View style={[styles.row, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
                <Pressable onPress={() => router.push(`/recette/${r.id}`)} accessibilityRole="button" accessibilityLabel={`Ouvrir la fiche : ${r.name}`}
                  style={({ pressed }) => [styles.title, { opacity: pressed ? 0.7 : 1 }]}>
                  <Illustration picture={pictureOf(r.id) ?? images[r.id]} height={42} width={56} rounded={8} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{r.name}</Text>
                    {!mine && <Text style={[styles.hint, { color: c.muted }]}>Suggestion, à vérifier</Text>}
                  </View>
                </Pressable>
                <View style={styles.buttons} accessibilityRole="radiogroup" accessibilityLabel={`Temps pour ${r.name}`}>
                  {WEATHER_LEVELS.map(({ value, label }) => {
                    const on = value === level;
                    const t = tone(value, c);
                    return (
                      <Pressable key={value} onPress={() => choose(r, value)} accessibilityRole="radio" accessibilityLabel={label}
                        accessibilityState={{ checked: on && mine, selected: on }}
                        style={({ pressed }) => [styles.button, {
                          backgroundColor: on ? (mine ? t.bg : c.background) : c.background,
                          borderColor: on ? t.ink : c.border, borderStyle: on && !mine ? "dashed" : "solid",
                          opacity: pressed || (on && saving.has(r.id)) ? 0.6 : 1,
                        }]}>
                        <Icon name={BUTTONS[value].icon} size={value === 1 ? 14 : 16} color={on ? t.ink : c.muted} />
                        <Text style={[styles.buttonText, { color: on ? t.ink : c.muted, fontWeight: on ? "700" : "400" }]} numberOfLines={2}>
                          {BUTTONS[value].short}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}

function Gap() {
  return <View style={{ height: 8 }} />;
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 24 },
  header: { gap: 12, marginBottom: 12 },
  searchIcon: { position: "absolute", left: 14, top: 0, bottom: 0, justifyContent: "center" },
  row: { borderRadius: 12, borderWidth: 1, padding: 10, gap: 9 },
  title: { flexDirection: "row", alignItems: "center", gap: 10 },
  name: { fontSize: 15.5, lineHeight: 19, fontWeight: "700" },
  hint: { fontSize: 12.5, lineHeight: 16, fontStyle: "italic" },
  buttons: { flexDirection: "row", gap: 5 },
  button: { flex: 1, minHeight: 50, borderRadius: 9, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingVertical: 4, gap: 2 },
  buttonText: { fontSize: 11.5, lineHeight: 13, textAlign: "center" },
});
