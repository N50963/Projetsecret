/**
 * Mise en page selon la largeur de l'écran. Un téléphone plié garde la présentation d'origine ; un grand écran (Galaxy
 * Z Fold déplié : environ 880 à 1 000 points de large, presque carré, en portrait comme en paysage ; tablette) reçoit
 * une présentation adaptée : texte et formulaires dans une colonne centrée de largeur confortable, grilles à plusieurs
 * colonnes, fiche recette avec les ingrédients et la préparation côte à côte.
 *
 * La largeur suit l'écran en direct (useWindowDimensions) : plier ou déplier le téléphone change la présentation sans
 * relancer l'application (MainActivity gère screenSize et smallestScreenSize).
 */

import { useWindowDimensions } from "react-native";

/** Écran large à partir de cette largeur (en points). */
export const WIDE_MIN = 700;
/** Largeur maximale d'une colonne de texte ou de formulaire sur grand écran. */
export const COLUMN_MAX = 720;
/** Largeur maximale de la carte des propositions sur grand écran. */
export const CARD_MAX = 760;

export function useLayout() {
  const { width, height } = useWindowDimensions();
  return { width, height, wide: width >= WIDE_MIN };
}

/** Nombre de colonnes d'une grille : cases d'au moins `min` points, entre 1 et `max` colonnes. */
export function columnsFor(width: number, min: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(width / min)));
}

/** Marge de chaque côté pour centrer un contenu de largeur `max` (au moins `min`). */
export function sideMargin(width: number, max: number, min = 14): number {
  return Math.max(min, Math.round((width - max) / 2));
}
