-- La règle « huile d'olive » passe après les poissons : « Thon fumé avec huile d'olive » ou « Sardines à l'huile d'olive »
-- étaient classés en huile d'olive. Elle reste avant la règle « olive ». Déplacement de la priorité 55 à 73 ;
-- résultat identique à la sortie de services/catalog/sql.py (vérifié après application).
update private.ingredient_rules set priority = priority + 10000 where priority between 55 and 73;
update private.ingredient_rules set priority = priority - 10001 where priority between 10056 and 10073;
update private.ingredient_rules set priority = 73 where priority = 10055;
