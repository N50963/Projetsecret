# Module de synchronisation Lidl Plus (application)

Code : `app/src/modules/lidl-sync/`. Tests : `app/test/`. Migration : `supabase/migrations/20261030000003_sync_runs.sql`.

## Rôle

Depuis le téléphone, sans serveur intermédiaire vers Lidl :

1. renouveler l'accès Lidl Plus avec le refresh token gardé dans le stockage sécurisé du téléphone ;
2. trouver les tickets absents de la base (liste parcourue du plus récent au plus ancien, arrêt à la première page déjà connue) ;
3. lire chaque nouveau ticket imprimé (lignes, quantités, pesées, remises) et vérifier son total au centime ;
4. l'enregistrer dans Supabase (`import_receipt`), qui classe les nouveaux produits, retient leur contenance et
   écarte les produits non alimentaires ;
5. exposer les ingrédients achetés et leurs quantités pour la préparation des repas.

## Utilisation dans l'application

```ts
import * as SecureStore from "expo-secure-store";
import { createClient } from "@supabase/supabase-js";
import { LidlClient, createSecureTokenStore, syncNewReceipts, getIngredientPurchases } from "./modules/lidl-sync";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY); // clé publique : la sécurité repose sur RLS
const lidl = new LidlClient({ tokenStore: createSecureTokenStore(SecureStore) });

const result = await syncNewReceipts({ lidl, supabase, householdId });
// result.status : "success" | "partial" | "reauth_required" | "error"
if (result.status === "reauth_required") { /* afficher la procédure de reconnexion à Lidl Plus */ }

const achats = await getIngredientPurchases(supabase, householdId, 14);
// [{ ingredientName: "Courgette", unit: "g", totalQuantity: 1240, linesWithoutQuantity: 0, minConfidence: 1, ... }]
```

Première synchronisation d'un appareil : appeler `syncNewReceipts` avec `maxPages` plus grand (25 tickets par page).

## Garanties

- **Pas de doublon** : clé unique (foyer, source, identifiant Lidl) en base ; une relance après interruption ne réimporte rien.
- **Une seule synchronisation à la fois** par appareil ; plusieurs téléphones peuvent synchroniser le même foyer
  (chacun avec son propre refresh token, ce qui évite qu'ils s'invalident mutuellement).
- **Rotation du token** : si Lidl renvoie un nouveau refresh token, il est enregistré avant toute autre requête.
- **Tolérance aux pannes** : 429 et erreurs 5xx réessayées (1 s, 2 s, 4 s) ; un ticket en échec n'empêche pas les suivants.
- **Reconnexion** : un refresh token refusé donne le statut `reauth_required`, visible dans `sync_runs` / `last_sync`.
- **Confidentialité** : le token ne quitte jamais le téléphone et n'apparaît dans aucun journal (vérifié par un test).
- **Lecture identique au parseur Python** de l'import initial : test de parité sur 158 tickets réels (6 575 lignes)
  et 1 576 libellés. Les données réelles ne sont pas versionnées : le test s'exécute avec `LIDL_PARITY_DIR`.

## Tests

```bash
cd app && npm install && npm test          # 34 tests (parité ignorée sans LIDL_PARITY_DIR)
npm run typecheck
LIDL_LIVE_TOKEN_FILE=chemin/vers/refresh_token npx vitest run test/live.test.ts   # essai réel, sans écriture en base
```

Résultats au 2026-10-29 : 34 tests réussis dont la parité sur les tickets réels ; essai réel réussi (158 tickets listés,
dernier ticket lu et total retrouvé au centime). La fonction d'import en base a été testée dans une transaction annulée
(nouveau produit classé avec sa contenance, produit non alimentaire écarté automatiquement, total cohérent).

## Pas encore fait

- Appel depuis un vrai téléphone (les essais sont partis d'un serveur) et tâche de fond Expo (`expo-background-task`).
- Écran de connexion initiale à Lidl Plus et écran de reconnexion.
- Recherche Open Food Facts pour la contenance des nouveaux produits (aujourd'hui : contenance lue sur le ticket ou inconnue).
