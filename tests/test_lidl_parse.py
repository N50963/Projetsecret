"""Tests du parseur de tickets Lidl Plus France, sur un ticket synthétique (aucune donnée personnelle)."""

from services.lidl import lidl_parse as P


def line(n, cls, attrs, text):
    return f'<span id="purchase_list_line_{n}" class="{cls}"{attrs}>{text}</span>\n'


TICKET = (
    '<span class="purchase_list">'
    + line(1, "currency", ' data-currency="EUR"', "Article P.U.EUR Qt&eacute; EUR")
    + line(2, "article", ' data-art-id="0000001" data-unit-price="1,17" data-tax-type="A" data-art-description="M�che"',
           "M&acirc;che                  1,17 x  2    2,34 A T")
    + line(3, "css_bold", "", "Prix en baisse") + line(3, "css_bold", "", "-0,10")
    + line(4, "discount", ' data-promotion-id="X"', "R&eacute;duction Lidl Plus") + line(4, "discount", ' data-promotion-id="X"', "-0,24")
    + line(5, "article", ' data-art-id="0000002" data-unit-price="3,20" data-tax-type="A" data-art-description="Tomate"',
           "Tomate allong&eacute;e 6,67 A T")
    + line(6, "article", ' data-art-id="0000002" data-art-quantity="1,336" data-unit-price="4,99"', "1,336 kg x 4,99 EUR/kg")
    + line(7, "article", ' data-art-id="0000003" data-unit-price="2,49" data-tax-type="B" data-art-description="Fromage"',
           "Fromage ch&egrave;vre pyram  2,49 1    2,49 B")
    + "</span> A payer 11,16 "
)


def test_parse_receipt_lines_and_totals():
    items, problems = P.parse_receipt(TICKET)
    assert problems == []
    assert [i["label_raw"] for i in items] == ["Mâche", "Tomate allongée", "Fromage chèvre pyram"]
    mache, tomate, fromage = items
    assert (mache["quantity"], mache["unit_price"], mache["line_total"]) == (2, 117, 234)
    assert mache["discount"] == -34 and mache["discount_labels"] == ["Prix en baisse", "Réduction Lidl Plus"]
    assert tomate["weight_g"] == 1336 and tomate["unit_price"] == 499 and tomate["line_total"] == 667
    assert fromage["tax"] == "B"
    assert sum(i["line_total"] + i["discount"] for i in items) == P.payable(TICKET) == 1116


def test_name_comes_from_visible_text_not_damaged_attribute():
    items, _ = P.parse_receipt(TICKET)
    assert "�" not in items[0]["label_raw"]


def test_cents_conversion():
    assert P.cents("1,17") == 117
    assert P.cents("-0,24") == -24
