import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Button, Chip, ErrorText, Field, Muted, Screen, SectionTitle, Tag } from "../components/ui";
import { suggestProducts } from "../lib/mistral";
import {
  confirmProducts, correctProduct, fold, ingredientOptions, productsToReview, ROLE_LABELS, ROLES, searchProducts,
  type IngredientOption, type ProductRole, type ShopProduct,
} from "../lib/products";
import { useHousehold } from "../lib/session";
import { CARD_SHADOW, useColors } from "../lib/theme";

interface Edit {
  name: string;
  role: ProductRole | null;
  ingredients: string[];
  suggested: boolean;
}

const editOf = (p: ShopProduct): Edit => ({ name: p.name, role: p.role, ingredients: p.ingredients, suggested: false });

/** Carte d'un produit : ce que MenuBily a compris, et la correction (nom, rôle, ingrédients). */
function ProductCard({ product, edit, names, options, open, busy, onToggle, onChange, onSave, onConfirm }: {
  product: ShopProduct; edit: Edit; names: Map<string, string>; options: IngredientOption[]; open: boolean; busy: boolean;
  onToggle: () => void; onChange: (e: Edit) => void; onSave: () => void; onConfirm?: () => void;
}) {
  const c = useColors();
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (q.length < 2) return [];
    return options.filter((o) => !edit.ingredients.includes(o.slug) && fold(o.name).includes(q)).slice(0, 8);
  }, [query, options, edit.ingredients]);
  const understood = edit.role === "ingredient"
    ? edit.ingredients.map((s) => names.get(s) ?? s).join(", ") || "ingrédient inconnu"
    : edit.role ? ROLE_LABELS[edit.role] : "pas compris";
  const unknown = !edit.role || (edit.role === "ingredient" && !edit.ingredients.length);
  const canSave = Boolean(edit.role) && (edit.role !== "ingredient" || edit.ingredients.length > 0) && Boolean(edit.name.trim());

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: unknown ? c.accent : c.cardLine }, CARD_SHADOW]}>
      <View style={{ gap: 3 }}>
        <Text style={[styles.name, { color: c.text }]}>{edit.name}</Text>
        {product.labelRaw !== edit.name ? <Muted>Ticket : {product.labelRaw}</Muted> : null}
        <Text style={{ color: unknown ? c.orangeInk : c.greenInk, fontSize: 15, fontWeight: "600" }}>
          {edit.role === "ingredient" ? `Ingrédient : ${understood}` : understood}
        </Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {product.unknown && !edit.suggested ? <Tag label="Non reconnu" tone="orange" /> : null}
          {edit.suggested ? <Tag label="Suggestion de Mistral" icon="sparkle" /> : null}
        </View>
      </View>

      {open ? (
        <View style={{ gap: 10 }}>
          <Field value={edit.name} onChangeText={(name) => onChange({ ...edit, name })} placeholder="Nom du produit" accessibilityLabel="Nom du produit" />
          <View style={styles.wrap}>
            {ROLES.map((r) => <Chip key={r} label={ROLE_LABELS[r]} active={edit.role === r} onPress={() => onChange({ ...edit, role: r })} />)}
          </View>
          {edit.role === "ingredient" ? (
            <View style={{ gap: 8 }}>
              <Muted>Ingrédients contenus (touchez pour retirer) :</Muted>
              <View style={styles.wrap}>
                {edit.ingredients.map((s) => (
                  <Chip key={s} label={`${names.get(s) ?? s}  ×`} active onPress={() => onChange({ ...edit, ingredients: edit.ingredients.filter((x) => x !== s) })} />
                ))}
                {!edit.ingredients.length ? <Text style={{ color: c.orangeInk }}>Aucun : ajoutez-en un.</Text> : null}
              </View>
              <Field value={query} onChangeText={setQuery} placeholder="Chercher un ingrédient (ex. truite fumée)" accessibilityLabel="Chercher un ingrédient" />
              <View style={styles.wrap}>
                {matches.map((o) => (
                  <Chip key={o.slug} label={o.name} icon="plus" onPress={() => {
                    onChange({ ...edit, ingredients: [...edit.ingredients, o.slug] });
                    setQuery("");
                  }} />
                ))}
              </View>
            </View>
          ) : null}
          <Button title="Enregistrer la correction" icon="check" onPress={onSave} disabled={!canSave || busy} busy={busy} />
          <Button title="Annuler" kind="secondary" onPress={onToggle} disabled={busy} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {onConfirm ? <Button title={unknown ? "Corriger" : "C'est juste"} icon={unknown ? undefined : "check"} style={{ flex: 1 }}
            onPress={unknown ? onToggle : onConfirm} disabled={busy} busy={busy && !open} /> : null}
          {!onConfirm || !unknown ? <Button title="Corriger" kind="secondary" style={{ flex: 1 }} onPress={onToggle} disabled={busy} /> : null}
        </View>
      )}
    </View>
  );
}

/**
 * Module de correction des produits : après l'import des tickets Lidl, les nouveaux produits (les non reconnus d'abord)
 * avec ce que MenuBily en a compris ; Mistral propose une lecture des non reconnus ; le foyer valide ou corrige.
 */
export default function Produits() {
  const household = useHousehold();
  const c = useColors();
  const [items, setItems] = useState<ShopProduct[] | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [options, setOptions] = useState<IngredientOption[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<ShopProduct[]>([]);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const names = useMemo(() => new Map(options.map((o) => [o.slug, o.name])), [options]);

  const load = useCallback(async () => {
    try {
      const [list, opts] = await Promise.all([productsToReview(household.id), ingredientOptions()]);
      setOptions(opts);
      setItems(list);
      setEdits((prev) => ({ ...Object.fromEntries(list.map((p) => [p.id, prev[p.id] ?? editOf(p)])) }));
      // Lecture des produits non reconnus par Mistral (pré-remplit la correction, le foyer garde le dernier mot).
      const unknown = list.filter((p) => p.unknown).map((p) => p.id);
      if (unknown.length) {
        suggestProducts(household.id, unknown).then(({ suggestions }) => setEdits((prev) => {
          const next = { ...prev };
          for (const s of suggestions) {
            if (next[s.id] && !next[s.id]!.suggested) next[s.id] = { name: s.name, role: s.role, ingredients: s.ingredients, suggested: true };
          }
          return next;
        })).catch(() => undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [household.id]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
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

  const save = (p: ShopProduct) => run(p.id, async () => {
    const e = edits[p.id] ?? editOf(p);
    await correctProduct(p.id, e.name, e.role!, e.ingredients);
    setOpen(null);
    setItems((list) => (list ?? []).filter((x) => x.id !== p.id));
    setFound((list) => list.map((x) => (x.id === p.id ? { ...x, name: e.name, role: e.role, ingredients: e.ingredients, unknown: false } : x)));
    setInfo(`« ${e.name} » corrigé : vos achats de ce produit, passés et futurs, en tiennent compte.`);
  });

  const confirm = (p: ShopProduct) => run(p.id, async () => {
    const e = edits[p.id] ?? editOf(p);
    // Une suggestion de Mistral acceptée devient une correction du foyer.
    if (e.suggested && e.role) await correctProduct(p.id, e.name, e.role, e.ingredients);
    else await confirmProducts([p.id]);
    setItems((list) => (list ?? []).filter((x) => x.id !== p.id));
  });

  const confirmAll = () => run("all", async () => {
    const list = items ?? [];
    const ready = list.filter((p) => {
      const e = edits[p.id] ?? editOf(p);
      return e.role && (e.role !== "ingredient" || e.ingredients.length);
    });
    for (const p of ready.filter((p) => edits[p.id]?.suggested)) {
      const e = edits[p.id]!;
      await correctProduct(p.id, e.name, e.role!, e.ingredients);
    }
    await confirmProducts(ready.filter((p) => !edits[p.id]?.suggested).map((p) => p.id));
    const done = new Set(ready.map((p) => p.id));
    setItems(list.filter((p) => !done.has(p.id)));
    setInfo(`${ready.length} produit${ready.length > 1 ? "s" : ""} validé${ready.length > 1 ? "s" : ""}.`);
  });

  /** Numéro de la dernière recherche : une réponse plus ancienne, arrivée après, n'écrase pas les résultats. */
  const latest = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const find = (text: string) => {
    setSearch(text);
    // Recherche lancée quand la saisie marque une pause (pas une requête par lettre tapée).
    if (typing.current) clearTimeout(typing.current);
    typing.current = setTimeout(() => lookup(text), 250);
  };
  const lookup = async (text: string) => {
    const n = ++latest.current;
    try {
      const list = await searchProducts(household.id, text);
      if (n !== latest.current) return;
      setFound(list);
      setEdits((prev) => ({ ...Object.fromEntries(list.map((p) => [p.id, editOf(p)])), ...prev }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const card = (p: ShopProduct, review: boolean) => (
    <ProductCard key={p.id} product={p} edit={edits[p.id] ?? editOf(p)} names={names} options={options} open={open === p.id}
      busy={busy === p.id || busy === "all"} onToggle={() => setOpen(open === p.id ? null : p.id)}
      onChange={(e) => setEdits((prev) => ({ ...prev, [p.id]: { ...e, suggested: prev[p.id]?.suggested ?? false } }))}
      onSave={() => save(p)} onConfirm={review ? () => confirm(p) : undefined} />
  );

  const pending = items ?? [];
  return (
    <Screen title="Produits à vérifier">
      <Muted>
        Nouveaux produits de vos tickets Lidl. Vérifiez ce que MenuBily a compris : c'est ce qui lui dit ce que vous avez à la
        maison (la truite fumée en tranches n'est pas de la truite fraîche). Une correction vaut pour tous les achats du produit.
      </Muted>
      <ErrorText>{error}</ErrorText>
      {info ? <Text style={{ color: c.greenInk, fontSize: 15 }}>{info}</Text> : null}

      {items === null ? <Muted>Chargement…</Muted> : pending.length === 0
        ? <Muted>Rien à vérifier : tous les produits des tickets sont connus.</Muted>
        : (
          <View style={{ gap: 10 }}>
            {pending.map((p) => card(p, true))}
            {pending.length > 1 ? <Button title={`Tout valider (${pending.length})`} kind="secondary" onPress={confirmAll} busy={busy === "all"} disabled={Boolean(busy)} /> : null}
          </View>
        )}

      <View style={{ marginTop: 10 }}><SectionTitle icon="search" title="Corriger un autre produit" /></View>
      <Field value={search} onChangeText={find} placeholder="Nom du produit sur le ticket (ex. pavés de truite)" accessibilityLabel="Chercher un produit acheté" />
      <View style={{ gap: 10 }}>
        {found.filter((p) => !pending.some((x) => x.id === p.id)).map((p) => card(p, false))}
        {search.trim().length >= 2 && !found.length ? <Muted>Aucun produit acheté ne correspond.</Muted> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  name: { fontSize: 16.5, lineHeight: 21, fontWeight: "700" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
