# Phase 1 — Rapport de faisabilité : connecteur Lidl Plus

Date : 2026-10-28 — Statut : **analyse documentaire terminée, validation réelle NON effectuée**

> **Important.** Aucun test n'a été fait avec un vrai compte Lidl Plus français (je n'ai ni identifiants,
> ni navigateur interactif, et le login exige une résolution manuelle de reCAPTCHA). Tout ce qui suit sur le
> fonctionnement réel avec Lidl France est donc **non vérifié**. La récupération automatique ne peut pas être
> déclarée opérationnelle avant le prototype décrit en section 9.

## 1. Analyse du dépôt `yagueto/lidl-plus`

- Fork actif de `Andre0512/lidl-plus`. Dernier commit : 2026-09-25 (« Working as of 25/09/2026 », selon le README).
- Version 0.4.0, Python ≥ 3.10, ~1 000 lignes au total (`api.py` 229, `browser_auth.py` 236, `__main__.py` 223).
- **Licence : MIT** (copyright Andre Basche) → réutilisable et modifiable, avec conservation de la notice.
- Dépendances : `requests` (cœur) ; `selenium` 4 (extra `auth`, seulement pour obtenir le premier jeton).
- Tests : 16 tests unitaires du dépôt exécutés ici → **16 passés** (ils utilisent des mocks, donc ne prouvent rien sur Lidl).
- Le README prévient : endpoints rétro-ingéniérés, non officiels, « peuvent changer sans préavis ». La version PyPI
  est maintenue séparément et **n'inclut pas ce fork** → installer depuis GitHub (idéalement figé sur un commit).

## 2. Compatibilité avec Lidl France

- Le client prend `country` et `language` en paramètres (`FR` / `fr`) : le code est générique, rien n'est codé en dur
  pour un pays. Le README ne montre que des exemples `de/AT`.
- **Non vérifié** : tickets numériques réellement disponibles pour un compte FR, contenu du `htmlPrintedReceipt`
  français, présence de v2 vs v3 pour la France (le code essaie v2 puis retombe sur v3).
- Risque spécifique : le parseur de lignes devra être écrit/validé sur de vrais tickets FR (le format varie selon les pays).

## 3. Authentification, jetons, dépendances

Flux (lu dans `api.py` / `browser_auth.py`) :
1. OAuth2 code d'autorisation + PKCE (`LidlPlusNativeClient`, scope `openid profile offline_access lpprofile lpapis`).
2. Connexion dans un **vrai navigateur visible** (Selenium) : la page utilise des contrôles d'appareil et **reCAPTCHA** ;
   le mode headless « peut être rejeté ». L'utilisateur doit résoudre le défi.
3. Échange du code contre `access_token` + `refresh_token` (`POST accounts.lidl.com/connect/token`).
4. Ensuite, plus de navigateur : `refresh_token` → `access_token` automatiquement (marge de 30 s avant expiration).
5. **Lidl fait tourner le refresh token** : il faut persister le nouveau jeton après chaque appel authentifié.

Conséquences d'architecture :
- La connexion initiale **ne peut pas** être faite par le service cloud : elle se fait sur la machine de l'utilisateur
  (CLI `lidl-plus auth`) ou via un flux dédié, puis le `refresh_token` est transmis de façon sécurisée au service.
  Nous ne contournerons ni le reCAPTCHA ni les contrôles d'appareil (exigence du cahier des charges).
- Rotation : écriture atomique du nouveau jeton **avant** de continuer ; un verrou évite deux synchros simultanées
  qui s'invalideraient mutuellement.
- Durée de vie du refresh token inconnue → à mesurer pendant le prototype. Une expiration/révocation est
  attendue un jour : état `reauth_required` visible dans l'app + procédure de réauthentification.

## 4. Récupération automatique des tickets

- `tickets()` : liste paginée (`pageNumber`, `totalCount`). `ticket(id)` : détail complet (v2, repli v3).
- Le détail contient (d'après l'article de référence) un `htmlPrintedReceipt` ; le détail structuré exact
  (lignes, quantités, remises) **reste à constater** sur un ticket réel FR.
- Idempotence : clé `(source, external_ticket_id)` unique en base + `INSERT … ON CONFLICT DO NOTHING`.
- On stocke toujours le JSON brut + le HTML d'origine, pour pouvoir re-parser sans perdre l'original.

## 5. Choix d'hébergement

| Option | Avantages | Inconvénients |
|---|---|---|
| **Google Cloud Run (job) + Cloud Scheduler** — *recommandé* | Exécute le Python tel quel (conteneur), facturation à l'usage, 3 jobs Scheduler gratuits/compte, Secret Manager | Compte de facturation GCP à créer, un peu de configuration |
| Render (Cron Job) | Très simple | Cron jobs payants (minimum mensuel), moins de contrôle des secrets |
| Réécriture en Edge Function Supabase (TS) | Tout dans Supabase | Le code est petit, mais la **connexion initiale** reste hors Supabase, et on perd les mises à jour du fork ; à n'envisager que si Cloud Run pose problème |
| GitHub Actions planifié | Gratuit | Pas fait pour ça ; secrets/rotation du jeton peu adaptés ; pas recommandé |

Recommandation : **Cloud Run Job** (conteneur Python) déclenché 1×/jour par **Cloud Scheduler**, avec un service HTTP
séparé (ou le même job paramétré) pour « Synchroniser maintenant » (appelé via une Edge Function authentifiée).
Le refresh token est stocké dans **Secret Manager** (ou table Supabase non exposée, accessible via `service_role`
uniquement, chiffrée avec `pgsodium`/Vault). Décision à valider (section 10).

## 6. Estimation des coûts (usage domestique, 1 foyer)

Chiffres tirés de recherches web, **à re-vérifier sur les pages officielles** avant décision :

| Poste | Estimation | Source / remarque |
|---|---|---|
| Cloud Run | ~0 € (une exécution quotidienne de quelques secondes reste très en dessous du quota gratuit : 180 000 vCPU-s, 2 M requêtes/mois) | [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| Cloud Scheduler | 0 € (3 jobs gratuits par compte de facturation, ensuite 0,10 $/job/mois) | [Scheduler pricing](https://cloud.google.com/scheduler/pricing) |
| Supabase | **Free : 0 €**, mais projet **mis en pause après 1 semaine d'inactivité** (la synchro quotidienne compte comme activité, à vérifier). **Pro : 25 $/mois** si on veut de la fiabilité | [Supabase pricing](https://supabase.com/pricing) |
| Mistral API | Quelques centimes/mois. Ordre de grandeur annoncé par des sources tierces (non officielles, divergentes) : Small ≈ 0,1–0,15 $ / 0,3–0,6 $ par million de tokens ; Large 3 ≈ 0,5 $ / 1,5 $ | à vérifier sur docs.mistral.ai |
| Secret Manager | ~0 € (quelques secrets) | à vérifier |

Total réaliste : **0–2 €/mois** avec Supabase Free, **≈ 25–27 $/mois** avec Supabase Pro.
Point de décision : la mise en pause du plan Free est un risque de fiabilité (cahier des charges : ne pas sacrifier la fiabilité).

## 7. Risques techniques et solutions de repli

| Risque | Gravité | Repli |
|---|---|---|
| Lidl change les endpoints / l'authentification (API non officielle) | Élevée | Épingler une version du fork, suivre les issues amont, tests de contrat sur ticket réel anonymisé, mode dégradé (app utilisable avec les données déjà stockées) |
| Refresh token expiré/révoqué | Élevée | Détection 400/401 → `reauth_required`, notification, procédure de reconnexion guidée ; l'automatisation reprend ensuite |
| reCAPTCHA / blocage d'IP datacenter sur les appels API | Moyenne | À tester depuis Cloud Run ; repli : import manuel (HTML/JSON/photo du ticket) via Mistral |
| Rotation du jeton perdue (crash entre appel et sauvegarde) | Moyenne | Persistance immédiate du nouveau jeton, verrou, journal sans jeton |
| Format HTML/JSON du ticket FR différent | Moyenne | Parseur versionné, brut conservé, ré-analyse possible |
| Conditions d'utilisation de Lidl (usage non officiel) | À évaluer | Usage strictement personnel sur son propre compte ; décision humaine requise |
| Mistral renvoie un JSON invalide/erroné | Moyenne | Schémas stricts, validation, jamais de décision de stock fondée sur l'IA seule |

## 8. Proposition de schéma Supabase (résumé)

Tables du cahier des charges conservées, regroupées en domaines (détail et migrations en Phase 2) :

- **Foyer** : `households`, `household_members(role)`, `user_preferences`, `dietary_restrictions(kind: allergy|intolerance|restriction|preference, strict bool)`.
- **Achats** : `receipt_sources`, `receipts(UNIQUE source_id, external_id; raw_json; raw_html; sync_status)`, `receipt_items(label_raw, qty, unit, unit_price, total, discount)`, `products`, `product_ingredient_mappings(confidence, validated_by_user)`.
- **Stocks** : `ingredients`, `ingredient_aliases`, `stock_items`, `stock_movements(type, qty, source, confirmed)`, `pantry_defaults`.
- **Recettes** : `recipes`, `recipe_versions` (jamais d'écrasement), `recipe_ingredients`, `recipe_steps`, `recipe_tags`, `recipe_ratings`, `recipe_sources`.
- **Planning** : `meal_plans`, `planned_meals`, `meal_candidates(score, breakdown jsonb)`, `prepared_meals`.
- **Nutrition** : `nutrition_references` (Ciqual), `ingredient_nutrition_mappings`, `recipe_nutrition_estimates`.
- **Technique** : `integration_connections` (aucun jeton côté client), `sync_runs`, `sync_cursors`, `processing_jobs`, `ai_processing_logs` (sans données sensibles).
- RLS partout, via une fonction `is_household_member(household_id)` ; jetons Lidl dans Secret Manager/Vault, lisibles uniquement par `service_role`.

## 9. Plan de développement détaillé

0. **Prototype Lidl (bloquant)** — à faire avec vous :
   1. Installer le fork, `lidl-plus --language fr --country FR auth` sur votre ordinateur (résolution manuelle du reCAPTCHA).
   2. `receipt --limit 1` : vérifier qu'un ticket FR est renvoyé ; enregistrer (anonymisé) le JSON/HTML.
   3. Script d'ingestion vers un projet Supabase de test ; relancer → 0 doublon.
   4. Même script dans un conteneur Cloud Run Job, token via Secret Manager ; vérifier la rotation après 2 exécutions espacées.
   5. Laisser tourner 1×/jour pendant ≥ 7 jours : mesurer la durée de vie du jeton.
   6. Rapport de résultats ; décision go/no-go.
1. Phases 2 à 10 comme définies dans le cahier des charges (fondations Expo/TS + Supabase + RLS, référentiels, sync de production, stocks, Mistral, planification, préférences/équilibre, courses, finalisation), chaque phase terminée par ses tests.
2. Fichier de suivi : `TASKS.md` à la racine, mis à jour à chaque étape.

## 10. Décisions humaines nécessaires

1. **Hébergement** : Cloud Run + Scheduler (recommandé) — d'accord pour créer un compte GCP ?
2. **Supabase Free ou Pro** (pause d'inactivité vs 25 $/mois).
3. **Acceptation du risque** lié à l'API non officielle et aux CGU de Lidl (usage personnel).
4. **Stockage du refresh token** : Secret Manager (recommandé) ou Supabase Vault.
5. **Fourniture du jeton** : acceptez-vous de lancer vous-même la connexion initiale sur votre ordinateur (nécessaire à cause du reCAPTCHA) ?
6. Périmètre : application utilisée par un seul foyer, ou multi-foyers dès le départ ?
7. Suivi nutritionnel chiffré (Ciqual) : retenu dès la V1 ou plus tard ?

## Verdict provisoire

**Faisable sous réserve de validation réelle.** Le connecteur est petit, sous licence MIT, récent et testé ; l'hébergement
Cloud Run convient. Le point dur est la connexion initiale (reCAPTCHA, non automatisable) et la pérennité d'une API non
officielle. Aucune suite du développement ne devrait commencer avant le prototype de la section 9.0.

Sources : [yagueto/lidl-plus](https://github.com/yagueto/lidl-plus), [Andre0512/lidl-plus](https://github.com/Andre0512/lidl-plus),
[Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing),
[Supabase pricing](https://supabase.com/pricing).
