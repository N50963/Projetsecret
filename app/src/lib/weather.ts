/**
 * Prévisions de Rochefort-du-Gard (Open-Meteo : gratuit, sans compte ni clé ; modèles de Météo-France pour la France).
 * Lues au plus une fois par heure, gardées sur le téléphone : hors réseau, la dernière prévision sert encore deux jours,
 * sinon la météo ne compte pas dans le choix des menus.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { DayWeather } from "../modules/planning";

/** Rochefort-du-Gard (30650). */
export const PLACE = { name: "Rochefort-du-Gard", latitude: 43.976, longitude: 4.691 };
const KEY = "meteo-v1";
const FRESH_MS = 60 * 60 * 1000;
const STALE_MS = 2 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

const URL = "https://api.open-meteo.com/v1/forecast"
  + `?latitude=${PLACE.latitude}&longitude=${PLACE.longitude}`
  + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
  + "&timezone=Europe%2FParis&forecast_days=16";

interface Saved {
  at: number;
  days: Record<string, DayWeather>;
}

let memory: Saved | null = null;
let loading: Promise<Record<string, DayWeather>> | null = null;

async function fetchDays(): Promise<Record<string, DayWeather>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Météo indisponible (${res.status})`);
    const d = (await res.json()).daily as Record<string, Array<number | string | null>>;
    const days: Record<string, DayWeather> = {};
    (d.time ?? []).forEach((date, i) => {
      const tMax = d.temperature_2m_max?.[i];
      const tMin = d.temperature_2m_min?.[i];
      if (typeof date !== "string" || typeof tMax !== "number" || typeof tMin !== "number") return;
      days[date] = { date, tMin, tMax, rainMm: Number(d.precipitation_sum?.[i] ?? 0), code: Number(d.weather_code?.[i] ?? 3) };
    });
    return days;
  } finally {
    clearTimeout(timer);
  }
}

/** Prévisions par jour (vide si elles n'ont jamais pu être lues). */
export function loadWeather(): Promise<Record<string, DayWeather>> {
  loading ??= (async () => {
    if (!memory) {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (raw) memory = JSON.parse(raw) as Saved;
      } catch {
        // Pas de prévision gardée.
      }
    }
    if (memory && Date.now() - memory.at < FRESH_MS) return memory.days;
    try {
      const days = await fetchDays();
      memory = { at: Date.now(), days };
      AsyncStorage.setItem(KEY, JSON.stringify(memory)).catch(() => undefined);
      return days;
    } catch {
      return memory && Date.now() - memory.at < STALE_MS ? memory.days : {};
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** Prévision déjà connue d'un jour, sans attendre. */
export const weatherOf = (date: string): DayWeather | undefined => memory?.days[date];
