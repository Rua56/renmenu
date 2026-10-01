"""Generate the synthetic PDF fixture; requires reportlab only at generation time.

The fixture contains no real restaurant, contact, price, logo or customer record.
It is never an uploaded customer's file and is excluded by the current public build.
"""
from pathlib import Path
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUTPUT = Path(__file__).resolve().parents[1] / "site" / "demo-assets" / "menu-fittizio-demo.pdf"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
page_width, page_height = A4
pdf = canvas.Canvas(str(OUTPUT), pagesize=A4, pageCompression=1, invariant=1)
pdf.setTitle("Menu fittizio - solo demo RenMenu")
pdf.setAuthor("RenMenu - dati sintetici")


def frame(page_number, heading):
    pdf.setFillColor(HexColor("#153e49"))
    pdf.rect(0, page_height - 150, page_width, 150, stroke=0, fill=1)
    pdf.setFillColor(HexColor("#ffffff"))
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(45, page_height - 48, "RENMENU / FONTE DIMOSTRATIVA")
    pdf.setFont("Helvetica", 25)
    pdf.drawString(45, page_height - 104, heading)
    pdf.setFillColor(HexColor("#20373b"))
    pdf.setFont("Helvetica", 9)
    pdf.drawString(45, 43, f"PAGINA {page_number}/2  -  DOCUMENTO FITTIZIO. NON PUBBLICARE.")


frame(1, "Bottega Aurora - demo")
pdf.setFont("Helvetica-Bold", 14)
pdf.drawString(45, page_height - 210, "Piccoli piatti")
pdf.setFont("Helvetica", 12)
for index, (dish, price) in enumerate([
    ("Crostino alle erbe", "4,50"),
    ("Verdure arrosto", "6,00"),
    ("Acqua naturale 0,75 l", "2,50"),
    ("Tisana della casa", "3,00"),
]):
    y = page_height - 260 - index * 47
    pdf.drawString(48, y, dish)
    pdf.drawRightString(page_width - 55, y, f"EUR {price}")
pdf.setFillColor(HexColor("#9e3548"))
pdf.setFont("Helvetica-Bold", 10)
pdf.drawString(45, page_height - 505, "ALLERGENI: non disponibili in questa fonte sintetica.")
pdf.drawString(45, page_height - 527, "Non dedurre ingredienti o numeri allergeni dai nomi dei piatti.")
pdf.showPage()

frame(2, "Note per la revisione")
pdf.setFont("Helvetica-Bold", 14)
pdf.drawString(45, page_height - 210, "Provenienza e limitazioni")
pdf.setFont("Helvetica", 11)
for index, row in enumerate([
    "Questi piatti e prezzi sono interamente inventati per il test dell'interfaccia.",
    "Il PDF non corrisponde ad alcun locale cliente o menu online.",
    "Le traduzioni, i recapiti e gli allergeni non sono forniti.",
    "Per un caso reale serve il documento originale del locale e la sua approvazione.",
]):
    pdf.drawString(45, page_height - 252 - index * 29, row)
pdf.showPage()
pdf.save()
print(OUTPUT)
