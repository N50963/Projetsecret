import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { Body, Button, Card, Chip, ErrorText, H2, Muted, Row, Screen } from "../components/ui";
import { dayLabel, minutes } from "../lib/format";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { addDays, savePlan, toIsoDate, weekDates, type SlotRequest } from "../modules/planning";
import type { MealType } from "../modules/recipes";

const TIMES: Array<number | null> = [20, 30, 45, 60, 90, null];
const nextTime = (t: number | null) => TIMES[(TIMES.indexOf(t) + 1) % TIMES.length] ?? null;

interface Choice {
  diner: boolean;
  dejeuner: boolean;
  /** Temps propre à ce jour ; undefined : temps général. */
  time?: number | null;
}

/** Choix des repas de la semaine pour lesquels un menu est demandé, et du temps disponible. */
export default function Semaine() {
  const router = useRouter();
  const household = useHousehold();
  const start = toIsoDate(new Date());
  const days = useMemo(() => weekDates(start), [start]);
  const [choices, setChoices] = useState<Record<string, Choice>>(() => Object.fromEntries(days.map((d) => [d, { diner: true, dejeuner: false }])));
  const [defaultTime, setDefaultTime] = useState<number | null>(45);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Repas déjà choisis cette semaine : ils restent cochés.
  useEffect(() => {
    supabase.from("meal_slots").select("meal_date, meal_type, status, max_total_min").eq("household_id", household.id)
      .gte("meal_date", start).lte("meal_date", addDays(start, 6)).then(({ data }) => {
        if (!data?.length) return;
        setChoices((prev) => {
          const next = { ...prev };
          for (const s of data) {
            const c: Choice = { ...(next[s.meal_date] ?? { diner: false, dejeuner: false }) };
            c[s.meal_type as MealType] = s.status !== "skipped";
            next[s.meal_date] = c;
          }
          return next;
        });
        setAccepted(new Set(data.filter((s) => s.status === "accepted").map((s) => `${s.meal_date}:${s.meal_type}`)));
      });
  }, [household.id, start]);

  const toggle = (date: string, meal: MealType) =>
    setChoices((p) => ({ ...p, [date]: { ...p[date]!, [meal]: !p[date]![meal] } }));
  const cycleTime = (date: string) =>
    setChoices((p) => ({ ...p, [date]: { ...p[date]!, time: nextTime(p[date]!.time === undefined ? defaultTime : p[date]!.time!) } }));

  const requests: SlotRequest[] = days.flatMap((d) => (["dejeuner", "diner"] as MealType[])
    .filter((m) => choices[d]?.[m])
    .map((m) => ({ date: d, mealType: m, maxTotalMin: choices[d]?.time === undefined ? defaultTime : choices[d]!.time!, servings: household.defaultServings })));

  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const { planId } = await savePlan(supabase, household.id, start, addDays(start, 6), requests);
      router.push({ pathname: "/propositions", params: { plan: planId, start } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Menus de la semaine">
      <Card>
        <H2>Temps disponible</H2>
        <Muted>Préparation et cuisson comprises, pour chaque repas (modifiable jour par jour).</Muted>
        <Row>{TIMES.map((t) => <Chip key={String(t)} label={minutes(t)} active={defaultTime === t} onPress={() => setDefaultTime(t)} />)}</Row>
      </Card>
      <Card>
        <H2>Repas à prévoir</H2>
        {days.map((d) => {
          const c = choices[d]!;
          const time = c.time === undefined ? defaultTime : c.time;
          return (
            <View key={d} style={{ gap: 6, paddingVertical: 4 }}>
              <Body style={{ fontWeight: "600" }}>{dayLabel(d, start)}</Body>
              <Row>
                <Chip label={accepted.has(`${d}:dejeuner`) ? "Déjeuner ✓" : "Déjeuner"} active={c.dejeuner} onPress={() => toggle(d, "dejeuner")} />
                <Chip label={accepted.has(`${d}:diner`) ? "Dîner ✓" : "Dîner"} active={c.diner} onPress={() => toggle(d, "diner")} />
                {(c.diner || c.dejeuner) && <Chip label={`⏱ ${minutes(time)}`} onPress={() => cycleTime(d)} />}
              </Row>
            </View>
          );
        })}
        <Muted>✓ : menu déjà choisi. Touchez ⏱ pour changer le temps d'un jour.</Muted>
      </Card>
      <ErrorText>{error}</ErrorText>
      <Button title={`Proposer les menus (${requests.length} repas)`} onPress={go} busy={busy} disabled={!requests.length} />
    </Screen>
  );
}
