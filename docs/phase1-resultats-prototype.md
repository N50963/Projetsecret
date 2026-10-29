# Phase 1 : résultats du prototype Lidl Plus France

Date : 2026-10-29. Complète `phase1-rapport-faisabilite.md` (analyse documentaire) avec ce qui a été
réellement testé sur un compte Lidl Plus français.

## Architecture retenue (change par rapport au rapport initial)

- Chaque téléphone se connecte **directement** à Lidl (aucun serveur intermédiaire pour Lidl) et garde
  son propre refresh token dans le stockage sécurisé du téléphone.
- **Supabase sert uniquement de stockage partagé** (tickets, produits, plus tard menus et préférences)
  entre les téléphones du foyer. Accès isolé par foyer (RLS).
- Conséquence : la synchronisation application fermée dépend des tâches de fond du téléphone (non garanties).
  Un bouton « Synchroniser maintenant » et une synchro à l'ouverture complètent.

## Ce qui est démontré

| Point | Résultat |
|---|---|
| Connexion initiale | Faite à la main dans le navigateur de l'utilisateur (reCAPTCHA), script `tools/lidl_manual_auth.py`. Le login piloté par Selenium a reçu « surcapacité » de Lidl. |
| Renouvellement du token | `POST accounts.lidl.com/connect/token` : 200. Le refresh token n'a pas été renouvelé par Lidl lors du test. Access token : 1200 s. |
| Liste des tickets | `GET tickets.lidlplus.com/api/v2/FR/tickets` : 200, 158 tickets (du 2022-04-22 au 2026-10-29), pages de 25. |
| Détail d'un ticket | **v2 renvoie 400 pour la France, v3 renvoie 200.** Le détail contient `htmlPrintedReceipt`, pas de lignes structurées. |
| Extraction des lignes | `services/lidl/lidl_parse.py` : 158/158 tickets, 6 575 lignes. Pour chaque ticket, somme des lignes + remises = « À payer » = `totalAmount` de l'API (au centime). |
| Import dans Supabase | 158 tickets sans doublon. Relance du même ticket : aucun doublon (clé unique sur l'identifiant Lidl). |

## Particularités du format Lidl France

- Le nom visible dans le ticket est correct (entités HTML) ; l'attribut `data-art-description` est abîmé (accents remplacés).
- Les noms sont tronqués à 20 caractères. Un code article peut porter plusieurs noms : un produit est donc identifié par (code article, libellé).
- Articles au poids : une ligne de prix suivie d'une ligne « 1,336 kg x 4,99 EUR/kg ».
- Remises : lignes « Prix en baisse », « Réduction Lidl Plus » ou « Coup de pouce », rattachées à l'article précédent.
- Articles de bazar : libellé mélangé au code article (« Rideau éto' '0427693 »).
- « FM » sur les tickets = Fleury Michon (confirmé par l'utilisateur).

## Noms de produits

Sur 1 624 produits initiaux : 1 141 noms complets, 483 de 20 caractères ou plus à vérifier. Résolus avec l'utilisateur
ou proposés puis relus. Les produits non alimentaires (155) ont été retirés de la base et placés dans une liste
d'exclusion. Le tri non alimentaire est fait par mots-clés : un second passage avec Mistral reste à faire.

## Non encore démontré

- Durée de vie réelle du refresh token (à mesurer sur plusieurs jours).
- Appel direct depuis un téléphone (le test est parti d'un serveur) et comportement de Lidl selon l'adresse IP.
- Synchronisation automatique de fond sur mobile.
- Effet de l'ajout d'un nouvel appareil sur les sessions des téléphones existants.
