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
- **Line:** black, fixed 2 mm thick at real-world scale.
- **Tiling:** pages are margin-less with a 10 mm overlap between neighbours. Registration
  crosses sit mid-overlap, so the same cross appears at the same spot on adjacent pages: line
  them up, then tape. Each page carries a label like `R2-C3  6/12` inside the page.
  Pages run left to right, top to bottom.
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
