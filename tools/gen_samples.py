#!/usr/bin/env python3
"""Génère des documents de test (docx, xlsx, pptx) ; LibreOffice produit ensuite
les variantes odt/ods/odp et doc/xls/ppt ainsi que les rendus PDF de référence.

usage : python3 tools/gen_samples.py <dossier>
"""
import datetime
import os
import sys

from PIL import Image, ImageDraw

out = sys.argv[1] if len(sys.argv) > 1 else "samples"
os.makedirs(out, exist_ok=True)

# Image de test -------------------------------------------------------------------------
img_path = os.path.join(out, "photo.png")
im = Image.new("RGB", (480, 300), (40, 110, 190))
d = ImageDraw.Draw(im)
for i in range(0, 300, 20):
    d.line([(0, i), (480, 300 - i)], fill=(255, 210, 60), width=3)
d.ellipse([170, 80, 310, 220], fill=(230, 60, 60), outline=(255, 255, 255), width=6)
im.save(img_path)

# Word ------------------------------------------------------------------------------------
from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

doc = Document()
sec = doc.sections[0]
sec.page_width = Cm(21)
sec.page_height = Cm(29.7)
for m in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
    setattr(sec, m, Cm(2.5))


def add_field(run, instr):
    f1 = OxmlElement("w:fldChar")
    f1.set(qn("w:fldCharType"), "begin")
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = instr
    f2 = OxmlElement("w:fldChar")
    f2.set(qn("w:fldCharType"), "separate")
    t = OxmlElement("w:t")
    t.text = "1"
    f3 = OxmlElement("w:fldChar")
    f3.set(qn("w:fldCharType"), "end")
    for e in (f1, it, f2, t, f3):
        run._r.append(e)


hp = sec.header.paragraphs[0]
hp.text = "Rapport annuel 2026 — Projet secret"
hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
fp = sec.footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
fp.add_run("Page ")
add_field(fp.add_run(), "PAGE")
fp.add_run(" sur ")
add_field(fp.add_run(), "NUMPAGES")

doc.add_heading("Lecteur de documents bureautiques", 0)
p = doc.add_paragraph("Ce document de test vérifie le rendu du ")
p.add_run("gras").bold = True
p.add_run(", de l'")
p.add_run("italique").italic = True
p.add_run(", du ")
r = p.add_run("souligné")
r.underline = True
p.add_run(", des ")
r = p.add_run("couleurs")
r.font.color.rgb = RGBColor(0xC0, 0x20, 0x20)
p.add_run(" et des tailles ")
r = p.add_run("variables")
r.font.size = Pt(16)
p.add_run(". Les exposants comme E = mc")
r = p.add_run("2")
r.font.superscript = True
p.add_run(" et les indices comme H")
r = p.add_run("2")
r.font.subscript = True
p.add_run("O doivent être correctement placés. ")
p.add_run("Texte barré.").font.strike = True

doc.add_heading("1. Paragraphes et alignements", 1)
long = ("Le traitement de texte doit gérer la césure des lignes, la justification et les retraits. "
        "Voici un paragraphe suffisamment long pour s'étendre sur plusieurs lignes et vérifier que "
        "l'algorithme de découpage respecte les espaces, la ponctuation française ; les guillemets « comme ceux-ci » "
        "et les nombres comme 1 234,56 €. ")
p = doc.add_paragraph(long * 2)
p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
p = doc.add_paragraph("Paragraphe centré.")
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p = doc.add_paragraph("Paragraphe aligné à droite.")
p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
p = doc.add_paragraph(long)
p.paragraph_format.left_indent = Cm(2)
p.paragraph_format.first_line_indent = Cm(1)

doc.add_heading("2. Listes", 1)
for t in ["Premier élément à puce", "Deuxième élément à puce, un peu plus long pour vérifier le retour à la ligne avec retrait suspendu correct", "Troisième élément"]:
    doc.add_paragraph(t, style="List Bullet")
for t in ["Étape numérotée un", "Étape numérotée deux", "Étape numérotée trois"]:
    doc.add_paragraph(t, style="List Number")

doc.add_heading("3. Tableau", 1)
table = doc.add_table(rows=1, cols=4)
table.style = "Light Grid Accent 1"
hdr = table.rows[0].cells
for i, t in enumerate(["Produit", "Quantité", "Prix unitaire", "Total"]):
    hdr[i].text = t
data = [("Clavier", 2, 45.0), ("Souris sans fil", 5, 19.9), ("Écran 27 pouces", 1, 329.0), ("Câble USB-C", 10, 7.5)]
for name, q, pu in data:
    row = table.add_row().cells
    row[0].text = name
    row[1].text = str(q)
    row[2].text = f"{pu:.2f} €".replace(".", ",")
    row[3].text = f"{q * pu:.2f} €".replace(".", ",")
doc.add_paragraph()
t2 = doc.add_table(rows=3, cols=3)
t2.style = "Table Grid"
t2.alignment = WD_TABLE_ALIGNMENT.CENTER
a = t2.cell(0, 0).merge(t2.cell(0, 1))
a.text = "Cellules fusionnées horizontalement"
b = t2.cell(1, 2).merge(t2.cell(2, 2))
b.text = "Fusion verticale"
t2.cell(1, 0).text = "A"
t2.cell(1, 1).text = "B"
t2.cell(2, 0).text = "C"
t2.cell(2, 1).text = "D"
t2.cell(0, 2).text = "E"

doc.add_heading("4. Tabulations", 1)
for title, page in [("Introduction", 1), ("Méthodologie", 4), ("Résultats détaillés", 12), ("Conclusion", 27)]:
    p = doc.add_paragraph()
    p.paragraph_format.tab_stops.add_tab_stop(Cm(16), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
    p.add_run(f"{title}\t{page}")

doc.add_heading("5. Image", 1)
doc.add_paragraph("Une image insérée dans le texte :")
doc.add_picture(img_path, width=Cm(8))
doc.add_paragraph("Légende : figure de test.").alignment = WD_ALIGN_PARAGRAPH.CENTER

p = doc.add_paragraph()
p.add_run().add_break(WD_BREAK.PAGE)
doc.add_heading("6. Deuxième page", 1)
for i in range(12):
    doc.add_paragraph(f"Ligne de remplissage numéro {i + 1}. " + long)
doc.save(os.path.join(out, "test.docx"))

# Excel -----------------------------------------------------------------------------------
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

wb = Workbook()
ws = wb.active
ws.title = "Ventes"
ws["A1"] = "Rapport des ventes 2026"
ws["A1"].font = Font(size=16, bold=True, color="1F4E79")
ws.merge_cells("A1:E1")
hdr = ["Mois", "Produit", "Quantité", "Prix", "Total"]
thin = Side(style="thin", color="999999")
for i, h in enumerate(hdr):
    c = ws.cell(row=3, column=i + 1, value=h)
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor="4472C4")
    c.alignment = Alignment(horizontal="center")
    c.border = Border(top=thin, bottom=thin, left=thin, right=thin)
mois = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin"]
for i, m in enumerate(mois):
    r = 4 + i
    ws.cell(row=r, column=1, value=m)
    ws.cell(row=r, column=2, value="Widget " + "ABC"[i % 3])
    ws.cell(row=r, column=3, value=10 * (i + 1))
    c = ws.cell(row=r, column=4, value=12.5 + i)
    c.number_format = '#,##0.00 €'
    c = ws.cell(row=r, column=5, value=f"=C{r}*D{r}")
    c.number_format = '#,##0.00 €'
    for col in range(1, 6):
        ws.cell(row=r, column=col).border = Border(top=thin, bottom=thin, left=thin, right=thin)
        if i % 2:
            ws.cell(row=r, column=col).fill = PatternFill("solid", fgColor="D9E1F2")
ws["A11"] = "Total"
ws["A11"].font = Font(bold=True)
ws["E11"] = "=SUM(E4:E9)"
ws["E11"].number_format = '#,##0.00 €'
ws["A13"] = "Date"
ws["B13"] = datetime.date(2026, 11, 14)
ws["B13"].number_format = "dd/mm/yyyy"
ws["A14"] = "Pourcentage"
ws["B14"] = 0.1234
ws["B14"].number_format = "0.00%"
ws["A15"] = "Texte long qui déborde sur les cellules voisines vides"
ws["A16"] = "Texte renvoyé à la ligne automatiquement dans la cellule"
ws["A16"].alignment = Alignment(wrap_text=True, vertical="top")
ws.row_dimensions[16].height = 45
ws.column_dimensions["A"].width = 18
ws.column_dimensions["B"].width = 14
ws.column_dimensions["E"].width = 14
ws.freeze_panes = "A4"
chart = BarChart()
chart.title = "Quantités"
chart.add_data(Reference(ws, min_col=3, min_row=3, max_row=9), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=4, max_row=9))
ws.add_chart(chart, "G3")
ws2 = wb.create_sheet("Données")
for r in range(1, 60):
    for c in range(1, 12):
        ws2.cell(row=r, column=c, value=r * c if c > 1 else f"Ligne {r}")
wb.save(os.path.join(out, "test.xlsx"))

# PowerPoint -------------------------------------------------------------------------------
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor as PRGB
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt as PPt

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = "Présentation de test"
s.placeholders[1].text = "Lecteur Office pour Galaxy Z Fold 7"
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = "Points clés"
tf = s.placeholders[1].text_frame
tf.text = "Lecture des fichiers Word, Excel et PowerPoint"
for t, lvl in [("Formats OpenDocument également", 0), ("ODT, ODS, ODP", 1), ("Rendu fidèle des polices", 0), ("Zoom et défilement fluides", 0)]:
    p = tf.add_paragraph()
    p.text = t
    p.level = lvl
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.title.text = "Formes et images"
sh = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(2), Inches(3), Inches(1.5))
sh.text = "Rectangle arrondi"
sh = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(4.3), Inches(2), Inches(2.2), Inches(1.5))
sh.fill.solid()
sh.fill.fore_color.rgb = PRGB(0xED, 0x7D, 0x31)
sh.text = "Ellipse"
sh = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(0.8), Inches(4.2), Inches(3), Inches(1.2))
s.shapes.add_picture(img_path, Inches(7.2), Inches(2), width=Inches(5))
tb = s.shapes.add_textbox(Inches(4.3), Inches(4.2), Inches(2.5), Inches(1.2))
tb.text_frame.text = "Zone de texte libre"
tb.text_frame.paragraphs[0].runs[0].font.size = PPt(20)
tb.text_frame.paragraphs[0].runs[0].font.color.rgb = PRGB(0x70, 0x30, 0xA0)
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.title.text = "Tableau et graphique"
rows, cols = 4, 3
tbl = s.shapes.add_table(rows, cols, Inches(0.6), Inches(1.8), Inches(5.5), Inches(2)).table
for c, h in enumerate(["Région", "T1", "T2"]):
    tbl.cell(0, c).text = h
for r, row in enumerate([("Nord", "120", "135"), ("Sud", "98", "110"), ("Est", "143", "150")]):
    for c, v in enumerate(row):
        tbl.cell(r + 1, c).text = v
cd = CategoryChartData()
cd.categories = ["Nord", "Sud", "Est"]
cd.add_series("T1", (120, 98, 143))
cd.add_series("T2", (135, 110, 150))
s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(6.8), Inches(1.8), Inches(6), Inches(4.5), cd)
prs.save(os.path.join(out, "test.pptx"))
print("ok")
