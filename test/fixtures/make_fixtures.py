"""Regenerates the synthetic test fixtures (no real project data).
Needs: python-docx, openpyxl, reportlab, Pillow, LibreOffice (soffice), poppler (pdftoppm) and libtiff (tiff2pdf).
Run from the repo root:  python3 test/fixtures/make_fixtures.py
"""
import os, subprocess
import docx, openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Table, Paragraph
from reportlab.lib.styles import getSampleStyleSheet

D = os.path.dirname(os.path.abspath(__file__))

# Word: a calibration certificate (label: value lines) plus a submittal table
d = docx.Document(); d.add_heading('Calibration Certificate', 1)
for l in ['Certificate No: CC-2026-0417', 'Equipment: Multifunction calibrator', 'Make/Model: Fluke 726',
          'Serial No: 4471102', 'Calibration Date: 12/03/2026', 'Next Due Date: 12/03/2027']:
    d.add_paragraph(l)
d.add_paragraph('Submittal register extract:')
t = d.add_table(rows=1, cols=5)
for c, h in zip(t.rows[0].cells, ['Submittal No', 'Title', 'Rev', 'Date Submitted', 'Status']): c.text = h
for r in [['SUB-BMS-001', 'BMS controllers datasheet', 'B', '03/09/2026', 'Approved as noted'],
          ['SUB-EPMS-004', 'EPMS meters', 'A', '15/10/2026', 'Under review']]:
    for c, v in zip(t.add_row().cells, r): c.text = v
d.save(os.path.join(D, 'cert.docx'))
subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', D, os.path.join(D, 'cert.docx')], check=True, capture_output=True)

# PDF via reportlab: an NCR log table (standard Type1 fonts, WinAnsi)
doc = SimpleDocTemplate(os.path.join(D, 'ncr.pdf'), pagesize=A4)
data = [['NCR No', 'Description', 'Location', 'Owner', 'Raised', 'Target', 'Status'],
        ['NCR-012', 'Cable tray support missing', 'Hall A', 'Electrical lead', '01/10/2026', '15/10/2026', 'Open'],
        ['NCR-013', 'Wrong breaker rating fitted', 'LV room 2', 'EPMS eng.', '05/10/2026', '30/12/2026', 'Closed']]
doc.build([Paragraph('Issues and NCR log – Café test é', getSampleStyleSheet()['Title']), Table(data)])

# Excel: checklist with a summary block above the header (header on row 8), formulas and a date cell
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Audit Checklist'
for i, (k, f) in enumerate([('Items', '=COUNTA(C9:C200)'), ('Ready', '=COUNTIF(D9:D200,"Ready")'), ('Partial', '=COUNTIF(D9:D200,"Partial")'),
                            ('Missing', '=COUNTIF(D9:D200,"Missing")'), ('Not checked', '=COUNTIF(D9:D200,"Not checked")'), ('% ready', '=0')], 1):
    ws.cell(i, 1, k); ws.cell(i, 2, f)
ws.append([]) if ws.max_row < 7 else None
hdr = ['Ref', 'Area', 'Item', 'Status', 'Where in ACC / TIDP', 'Owner', 'Gap / action needed', 'Quality Plan ref', 'What to have ready']
for c, h in enumerate(hdr, 1): ws.cell(8, c, h)
rows = [['1.1', '1. Pre-Start', 'Pre-start documentation', 'Ready', 'ACC > Quality', 'QM', None, '§1', 'Minutes'],
        ['1.2', '1. Pre-Start', 'Quality plan adopted', 'Partial', None, 'QM', 'Get approval comments closed', '§6.2', 'QP rev'],
        ['2.1', '2. ITPs', 'ITP register', 'Missing', None, 'QM', 'Build register', '§8.1', 'Register'],
        ['2.2', '2. ITPs', 'Approved ITPs', 'Not checked', None, None, None, '§8.2', 'ITPs'],
        ['3.1', '3. Testing', 'Calibration records', 'N/A', None, None, None, '§9', 'Certs']]
for r, row in enumerate(rows, 9):
    for c, v in enumerate(row, 1): ws.cell(r, c, v)
wb.save(os.path.join(D, 'checklist.xlsx'))
# Scanned versions (images only, no text): JPEG, CCITT Group 4 and Flate-encoded pages
import tempfile
from PIL import Image
from reportlab.pdfgen import canvas
tmp = tempfile.mkdtemp()
subprocess.run(['pdftoppm', '-r', '200', '-gray', '-png', os.path.join(D, 'ncr.pdf'), os.path.join(tmp, 'ncr')], check=True)
subprocess.run(['pdftoppm', '-r', '200', '-gray', '-png', os.path.join(D, 'cert.pdf'), os.path.join(tmp, 'cert')], check=True)
ncr = Image.open(os.path.join(tmp, 'ncr-1.png')).convert('L')
ncr.save(os.path.join(D, 'scan-ncr-jpeg.pdf'), 'PDF', resolution=200, quality=70)
cert = Image.open(os.path.join(tmp, 'cert-1.png')).convert('L')
cert.point(lambda v: 255 if v > 160 else 0).convert('1').save(os.path.join(tmp, 'cert.tif'), compression='group4', dpi=(200, 200))
subprocess.run(['tiff2pdf', '-o', os.path.join(D, 'scan-cert-g4.pdf'), os.path.join(tmp, 'cert.tif')], check=True)
ncr.resize((1240, 1754)).save(os.path.join(tmp, 'ncr-small.png'))
c = canvas.Canvas(os.path.join(D, 'scan-ncr-flate.pdf'), pagesize=A4)
c.drawImage(os.path.join(tmp, 'ncr-small.png'), 0, 0, width=A4[0], height=A4[1]); c.showPage(); c.save()
print('fixtures written to', D)
