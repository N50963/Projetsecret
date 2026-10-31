/**
 * Minuteurs de cuisson. Ils continuent quand on change d'écran ; le temps restant est calculé d'après l'heure de fin, donc
 * juste même si l'application a été mise en arrière-plan. À la fin : vibration et message (au retour dans l'application).
 */

import { useSyncExternalStore } from "react";
import { Alert, Vibration } from "react-native";

export interface CookingTimer {
  id: string;
  recipeId: string;
  /** Texte court affiché dans la barre des minuteurs (« Étape 3 · 8 min »). */
  label: string;
  /** Rappel de l'étape, montré quand le minuteur sonne. */
  detail: string;
  endsAt: number;
  done: boolean;
}

interface Snapshot {
  timers: CookingTimer[];
  now: number;
}

let snapshot: Snapshot = { timers: [], now: Date.now() };
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function publish(timers: CookingTimer[]) {
  snapshot = { timers, now: Date.now() };
  listeners.forEach((l) => l());
}

function ring(t: CookingTimer) {
  Vibration.vibrate([0, 700, 400, 700, 400, 700]);
  Alert.alert("Minuteur terminé", `${t.label}\n\n${t.detail}`);
}

function tick() {
  const now = Date.now();
  const timers = snapshot.timers.map((t) => {
    if (t.done || t.endsAt > now) return t;
    ring(t);
    return { ...t, done: true };
  });
  publish(timers);
  if (!timers.some((t) => !t.done) && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function startTimer(recipeId: string, label: string, detail: string, seconds: number) {
  publish([...snapshot.timers, { id: `${Date.now()}-${snapshot.timers.length}`, recipeId, label, detail, endsAt: Date.now() + seconds * 1000, done: false }]);
  ticker ??= setInterval(tick, 1000);
}

export function stopTimer(id: string) {
  publish(snapshot.timers.filter((t) => t.id !== id));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Minuteurs en cours ou terminés (jusqu'à ce qu'on les ferme), avec l'heure du dernier calcul. */
export function useTimers(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
