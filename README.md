# Stencil Tiler

Upload an SVG, choose a real-world size (e.g. 2 ft wide), pick a paper size, and download a
single **margin-less PDF** of the outline split across pages. Print, tape the pages together,
paint.

Everything runs in the browser. No server, accounts or uploads.

## Use

No build step. Serve the folder with any static server (ES modules need http, not `file://`):

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

It also deploys as-is to GitHub Pages, Netlify, etc.

## How it works

- **Outline:** every visible shape is outlined separately (no merging). Filled shapes become
  their boundary, holes become their own outlines, stroke-only shapes use their centre line.
  Fills, dashes, gradients, clips, masks and filters are ignored. Text and raster images are
  skipped with a warning (convert text to paths first).
- **Size:** you give width or height (ft, in, cm, m); the other follows the artwork's aspect
  ratio. The size refers to the artwork's geometry bounding box.
- **Line thickness:** you choose it (mm, cm or in; default 2 mm, range 0.1 to 100 mm). It is a
  real printed thickness and does not grow or shrink with the artwork size. The preview draws it
  at true scale.
- **Print style** (toggle):
  - *Edge to edge* (default): margin-less pages with a 10 mm overlap between neighbours, so a
    slightly shifted sheet never leaves a gap. Grey registration crosses sit mid-overlap; line
    them up on neighbouring pages, then tape.
  - *Bordered*: for printers that cannot print to the edge. Every page keeps a blank 1 cm margin.
    Cut marks appear only on sides that join a neighbouring page (cut the margin off along the
    marks and butt the pages together); the outer sides of the whole grid keep their margin and
    have no marks. In a 3x3 grid the top row keeps its top margin, the left column its left
    margin, the right column its right margin and the bottom row its bottom margin.
  - Each page carries a label like `R2-C3  6/12` inside the page. Pages run left to right, top
    to bottom.
- **Paper:** A5, A4 (default), A3, Letter, Legal, Tabloid, 4x6, 5x7; portrait or landscape.
- **PDF:** vector paths embedded once and reused per page, so lines stay crisp at any size.
  An optional assembly-map page can be added first.
- Printing: use 100% / "Actual size", never "Fit to page".

## Layout

```
index.html        UI
css/styles.css
js/svg-outline.js SVG parsing -> outline geometry
js/tiling.js      units, paper sizes, grid maths
js/pdf.js         PDF generation (pdf-lib)
js/main.js        UI wiring and preview
vendor/           pdf-lib (MIT)
tests/            fixtures + Playwright smoke test
```

## Tests

```sh
NODE_PATH=<dir with playwright and pdf-lib> node tests/smoke.mjs
```

Drives the real app in headless Chromium, downloads PDFs and checks page counts and sizes.
