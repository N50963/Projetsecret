import { useEffect, useState } from "react";
import { StyleSheet, TextInput } from "react-native";

import { Body, Button, Card, Chip, ErrorText, H2, Loading, Muted, Row, Screen } from "../components/ui";
import { useHousehold, useSession } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import { getHouseholdPreferences, saveHouseholdPreferences, type FoodGroup, type HouseholdPreferences, type SpiceLevel } from "../modules/recipes";

const GROUPS: Array<[FoodGroup, string]> = [
  ["abats", "Abats"], ["coquillages", "Coquillages"], ["crustaces", "Crustacés"], ["porc", "Porc"], ["boeuf", "Bœuf"],
  ["agneau", "Agneau"], ["poisson", "Poisson"], ["champignons", "Champignons"],
];
const SPICES: Array<[SpiceLevel, string]> = [["aucun", "Rien d'épicé"], ["doux", "Doux, rien de piquant"], ["tout", "Tout"]];
const ALLERGENS: Array<[string, string]> = [["gluten", "Gluten"], ["lait", "Lait"], ["oeuf", "Œuf"], ["fruits_a_coque", "Fruits à coque"],
  ["poisson", "Poisson"], ["crustaces", "Crustacés"], ["soja", "Soja"], ["sesame", "Sésame"]];

/** Préférences du foyer : appliquées d'office aux propositions de menus et aux idées de Mistral. */
export default function Preferences() {
  const household = useHousehold();
  const { session, changePassword } = useSession();
  const c = useColors();
  const [prefs, setPrefs] = useState<HouseholdPreferences | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    getHouseholdPreferences(supabase, household.id).then(setPrefs).catch((e) => setError(String(e)));
  }, [household.id]);

  if (!prefs) return error ? <Screen title="Préférences"><ErrorText>{error}</ErrorText></Screen> : <Loading />;
  const set = (patch: Partial<HouseholdPreferences>) => {
    setPrefs({ ...prefs, ...patch });
    setMessage("");
  };
  const toggleIn = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const count = (label: string, key: "adults" | "teens" | "children") => (
    <Row>
      <Body style={{ minWidth: 110 }}>{label}</Body>
      <Chip label="−" onPress={() => set({ [key]: Math.max(0, prefs[key] - 1) })} />
      <Body>{prefs[key]}</Body>
      <Chip label="+" onPress={() => set({ [key]: Math.min(10, prefs[key] + 1) })} />
    </Row>
  );

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await saveHouseholdPreferences(supabase, household.id, prefs);
      setMessage("Préférences enregistrées.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    setPasswordMessage("");
    if (password.length < 8) return setPasswordMessage("8 caractères au moins.");
    if (password !== confirm) return setPasswordMessage("Les deux saisies sont différentes.");
    try {
      await changePassword(password);
      setPassword("");
      setConfirm("");
      setPasswordMessage("Mot de passe changé : utilisez-le aussi sur l'autre téléphone.");
    } catch (e) {
      setPasswordMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const input = [styles.input, { backgroundColor: c.background, borderColor: c.border, color: c.text }];

  return (
    <Screen title="Préférences">
      <Card>
        <H2>Le foyer</H2>
        {count("Adultes", "adults")}
        {count("Adolescents", "teens")}
        {count("Enfants", "children")}
      </Card>
      <Card>
        <H2>Épices</H2>
        <Row>{SPICES.map(([v, l]) => <Chip key={v} label={l} active={prefs.spiceLevel === v} onPress={() => set({ spiceLevel: v })} />)}</Row>
      </Card>
      <Card>
        <H2>Jamais proposé</H2>
        <Row>{GROUPS.map(([v, l]) => <Chip key={v} label={l} active={prefs.excludedFoodGroups.includes(v)}
          onPress={() => set({ excludedFoodGroups: toggleIn(prefs.excludedFoodGroups, v) })} />)}</Row>
      </Card>
      <Card>
        <H2>Allergies</H2>
        <Row>{ALLERGENS.map(([v, l]) => <Chip key={v} label={l} active={prefs.excludedAllergens.includes(v)}
          onPress={() => set({ excludedAllergens: toggleIn(prefs.excludedAllergens, v) })} />)}</Row>
      </Card>
      <Card>
        <H2>Soirs sans viande ni poisson</H2>
        <Muted>Par semaine : {prefs.meatlessDinnersMin} à {prefs.meatlessDinnersMax}</Muted>
        <Row>{[[0, 1], [1, 2], [2, 3], [3, 4]].map(([a, b]) => (
          <Chip key={`${a}-${b}`} label={`${a} à ${b}`} active={prefs.meatlessDinnersMin === a && prefs.meatlessDinnersMax === b}
            onPress={() => set({ meatlessDinnersMin: a!, meatlessDinnersMax: b! })} />
        ))}</Row>
      </Card>
      <ErrorText>{error}</ErrorText>
      {message ? <Body>{message}</Body> : null}
      <Button title="Enregistrer" onPress={save} busy={busy} />
      <Card>
        <H2>Compte</H2>
        <Muted>{session?.user.email}</Muted>
        <TextInput style={input} placeholder="Nouveau mot de passe" placeholderTextColor={c.muted} secureTextEntry
          autoComplete="new-password" value={password} onChangeText={setPassword} />
        <TextInput style={input} placeholder="Nouveau mot de passe (confirmation)" placeholderTextColor={c.muted} secureTextEntry
          autoComplete="new-password" value={confirm} onChangeText={setConfirm} />
        {passwordMessage ? <Body>{passwordMessage}</Body> : null}
        <Button title="Changer le mot de passe" kind="secondary" onPress={savePassword} disabled={!password} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 16 },
});
