# Marley Moves Removal Quote PDF — pdfmake Build Specification

A4 PDF size: **595.28 x 841.89 pt**

This spec defines a **2-page A4 PDF**:

- **Page 1:** Removal Quote
- **Page 2:** Quote Assumptions & Terms

Design style: clean, professional, modern removal company quote using Marley Moves red, charcoal, white cards, subtle borders, rounded corners, structured spacing, and strong total/acceptance callouts.

---

# 1. PAGE GEOMETRY

## Global page setup

| Property | Value |
|---|---:|
| Page size | A4 |
| Width | 595.28 pt |
| Height | 841.89 pt |
| Left margin | 38 pt |
| Right margin | 38 pt |
| Top margin | 32 pt |
| Bottom margin | 34 pt |
| Content width | 519.28 pt |
| Footer top rule Y | 791 pt |
| Footer baseline Y | 813 pt |

---

## Page 1 block map

| Block | X | Y | W | H |
|---|---:|---:|---:|---:|
| Header logo/contact area | 38 | 32 | 230 | 100 |
| Header title/ref area | 300 | 32 | 257.28 | 100 |
| Header red rule | 38 | 145 | 519.28 | 1.4 |
| Client card | 38 | 164 | 242 | 193 |
| Job details card | 291 | 164 | 266.28 | 193 |
| Quote breakdown heading | 38 | 377 | 519.28 | 28 |
| Quote table | 38 | 414 | 519.28 | dynamic, base 146 |
| Mileage info callout | 38 | 580 | 220 | 58 |
| Totals stack | 304 | 570 | 253.28 | 110 |
| Acceptance strip with QR | 38 | 704 | 519.28 | 74 |
| Footer rule | 38 | 791 | 519.28 | 1 |
| Footer text row | 38 | 807 | 519.28 | 18 |

### Page 1 vertical rules

- Header always fixed.
- Cards always fixed height.
- Quote table starts at **Y 414**.
- For 1-5 quote rows, totals remain at **Y 570**.
- For 6-8 quote rows, move mileage callout and totals down, but keep acceptance strip at bottom only if enough space remains.
- If table + totals cannot fit before **Y 690**, continue quote table on a new continuation page.
- Acceptance strip must never overlap totals.

---

## Page 2 block map

| Block | X | Y | W | H |
|---|---:|---:|---:|---:|
| Header logo | 38 | 32 | 230 | 76 |
| Page title | 300 | 42 | 257.28 | 44 |
| Header red rule | 38 | 111 | 519.28 | 1.4 |
| Terms list | 38 | 132 | 519.28 | 505 |
| Bank details card | 38 | 660 | 166 | 102 |
| Customer acceptance box | 219 | 660 | 338.28 | 102 |
| Footer rule | 38 | 791 | 519.28 | 1 |
| Footer text row | 38 | 807 | 519.28 | 18 |

### Page 2 vertical rules

- Terms page always starts on its own page.
- Terms list must not share a page with quote table continuation unless specifically using a 3-page document.
- Page 2 bottom cards fixed at **Y 660**.
- If legal copy grows, reduce terms body font to minimum **6.8 pt** before allowing page 3.

---

# 2. COLOUR PALETTE

| Name | Hex | Usage |
|---|---|---|
| brand-red | `#C03838` | Logo accent, badges, rules, total bar |
| brand-red-dark | `#A8221C` | Total bar gradient/deeper red accent |
| brand-red-soft | `#FDF1F1` | Acceptance strip/card soft fill |
| ink | `#1F1D1B` | Main text |
| charcoal | `#2A2927` | Page titles, table header |
| muted-grey | `#6F6A64` | Secondary text |
| light-grey | `#E8E3DC` | Borders/dividers |
| card-fill | `#FFFFFF` | Cards/table body |
| page-bg | `#FFFFFF` | Page background |
| soft-panel | `#FBF8F4` | Info card/card background |
| table-header-dark | `#262422` | Quote table header |
| table-row-alt | `#FCFAF7` | Very subtle table alternate fill |
| success-green | `#138A3D` | Discount amount |
| warning-soft | `#FFF7F2` | Optional notices |
| footer-grey | `#5C5752` | Footer text |
| white | `#FFFFFF` | Reversed text |

---

# 3. TYPOGRAPHY

Only two font families are available:

- **Montserrat**
- **Cormorant**

Use **Montserrat** for almost everything. Use **Cormorant** only for optional formal display emphasis if needed, but the draft design is primarily Montserrat.

## Text style map

| Style | Font | Weight | Size | Colour | Line height | Letter spacing | Casing |
|---|---|---:|---:|---|---:|---:|---|
| Logo wordmark | Montserrat | Bold | 21 pt | ink/brand-red | 24 pt | 1.2 | Uppercase |
| Logo tagline | Montserrat | Bold | 5.8 pt | muted-grey | 7 pt | 0.6 | Uppercase |
| Page title | Montserrat | Bold | 24 pt | ink | 28 pt | 0 | Title Case |
| Header meta label | Montserrat | Regular | 8.3 pt | muted-grey | 13 pt | 0 | Title Case |
| Header meta value | Montserrat | Bold | 8.7 pt | ink/brand-red | 13 pt | 0 | Mixed |
| Contact text | Montserrat | Regular | 8.2 pt | ink | 12.5 pt | 0 | Mixed |
| Card heading | Montserrat | Bold | 10 pt | ink | 13 pt | 0.2 | Uppercase |
| Card label | Montserrat | Bold | 7.5 pt | brand-red | 10 pt | 0 | Title Case |
| Card value | Montserrat | Regular/Bold | 9.5 pt | ink | 13 pt | 0 | Mixed |
| Section heading | Montserrat | Bold | 10.5 pt | ink | 14 pt | 0.3 | Uppercase |
| Table header | Montserrat | Bold | 7.5 pt | white | 10 pt | 0.6 | Uppercase |
| Table cell | Montserrat | Regular | 8.7 pt | ink | 11.5 pt | 0 | Mixed |
| Table item label | Montserrat | Bold | 8.8 pt | ink | 11.5 pt | 0 | Mixed |
| Table sub-detail | Montserrat | Regular | 7.5 pt | muted-grey | 9.5 pt | 0 | Mixed |
| Totals label | Montserrat | Regular | 8.8 pt | ink | 12 pt | 0 | Mixed |
| Totals value | Montserrat | Regular/Bold | 8.8 pt | ink | 12 pt | 0 | Mixed |
| Discount row | Montserrat | Regular | 8.8 pt | success-green | 12 pt | 0 | Mixed |
| Total bar label | Montserrat | Bold | 10 pt | white | 14 pt | 0.2 | Uppercase |
| Total bar amount | Montserrat | Bold | 21 pt | white | 25 pt | 0 | Currency |
| Acceptance strip | Montserrat | Bold | 9.2 pt | ink | 13 pt | 0 | Sentence |
| QR URL text | Montserrat | Regular | 6.5 pt | muted-grey | 8 pt | 0 | URL |
| Terms heading | Montserrat | Bold | 9.3 pt | ink | 12 pt | 0 | Sentence |
| Terms body | Montserrat | Regular | 7.4 pt | ink | 9.7 pt | 0 | Sentence |
| Bank card heading | Montserrat | Bold | 8 pt | brand-red | 11 pt | 0.3 | Uppercase |
| Signature labels | Montserrat | Regular | 7 pt | ink | 10 pt | 0 | Title Case |
| Footer | Montserrat | Regular | 6.8 pt | footer-grey | 9 pt | 0 | Mixed |

---

# 4. COMPONENT SPECS

---

## 4.1 Header — both pages

### Logo area

| Element | X | Y | W | H |
|---|---:|---:|---:|---:|
| Logo icon | 38 | 36 | 62 | 38 |
| Wordmark | 104 | 43 | 145 | 20 |
| Tagline | 106 | 65 | 145 | 8 |

Logo icon should be the Marley Moves mark if available. If not, use a red house roof + simple van icon.

Wordmark treatment:

- `MARLEY` in brand-red.
- `MOVES` in ink.
- Tagline: `MOVING YOU TOWARDS YOUR FUTURE`.

### Contact rows — page 1 only

Start at **X 42**, **Y 96**.

| Row | Icon X | Text X | Y |
|---|---:|---:|---:|
| Phone | 42 | 62 | 96 |
| Email | 42 | 62 | 113 |
| Website | 42 | 62 | 130 |

Icon size: **10 x 10 pt**  
Icon colour: **ink**  
Text: Montserrat Regular, **8.2 pt**

Copy:

- `01747 637070`
- `info@marleymoves.co.uk`
- `www.marleymoves.co.uk`

### Page title block

| Element | X | Y | W | H |
|---|---:|---:|---:|---:|
| Page 1 title | 392 | 39 | 165 | 31 |
| Page 2 title | 340 | 39 | 217.28 | 31 |

Page 1 title: `Removal Quote`  
Page 2 title: `Quote Assumptions & Terms`

### Quote meta table — page 1 only

| Element | X | Y | W | H |
|---|---:|---:|---:|---:|
| Vertical divider | 319 | 76 | 1 | 64 |
| Meta labels | 350 | 83 | 92 | 52 |
| Meta values | 458 | 83 | 99 | 52 |

Rows:

| Label | Value |
|---|---|
| `Quote Reference:` | `{quoteRef}` |
| `Date Issued:` | `{issueDate}` |
| `Valid Until:` | `{validUntil}` |

Y positions: **83**, **105**, **127**  
Valid until value colour: **brand-red**.

### Header red rule

| Page | X | Y | W | H |
|---|---:|---:|---:|---:|
| Both | 38 | 145 page 1 / 111 page 2 | 519.28 | 1.4 |

Colour: **brand-red**

---

## 4.2 Client Information card

| Property | Value |
|---|---:|
| X | 38 |
| Y | 164 |
| W | 242 |
| H | 193 |
| Fill | card-fill |
| Border | `#E8E3DC` |
| Border width | 0.8 pt |
| Corner radius | 6 pt |
| Padding | 16 pt |

### Icon badge

| Property | Value |
|---|---:|
| Badge X | 52 |
| Badge Y | 177 |
| Diameter | 28 pt |
| Fill | brand-red |
| Icon | person |
| Icon size | 15 pt |
| Icon colour | white |

Heading:

- X **88**
- Y **184**
- Text: `CLIENT INFORMATION`
- Style: card heading.

### Card content

| Label | X | Y | Value Y |
|---|---:|---:|---:|
| `Prepared for` | 52 | 224 | 240 |
| `Phone` | 52 | 278 | 294 |
| `Email` | 52 | 318 | 334 |

Value widths: **200 pt**.

Customer name should be bold.

---

## 4.3 Job Details card

| Property | Value |
|---|---:|
| X | 291 |
| Y | 164 |
| W | 266.28 |
| H | 193 |
| Fill | card-fill |
| Border | `#E8E3DC` |
| Border width | 0.8 pt |
| Corner radius | 6 pt |
| Padding | 16 pt |

### Icon badge

| Property | Value |
|---|---:|
| Badge X | 305 |
| Badge Y | 177 |
| Diameter | 28 pt |
| Fill | brand-red |
| Icon | job/briefcase |
| Icon size | 15 pt |
| Icon colour | white |

Heading:

- X **341**
- Y **184**
- Text: `JOB DETAILS`

### Internal columns

| Column | X | W |
|---|---:|---:|
| Left column | 307 | 145 |
| Right column | 455 | 86 |

### Left column fields

| Label | Y | Value start Y |
|---|---:|---:|
| `Collection` | 224 | 240 |
| `Destination` | 291 | 307 |

### Right column fields

| Label | Y | Value start Y |
|---|---:|---:|
| `Move Date` | 224 | 240 |
| `Prepared by` | 278 | 294 |
| `Scope` | 322 | 338 |

Horizontal mini-dividers under right column values:

- X **455**
- W **86**
- Colour **light-grey**
- Width **0.6 pt**

---

## 4.4 Quote Breakdown heading

| Element | X | Y | W | H |
|---|---:|---:|---:|---:|
| Badge | 38 | 377 | 28 | 28 |
| Heading | 75 | 385 | 250 | 15 |

Badge:

- Diameter: **28 pt**
- Fill: **brand-red**
- Icon: breakdown/table
- Icon size: **15 pt**
- Icon colour: white

Heading text:

`QUOTE BREAKDOWN`

---

## 4.5 Quote Breakdown table

### Table position

| Property | Value |
|---|---:|
| X | 38 |
| Y | 414 |
| W | 519.28 |
| Header H | 25 pt |
| Standard row H | 40 pt |
| Minimum row H | 34 pt |
| Border radius | 4 pt for outer table |

### Column widths

| Column | Width |
|---|---:|
| NO. | 50 pt |
| ITEM / SERVICES | 205 pt |
| QUANTITY | 105 pt |
| UNIT PRICE | 102 pt |
| AMOUNT | 57.28 pt |
| Total | 519.28 pt |

### Header styling

- Fill: **table-header-dark**
- Text: **Montserrat Bold 7.5 pt**
- Colour: **white**
- Uppercase.
- Vertical centre.
- Padding top: **8 pt**
- Padding bottom: **7 pt**
- Padding left/right: **8 pt**

Header labels:

- `NO.`
- `ITEM / SERVICES`
- `QUANTITY`
- `UNIT PRICE`
- `AMOUNT`

### Body row styling

- Fill: **white**
- Alternate fill: **table-row-alt**, optional only if table has 5+ rows.
- Border colour: **light-grey**
- Border width: **0.5 pt**
- Cell padding: **8 pt horizontal**, **7 pt vertical**
- Row height: dynamic, minimum **40 pt**
- Item label: Montserrat Bold **8.8 pt**
- Sub-detail: Montserrat Regular **7.5 pt**, muted-grey, directly below label.

### Alignment

| Column | Alignment |
|---|---|
| NO. | Centre |
| ITEM / SERVICES | Left |
| QUANTITY | Centre |
| UNIT PRICE | Right |
| AMOUNT | Right, bold |

### Item sub-detail rendering

Format:

```text
Vehicle & Base
(1 Luton Van)
```

- Label line: bold.
- Sub-detail line: muted-grey.
- If sub-detail is empty, omit second line and vertically centre label.

---

## 4.6 Mileage info callout

| Property | Value |
|---|---:|
| X | 38 |
| Y | 580 |
| W | 220 |
| H | 58 |
| Fill | soft-panel |
| Border | `#E8E3DC` |
| Border width | 0.6 pt |
| Corner radius | 5 pt |
| Padding | 14 pt |

Icon badge:

| Property | Value |
|---|---:|
| X | 52 |
| Y | 596 |
| Diameter | 20 pt |
| Fill | brand-red |
| Icon | info |
| Icon colour | white |

Text:

- X **82**
- Y **594**
- W **155**
- Font: Montserrat Regular **7.3 pt**
- Line height **10 pt**
- Colour: ink

Copy:

```text
Mileage is calculated from base
to collection, collection to destination,
and return to base.
```

---

## 4.7 Totals stack

| Property | Value |
|---|---:|
| X | 304 |
| Y | 570 |
| W | 253.28 |
| H before total bar | 54 |
| Total bar Y | 631 |
| Total bar H | 43 |

### Totals rows

| Row | Label X | Value X | Y |
|---|---:|---:|---:|
| Subtotal | 304 | 480 | 570 |
| Discount | 304 | 480 | 592 |
| VAT | 304 | 480 | 614 |

Label width: **130 pt**  
Value width: **77 pt**  
Value aligned right.

Discount:

- Label colour: success-green.
- Value colour: success-green.
- Show minus sign as `−`, not hyphen.

### Red total bar

| Property | Value |
|---|---:|
| X | 304 |
| Y | 631 |
| W | 253.28 |
| H | 43 |
| Fill | brand-red |
| Corner radius | 5 pt |
| Padding L/R | 17 pt |

Label:

- X **321**
- Y **646**
- Text: `TOTAL INCLUDING VAT`

Amount:

- X **440**
- Y **640**
- W **100**
- Right aligned.
- Text: `{grandTotal}`

---

## 4.8 Acceptance strip — page 1 bottom

| Property | Value |
|---|---:|
| X | 38 |
| Y | 704 |
| W | 519.28 |
| H | 74 |
| Fill | brand-red-soft |
| Border | `#F1D8D8` |
| Border width | 0.7 pt |
| Corner radius | 5 pt |

### Tick badge

| Property | Value |
|---|---:|
| X | 65 |
| Y | 725 |
| Diameter | 28 pt |
| Fill | brand-red |
| Icon | tick |
| Icon colour | white |

### Acceptance wording

| Property | Value |
|---|---:|
| X | 105 |
| Y | 725 |
| W | 310 |
| H | 18 |

Copy:

```text
To accept this quote, reply in writing and pay the {depositAmount} deposit.
```

### QR code slot

Reserve a right-aligned QR image slot.

| Property | Value |
|---|---:|
| QR X | 476 |
| QR Y | 706 |
| QR W | 66 |
| QR H | 66 |

The QR slot should render only if `{acceptQrImage}` exists.

### Accept URL line

| Property | Value |
|---|---:|
| X | 250 |
| Y | 752 |
| W | 218 |
| H | 10 |
| Alignment | Right |

Copy pattern:

```text
Accept online: {acceptUrl}
```

Style:

- Montserrat Regular **6.5 pt**
- Colour: muted-grey.

If no QR code exists, the URL line can use full width **X 105 / W 420**.

---

## 4.9 Page 2 terms list

### Terms list container

| Property | Value |
|---|---:|
| X | 38 |
| Y | 132 |
| W | 519.28 |
| Row H | 49 pt |
| Row divider | 0.5 pt, light-grey |

### Terms row structure

| Element | X | W |
|---|---:|---:|
| Icon badge column | 57 | 34 |
| Text column | 105 | 420 |

Badge:

- Diameter: **28 pt**
- Stroke: brand-red
- Stroke width: **1.2 pt**
- Fill: white
- Icon size: **14 pt**
- Icon colour: brand-red

Per row:

| Row | Y | Icon |
|---|---:|---|
| What this quote includes | 132 | box |
| Quote basis | 181 | document |
| Deposit & payment | 230 | pound |
| Cancellation & postponement | 279 | calendar |
| Access, parking & waiting time | 328 | parking |
| Customer packing responsibilities | 377 | package |
| Restricted items | 426 | prohibited |
| Liability & damage | 475 | shield |
| Claims | 524 | claims-document |
| Delays outside our control | 573 | cloud-delay |

Heading:

- X **105**
- Y row + **4**
- Font: Montserrat Bold **9.3 pt**
- Colour: ink

Body:

- X **105**
- Y row + **17**
- W **420**
- Font: Montserrat Regular **7.4 pt**
- Line height **9.7 pt**
- Colour: ink

Divider:

- X **38**
- Y row + **48**
- W **519.28**

---

## 4.10 Bank details card — page 2 bottom

| Property | Value |
|---|---:|
| X | 38 |
| Y | 660 |
| W | 166 |
| H | 102 |
| Fill | soft-panel |
| Border | light-grey |
| Border width | 0.7 pt |
| Corner radius | 5 pt |

Icon badge:

| Property | Value |
|---|---:|
| X | 52 |
| Y | 678 |
| Diameter | 30 pt |
| Fill | brand-red |
| Icon | bank |
| Icon colour | white |

Text:

| Text | X | Y | Style |
|---|---:|---:|---|
| `BANK DETAILS` | 91 | 679 | bank heading |
| `{bankAccountName}` | 91 | 702 | body bold |
| `Sort code:` | 52 | 732 | body |
| `{bankSortCode}` | 120 | 732 | body |
| `Account:` | 52 | 753 | body |
| `{bankAccountNumber}` | 120 | 753 | body |

---

## 4.11 Customer Acceptance box — page 2 bottom

| Property | Value |
|---|---:|
| X | 219 |
| Y | 660 |
| W | 338.28 |
| H | 102 |
| Fill | white |
| Border | `#F1C7C7` |
| Border width | 0.8 pt |
| Corner radius | 5 pt |
| Padding | 12 pt |

Heading:

- X **231**
- Y **672**
- Text: `CUSTOMER ACCEPTANCE`
- Style: bank heading

Acceptance text:

- X **231**
- Y **688**
- W **210**
- Font **6.9 pt**
- Line height **8.8 pt**

Copy:

```text
By paying the deposit or confirming in writing, I accept this quote and agree
to the terms and conditions outlined above.
```

### Signature lines

| Label | Label X | Label Y | Line X | Line Y | Line W |
|---|---:|---:|---:|---:|---:|
| `Name:` | 231 | 721 | 277 | 725 | 182 |
| `Signature:` | 231 | 742 | 277 | 746 | 182 |
| `Date:` | 231 | 762 | 277 | 766 | 182 |

Line width: **0.6 pt**  
Line colour: muted-grey.

### QR slot inside acceptance box

| Property | Value |
|---|---:|
| QR X | 478 |
| QR Y | 680 |
| QR W | 60 |
| QR H | 60 |

Render only if `{acceptQrImage}` exists.

If QR is not available, signature lines may extend to **W 260 pt**.

---

## 4.12 Footer — both pages

| Property | Value |
|---|---:|
| Rule X | 38 |
| Rule Y | 791 |
| Rule W | 519.28 |
| Rule H | 1 |
| Rule colour | brand-red |

Footer text baseline Y: **813**

Segments separated by vertical pipes.

Footer copy pattern:

```text
Marley Moves Ltd  |  Company No. 15914266  |  VAT No. {vatNumber}  |  01747 637070  |  Ref: {quoteRef}  |  Page {pageNumber} of {pageCount}
```

Style:

- Montserrat Regular **6.8 pt**
- Colour: footer-grey
- Alignment: centre
- Line height: **9 pt**

If VAT number is missing, render:

```text
VAT No. —
```

---

# 5. ICON SET

All icons use:

- `viewBox="0 0 24 24"`
- `fill="none"`
- `stroke="currentColor"`
- `stroke-width="1.8"`
- `stroke-linecap="round"`
- `stroke-linejoin="round"`

Developer should set `currentColor` to required colour.

---

## phone

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6.5 4.5 9 7.2 7.4 9.1c1.1 2.2 2.8 3.9 5.5 5.5l1.9-1.6 2.7 2.5c.4.4.5 1 .2 1.5-.8 1.5-2 2.4-3.4 2.4C9.6 19.4 4.6 14.4 4.6 9.7c0-1.4.9-2.6 2.4-3.4.5-.3 1.1-.2 1.5.2Z"/>
</svg>
```

## email

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="6" width="16" height="12" rx="2"/>
  <path d="m4.8 7.2 7.2 6 7.2-6"/>
</svg>
```

## web

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="8"/>
  <path d="M4 12h16"/>
  <path d="M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8"/>
  <path d="M12 4C9.8 6.3 8.8 9 8.8 12s1 5.7 3.2 8"/>
</svg>
```

## person

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="8" r="3.2"/>
  <path d="M5.5 19c.8-3.5 3-5.2 6.5-5.2s5.7 1.7 6.5 5.2"/>
</svg>
```

## job / briefcase

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="5" y="8" width="14" height="10" rx="2"/>
  <path d="M9 8V6.5c0-.9.6-1.5 1.5-1.5h3c.9 0 1.5.6 1.5 1.5V8"/>
  <path d="M5 12h14"/>
  <path d="M11 12v1h2v-1"/>
</svg>
```

## breakdown / table

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="5" y="4.5" width="14" height="15" rx="2"/>
  <path d="M5 9h14"/>
  <path d="M9.5 4.5v15"/>
  <path d="M14.5 4.5v15"/>
  <path d="M5 14h14"/>
</svg>
```

## info

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="8"/>
  <path d="M12 11v5"/>
  <path d="M12 8h.01"/>
</svg>
```

## tick

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
  <path d="m6.5 12.5 3.5 3.5 7.5-8"/>
</svg>
```

## bank

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 10h16"/>
  <path d="M5 10 12 5l7 5"/>
  <path d="M6.5 10v7"/>
  <path d="M10 10v7"/>
  <path d="M14 10v7"/>
  <path d="M17.5 10v7"/>
  <path d="M4.5 18.5h15"/>
</svg>
```

---

## Terms icons

### box

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="m12 4 7 4-7 4-7-4 7-4Z"/>
  <path d="M5 8v8l7 4 7-4V8"/>
  <path d="M12 12v8"/>
</svg>
```

### document

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 4h7l4 4v12H7V4Z"/>
  <path d="M14 4v4h4"/>
  <path d="M9.5 12h5"/>
  <path d="M9.5 15h5"/>
</svg>
```

### pound

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M15.5 8.2c-.6-1.3-1.7-2-3.1-2-2 0-3.4 1.4-3.4 3.6v7"/>
  <path d="M7 12h7"/>
  <path d="M7 18h10"/>
</svg>
```

### calendar

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="5" y="6.5" width="14" height="12" rx="2"/>
  <path d="M8.5 4.5v4"/>
  <path d="M15.5 4.5v4"/>
  <path d="M5 10h14"/>
  <path d="M8.5 13.5h.01"/>
  <path d="M12 13.5h.01"/>
  <path d="M15.5 13.5h.01"/>
</svg>
```

### parking

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9 18V6h4.5c2.2 0 3.5 1.4 3.5 3.4s-1.3 3.4-3.5 3.4H9"/>
</svg>
```

### package

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.5 8 12 4l7.5 4-7.5 4-7.5-4Z"/>
  <path d="M4.5 8v8l7.5 4 7.5-4V8"/>
  <path d="M8.5 6 16 10"/>
</svg>
```

### prohibited

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="8"/>
  <path d="m7 17 10-10"/>
</svg>
```

### shield

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 4.5 18 7v4.5c0 4-2.4 6.7-6 8-3.6-1.3-6-4-6-8V7l6-2.5Z"/>
  <path d="m9.5 12 1.7 1.7 3.5-4"/>
</svg>
```

### claims-document

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 4h7l4 4v12H7V4Z"/>
  <path d="M14 4v4h4"/>
  <path d="M9.5 12h5"/>
  <path d="M9.5 15h3"/>
  <circle cx="16.5" cy="16.5" r="1.5"/>
</svg>
```

### cloud-delay

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 17h8.5a3 3 0 0 0 .4-6 5 5 0 0 0-9.5-1.7A3.8 3.8 0 0 0 8 17Z"/>
  <path d="M10 20h.01"/>
  <path d="M14 20h.01"/>
</svg>
```

### clock-waiting

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="8"/>
  <path d="M12 7.5V12l3 2"/>
</svg>
```

---

# 6. STATIC COPY

## Header copy

```text
MARLEYMOVES
MOVING YOU TOWARDS YOUR FUTURE
01747 637070
info@marleymoves.co.uk
www.marleymoves.co.uk
Removal Quote
Quote Reference:
Date Issued:
Valid Until:
```

---

## Page 1 card copy

```text
CLIENT INFORMATION
Prepared for
Phone
Email

JOB DETAILS
Collection
Destination
Move Date
Prepared by
Scope
```

---

## Quote section copy

```text
QUOTE BREAKDOWN
NO.
ITEM / SERVICES
QUANTITY
UNIT PRICE
AMOUNT
Subtotal
Discount
VAT (20%)
TOTAL INCLUDING VAT
```

Mileage note:

```text
Mileage is calculated from base
to collection, collection to destination,
and return to base.
```

Acceptance strip:

```text
To accept this quote, reply in writing and pay the {depositAmount} deposit.
Accept online: {acceptUrl}
```

---

## Page 2 title copy

```text
Quote Assumptions & Terms
```

---

## Terms copy

### What this quote includes

```text
Professional removal of your household goods as detailed in this quote, carried out by our experienced team using appropriately sized vehicles and equipment.
```

### Quote basis

```text
This quote is based on the information provided and is subject to change based on actual conditions at the time of the move.
```

### Deposit & payment

```text
A booking deposit of {depositAmount} is required to secure your booking. The balance is due on completion of the removal unless agreed otherwise in writing.
```

### Cancellation & postponement

```text
Cancellations made with less than 48 hours’ notice may incur charges. Postponements are subject to availability and may incur additional costs.
```

### Access, parking & waiting time

```text
Please ensure clear access and parking for our vehicle. Charges may apply for long carries, restricted access, or waiting time caused by access issues.
```

### Customer packing responsibilities

```text
Customers are responsible for packing and preparing their items unless a packing service has been arranged and confirmed in advance.
```

### Restricted items

```text
We do not move hazardous materials, perishable goods, plants, pets, or items prohibited by law. Please inform us in advance of any items requiring special handling.
```

### Liability & damage

```text
We take all reasonable care with your belongings. Our liability is limited to loss or damage caused by our negligence and does not include pre-existing damage, poor customer packing, defective furniture, or items not suitable for normal removal handling.
```

### Claims

```text
Any claims for loss or damage must be notified in writing within 7 days of completion of the move. We will investigate promptly and fairly.
```

### Delays outside our control

```text
We are not liable for delays caused by traffic, weather, roadworks, vehicle breakdown, key delays, property chain delays, or any other circumstances beyond our reasonable control.
```

---

## Bank details copy

```text
BANK DETAILS
MARLEYMOVES LTD
Sort code:
Account:
```

---

## Customer acceptance copy

```text
CUSTOMER ACCEPTANCE
By paying the deposit or confirming in writing, I accept this quote and agree to the terms and conditions outlined above.
Name:
Signature:
Date:
```

---

## Footer copy

```text
Marley Moves Ltd  |  Company No. 15914266  |  VAT No. {vatNumber}  |  01747 637070  |  Ref: {quoteRef}  |  Page {pageNumber} of {pageCount}
```

---

# 7. DYNAMIC DATA SLOTS

## Quote/document data

| Placeholder | Description |
|---|---|
| `{quoteRef}` | Quote reference, e.g. `MM-260708-010` |
| `{issueDate}` | Date issued |
| `{validUntil}` | Quote expiry date |
| `{pageNumber}` | Current page number |
| `{pageCount}` | Total page count |
| `{vatNumber}` | VAT number or `—` |
| `{acceptUrl}` | Public quote acceptance URL |
| `{acceptQrImage}` | QR image for accept URL |

---

## Customer data

| Placeholder | Description |
|---|---|
| `{customerName}` | Customer name |
| `{customerPhone}` | Customer phone |
| `{customerEmail}` | Customer email |

---

## Job data

| Placeholder | Description |
|---|---|
| `{collectionAddressLines}` | Array of collection address lines |
| `{destinationAddressLines}` | Array of destination address lines |
| `{moveDate}` | Move date or `TBC` |
| `{preparedBy}` | Staff member |
| `{scope}` | Scope/type, e.g. `Rented` |

---

## Line items

Variable array: `{lineItems}`

Each line item:

| Placeholder | Description |
|---|---|
| `{lineItem.number}` | Row number |
| `{lineItem.label}` | Main item name |
| `{lineItem.subDetail}` | Smaller supporting detail |
| `{lineItem.quantity}` | Quantity |
| `{lineItem.unitPrice}` | Unit price |
| `{lineItem.amount}` | Row amount |

---

## Totals

| Placeholder | Description |
|---|---|
| `{subtotal}` | Subtotal |
| `{discount}` | Discount amount |
| `{hasDiscount}` | Boolean. Hide row when zero |
| `{vatRate}` | VAT rate, e.g. `20%` |
| `{vatAmount}` | VAT amount |
| `{grandTotal}` | Total including VAT |

---

## Payment

| Placeholder | Description |
|---|---|
| `{depositAmount}` | Deposit amount, e.g. `£100` |
| `{bankAccountName}` | Bank account name |
| `{bankSortCode}` | Sort code |
| `{bankAccountNumber}` | Account number |
| `{paymentReference}` | Suggested payment reference, usually quote ref |

Optional payment reference line for bank card if desired:

```text
Reference: {paymentReference}
```

If added, place at:

- X **52**
- Y **773**
- Text value X **120**

---

# 8. LAYOUT RULES & EDGE CASES

## 8.1 Quote table row count

### Normal mode: 1-5 rows

- Use standard geometry.
- Quote table starts at **Y 414**.
- Totals stack remains at **Y 570**.
- Acceptance strip remains at **Y 704**.

### Compact mode: 6-8 rows

Apply:

- Table row height: **34-36 pt**.
- Reduce card height only if required, minimum **178 pt**.
- Move totals directly below table with **14 pt gap**.
- Move mileage callout directly below table or below totals depending on available space.
- Acceptance strip must remain above footer with minimum Y **704** where possible.

### Continuation mode: 9+ rows or insufficient space

- Continue quote table on next page.
- Repeat quote table header.
- Add section heading:

```text
QUOTE BREAKDOWN CONTINUED
```

- Heading Y: **132 pt** on continuation page.
- Table Y: **164 pt**.
- Keep totals block unbroken after final row.
- If final row + totals cannot fit on same page, move totals to the next page.

---

## 8.2 Keep-together rules

These blocks must never split:

- Header
- Client card
- Job details card
- Table header row
- Totals stack including red total bar
- Acceptance strip
- Each individual terms row
- Bank details card
- Customer acceptance box
- Footer

---

## 8.3 Long item names

For quote table item labels:

- Label max width: **185 pt**.
- Wrap to max **2 lines**.
- Sub-detail max **2 lines**.
- If label + sub-detail exceeds row height, increase that row height.
- Do not reduce font below:
  - Label: **7.5 pt**
  - Sub-detail: **6.7 pt**

---

## 8.4 Long addresses

Address areas:

- Collection/destination max width: **130 pt**.
- Wrap naturally by line.
- Maximum visible lines per address: **4**.
- If address exceeds 4 lines:
  - Use smaller address font **8.2 pt**.
  - Line height **10.5 pt**.
  - Do not truncate postcode.

---

## 8.5 Long customer email

- Email max width: **200 pt**.
- Reduce font size to **7.3 pt** if required.
- If still too long, wrap once.
- Do not truncate unless absolutely unavoidable.

---

## 8.6 Discount row

If `{hasDiscount}` is false:

- Hide discount row.
- Move VAT row up by **22 pt**.
- Total bar remains fixed relative to totals stack.
- Do not leave a blank gap.

---

## 8.7 VAT handling

Footer must always include:

```text
VAT No. {vatNumber}
```

If Marley Moves is not VAT registered or no VAT number exists:

```text
VAT No. —
```

If VAT is not charged:

- Replace VAT row with:

```text
VAT
£0.00
```

or hide VAT row only if legally/accounting-approved.

---

## 8.8 Terms page rule

The terms content **always starts on its own page**.

Scenarios:

| Scenario | Output |
|---|---|
| Quote table fits page 1 | Page 2 = terms |
| Quote table continues to page 2 | Page 3 = terms |
| Terms copy grows too large | Page 3 or 4 allowed, but keep bottom acceptance box on final terms page |

---

## 8.9 QR slots

Two QR placements are reserved:

### Page 1 acceptance strip

| Slot | X | Y | W | H |
|---|---:|---:|---:|---:|
| `{acceptQrImage}` | 476 | 706 | 66 | 66 |

### Page 2 customer acceptance box

| Slot | X | Y | W | H |
|---|---:|---:|---:|---:|
| `{acceptQrImage}` | 478 | 680 | 60 | 60 |

If QR code is missing:

- Do not show placeholder border.
- Expand text/signature lines into available space.

---

## 8.10 Footer page count

Page count must reflect actual generated pages.

Examples:

- Standard quote: `Page 1 of 2`, `Page 2 of 2`
- Quote continuation: `Page 1 of 3`, `Page 2 of 3`, `Page 3 of 3`

Final terms page must always include the customer acceptance box.
