/**
 * Commune du foyer, pour la météo qui oriente les menus (Profil › Commune pour la météo). Chaque foyer a la sienne :
 * les parents, sur leur propre compte, choisissent leur commune. Recherche par le service de géocodage d'Open-Meteo
 * (gratuit, sans compte ni clé), limitée à la France.
 */

import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../components/icons";
import { Body, ErrorText, Field, Muted, Screen } from "../components/ui";
import { errorText } from "../lib/errors";
import { useHousehold, useSession } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";

interface Town {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  /** Département et code postal, pour distinguer les communes de même nom. */
  detail: string;
}

async function searchTowns(query: string, signal: AbortSignal): Promise<Town[]> {
  const url = "https://geocoding-api.open-meteo.com/v1/search"
    + `?name=${encodeURIComponent(query)}&count=10&language=fr&format=json&countryCode=FR`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Recherche de commune indisponible (${res.status})`);
  const results = ((await res.json()).results ?? []) as Array<Record<string, any>>;
  // Une commune revient parfois deux fois (la ville et son entité administrative) : la première suffit.
  const seen = new Set<string>();
  return results
    .filter((r) => typeof r.latitude === "number" && typeof r.longitude === "number" && typeof r.name === "string")
    .filter((r) => {
      const k = `${r.name}|${r.admin2 ?? r.admin1 ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({
      id: Number(r.id), name: r.name, latitude: r.latitude, longitude: r.longitude,
      detail: [r.admin2 ?? r.admin1, Array.isArray(r.postcodes) ? r.postcodes[0] : null].filter(Boolean).join(" · "),
    }));
}

export default function Commune() {
  const router = useRouter();
  const home = useHousehold();
  const { refreshHousehold } = useSession();
  const c = useColors();
  const [query, setQuery] = useState("");
  const [towns, setTowns] = useState<Town[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);

  // Recherche lancée quand la saisie s'arrête (au moins 2 lettres).
  useEffect(() => {
    const q = query.trim();
    pending.current?.abort();
    if (q.length < 2) {
      setTowns(null);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    pending.current = ctrl;
    setSearching(true);
    const timer = setTimeout(() => {
      searchTowns(q, ctrl.signal)
        .then((t) => {
          setTowns(t);
          setError("");
        })
        .catch((e) => {
          if (!ctrl.signal.aborted) setError(errorText(e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setSearching(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const choose = async (t: Town) => {
    setSaving(t.id);
    setError("");
    try {
      const { error: e } = await supabase.rpc("set_household_place", {
        p_household: home.id, p_name: t.name, p_latitude: t.latitude, p_longitude: t.longitude,
      });
      if (e) throw new Error(`Commune non enregistrée : ${e.message}`);
      // Foyer relu : la météo de la nouvelle commune remplace l'ancienne sur tous les écrans.
      await refreshHousehold();
      router.back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Screen title="Commune pour la météo">
      <Muted>
        Les menus proposés suivent la météo du jour dans votre commune : plats frais quand il fait chaud, plats chauds et
        réconfortants quand il fait froid ou qu'il pleut.
      </Muted>
      <View style={[styles.current, { backgroundColor: c.greenSoft }]}>
        <Icon name="check" size={20} color={c.greenInk} />
        <Text style={{ color: c.greenInk, fontSize: 16, fontWeight: "600", flex: 1 }}>Commune actuelle : {home.place.name}</Text>
      </View>
      <Field value={query} onChangeText={setQuery} placeholder="Rechercher une commune" autoCorrect={false} autoFocus
        accessibilityLabel="Rechercher une commune" returnKeyType="search" />
      <ErrorText>{error}</ErrorText>
      {searching && !towns ? <Muted>Recherche…</Muted> : null}
      {towns && !towns.length && !searching ? <Body>Aucune commune trouvée. Vérifiez l'orthographe.</Body> : null}
      {towns?.length ? (
        <View style={[styles.list, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
          {towns.map((t, i) => (
            <Pressable key={t.id} onPress={() => choose(t)} disabled={saving !== null} accessibilityRole="button"
              accessibilityLabel={`${t.name}${t.detail ? `, ${t.detail}` : ""}`}
              style={({ pressed }) => [styles.row, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }, { opacity: pressed || saving === t.id ? 0.6 : 1 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: c.text }]}>{t.name}</Text>
                {t.detail ? <Text style={{ color: c.muted, fontSize: 14 }}>{t.detail}</Text> : null}
              </View>
              {saving === t.id ? <Muted>Enregistrement…</Muted> : <Icon name="chevronRight" width={9} height={15} color={c.text} />}
            </Pressable>
          ))}
        </View>
      ) : null}
      <Muted style={{ fontSize: 13 }}>Recherche des communes : Open-Meteo (le nom tapé seulement).</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  current: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11 },
  list: { borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 14 },
  name: { fontSize: 16, fontWeight: "700" },
});
