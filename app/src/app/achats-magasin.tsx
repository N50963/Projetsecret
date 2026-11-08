/**
 * Fruits et légumes d'un autre magasin (Profil › Tickets et achats) : les achats faits au marché, chez le primeur ou dans
 * un autre magasin, qui n'apparaissent sur aucun ticket Lidl. Grille des fruits, légumes et herbes fraîches avec leur
 * photo : toucher un produit le sélectionne, − et + règlent la quantité ; jour d'achat et magasin facultatif. Une fois
 * ajoutés, ils comptent comme les achats des tickets (propositions de menus, liste de courses, recherche par ingrédient).
 */

import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useConfirm } from "../components/ConfirmSheet";
import { Icon } from "../components/icons";
import { Body, Button, Chip, ErrorText, Field, H2, Muted, Screen } from "../components/ui";
import { errorText } from "../lib/errors";
import {
  addExtraPurchases, BUNCH, defaultQuantity, deleteExtraPurchase, listExtraPurchases, listFreshProducts, quantityLabel, stepQuantity,
  type ExtraPurchase, type FreshCategory, type FreshProduct,
} from "../lib/extraPurchases";
import { dayLabel } from "../lib/format";
import { ingredientPictureUrls, ingredientSource } from "../lib/images";
import { useHousehold } from "../lib/session";
import { refreshShoppingCount } from "../lib/shoppingCount";
import { CARD_SHADOW, useColors } from "../lib/theme";
import { toIsoDate } from "../modules/planning";

type Filter = "tous" | FreshCategory;
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "tous", label: "Tous" }, { value: "legume", label: "Légumes" }, { value: "fruit", label: "Fruits" }, { value: "herbe", label: "Herbes" },
];
const DAYS = ["Aujourd'hui", "Hier", "Avant-hier"];
const STORES = ["Marché", "Primeur", "Supermarché"];
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

export default function AchatsMagasin() {
  const household = useHousehold();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [ask, confirmSheet] = useConfirm();
  const [products, setProducts] = useState<FreshProduct[] | null>(null);
  /** Produits choisis et leur quantité (en bottes pour les radis et oignons nouveaux, sinon dans l'unité du produit). */
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const [filter, setFilter] = useState<Filter>("tous");
  const [search, setSearch] = useState("");
  const [day, setDay] = useState(0);
  const [store, setStore] = useState("");
  const [recent, setRecent] = useState<ExtraPurchase[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  /** Vignettes des ingrédients connues (redessine la grille quand la liste arrive). */
  const [, setPictures] = useState(0);

  const loadRecent = useCallback(() => {
    listExtraPurchases(household.id).then(setRecent, (e) => setError(errorText(e)));
  }, [household.id]);

  useEffect(() => {
    listFreshProducts().then(setProducts, (e) => setError(errorText(e)));
    ingredientPictureUrls().then((m) => setPictures(m.size), () => undefined);
    loadRecent();
  }, [loadRecent]);

  const shown = useMemo(() => {
    const q = fold(search.trim());
    return (products ?? []).filter((p) => (filter === "tous" || p.category === filter) && (!q || fold(p.name).includes(q)));
  }, [products, filter, search]);

  const toggle = (p: FreshProduct) => {
    setInfo("");
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(p.slug)) next.delete(p.slug);
      else next.set(p.slug, defaultQuantity(p));
      return next;
    });
  };
  const step = (p: FreshProduct, direction: 1 | -1) => setPicked((m) => {
    const next = new Map(m);
    const value = stepQuantity(p, next.get(p.slug) ?? defaultQuantity(p), direction);
    if (value === null) next.delete(p.slug);
    else next.set(p.slug, value);
    return next;
  });

  const save = async () => {
    if (!products) return;
    setBusy(true);
    setError("");
    try {
      const items = products.filter((p) => picked.has(p.slug))
        .map((p) => ({ product: p, quantity: (picked.get(p.slug) ?? 1) * (BUNCH[p.slug] ?? 1) }));
      // Jour d'achat : maintenant, ou en milieu de journée pour hier et avant-hier.
      const when = new Date();
      if (day > 0) {
        when.setDate(when.getDate() - day);
        when.setHours(12, 0, 0, 0);
      }
      await addExtraPurchases(household.id, items, when, store);
      setPicked(new Map());
      setInfo(`${items.length} produit${items.length > 1 ? "s ajoutés" : " ajouté"} : ${items.length > 1 ? "ils comptent" : "il compte"} dans les menus proposés et la liste de courses, comme les achats des tickets.`);
      loadRecent();
      refreshShoppingCount(household.id).catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (p: ExtraPurchase) => ask({
    title: "Retirer cet achat ?", name: p.name, detail: `${quantityLabel(p.slug, p.unit, p.quantity, true)} · ${dayLabel(p.purchasedAt.slice(0, 10), toIsoDate(new Date()))}`,
    message: "Il ne comptera plus dans les menus proposés ni dans la liste de courses.",
    confirmLabel: "Retirer l'achat", cancelLabel: "Garder l'achat", icon: "trash",
    onConfirm: () => {
      setRecent((list) => (list ?? []).filter((x) => x.id !== p.id));
      deleteExtraPurchase(p.id).catch((e) => {
        setError(errorText(e));
        loadRecent();
      });
    },
  });

  const count = picked.size;
  const header = (
    <View style={styles.header}>
      <Muted>
        Fruits, légumes et herbes achetés au marché, chez le primeur ou dans un autre magasin : ils comptent dans les menus
        proposés comme les achats des tickets Lidl. Touchez un produit pour le choisir, puis réglez la quantité.
      </Muted>
      <View style={{ gap: 8 }}>
        <Text style={[styles.label, { color: c.text }]}>Acheté</Text>
        <View style={styles.row}>
          {DAYS.map((d, i) => <Chip key={d} label={d} active={day === i} onPress={() => setDay(i)} />)}
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={[styles.label, { color: c.text }]}>Magasin (facultatif)</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
          {STORES.map((s) => <Chip key={s} label={s} active={store === s} onPress={() => setStore(store === s ? "" : s)} />)}
        </ScrollView>
        <Field value={store} placeholder="Ou le nom du magasin" onChangeText={setStore} maxLength={60} />
      </View>
      <View>
        <Field value={search} placeholder="Rechercher un fruit ou un légume" style={{ paddingLeft: 44 }} onChangeText={setSearch} />
        <View style={styles.searchIcon} pointerEvents="none"><Icon name="search" size={20} color={c.muted} /></View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {FILTERS.map((f) => <Chip key={f.value} label={f.label} active={filter === f.value} onPress={() => setFilter(f.value)} />)}
      </ScrollView>
      {info ? <Body style={{ color: c.greenInk }}>{info}</Body> : null}
      <ErrorText>{error}</ErrorText>
    </View>
  );

  const footer = (
    <View style={styles.recent}>
      <H2>Achats des 30 derniers jours</H2>
      {recent === null ? <Muted>Chargement…</Muted> : recent.length === 0 ? <Muted>Aucun achat d'un autre magasin pour le moment.</Muted> : (
        <View style={[styles.recentCard, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW]}>
          {recent.map((p, i) => {
            const src = ingredientSource(p.slug);
            return (
              <View key={p.id} style={[styles.recentRow, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }]}>
                <View style={styles.recentThumb}>{src ? <Image source={src} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} /> : null}</View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.recentName, { color: c.text }]} numberOfLines={1}>{p.name} · {quantityLabel(p.slug, p.unit, p.quantity, true)}</Text>
                  <Text style={[styles.recentMeta, { color: c.muted }]} numberOfLines={1}>
                    {dayLabel(p.purchasedAt.slice(0, 10), toIsoDate(new Date()))}{p.store ? ` · ${p.store}` : ""}
                  </Text>
                </View>
                <Pressable onPress={() => remove(p)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Retirer l'achat : ${p.name}`}
                  style={({ pressed }) => [styles.trash, { opacity: pressed ? 0.6 : 1 }]}>
                  <Icon name="trash" size={19} color={c.muted} />
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );

  return (
    <Screen title="Fruits et légumes" scroll={false} padded={false} footer={count ? (
      <View style={[styles.bar, { backgroundColor: c.background, borderTopColor: c.border, paddingBottom: 10 + insets.bottom }]}>
        <Button title={`Ajouter ${count} produit${count > 1 ? "s" : ""}`} icon="plus" onPress={save} busy={busy} />
      </View>
    ) : undefined}>
      {products === null && !error ? <View style={styles.list}><Muted>Chargement des fruits et légumes…</Muted></View> : (
        <FlatList
          data={shown}
          keyExtractor={(p) => p.slug}
          numColumns={3}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          columnWrapperStyle={{ gap: 8 }}
          ItemSeparatorComponent={Gap}
          extraData={picked}
          initialNumToRender={18}
          ListEmptyComponent={<Muted>Aucun produit ne correspond à la recherche.</Muted>}
          renderItem={({ item: p }) => {
            const on = picked.has(p.slug);
            const qty = picked.get(p.slug) ?? 0;
            const src = ingredientSource(p.slug);
            return (
              <Pressable onPress={() => toggle(p)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                accessibilityLabel={on ? `${p.name}, ${quantityLabel(p.slug, p.unit, qty)}` : p.name}
                style={({ pressed }) => [styles.tile, { backgroundColor: on ? c.greenSoft : c.card, borderColor: on ? c.primary : c.cardLine, opacity: pressed ? 0.85 : 1 }, CARD_SHADOW]}>
                <View style={styles.thumb}>
                  {src ? <Image source={src} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
                    : <Icon name="image" size={22} color={c.muted} />}
                </View>
                <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{p.name}</Text>
                {on ? (
                  <View style={styles.stepper}>
                    <Pressable onPress={() => step(p, -1)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`Moins de ${p.name}`}
                      style={({ pressed }) => [styles.stepButton, { backgroundColor: c.card, opacity: pressed ? 0.6 : 1 }]}>
                      <Icon name="minus" size={14} color={c.text} />
                    </Pressable>
                    <Text style={[styles.qty, { color: c.text }]} numberOfLines={1}>{quantityLabel(p.slug, p.unit, qty)}</Text>
                    <Pressable onPress={() => step(p, 1)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`Plus de ${p.name}`}
                      style={({ pressed }) => [styles.stepButton, { backgroundColor: c.card, opacity: pressed ? 0.6 : 1 }]}>
                      <Icon name="plus" size={14} color={c.text} />
                    </Pressable>
                  </View>
                ) : null}
                {on ? <View style={[styles.check, { backgroundColor: c.primary }]}><Icon name="tick" size={12} color="#FFFFFF" /></View> : null}
              </Pressable>
            );
          }}
        />
      )}
      {confirmSheet}
    </Screen>
  );
}

function Gap() {
  return <View style={{ height: 8 }} />;
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 24 },
  header: { gap: 14, marginBottom: 12 },
  label: { fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  searchIcon: { position: "absolute", left: 14, top: 0, bottom: 0, justifyContent: "center" },
  tile: { flex: 1, maxWidth: "33.3%", minHeight: 118, borderRadius: 12, borderWidth: 1.5, padding: 7, alignItems: "center", gap: 5 },
  thumb: { width: 58, height: 58, borderRadius: 10, overflow: "hidden", backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  name: { fontSize: 13.5, lineHeight: 16, fontWeight: "600", textAlign: "center" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: "auto" },
  stepButton: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  qty: { minWidth: 40, fontSize: 12.5, fontWeight: "700", textAlign: "center", fontVariant: ["tabular-nums"] },
  check: { position: "absolute", top: 6, right: 6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  bar: { paddingHorizontal: 12, paddingTop: 10, borderTopWidth: 1 },
  recent: { marginTop: 22, gap: 10 },
  recentCard: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 10 },
  recentRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  recentThumb: { width: 40, height: 40, borderRadius: 8, overflow: "hidden", backgroundColor: "#FFFFFF" },
  recentName: { fontSize: 15, fontWeight: "600" },
  recentMeta: { fontSize: 13.5 },
  trash: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
