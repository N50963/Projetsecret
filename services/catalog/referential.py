"""Référentiel d'ingrédients culinaires et règles de classement des produits Lidl.

Les règles s'appliquent au nom normalisé du produit (minuscules, sans accents, mots séparés par
un espace, entouré d'espaces : " filets de poulet jaune "). Elles n'utilisent que des motifs
compatibles à la fois avec Python `re` et les expressions régulières de PostgreSQL, pour que la
base applique exactement les mêmes règles aux nouveaux tickets (voir sql.py).

La première règle qui correspond l'emporte : les règles spécifiques sont placées avant les génériques.
"""

import re
import unicodedata

# Rôles d'un produit dans le foyer.
ROLES = {
    "non_food": "Non alimentaire (retiré de la base)",
    "ingredient": "Ingrédient de cuisine",
    "prepared_meal": "Plat préparé",
    "dessert": "Dessert",
    "snack": "En-cas, apéritif, confiserie",
    "breakfast": "Petit-déjeuner",
    "beverage": "Boisson",
    "bread": "Pain",
}

CATEGORIES = (
    "legume", "fruit", "herbe_epice", "viande", "volaille", "charcuterie", "poisson", "oeuf", "produit_laitier",
    "fromage", "feculent", "legumineuse", "pate_a_cuire", "conserve", "condiment", "matiere_grasse",
    "epicerie_sucree", "fruit_sec",
)

# (slug, nom affiché, catégorie, unité de référence, ingrédient de base toujours disponible ?)
INGREDIENTS = [
    # Légumes
    ("concombre", "Concombre", "legume", "piece", False),
    ("avocat", "Avocat", "legume", "piece", False),
    ("carotte", "Carotte", "legume", "g", False),
    ("courgette", "Courgette", "legume", "g", False),
    ("fenouil", "Fenouil", "legume", "g", False),
    ("patate_douce", "Patate douce", "legume", "g", False),
    ("aubergine", "Aubergine", "legume", "g", False),
    ("radis", "Radis", "legume", "piece", False),
    ("radis_noir", "Radis noir", "legume", "piece", False),
    ("salade_verte", "Salade verte", "legume", "piece", False),
    ("mache", "Mâche", "legume", "g", False),
    ("roquette", "Roquette", "legume", "g", False),
    ("endive", "Endive", "legume", "g", False),
    ("courge_butternut", "Courge butternut", "legume", "g", False),
    ("potimarron", "Potimarron", "legume", "g", False),
    ("brocoli", "Brocoli", "legume", "g", False),
    ("chou_fleur", "Chou-fleur", "legume", "piece", False),
    ("chou_rouge", "Chou rouge", "legume", "piece", False),
    ("chou_blanc", "Chou blanc", "legume", "piece", False),
    ("chou_chinois", "Chou chinois", "legume", "piece", False),
    ("chou_bruxelles", "Chou de Bruxelles", "legume", "g", False),
    ("pak_choi", "Pak choï", "legume", "piece", False),
    ("champignon", "Champignon de Paris", "legume", "g", False),
    ("tomate", "Tomate", "legume", "g", False),
    ("tomate_cerise", "Tomate cerise", "legume", "g", False),
    ("poivron", "Poivron", "legume", "g", False),
    ("oignon", "Oignon", "legume", "g", False),
    ("oignon_rouge", "Oignon rouge", "legume", "g", False),
    ("oignon_nouveau", "Oignon nouveau (botte)", "legume", "piece", False),
    ("echalote", "Échalote", "legume", "g", False),
    ("ail", "Ail", "legume", "g", True),
    ("poireau", "Poireau", "legume", "g", False),
    ("asperge", "Asperge", "legume", "g", False),
    ("celeri_branche", "Céleri branche", "legume", "piece", False),
    ("celeri_rave", "Céleri-rave", "legume", "g", False),
    ("betterave", "Betterave cuite", "legume", "g", False),
    ("epinard", "Épinard", "legume", "g", False),
    ("haricot_vert", "Haricot vert", "legume", "g", False),
    ("haricot_beurre", "Haricot beurre", "legume", "g", False),
    ("petit_pois", "Petit pois", "legume", "g", False),
    ("mais", "Maïs doux", "legume", "g", False),
    ("salsifis", "Salsifis", "legume", "g", False),
    ("topinambour", "Topinambour", "legume", "g", False),
    ("gingembre", "Gingembre", "legume", "g", False),
    ("pomme_de_terre", "Pomme de terre", "legume", "g", False),
    ("artichaut", "Cœur d'artichaut", "legume", "g", False),
    ("coeur_palmier", "Cœur de palmier", "legume", "g", False),
    ("legumes_melange", "Mélange de légumes", "legume", "g", False),
    ("ratatouille", "Ratatouille (cuisinée)", "legume", "g", False),
    # Fruits
    ("citron", "Citron", "fruit", "piece", False),
    ("citron_vert", "Citron vert", "fruit", "piece", False),
    ("poire", "Poire", "fruit", "g", False),
    ("melon", "Melon", "fruit", "piece", False),
    ("mangue", "Mangue", "fruit", "piece", False),
    ("kiwi", "Kiwi", "fruit", "piece", False),
    ("pomelo", "Pomelo", "fruit", "piece", False),
    ("raisin", "Raisin", "fruit", "g", False),
    ("banane", "Banane", "fruit", "g", False),
    ("fraise", "Fraise", "fruit", "g", False),
    ("framboise", "Framboise", "fruit", "g", False),
    ("fruits_rouges", "Fruits rouges", "fruit", "g", False),
    ("cerise", "Cerise", "fruit", "g", False),
    ("abricot", "Abricot", "fruit", "g", False),
    ("peche", "Pêche / nectarine", "fruit", "g", False),
    ("agrume_petit", "Clémentine / mandarine", "fruit", "g", False),
    ("orange", "Orange", "fruit", "g", False),
    ("pomme", "Pomme", "fruit", "g", False),
    ("ananas", "Ananas", "fruit", "piece", False),
    ("figue", "Figue", "fruit", "piece", False),
    ("grenade", "Grenade", "fruit", "piece", False),
    ("pasteque", "Pastèque", "fruit", "piece", False),
    ("fruit_divers", "Autre fruit", "fruit", "g", False),
    ("poire_au_sirop", "Fruits au sirop", "fruit", "g", False),
    # Herbes et épices
    ("coriandre", "Coriandre", "herbe_epice", "g", False),
    ("ciboulette", "Ciboulette", "herbe_epice", "g", False),
    ("herbes_fraiches", "Herbes aromatiques", "herbe_epice", "g", False),
    ("laurier", "Laurier", "herbe_epice", "g", True),
    ("sel", "Sel", "herbe_epice", "g", True),
    ("poivre", "Poivre", "herbe_epice", "g", True),
    ("paprika", "Paprika", "herbe_epice", "g", True),
    ("epices", "Épices", "herbe_epice", "g", True),
    ("thym", "Thym", "herbe_epice", "g", True),
    ("romarin", "Romarin", "herbe_epice", "g", True),
    ("herbes_provence", "Herbes de Provence", "herbe_epice", "g", True),
    ("origan", "Origan", "herbe_epice", "g", True),
    ("cumin", "Cumin", "herbe_epice", "g", True),
    ("curry", "Curry en poudre", "herbe_epice", "g", True),
    ("curcuma", "Curcuma", "herbe_epice", "g", True),
    ("cannelle", "Cannelle", "herbe_epice", "g", True),
    ("muscade", "Noix de muscade", "herbe_epice", "g", True),
    ("piment", "Piment (poudre, flocons)", "herbe_epice", "g", True),
    ("persil", "Persil", "herbe_epice", "g", False),
    ("basilic", "Basilic frais", "herbe_epice", "g", False),
    # Volaille
    ("poulet_filet", "Poulet (filet, blanc, escalope)", "volaille", "g", False),
    ("poulet_entier", "Poulet entier", "volaille", "g", False),
    ("dinde", "Dinde (escalope, filet)", "volaille", "g", False),
    ("canard_magret", "Magret de canard", "volaille", "g", False),
    ("canard_aiguillette", "Aiguillettes de canard", "volaille", "g", False),
    # Viande
    ("boeuf_hache", "Bœuf haché / steak haché", "viande", "g", False),
    ("boeuf_a_mijoter", "Bœuf à mijoter", "viande", "g", False),
    ("boeuf_a_griller", "Bœuf à griller", "viande", "g", False),
    ("veau_a_mijoter", "Veau à mijoter", "viande", "g", False),
    ("porc_filet", "Porc (filet mignon, rôti, longe)", "viande", "g", False),
    ("porc_tranche", "Porc (côte, escalope, steak, émincé)", "viande", "g", False),
    ("porc_hache", "Porc haché", "viande", "g", False),
    ("saucisse", "Saucisse (chipolata, Montbéliard...)", "viande", "piece", False),
    ("saucisse_cocktail", "Saucisse type knacki / hot dog", "viande", "piece", False),
    ("boudin_blanc", "Boudin blanc", "viande", "piece", False),
    # Charcuterie
    ("jambon_cuit", "Jambon cuit", "charcuterie", "piece", False),
    ("blanc_volaille_tranche", "Blanc de volaille en tranches", "charcuterie", "piece", False),
    ("jambon_cru", "Jambon cru", "charcuterie", "g", False),
    ("lardons", "Lardons / allumettes", "charcuterie", "g", False),
    ("chorizo", "Chorizo", "charcuterie", "g", False),
    ("charcuterie_tranchee", "Charcuterie en tranches (coppa, rosette...)", "charcuterie", "g", False),
    ("canard_magret_fume", "Magret de canard fumé (tranches)", "charcuterie", "g", False),
    ("saucisson", "Saucisson sec", "charcuterie", "g", False),
    ("rillettes_pate", "Rillettes, pâté, terrine", "charcuterie", "g", False),
    ("corned_beef", "Corned beef", "charcuterie", "g", False),
    # Poisson
    ("saumon", "Saumon", "poisson", "g", False),
    ("truite", "Truite", "poisson", "g", False),
    ("truite_fumee", "Truite fumée", "poisson", "g", False),
    ("poisson_blanc", "Poisson blanc (cabillaud, lieu, colin...)", "poisson", "g", False),
    ("poisson_blanc_pane", "Poisson pané / meunière", "poisson", "g", False),
    ("thon_conserve", "Thon en conserve", "poisson", "g", False),
    ("thon_frais", "Thon frais", "poisson", "g", False),
    ("thon_fume", "Thon fumé", "poisson", "g", False),
    ("sardine_conserve", "Sardines / maquereaux en conserve", "poisson", "g", False),
    ("crevette", "Crevette / gambas", "poisson", "g", False),
    ("surimi", "Surimi", "poisson", "piece", False),
    ("anchois", "Anchois", "poisson", "g", False),
    # Oeufs
    ("oeuf", "Œuf", "oeuf", "piece", False),
    # Produits laitiers
    ("lait", "Lait", "produit_laitier", "ml", False),
    ("lait_vegetal", "Boisson végétale", "produit_laitier", "ml", False),
    ("creme_epaisse", "Crème fraîche épaisse", "produit_laitier", "g", False),
    ("creme_liquide", "Crème liquide", "produit_laitier", "ml", False),
    ("beurre", "Beurre", "matiere_grasse", "g", True),
    ("yaourt_nature", "Yaourt nature", "produit_laitier", "g", False),
    ("yaourt_grec", "Yaourt à la grecque / skyr", "produit_laitier", "g", False),
    ("fromage_blanc", "Fromage blanc", "produit_laitier", "g", False),
    ("ricotta", "Ricotta", "produit_laitier", "g", False),
    ("mascarpone", "Mascarpone", "produit_laitier", "g", False),
    # Fromages
    ("mozzarella", "Mozzarella", "fromage", "g", False),
    ("burrata", "Burrata", "fromage", "g", False),
    ("feta", "Feta", "fromage", "g", False),
    ("halloumi", "Halloumi", "fromage", "g", False),
    ("emmental", "Emmental", "fromage", "g", False),
    ("emmental_rape", "Fromage râpé", "fromage", "g", False),
    ("comte", "Comté / gruyère", "fromage", "g", False),
    ("parmesan", "Parmesan / grana padano", "fromage", "g", False),
    ("gouda_cheddar", "Gouda / cheddar", "fromage", "g", False),
    ("tomme", "Tomme / fromage à pâte pressée", "fromage", "g", False),
    ("raclette", "Fromage à raclette", "fromage", "g", False),
    ("chevre", "Fromage de chèvre", "fromage", "g", False),
    ("brebis", "Fromage de brebis", "fromage", "g", False),
    ("fromage_frais", "Fromage frais à tartiner", "fromage", "g", False),
    ("fromage_bleu", "Fromage bleu (gorgonzola, roquefort...)", "fromage", "g", False),
    ("fromage_croute", "Fromage à croûte (brie, saint-marcellin...)", "fromage", "g", False),
    ("fromage_portion", "Fromage en portions", "fromage", "piece", False),
    # Féculents
    ("pates", "Pâtes sèches", "feculent", "g", False),
    ("pates_fraiches", "Pâtes fraîches", "feculent", "g", False),
    ("pates_farcies", "Pâtes farcies (ravioli, tortellini)", "feculent", "g", False),
    ("lasagne", "Feuilles de lasagne", "feculent", "g", False),
    ("gnocchi", "Gnocchi", "feculent", "g", False),
    ("riz", "Riz", "feculent", "g", False),
    ("couscous", "Semoule / couscous", "feculent", "g", False),
    ("cereale_cuisson", "Boulgour, quinoa, céréales à cuire", "feculent", "g", False),
    ("nouilles", "Nouilles asiatiques", "feculent", "g", False),
    ("farine", "Farine", "feculent", "g", True),
    ("flocons_avoine", "Flocons d'avoine", "feculent", "g", False),
    ("tortilla_wrap", "Tortilla / wrap", "feculent", "piece", False),
    ("galette_sarrasin", "Galette de blé noir", "feculent", "piece", False),
    ("feuille_riz", "Feuille de riz", "feculent", "piece", False),
    ("chapelure", "Chapelure / croûtons", "feculent", "g", False),
    ("pain", "Pain", "feculent", "g", False),
    ("pain_de_mie", "Pain de mie", "feculent", "piece", False),
    ("pain_burger_pita", "Pain burger / hot-dog / pita", "feculent", "piece", False),
    ("frites_surgelees", "Pommes de terre surgelées (frites, rissolées)", "feculent", "g", False),
    # Légumineuses
    ("lentilles", "Lentilles", "legumineuse", "g", False),
    ("pois_chiches", "Pois chiches", "legumineuse", "g", False),
    ("haricots_secs", "Haricots rouges / blancs / flageolets", "legumineuse", "g", False),
    ("falafel", "Falafels", "legumineuse", "piece", False),
    ("proteine_vegetale", "Protéine végétale (tofu, steak végétal)", "legumineuse", "g", False),
    # Pâtes à cuire
    ("pate_feuilletee", "Pâte feuilletée", "pate_a_cuire", "piece", False),
    ("pate_brisee", "Pâte brisée", "pate_a_cuire", "piece", False),
    ("pate_pizza", "Pâte à pizza", "pate_a_cuire", "piece", False),
    ("feuille_brick", "Feuille de brick", "pate_a_cuire", "piece", False),
    # Conserves et sauces
    ("tomate_conserve", "Tomates en conserve (morceaux, pelées)", "conserve", "g", False),
    ("lait_coco", "Lait de coco", "conserve", "ml", False),
    ("tomate_coulis", "Purée / coulis de tomate", "conserve", "g", False),
    ("concentre_tomate", "Concentré de tomate", "conserve", "g", False),
    ("sauce_tomate", "Sauce tomate cuisinée", "conserve", "g", False),
    ("sauce_pesto", "Pesto", "conserve", "g", False),
    ("olive", "Olives", "conserve", "g", False),
    ("cornichon", "Cornichons", "conserve", "g", False),
    ("bouillon", "Bouillon", "condiment", "piece", True),
    ("moutarde", "Moutarde", "condiment", "g", True),
    ("mayonnaise", "Mayonnaise", "condiment", "g", False),
    ("ketchup", "Ketchup / sauce burger", "condiment", "g", False),
    ("vinaigre", "Vinaigre", "condiment", "ml", True),
    ("sauce_soja", "Sauce soja / asiatique", "condiment", "ml", False),
    ("miso", "Pâte miso", "condiment", "g", False),
    ("huile_olive", "Huile d'olive", "matiere_grasse", "ml", True),
    ("huile_neutre", "Huile (tournesol, colza)", "matiere_grasse", "ml", True),
    ("huile_noix", "Huile de noix", "matiere_grasse", "ml", False),
    # Épicerie sucrée
    ("sucre", "Sucre", "epicerie_sucree", "g", True),
    ("sucre_vanille", "Sucre vanillé / arôme vanille", "epicerie_sucree", "g", False),
    ("levure_chimique", "Levure chimique", "epicerie_sucree", "g", True),
    ("levure_boulangere", "Levure boulangère", "epicerie_sucree", "g", False),
    ("chocolat_patissier", "Chocolat pâtissier / pépites", "epicerie_sucree", "g", False),
    ("miel", "Miel / sirop", "epicerie_sucree", "g", False),
    ("poudre_amande", "Poudre d'amande", "fruit_sec", "g", False),
    ("noix", "Noix, noisettes, amandes nature", "fruit_sec", "g", False),
    ("pignons", "Pignons de pin", "fruit_sec", "g", False),
    ("graines", "Graines (mélange)", "fruit_sec", "g", False),
    ("chataigne", "Châtaigne / marron", "fruit_sec", "g", False),
    ("canneberge", "Fruits secs sucrés", "fruit_sec", "g", False),
]

INGREDIENT_SLUGS = {i[0] for i in INGREDIENTS}

# Allergènes réglementaires (UE) par ingrédient, avec une approche prudente : un produit qui en contient souvent
# est marqué. Indicatif uniquement : la composition exacte se lit sur l'emballage.
ALLERGEN_NAMES = {
    "gluten": "Gluten", "lait": "Lait", "oeuf": "Œuf", "poisson": "Poisson", "crustaces": "Crustacés",
    "fruits_a_coque": "Fruits à coque", "soja": "Soja", "moutarde": "Moutarde", "celeri": "Céleri", "sesame": "Sésame",
}
# Niveau d'épice : 1 = épicé mais doux (curry, chorizo doux), 2 = piquant. Absent = 0.
# Les préférences du foyer (spice_level) excluent les recettes au-dessus du niveau accepté.
SPICINESS = {"curry": 1, "chorizo": 1, "piment": 2}

_ALLERGENS_BY_GROUP = {
    "gluten": ["pates", "pates_fraiches", "pates_farcies", "lasagne", "gnocchi", "couscous", "cereale_cuisson", "nouilles",
               "farine", "flocons_avoine", "tortilla_wrap", "galette_sarrasin", "chapelure", "pain", "pain_de_mie",
               "pain_burger_pita", "pate_feuilletee", "pate_brisee", "pate_pizza", "feuille_brick", "sauce_soja",
               "poisson_blanc_pane", "proteine_vegetale", "falafel"],
    "lait": ["lait", "creme_epaisse", "creme_liquide", "beurre", "yaourt_nature", "yaourt_grec", "fromage_blanc", "ricotta",
             "mascarpone", "mozzarella", "burrata", "feta", "halloumi", "emmental", "emmental_rape", "comte", "parmesan",
             "gouda_cheddar", "tomme", "raclette", "chevre", "brebis", "fromage_frais", "fromage_bleu", "fromage_croute",
             "fromage_portion", "pate_feuilletee", "pate_brisee", "poisson_blanc_pane", "sauce_pesto", "gnocchi"],
    "oeuf": ["oeuf", "pates_fraiches", "pates_farcies", "lasagne", "mayonnaise", "surimi", "poisson_blanc_pane"],
    "poisson": ["saumon", "truite", "truite_fumee", "poisson_blanc", "poisson_blanc_pane", "thon_conserve", "thon_frais",
                "thon_fume", "sardine_conserve", "surimi", "anchois"],
    "crustaces": ["crevette"],
    "fruits_a_coque": ["noix", "poudre_amande", "huile_noix", "sauce_pesto"],
    "soja": ["sauce_soja", "miso", "proteine_vegetale"],
    "moutarde": ["moutarde", "mayonnaise"],
    "celeri": ["celeri_branche", "celeri_rave", "bouillon"],
    "sesame": ["graines", "falafel"],
}
ALLERGENS = {}
for _allergen, _slugs in _ALLERGENS_BY_GROUP.items():
    for _slug in _slugs:
        ALLERGENS.setdefault(_slug, []).append(_allergen)

# Règles : (motif sur le nom normalisé, rôle, [ingrédients], part de chaque ingrédient)
# Une part différente de 1 sert aux produits composés de plusieurs ingrédients (petits pois/carottes).
R = []


def rule(pattern, role, *slugs):
    # Un motif qui se termine par un groupe accepte aussi le pluriel du dernier mot (" olive " -> " olives ").
    if pattern.endswith(") "):
        pattern = pattern[:-2] + ")s? "
    R.append((pattern, role, list(slugs)))


# --- Non alimentaire : produits retirés de la base, comme ceux déjà exclus ---
rule(r" (signal|dentifrice|narta|ultra doux|aussie|vitalhair|h s classic|h s sh|lpm monoi|lpm cerisier|masque|creme de jour|dissolvant|gel wc|chlore|liquide de rincage|papier cuisson|sacs? poub|sac cabas|sac poignee|sac isotherme|sachets glacon|charbon de bois|bouquet|tulipes|rhododendron|pivoine|deco fleur|bloc papier|capsules marseille|gourmet gold|purina|crayon) ", "non_food")
# --- Exceptions : produits dont le nom contient un mot trompeur ---
rule(r" (lpm lait|creme lavante) ", "non_food")
rule(r" (lait de coco|creme de coco) ", "ingredient", "lait_coco")
rule(r" (fromage rape pizza) ", "ingredient", "emmental_rape")
rule(r" (pate a pizza) ", "ingredient", "pate_pizza")
rule(r" (sauce pizza|ferrero sauce couscous) ", "ingredient", "sauce_tomate")
rule(r" (sauce gyoza) ", "ingredient", "sauce_soja")
rule(r" (tomates pelees arrabbiata) ", "ingredient", "tomate_conserve")
rule(r" (orange a jus) ", "ingredient", "orange")
rule(r" (sucre glace) ", "ingredient", "sucre")
rule(r" (fine chapelure de pain) ", "ingredient", "chapelure")
rule(r" (pain de mozzarella) ", "ingredient", "mozzarella")
rule(r" (bridelice) ", "ingredient", "creme_epaisse")
rule(r" (fromage blanc fondu) ", "ingredient", "fromage_frais")
rule(r" (yaourts? (a la grecque|facon grecque)) ", "ingredient", "yaourt_grec")
rule(r" (yaourts? (brasses? )?nature|yaourts? (brebis|chevre) nature) ", "ingredient", "yaourt_nature")
rule(r" (blanquette.*veau) ", "ingredient", "veau_a_mijoter")
rule(r" (osso bucco de dinde) ", "ingredient", "dinde")
rule(r" (tortilla (chorizo|oignons|aux oignons|epinard)) ", "prepared_meal")
rule(r" (carre graines et pepites) ", "bread")
rule(r" (chili biltong|viande boeuf chili biltong) ", "snack")
rule(r" (cereales (boulgour|sarrasin|bio millet|bio galette quinoa|p de terre)) ", "ingredient", "cereale_cuisson")
rule(r" (flocons d avoine) ", "breakfast", "flocons_avoine")
rule(r" (bjorg emince ble) ", "ingredient", "proteine_vegetale")
rule(r" (farce a legumes) ", "ingredient", "porc_hache")
rule(r" (salade saison) ", "ingredient", "salade_verte")
# --- Chocolat pâtissier (avant les confiseries au chocolat) ---
rule(r"^ (chocolat dessert|chocolat noir sup|pepites de chocolat|vahine pepites|fairtrade pepites) ", "ingredient", "chocolat_patissier")
# --- Produits non culinaires ou consommés tels quels (placés avant les ingrédients qu'ils contiennent) ---
rule(r" (pizza|tarte flambee|bruschetta pizza|barchetta) ", "prepared_meal")
rule(r" (cordons? bleu|nems?|gyo[sz]as?|sushis?|tielles|banh bao|raviolis vapeur|yakitori|parmentier|pastilla|samboussek|borek|boeuf bourguignon|blanquette|axoa|osso bucco|buddha|wraps poulet|maxi hot dog|aubergines au parm|pates en pot|lustucru banz|nouilles instantanees|soupe nouilles|ramen|yum yum|calamar a la romaine|carpaccio de poulpes|cake mozza|plateau raclette|plateau fromages|kit a cuisiner|kit pour potee|assortiment libanais|beignets de crevettes|chips de crevettes|feuilles de vignes|piperade|tomates pelees arrabbiata|epinards a la creme|chinois a la creme) ", "prepared_meal")
rule(r" (gazpacho|soupe|nestle p tit soup|knorr douceur|knorr soupe) ", "prepared_meal")
rule(r" (houmous|tzatziki|caviar d aubergine|tartinable|artichonade|riste d aubergine|babaganusch|pate d artichaut|blini|crackers|cracker|chips|rustichips|pringles|tuc|doritos|monster munch|curly|lay s|cruspies|apericube|aperivrais|tuiles|mix aperitif|snack|gressins|mini sables aperitif|sticks de saucisson|mini saucissons|cacahuetes grillees|amandes grillees salees|noix de cajou|pistaches|croustillants|petits coraya|bretzel|wasa|galettes de riz|galettes au beurre) ", "snack")
rule(r" (biscuit|cookie|madeleine|palet|doomino|gateau|brownie|cake|canele|caneles|financiers|gaufre|gaufrette|petit beurre|bn|belin|prince|oreo|nutella biscuits|barre|kinder|milka|ferrero|raffaello|toblerone|cote d or|suchard|mars|haribo|chupa|confiserie|mallow|party mix|lunettes|crocos|choco sticks|smarties|petits oeufs|rochers|deco choco|chocolat au lait|chocolat noir|chocolat lait|chocolat degustation|chocolat degus|tablette|way to go|st michel|soft cake|pancakes|muffin|mini roules|choudou|mini gateaux|mini viennoiseries|neo roll|jumbo neo|mariette|snack 4 friends|tam tam|doonuts|pain d epice|galette ronde|barre bretonne|choco duo|choco crush|choco surprise|oeufs surprise|mon p tit panda|nestle recettes|nestle smarties|poulain) ", "snack")
rule(r" (magnum|extreme mini|glace|sorbet|cone) ", "dessert")
rule(r" (yaourt|yaourts|yop|danette|creme dessert|cremes dessert|mousse au chocolat|mousses au chocolat|fontaine a yaourt|cantaveylot|from bl|from blanc|fromage blanc fondu|petits suisses|specialites laitieres|nestle dessert|bridelice|compote|pom potes|demi poires|yoplait) ", "dessert")
rule(r" (nestle couscous) ", "breakfast")
rule(r" (muesli|musli|granola|kellogg|cornflakes|nesquik|cookie crisp|mix cereales|boules de cereales|confiture|pate a tartiner|pates a tartiner|nutella|beurre de cacahuete|brioche|briochettes|briochette|bjorg p tit fondant|bjorg croust|croissant|pain au chocolat|pains au lait|pain tout chocolat|pain au lait|viennoiserie|creme de pistache|recharge amande) ", "breakfast", )
rule(r" (coca|cola|schweppes|oasis|lipton|ice tea|fuze tea|feeltea|maytea|jus|pur jus|fruit blast|nectar|boisson|smoothie|eau|evian|vittel|badoit|cristaline|biere|bier|vin|rose u golfu|blanc brut|prosecco|whisky|scotch|blended|abrachan|bordeaux|cotes de provence|coteaux|costieres|bandol|alpilles|ile de beaute|patrimonio|pays d oc|terres du midi|var rose|vallee du paradis|cuvee|zinfandel|saumur|sauvignon|viognier|melusine|britt|saint cyp|saint agaune|st agaune|the|english breakfast|infusion|senseo|dosette|cafe|lpm lait|co 02) ", "beverage")
rule(r" (pain de mie|pain mie|gache) ", "bread", "pain_de_mie")
rule(r" (pains hamburger|petits pains hot dog|pains pita|pain pita|pain durum) ", "bread", "pain_burger_pita")
rule(r" (pain|baguette|ciabatta|focaccia|pita|pave rustique|ficeli|tartines au seigle|petits pains|petit pain|puccia) ", "bread", "pain")

# --- Ingrédients composés ---
rule(r" petits? pois.*carottes? ", "ingredient", "petit_pois", "carotte")
rule(r" (trio de poivrons|poivron mix|mini poivron|poivrons en lamelles) ", "ingredient", "poivron")
rule(r" (julienne de legumes|macedoine|trio de legumes|farce a legumes) ", "ingredient", "legumes_melange")
rule(r" ratatouille ", "ingredient", "ratatouille")

# --- Ingrédients dont le nom contient un autre ingrédient (avant les règles générales) ---
rule(r" (rillettes|pate x2|henaff|terrine) ", "ingredient", "rillettes_pate")
rule(r" (ben s original|bens original) ", "ingredient", "riz")
rule(r" (feuilles de riz) ", "ingredient", "feuille_riz")
rule(r" (vermicelles de riz) ", "ingredient", "nouilles")
rule(r" (lentille|lentilles) ", "ingredient", "lentilles")
rule(r" (ravioli|raviolis|tortellini|tortelloni|pates farcies|cannelloni|medaglioni) ", "ingredient", "pates_farcies")
rule(r" (lasagne) ", "ingredient", "lasagne")
rule(r" (pates aux oeufs) ", "ingredient", "pates")
rule(r" haricots? beurre ", "ingredient", "haricot_beurre")
rule(r" pate brisee ", "ingredient", "pate_brisee")
rule(r" (lardons|allumettes|poitrine fumee) ", "ingredient", "lardons")
rule(r" (saucisson|specialite saucisson) ", "ingredient", "saucisson")
rule(r" (emmental bio au lait cru) ", "ingredient", "emmental")
rule(r" (morbier) ", "ingredient", "tomme")
rule(r" (mozzarella|mozarella) ", "ingredient", "mozzarella")
rule(r" (canneberges|melange de baies) ", "ingredient", "canneberge")
# --- Poissons (avant les légumes : " truite fumee ", " thon fume avec citron ") ---
rule(r" (truite fumee|ovive truite) ", "ingredient", "truite_fumee")
rule(r" thon fume ", "ingredient", "thon_fume")
rule(r" filet de thon ", "ingredient", "thon_frais")
rule(r" (thon|pn thon) ", "ingredient", "thon_conserve")
rule(r" (saumon|emince(s)? de saumon) ", "ingredient", "saumon")
rule(r" truite ", "ingredient", "truite")
rule(r" (colin meuniere|filet colin meuniere) ", "ingredient", "poisson_blanc_pane")
rule(r" (cabillaud|lieu|colin|merlan|eglefin|limande|merlu) ", "ingredient", "poisson_blanc")
rule(r" (sardine|maquereaux|maquereau|pn ptit maquereau) ", "ingredient", "sardine_conserve")
rule(r" (crevette|gambas) ", "ingredient", "crevette")
rule(r" surimi ", "ingredient", "surimi")
rule(r" anchois ", "ingredient", "anchois")
# Après les poissons (« thon fumé avec huile d'olive ») et avant « olive ».
rule(r" huile d olive ", "ingredient", "huile_olive")

# --- Volaille et viandes ---
rule(r" magrets? (de )?(canard )?fumes? ", "ingredient", "canard_magret_fume")
rule(r" (magret) ", "ingredient", "canard_magret")
rule(r" aiguillettes canard ", "ingredient", "canard_aiguillette")
rule(r" (fleury michon blanc de dinde|blanc de poulet .*tranches|fm blanc poulet|blanc de poulet fume|blanc de poulet csn) ", "ingredient", "blanc_volaille_tranche")
rule(r" (poulet pac|poulet fermier) ", "ingredient", "poulet_entier")
rule(r" (filets? de poulet|blanc de poulet|escalopes? de poulet|aiguillettes de poulet|fines escalopes de poulet) ", "ingredient", "poulet_filet")
rule(r" (dinde) ", "ingredient", "dinde")
rule(r" (viande hachee porc) ", "ingredient", "porc_hache")
rule(r" (viande hachee|viande boeuf hachee|steaks? haches?|steaks? charolais|steaks x 2 charolais) ", "ingredient", "boeuf_hache")
rule(r" (viande a bourguignon) ", "ingredient", "boeuf_a_mijoter")
rule(r" (faux filet) ", "ingredient", "boeuf_a_griller")
rule(r" (blanquette.*veau) ", "ingredient", "veau_a_mijoter")
rule(r" (filet mignon fume|lomo) ", "ingredient", "charcuterie_tranchee")
rule(r" (filet mignon|roti de porc|longe de porc) ", "ingredient", "porc_filet")
rule(r" (steak de porc|escalope de porc|cotes echine|emince de porc) ", "ingredient", "porc_tranche")
rule(r" (boudins? blancs?) ", "ingredient", "boudin_blanc")
rule(r" (knacki|saucisses? fumees? hot dog|saucisses hot dog) ", "ingredient", "saucisse_cocktail")
rule(r" (chipolata|saucisse) ", "ingredient", "saucisse")
rule(r" (jarret) ", "ingredient", "porc_tranche")
# --- Charcuterie ---
rule(r" (jambon fume|serrano|crudo|jambon italien|jambon cru|bresaola|viande des grisons|viande boeuf chili biltong|chili biltong) ", "ingredient", "jambon_cru")
rule(r" (jambon|herta|le superieur|simplement bon|fm jambon|des de jambon) ", "ingredient", "jambon_cuit")
rule(r" (lardons|allumettes|poitrine fumee) ", "ingredient", "lardons")
rule(r" chorizo ", "ingredient", "chorizo")
rule(r" (coppa|rosette) ", "ingredient", "charcuterie_tranchee")
rule(r" (saucisson|specialite saucisson) ", "ingredient", "saucisson")
rule(r" (rillettes|pate x2|henaff|terrine) ", "ingredient", "rillettes_pate")
rule(r" corned beef ", "ingredient", "corned_beef")

# --- Oeufs, produits laitiers, fromages ---
rule(r" oeufs? ", "ingredient", "oeuf")
rule(r" (lait d amande|bjorg lait) ", "ingredient", "lait_vegetal")
rule(r" lait ", "ingredient", "lait")
rule(r" (creme fraiche fleurette|creme entiere liquide|creme liquide) ", "ingredient", "creme_liquide")
rule(r" creme fraiche ", "ingredient", "creme_epaisse")
rule(r" beurre ", "ingredient", "beurre")
rule(r" (skyr|a la grecque|facon grecque) ", "ingredient", "yaourt_grec")
rule(r" fromage blanc ", "ingredient", "fromage_blanc")
rule(r" ricotta ", "ingredient", "ricotta")
rule(r" mascarpone ", "ingredient", "mascarpone")
rule(r" (burrata) ", "ingredient", "burrata")
rule(r" (mozzarella|mozarella) ", "ingredient", "mozzarella")
rule(r" (feta|salakis) ", "ingredient", "feta")
rule(r" halloumi ", "ingredient", "halloumi")
rule(r" (emmental rape|emmental francais rape|fromage rape|mozzarella rapee) ", "ingredient", "emmental_rape")
rule(r" (comte|gruyere|president comte|meule fruitee) ", "ingredient", "comte")
rule(r" (grana padano|parmigiano|parmesan) ", "ingredient", "parmesan")
rule(r" emmental ", "ingredient", "emmental")
rule(r" (gouda|cheddar) ", "ingredient", "gouda_cheddar")
rule(r" (raclette) ", "ingredient", "raclette")
rule(r" (chevre|crottins?|sainte maure|valencay|selles sur cher|rocamadour|chavignol|soignon) ", "ingredient", "chevre")
rule(r" (brebis|ossau iraty|perail) ", "ingredient", "brebis")
rule(r" (st moret|saint moret|fromage frais|kiri|mousse fromage frais|labneh) ", "ingredient", "fromage_frais")
rule(r" (gorgonzola|roquefort|saint agur|bleu|fromage bleu) ", "ingredient", "fromage_bleu")
rule(r" (tomme|morbier|cantal|saint nectaire|coeur de savoie|fromage ovale|tranche de fromage|carre de est|fromage noisettes) ", "ingredient", "tomme")
rule(r" (brie|chaource|saint felicien|saint marcellin|caprice des anges|petit brie|petits fromages) ", "ingredient", "fromage_croute")
rule(r" (vache qui rit|babybel|fromage fondu) ", "ingredient", "fromage_portion")

# --- Féculents, légumineuses, pâtes ---
rule(r" (ravioli|raviolis|tortellini|tortelloni|pates farcies|cannelloni|medaglioni) ", "ingredient", "pates_farcies")
rule(r" (gnocchi|gnocchis|lustucru gap) ", "ingredient", "gnocchi")
rule(r" (lasagne) ", "ingredient", "lasagne")
rule(r" (tagliatelles fraiches|fettuccine frais) ", "ingredient", "pates_fraiches")
rule(r" (spaghetti|fusilli|penne|tagliatelles|tagliatelle|fettuccine|farfalle|coquillettes|macaroni|maccaroni|linguine|paccheri|pipe rigate|torti|vermicelles|pates|fusillini|torsades lentilles|garofalo|panzani coquillettes|panzani pipe) ", "ingredient", "pates")
rule(r" (nouilles|vermicelles de riz) ", "ingredient", "nouilles")
rule(r" (riz|les 2 marm|ben s original) ", "ingredient", "riz")
rule(r" (couscous) ", "ingredient", "couscous")
rule(r" (quinoa|boulgour|duo de quinoa|bjorg emince ble) ", "ingredient", "cereale_cuisson")
rule(r" (lentille|lentilles) ", "ingredient", "lentilles")
rule(r" pois chiches ", "ingredient", "pois_chiches")
rule(r" (haricots rouges|haricots blancs|flageolets|cassegrain haricots) ", "ingredient", "haricots_secs")
rule(r" falafels? ", "ingredient", "falafel")
rule(r" (tofu|garden gourmet) ", "ingredient", "proteine_vegetale")
rule(r" farine ", "ingredient", "farine")
rule(r" (tortilla wraps|tortillas? ble|tortillas? complet|tortilla nature|6 tortillas|wraps|tortilla epinard|tortilla chorizo|tortilla oignons|tortilla aux oignons|tortilla wraps xxl) ", "ingredient", "tortilla_wrap")
rule(r" galettes de ble noir ", "ingredient", "galette_sarrasin")
rule(r" feuilles de riz ", "ingredient", "feuille_riz")
rule(r" (chapelure|croutons) ", "ingredient", "chapelure")
rule(r" (frites|rissolees|mccain|pommes de terre frites) ", "ingredient", "frites_surgelees")
rule(r" pate feuilletee ", "ingredient", "pate_feuilletee")
rule(r" pate brisee ", "ingredient", "pate_brisee")
rule(r" pate a pizza ", "ingredient", "pate_pizza")
rule(r" (brick|suntat) ", "ingredient", "feuille_brick")

# --- Conserves, sauces, condiments ---
rule(r" (concentre de tomates) ", "ingredient", "concentre_tomate")
rule(r" (puree de tomates) ", "ingredient", "tomate_coulis")
rule(r" (tomates en morceaux|tomates pelees) ", "ingredient", "tomate_conserve")
rule(r" (pesto) ", "ingredient", "sauce_pesto")
rule(r" (sauce tomate|sauces tomate|panzani|sauce pizza|sauce itali|ferrero sauce) ", "ingredient", "sauce_tomate")
rule(r" (olive) ", "ingredient", "olive")
rule(r" (cornichons) ", "ingredient", "cornichon")
rule(r" (bouillon|kub or) ", "ingredient", "bouillon")
rule(r" moutarde ", "ingredient", "moutarde")
rule(r" (mayonnaise|mayomix|bearnaise) ", "ingredient", "mayonnaise")
rule(r" (ketchup|sauce burger) ", "ingredient", "ketchup")
rule(r" (vinaigre|creme balsamique) ", "ingredient", "vinaigre")
rule(r" (sauce soja|soja salee|teriyaki|sauce gyoza|tanoshi sauce) ", "ingredient", "sauce_soja")
rule(r" miso ", "ingredient", "miso")
rule(r" huile d olive ", "ingredient", "huile_olive")
rule(r" (huile de colza|huile de tournesol|huile tourn) ", "ingredient", "huile_neutre")
rule(r" huile de noix ", "ingredient", "huile_noix")
rule(r" (sel|fleur de sel) ", "ingredient", "sel")
rule(r" (ducros moulin|baies) ", "ingredient", "poivre")
rule(r" paprika ", "ingredient", "paprika")
rule(r" (moulin ail) ", "ingredient", "ail")

# --- Épicerie sucrée ---
rule(r" (sucre vanille|arome de vanille|vahine arome) ", "ingredient", "sucre_vanille")
rule(r" (sucre|cassonade|edulcor|stevia) ", "ingredient", "sucre")
rule(r" (levure chimique|ste lucie levure) ", "ingredient", "levure_chimique")
rule(r" (levure boulangere|l hirondelle levure) ", "ingredient", "levure_boulangere")
rule(r" (pepites) ", "ingredient", "chocolat_patissier")
rule(r" (miel|sirop d agave) ", "ingredient", "miel")
rule(r" (amandes en poudre|amande poudre) ", "ingredient", "poudre_amande")
rule(r" (noix|noisettes|amandes|cerneaux|melange de noix) ", "ingredient", "noix")
rule(r" pignons ", "ingredient", "pignons")
rule(r" (graines|carre graines) ", "ingredient", "graines")
rule(r" (marron|chataigne) ", "ingredient", "chataigne")
rule(r" (canneberges|melange de baies) ", "ingredient", "canneberge")

# --- Légumes (après les produits qui les contiennent) ---
rule(r" (coeurs? de palmiers?) ", "ingredient", "coeur_palmier")
rule(r" (coeurs? d artichauts?|artichauts? grilles) ", "ingredient", "artichaut")
rule(r" (patate douce|patates douces) ", "ingredient", "patate_douce")
rule(r" (pomme de terre|pdt|pommes de terre) ", "ingredient", "pomme_de_terre")
rule(r" tomates? cerises? ", "ingredient", "tomate_cerise")
rule(r" (tomate|tomates) ", "ingredient", "tomate")
rule(r" (concombre) ", "ingredient", "concombre")
rule(r" avocat ", "ingredient", "avocat")
rule(r" (carotte|carottes) ", "ingredient", "carotte")
rule(r" courgette ", "ingredient", "courgette")
rule(r" fenouil ", "ingredient", "fenouil")
rule(r" aubergines? ", "ingredient", "aubergine")
rule(r" radis noir ", "ingredient", "radis_noir")
rule(r" radis ", "ingredient", "radis")
rule(r" (salades|salade|iceberg|batavia|romaine|sucrine|jeune pousse) ", "ingredient", "salade_verte")
rule(r" mache ", "ingredient", "mache")
rule(r" (roquette) ", "ingredient", "roquette")
rule(r" endive ", "ingredient", "endive")
rule(r" butternut ", "ingredient", "courge_butternut")
rule(r" potimarron ", "ingredient", "potimarron")
rule(r" brocolis? ", "ingredient", "brocoli")
rule(r" chou fleur ", "ingredient", "chou_fleur")
rule(r" chou rouge ", "ingredient", "chou_rouge")
rule(r" chou blanc ", "ingredient", "chou_blanc")
rule(r" chou chinois ", "ingredient", "chou_chinois")
rule(r" chou de bruxelles ", "ingredient", "chou_bruxelles")
rule(r" pak choi ", "ingredient", "pak_choi")
rule(r" champignons? ", "ingredient", "champignon")
rule(r" poivron ", "ingredient", "poivron")
rule(r" oignon rouge ", "ingredient", "oignon_rouge")
rule(r" (oignons? botte|oignon botte) ", "ingredient", "oignon_nouveau")
rule(r" oignon ", "ingredient", "oignon")
rule(r" echalote ", "ingredient", "echalote")
rule(r" (ail) ", "ingredient", "ail")
rule(r" (poireau|poireaux) ", "ingredient", "poireau")
rule(r" asperges? ", "ingredient", "asperge")
rule(r" celeri branche ", "ingredient", "celeri_branche")
rule(r" celeri rave ", "ingredient", "celeri_rave")
rule(r" betteraves? ", "ingredient", "betterave")
rule(r" epinards? ", "ingredient", "epinard")
rule(r" haricots? beurre ", "ingredient", "haricot_beurre")
rule(r" (haricots? verts?|haricots plats) ", "ingredient", "haricot_vert")
rule(r" (petits? pois|pois doux) ", "ingredient", "petit_pois")
rule(r" (mais doux|mais) ", "ingredient", "mais")
rule(r" salsifis ", "ingredient", "salsifis")
rule(r" topinambour ", "ingredient", "topinambour")
rule(r" gingembre ", "ingredient", "gingembre")
rule(r" coriandre ", "ingredient", "coriandre")
rule(r" ciboulette ", "ingredient", "ciboulette")
rule(r" herbes aromatiques ", "ingredient", "herbes_fraiches")
rule(r" laurier ", "ingredient", "laurier")
rule(r" thym ", "ingredient", "thym")
rule(r" romarin ", "ingredient", "romarin")
rule(r" herbes de provence ", "ingredient", "herbes_provence")
rule(r" origan ", "ingredient", "origan")
rule(r" persil ", "ingredient", "persil")
rule(r" basilic ", "ingredient", "basilic")
rule(r" cumin ", "ingredient", "cumin")
rule(r" curry ", "ingredient", "curry")
rule(r" curcuma ", "ingredient", "curcuma")
rule(r" cannelle ", "ingredient", "cannelle")
rule(r" muscade ", "ingredient", "muscade")
rule(r" piment ", "ingredient", "piment")
# --- Fruits ---
rule(r" citron vert ", "ingredient", "citron_vert")
rule(r" citron ", "ingredient", "citron")
rule(r" poires? ", "ingredient", "poire")
rule(r" melon ", "ingredient", "melon")
rule(r" mangue ", "ingredient", "mangue")
rule(r" kiwi ", "ingredient", "kiwi")
rule(r" (pomelo|pomelos|pamplemousse) ", "ingredient", "pomelo")
rule(r" raisin ", "ingredient", "raisin")
rule(r" banane ", "ingredient", "banane")
rule(r" (fraise|fraises) ", "ingredient", "fraise")
rule(r" (framboise|framboises) ", "ingredient", "framboise")
rule(r" fruits rouges ", "ingredient", "fruits_rouges")
rule(r" cerise ", "ingredient", "cerise")
rule(r" abricot ", "ingredient", "abricot")
rule(r" (peche|nectarine) ", "ingredient", "peche")
rule(r" (clementine|mandarine) ", "ingredient", "agrume_petit")
rule(r" (orange|oranges) ", "ingredient", "orange")
rule(r" (pomme|pommes) ", "ingredient", "pomme")
rule(r" ananas ", "ingredient", "ananas")
rule(r" figue ", "ingredient", "figue")
rule(r" grenade ", "ingredient", "grenade")
rule(r" (pasteque|baby pasteque) ", "ingredient", "pasteque")
rule(r" (litchi|mirabelle) ", "ingredient", "fruit_divers")

RULES = R


def normalize(text):
    """Nom normalisé : minuscules, sans accents, séparateurs réduits à un espace, entouré d'espaces."""
    t = text.replace("œ", "oe").replace("Œ", "oe").replace("æ", "ae").replace("Æ", "ae")
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode().lower()
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    return f" {t} "


_COMPILED = [(re.compile(p), role, slugs) for p, role, slugs in RULES]


def classify(name):
    """Renvoie (rôle, [ingrédients], index de la règle) ou (None, [], None) si aucune règle ne correspond."""
    n = normalize(name)
    for i, (rx, role, slugs) in enumerate(_COMPILED):
        if rx.search(n):
            return role, slugs, i
    return None, [], None


def _check():
    assert set(ALLERGENS) <= INGREDIENT_SLUGS, set(ALLERGENS) - INGREDIENT_SLUGS
    unknown = {s for _, _, slugs in RULES for s in slugs} - INGREDIENT_SLUGS
    assert not unknown, f"ingrédients inconnus dans les règles : {unknown}"
    assert all(c in CATEGORIES for _, _, c, _, _ in INGREDIENTS)
    for p, _, _ in RULES:
        assert "\\b" not in p and "\\d" not in p and "\\w" not in p, f"motif non portable vers PostgreSQL : {p}"


_check()
