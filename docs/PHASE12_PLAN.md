# Phase 12 plan — Camera and OCR for selling, adding products, purchases and stock

Version 1.0 — 2026-10-28. Requested by the user after Phase 11 (D-071).

**The request:** in the dashboard, take a photo with the camera and let OCR record everything, in four places:
1. **Start a sale** — the IMEI or barcode is read and the item goes into the cart.
2. **Add a product** — read from the box label.
3. **Record a purchase** — read from the supplier bill; the stock is updated when it is posted.
4. **Stock** — find a phone or product by its IMEI or barcode.

It extends FR-OCR (scans), FR-POS-1 and FR-INV. Acceptance criteria (AC) are fixed **before** coding. Only executed checks count (`TEST_REPORT.md`).

**What existed before this phase:**
- Scans of a product box label or a supplier invoice, read by an isolated worker.
- Every field reviewed, with confidence shown.
- A purchase draft made from the scan; posting it updates stock (Phases 4–5).
- The OCR engine was a **mock** that does not read real photos (Q4).

**Decisions (D-071):**
- **Engine.** Tesseract 5 (open source, runs on the shop's own server, free, no data leaves the machine) is the real OCR engine. It is chosen by `OCR_ENGINE=tesseract`; the mock stays for tests.
- **Accuracy.** Tesseract reads printed text and digits well on clear, flat, well-lit photos. Accuracy on real phone photos of boxes and bills is **not measured yet**. That needs real, consented samples from the pilot shop. A person always reviews what was read.
- **Camera.** The camera is used through the browser:
  - **Live camera:** `getUserMedia`, on a laptop webcam at `http://127.0.0.1`, or on any device over https.
  - **Phone photo:** a picture input that opens the phone camera.
- **Nothing is changed by OCR alone.**
  - A sale scan only adds an item to the cart; the cashier still completes the sale.
  - A product scan only fills the form; the owner saves it.
  - A bill scan makes a purchase draft; posting it is a separate step with its own checks.

## Status

All four increments and the exit are done (TR-0047). Accuracy on real photos is not measured.

## Increment 12.1 — Real OCR engine (Tesseract adapter)
- **AC1:** with `OCR_ENGINE=tesseract`, scans are read by the local `tesseract` program.
  - It runs inside the isolated worker with a time limit of its own. Its output is split into lines with a confidence from the word confidences.
  - A missing program, a timeout or a crash becomes a scan failure (with retry), never an API error.
- **AC2:** on generated test images of a product label and a supplier invoice, the existing parsers find the brand, model, RAM/storage, colour, IMEIs (check digit valid) and barcode, and the invoice number, date, lines and total.
- **AC3:** PDFs are not read by Tesseract. A PDF scan fails as `PDF_NEEDS_TEXT_ENGINE` and goes to manual entry; photos are the supported input.

## Increment 12.2 — Scan to find (sale and stock)
- **AC1:** a photo sent to the scan lookup is read at once (synchronously, same isolation and limits) and is **not stored**. The response contains the IMEIs (check digit valid) and barcodes/SKUs it found, and what each matches in this business:
  - **For an IMEI:** the phone unit, its product and its status (available, sold, in inspection …).
  - **For a barcode or SKU:** the product, its stock and price.
- **AC2:** Point of sale: **Scan IMEI or barcode** adds the matched available item to the cart (a phone with its IMEI). A sold or unknown IMEI is reported and not added. The sale is completed as usual.
- **AC3:** Stock: **Scan to find** shows what the photo matched, with its stock and status.
- **AC4:** permission `pos.sell` or `inventory.view`. The same size and type checks as scans apply, with a concurrency limit. Another business's IMEIs never match (tenant context).

## Increment 12.3 — Add a product from the box label
- **AC1:** from a product-label scan, **Create product** pre-fills a form: brand, model, model number, RAM, storage, colour, barcode, and serialized when IMEIs were read. The owner enters the selling price and confirms the flagged fields, then saves.
  - Saving uses the normal product rules (`catalogue.manage`), and an existing brand is reused.
  - The new product is proposed in the scan's purchase draft, with the read IMEIs, so the stock comes in when that purchase is posted.

## Increment 12.4 — Camera in the screens
- **AC1:** a **Take photo** control on Scans, Point of sale, Catalogue and Stock:
  - **Live camera** where the browser allows it: preview, capture and send. A refused permission shows a clear message.
  - Otherwise a **photo** input that opens the phone camera (`capture="environment"`).
- **AC2:** the existing scan review, purchase draft and posting flow are unchanged (FR-OCR), and the Scans and Purchases screens offer the camera.

## Phase 12 exit (browser, Chromium with a fake camera that shows a generated label image)
1. A product is added from a label photo (Tesseract).
2. A purchase draft is created from an invoice photo and posted, and stock goes up.
3. In Point of sale, an IMEI photo adds that phone to the cart and the sale is completed.
4. Stock: a scan finds the phone as sold.

Also: axe 0 serious/critical at 360/768/1280 px on the new controls, no CSP errors, and CI green.

**Not done in this phase:**
- Live barcode decoding in the browser (`BarcodeDetector`). It is not available in the test browser, so it cannot be verified here.
- Accuracy on real photos (needs pilot samples).
- Handwritten bills.
