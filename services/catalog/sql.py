"""Génère le SQL qui copie le référentiel (ingrédients + règles) dans Supabase.

Usage : python -m services.catalog.sql > supabase/migrations/<horodatage>_ingredient_referential_seed.sql
"""

from services.catalog import referential as R


def q(text):
    return "'" + text.replace("'", "''") + "'"


def seed_sql():
    lines = ["-- Généré par services/catalog/sql.py à partir de services/catalog/referential.py : ne pas modifier à la main.",
             "insert into public.ingredients (slug, name, category, default_unit, is_pantry_staple) values"]
    lines.append(",\n".join(f"  ({q(s)}, {q(n)}, {q(c)}, {q(u)}, {'true' if st else 'false'})" for s, n, c, u, st in R.INGREDIENTS))
    lines[-1] += "\non conflict (slug) do update set name = excluded.name, category = excluded.category,"
    lines.append("  default_unit = excluded.default_unit, is_pantry_staple = excluded.is_pantry_staple;")
    lines.append("")
    lines.append("delete from private.ingredient_rules where true;")
    lines.append("insert into private.ingredient_rules (priority, pattern, role, ingredient_slugs) values")
    rows = []
    for i, (pattern, role, slugs) in enumerate(R.RULES, start=1):
        arr = "array[" + ", ".join(q(x) for x in slugs) + "]::text[]" if slugs else "'{}'::text[]"
        rows.append(f"  ({i}, {q(pattern)}, {q(role)}, {arr})")
    lines.append(",\n".join(rows) + ";")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    print(seed_sql(), end="")
