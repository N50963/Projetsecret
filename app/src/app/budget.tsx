import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ErrorText, Muted, Screen, SectionTitle } from "../components/ui";
import { dayLabel } from "../lib/format";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { addDays, toIsoDate } from "../modules/planning";

interface Receipt {
  id: string;
  purchasedAt: string;
  store: string | null;
  totalCents: number;
  savingsCents: number;
  articles: number | null;
}

const WEEKS = 8;
/** Couleur des barres : vert de la charte, contrôlé (contraste ≥ 3:1 sur les cartes, ni trop sombre ni grisé). */
const BAR = "#64842B";
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

const euros = (cents: number) => `${(cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
/** « ROCHEFORT DU GARD » → « Rochefort du Gard ». */
const placeName = (s: string | null) => s && s.toLowerCase().replace(/(^|[\s-])([a-zà-ÿ])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
  .replace(/ (Du|De|Des|La|Le|Les|Sur|Sous|En|Et) /g, (m) => m.toLowerCase());
const roundEuros = (cents: number) => `${Math.round(cents / 100).toLocaleString("fr-FR")} €`;

/** Lundi de la semaine d'une date (AAAA-MM-JJ). */
function monday(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return addDays(iso, -((d.getDay() + 6) % 7));
}
const shortDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** Budget MenuMalin : dépenses d'après les tickets Lidl Plus (mois en cours, 8 dernières semaines, tickets). */
export default function Budget() {
  const household = useHousehold();
  const c = useColors();
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [selected, setSelected] = useState(WEEKS - 1);
  const [error, setError] = useState("");
  const today = toIsoDate(new Date());

  const load = useCallback(async () => {
    const since = addDays(monday(today), -7 * (WEEKS - 1));
    const lastMonthStart = toIsoDate(new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1, 12));
    const from = [since, lastMonthStart].sort()[0] ?? since;
    const { data, error: e } = await supabase.from("receipts").select("id, purchased_at, store_name, store_locality, total_cents, savings_cents, articles_count")
      .eq("household_id", household.id).gte("purchased_at", `${from}T00:00:00`).order("purchased_at", { ascending: false });
    if (e) {
      setError(`Tickets illisibles : ${e.message}`);
      return;
    }
    setError("");
    setReceipts((data ?? []).map((r: any) => ({
      id: r.id, purchasedAt: r.purchased_at, store: placeName(r.store_locality ?? r.store_name), totalCents: r.total_cents, savingsCents: r.savings_cents ?? 0,
      articles: r.articles_count,
    })));
  }, [household.id, today]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const stats = useMemo(() => {
    const list = receipts ?? [];
    const month = today.slice(0, 7);
    const lastMonth = toIsoDate(new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1, 12)).slice(0, 7);
    const inMonth = list.filter((r) => r.purchasedAt.slice(0, 7) === month);
    const thisWeek = monday(today);
    const weeks = Array.from({ length: WEEKS }, (_, i) => {
      const start = addDays(thisWeek, -7 * (WEEKS - 1 - i));
      const end = addDays(start, 7);
      const cents = list.filter((r) => r.purchasedAt.slice(0, 10) >= start && r.purchasedAt.slice(0, 10) < end).reduce((s, r) => s + r.totalCents, 0);
      return { start, cents };
    });
    return {
      monthCents: inMonth.reduce((s, r) => s + r.totalCents, 0),
      lastMonthCents: list.filter((r) => r.purchasedAt.slice(0, 7) === lastMonth).reduce((s, r) => s + r.totalCents, 0),
      savingsCents: inMonth.reduce((s, r) => s + r.savingsCents, 0),
      tickets: inMonth.length,
      weeks,
      max: Math.max(1, ...weeks.map((w) => w.cents)),
      recent: list.slice(0, 10),
    };
  }, [receipts, today]);

  const monthName = new Date(`${today}T12:00:00`).toLocaleDateString("fr-FR", { month: "long" });
  const week = stats.weeks[selected];

  return (
    <Screen title="Budget" nav="budget" padded={false}>
      <View style={styles.head}><SectionTitle icon="budget" title={`Dépenses de ${monthName}`} /></View>
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
        <ErrorText>{error}</ErrorText>
        {receipts === null ? <Muted>Chargement…</Muted> : (
          <>
            <Text style={[styles.hero, { color: c.text }]}>{euros(stats.monthCents)}</Text>
            <Text style={{ color: c.muted, fontSize: 15 }}>
              {stats.tickets} ticket{stats.tickets > 1 ? "s" : ""} Lidl ce mois-ci · {roundEuros(stats.lastMonthCents)} le mois dernier
            </Text>
            <View style={styles.tiles}>
              <View style={[styles.tile, { backgroundColor: c.greenSoft }]}>
                <Text style={[styles.tileValue, { color: c.greenInk }]}>{euros(stats.savingsCents)}</Text>
                <Text style={[styles.tileLabel, { color: c.greenInk }]}>économisés avec Lidl Plus</Text>
              </View>
              <View style={[styles.tile, { backgroundColor: c.chip }]}>
                <Text style={[styles.tileValue, { color: c.text }]}>{stats.tickets ? euros(Math.round(stats.monthCents / stats.tickets)) : "–"}</Text>
                <Text style={[styles.tileLabel, { color: c.muted }]}>par ticket en moyenne</Text>
              </View>
            </View>
          </>
        )}
      </View>

      <View style={[styles.head, { marginTop: 2 }]}><SectionTitle icon="calendar" title="Dépenses par semaine" /></View>
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
        {week ? (
          <Text style={{ color: c.text, fontSize: 15.5, fontWeight: "700" }} accessibilityLiveRegion="polite">
            Semaine du {shortDay(week.start)} : <Text style={{ fontWeight: "400" }}>{euros(week.cents)}</Text>
          </Text>
        ) : null}
        <View style={styles.chart} accessibilityLabel="Dépenses des 8 dernières semaines">
          {stats.weeks.map((w, i) => {
            const on = i === selected;
            const height = w.cents ? Math.max(4, Math.round((w.cents / stats.max) * 120)) : 0;
            return (
              <Pressable key={w.start} onPress={() => setSelected(i)} accessibilityRole="button" accessibilityState={{ selected: on }}
                accessibilityLabel={`Semaine du ${shortDay(w.start)} : ${euros(w.cents)}`} style={styles.column}>
                <View style={[styles.bar, { height, backgroundColor: BAR, opacity: on ? 1 : 0.75 }]} />
              </Pressable>
            );
          })}
        </View>
        <View style={[styles.axis, { borderTopColor: c.border }]}>
          {stats.weeks.map((w, i) => (
            <Text key={w.start} style={[styles.axisLabel, { color: i === selected ? c.text : c.muted, fontWeight: i === selected ? "700" : "400" }]}>
              {i === WEEKS - 1 ? "Cette sem." : new Date(`${w.start}T12:00:00`).getDate()}
            </Text>
          ))}
        </View>
        <Muted>Touchez une barre pour voir la semaine. Montants des tickets Lidl Plus.</Muted>
      </View>

      <View style={[styles.head, { marginTop: 2 }]}><SectionTitle icon="receipt" title="Derniers tickets" /></View>
      <View style={[styles.card, styles.list, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
        {stats.recent.length === 0 && <View style={{ padding: 14 }}><Muted>Aucun ticket récupéré pour le moment.</Muted></View>}
        {stats.recent.map((r, i) => (
          <View key={r.id} style={[styles.row, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontSize: 15.5, fontWeight: "700" }}>{dayLabel(r.purchasedAt.slice(0, 10), today)}</Text>
              <Text style={{ color: c.muted, fontSize: 14.2 }}>
                {[r.store, r.articles ? `${r.articles} article${r.articles > 1 ? "s" : ""}` : null, r.savingsCents ? `${euros(r.savingsCents)} économisés` : null]
                  .filter(Boolean).join(" · ")}
              </Text>
            </View>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{euros(r.totalCents)}</Text>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingLeft: 13, paddingRight: 13, paddingTop: 4 },
  card: { marginLeft: 12.8, marginRight: 9.2, borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  hero: { fontSize: 34, lineHeight: 40, fontWeight: "700", fontVariant: ["tabular-nums"] },
  tiles: { flexDirection: "row", gap: 7 },
  tile: { flex: 1, minHeight: 64, borderRadius: 13, alignItems: "center", justifyContent: "center", paddingHorizontal: 6, paddingVertical: 8 },
  tileValue: { fontSize: 18, lineHeight: 22, fontWeight: "700" },
  tileLabel: { fontSize: 13.5, lineHeight: 17, textAlign: "center" },
  chart: { flexDirection: "row", alignItems: "flex-end", height: 124, gap: 2 },
  column: { flex: 1, height: 124, justifyContent: "flex-end" },
  bar: { borderTopLeftRadius: 4, borderTopRightRadius: 4, marginHorizontal: 3 },
  axis: { flexDirection: "row", gap: 2, borderTopWidth: 1, paddingTop: 4 },
  axisLabel: { flex: 1, textAlign: "center", fontSize: 11.5 },
  list: { padding: 0, gap: 0, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 14 },
});
