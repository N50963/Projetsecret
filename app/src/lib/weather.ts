/**
 * Prévisions de la commune du foyer (Open-Meteo : gratuit, sans compte ni clé ; modèles de Météo-France pour la France).
 * Supabase les lit chaque heure pour chaque commune des foyers et les garde (table weather_days). La commune vient du
 * foyer du compte connecté (`setWeatherPlace`, appelé au chargement du foyer) ; en attendant, celle de la dernière
 * ouverture, gardée sur le téléphone avec la prévision.
 *
 * L'application ne relit la prévision qu'à son ouverture : au lancement, et au retour au premier plan après au moins
 * 30 minutes en arrière-plan (`refreshWeather`, appelé par la racine de l'application). Pendant l'utilisation, tous les
 * écrans se servent de cette lecture (`loadWeather`, `useWeather`), sans nouvel appel réseau.
 * Le téléphone lit la table de Supabase, et n'interroge Open-Meteo lui-même qu'en secours (table vide ou prévision de
 * plus de 6 heures). Gardée sur le téléphone : hors réseau, la dernière prévision sert encore deux jours, sinon la météo
 * ne compte pas dans le choix des menus.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

import type { DayWeather } from "../modules/planning";
import { supabase } from "./supabase";

/** Commune d'un foyer et clé de sa prévision dans weather_days. */
export interface WeatherPlace {
  key: string;
  name: string;
  latitude: number;
  longitude: number;
}

/** Rochefort-du-Gard (30650) : commune du premier foyer, et par défaut avant le chargement du foyer. */
export const DEFAULT_PLACE: WeatherPlace = { key: "rochefort-du-gard", name: "Rochefort-du-Gard", latitude: 43.976, longitude: 4.691 };
/** Prévision de Supabase trop ancienne au-delà : lecture directe d'Open-Meteo. */
const SERVER_STALE_MS = 6 * 60 * 60 * 1000;
const KEY = "meteo-v2";
const STALE_MS = 2 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
/** Retour au premier plan après cette absence : compté comme une nouvelle ouverture. */
export const REOPEN_AFTER_MS = 30 * 60 * 1000;

const urlOf = (p: WeatherPlace) => "https://api.open-meteo.com/v1/forecast"
  + `?latitude=${p.latitude.toFixed(3)}&longitude=${p.longitude.toFixed(3)}`
  + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
  + "&timezone=Europe%2FParis&forecast_days=16";

interface Saved {
  at: number;
  /** Commune de cette prévision. */
  place: WeatherPlace;
  days: Record<string, DayWeather>;
}

const EMPTY: Record<string, DayWeather> = {};
let memory: Saved | null = null;
/** Commune en usage (null tant que ni le foyer ni la prévision gardée ne l'ont donnée). */
let place: WeatherPlace | null = null;
/** Prévision en usage (celle de la dernière ouverture), pour les écrans. */
let current: Record<string, DayWeather> = EMPTY;
/** Lecture de la dernière ouverture (en cours ou terminée). */
let opening: Promise<Record<string, DayWeather>> | null = null;
const listeners = new Set<() => void>();

function publish(days: Record<string, DayWeather>) {
  current = days;
  listeners.forEach((l) => l());
}

/** Prévision gardée par Supabase (null si absente, trop ancienne ou illisible). */
async function serverDays(p: WeatherPlace): Promise<Record<string, DayWeather> | null> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from("weather_days").select("day, t_min, t_max, rain_mm, code, fetched_at")
    .eq("place", p.key).gte("day", since).order("day").limit(40);
  if (error || !data?.length) return null;
  const newest = Math.max(...data.map((d) => Date.parse(d.fetched_at as string)));
  if (!(Date.now() - newest < SERVER_STALE_MS)) return null;
  return Object.fromEntries(data.map((d) => [d.day as string, {
    date: d.day as string, tMin: Number(d.t_min), tMax: Number(d.t_max), rainMm: Number(d.rain_mm), code: Number(d.code),
  }]));
}

async function fetchDays(p: WeatherPlace): Promise<Record<string, DayWeather>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(urlOf(p), { signal: ctrl.signal });
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

/**
 * Ouverture de l'application : prévision relue (Supabase, sinon Open-Meteo), publiée pour tous les écrans. La prévision
 * gardée sur le téléphone s'affiche tout de suite en attendant.
 */
export function refreshWeather(): Promise<Record<string, DayWeather>> {
  opening = (async () => {
    if (!memory) {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (raw) memory = JSON.parse(raw) as Saved;
      } catch {
        // Pas de prévision gardée.
      }
    }
    // Commune : celle du foyer si elle est déjà connue, sinon celle de la dernière ouverture.
    if (!place) setPlace(memory?.place ?? DEFAULT_PLACE);
    const p = place!;
    const kept = () => (memory && memory.place.key === p.key && Date.now() - memory.at < STALE_MS ? memory.days : EMPTY);
    if (current === EMPTY && kept() !== EMPTY) publish(kept());
    try {
      const days = (await serverDays(p).catch(() => null)) ?? (await fetchDays(p));
      // Commune changée pendant la lecture (autre compte, nouvelle commune) : cette prévision ne sert plus.
      if (place?.key !== p.key) return current;
      memory = { at: Date.now(), place: p, days };
      AsyncStorage.setItem(KEY, JSON.stringify(memory)).catch(() => undefined);
      publish(days);
      return days;
    } catch {
      if (place?.key !== p.key) return current;
      publish(kept());
      return kept();
    }
  })();
  return opening;
}

function setPlace(p: WeatherPlace) {
  place = p;
  listeners.forEach((l) => l());
}

/**
 * Commune du foyer du compte connecté (au chargement du foyer, et quand le foyer en choisit une autre). Une autre
 * commune que celle en usage : la prévision affichée est effacée et celle de la nouvelle commune est lue.
 */
export function setWeatherPlace(p: WeatherPlace) {
  if (place?.key === p.key) {
    if (place.name !== p.name) setPlace(p);
    return;
  }
  const first = place === null;
  setPlace(p);
  // Première commune connue avant toute lecture : la lecture de l'ouverture (en cours ou à venir) l'utilisera.
  if (first && !opening) return;
  publish(EMPTY);
  refreshWeather().catch(() => undefined);
}

/** Prévision de la dernière ouverture (attend sa lecture si elle est en cours ; aucune nouvelle lecture). */
export function loadWeather(): Promise<Record<string, DayWeather>> {
  return opening ?? refreshWeather();
}

/** Prévision en usage, mise à jour à chaque ouverture de l'application. */
export function useWeather(): Record<string, DayWeather> {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, () => current);
}

/** Nom de la commune de la météo (celle du foyer), pour les textes. */
export function useWeatherPlace(): string {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, () => (place ?? DEFAULT_PLACE).name);
}

/** Prévision déjà connue d'un jour, sans attendre. */
export const weatherOf = (date: string): DayWeather | undefined => current[date];
