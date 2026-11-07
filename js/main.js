import { parseSvg, toPathD } from './svg-outline.js';
import {
  MM_PER, PAPERS, STROKE_MM, MAX_PAGES, WARN_PAGES, paperLabel, computeLayout,
} from './tiling.js';
import { buildPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);
const el = {
  file: $('file'), drop: $('drop'), sample: $('sample'), info: $('fileinfo'), error: $('error'),
  warnings: $('warnings'), steps: $('steps'), unit: $('unit'), width: $('width'), height: $('height'),
  paper: $('paper'), overview: $('overview'), orientHint: $('orienthint'), summary: $('summary'),
  pageWarn: $('pagewarn'), preview: $('preview'), download: $('download'),
};

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="95" fill="#222"/>
  <circle cx="100" cy="100" r="78" fill="#fff"/>
  <polygon points="100,28 119,78 172,80 130,113 145,165 100,135 55,165 70,113 28,80 81,78" fill="#222"/>
</svg>`;

const state = {
  name: 'stencil', parsed: null, d: '',
  widthMm: 2 * MM_PER.ft, // default request: 2 ft wide
  valid: false, layout: null, busy: false,
};

for (const key of Object.keys(PAPERS)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = paperLabel(key);
  if (key === 'A4') o.selected = true;
  el.paper.append(o);
}

const orientation = () => document.querySelector('input[name="orient"]:checked').value;
const unitMm = () => MM_PER[el.unit.value];
const fmt = (v) => String(Math.round(v * 100) / 100);
const aspect = () => state.parsed.bbox.h / state.parsed.bbox.w; // height per unit width

// ------------------------------------------------------------------ loading

function showError(msg) {
  el.error.textContent = msg || '';
  el.error.hidden = !msg;
}

function load(text, name) {
  showError('');
  try {
    const parsed = parseSvg(text);
    state.parsed = parsed;
    state.d = toPathD(parsed.subpaths);
    state.name = name;
    el.info.hidden = false;
    el.info.textContent =
      `${name}: ${parsed.stats.shapes} shape${parsed.stats.shapes === 1 ? '' : 's'}, ` +
      `${parsed.stats.subpaths} outline${parsed.stats.subpaths === 1 ? '' : 's'}.`;
    el.warnings.replaceChildren(...parsed.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
    el.warnings.hidden = parsed.warnings.length === 0;
    el.steps.disabled = false;
    setWidth(el.width.value ? parseFloat(el.width.value) * unitMm() : state.widthMm);
    update();
  } catch (e) {
    state.parsed = null;
    state.valid = false;
    el.steps.disabled = true;
    el.info.hidden = true;
    el.warnings.hidden = true;
    showError(e.message || 'Could not read that SVG.');
    update();
  }
}

async function loadFile(file) {
  if (!file) return;
  load(await file.text(), file.name.replace(/\.svg$/i, '') || 'stencil');
}

el.file.addEventListener('change', () => loadFile(el.file.files[0]));
el.sample.addEventListener('click', () => load(SAMPLE_SVG, 'sample-star'));
for (const ev of ['dragenter', 'dragover']) {
  el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove('over'); });
}
el.drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

// ------------------------------------------------------------------ size inputs

function setWidth(mm) {
  state.widthMm = mm;
  el.width.value = fmt(mm / unitMm());
  el.height.value = fmt((mm * aspect()) / unitMm());
}

el.width.addEventListener('input', () => {
  const v = parseFloat(el.width.value);
  if (state.parsed && v > 0) {
    state.widthMm = v * unitMm();
    el.height.value = fmt((state.widthMm * aspect()) / unitMm());
  } else el.height.value = '';
  update();
});

el.height.addEventListener('input', () => {
  const v = parseFloat(el.height.value);
  if (state.parsed && v > 0) {
    state.widthMm = (v * unitMm()) / aspect();
    el.width.value = fmt(state.widthMm / unitMm());
  } else el.width.value = '';
  update();
});

el.unit.addEventListener('change', () => {
  // keep the physical size, just re-express it in the new unit
  if (state.parsed && state.widthMm > 0) setWidth(state.widthMm);
  update();
});
el.paper.addEventListener('change', update);
el.overview.addEventListener('change', update);
for (const r of document.querySelectorAll('input[name="orient"]')) r.addEventListener('change', update);

// ------------------------------------------------------------------ render

function hasSize() {
  return state.parsed && parseFloat(el.width.value) > 0 && parseFloat(el.height.value) > 0;
}

function update() {
  const ok = hasSize();
  state.valid = ok;
  if (!ok) {
    state.layout = null;
    el.summary.textContent = state.parsed ? 'Enter a width or height greater than zero.' : 'Load an SVG to see the page layout.';
    el.pageWarn.hidden = true;
    el.orientHint.textContent = '';
    el.preview.innerHTML = '<span class="empty">The tile preview appears here.</span>';
    el.download.disabled = true;
    return;
  }

  const artW = state.widthMm, artH = state.widthMm * aspect();
  const L = computeLayout(artW, artH, el.paper.value, orientation());
  state.layout = L;

  const u = el.unit.value;
  const extra = el.overview.checked ? ' + 1 map page' : '';
  el.summary.textContent =
    `${fmt(artW / unitMm())} x ${fmt(artH / unitMm())} ${u} on ${L.cols} x ${L.rows} = ${L.pages} page${L.pages === 1 ? '' : 's'}${extra}`;

  const tooMany = L.pages > MAX_PAGES;
  if (tooMany) el.pageWarn.textContent = `That needs ${L.pages} pages, more than the ${MAX_PAGES}-page limit. Choose larger paper or a smaller size.`;
  else if (L.pages > WARN_PAGES) el.pageWarn.textContent = `That is ${L.pages} pages to print and tape. Larger paper would cut the count.`;
  el.pageWarn.hidden = !(tooMany || L.pages > WARN_PAGES);

  const other = orientation() === 'portrait' ? 'landscape' : 'portrait';
  const O = computeLayout(artW, artH, el.paper.value, other);
  el.orientHint.textContent = O.pages === L.pages
    ? `${other[0].toUpperCase()}${other.slice(1)} needs the same number of pages.`
    : `${other[0].toUpperCase()}${other.slice(1)} would need ${O.pages} page${O.pages === 1 ? '' : 's'}.`;

  renderPreview(L);
  el.download.disabled = state.busy || tooMany;
}

function renderPreview(L) {
  const { parsed } = state;
  const s = state.widthMm / parsed.bbox.w;
  const pad = STROKE_MM / 2;
  const tx = pad - parsed.bbox.minX * s, ty = pad - parsed.bbox.minY * s;
  const m = Math.max(L.pw, L.ph) * 0.02;
  const fs = Math.min(L.pw, L.ph) * 0.09;
  let tiles = '';
  let n = 0;
  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.cols; c++) {
      n++;
      const x = c * L.stepX, y = r * L.stepY;
      tiles += `<rect class="tile ${(r + c) % 2 ? 'b' : 'a'}" x="${x}" y="${y}" width="${L.pw}" height="${L.ph}"/>` +
        `<text class="lbl" x="${x + L.pw / 2}" y="${y + L.ph - fs}" font-size="${fs}">R${r + 1}-C${c + 1} (${n})</text>`;
    }
  }
  el.preview.innerHTML =
    `<svg viewBox="${-m} ${-m} ${L.totalW + 2 * m} ${L.totalH + 2 * m}" role="img" aria-label="Artwork placed on a grid of pages">` +
    tiles +
    `<g transform="translate(${tx} ${ty}) scale(${s})"><path class="art" d="${state.d}"/></g></svg>`;
}

// ------------------------------------------------------------------ download

el.download.addEventListener('click', async () => {
  if (!state.valid || state.busy) return;
  state.busy = true;
  el.download.disabled = true;
  const label = el.download.textContent;
  el.download.textContent = 'Preparing PDF...';
  showError('');
  try {
    // let the button repaint before the heavy work starts
    await new Promise((r) => setTimeout(r, 30));
    const bytes = await buildPdf({
      subpaths: state.parsed.subpaths,
      bbox: state.parsed.bbox,
      widthMm: state.widthMm,
      paper: el.paper.value,
      orientation: orientation(),
      overview: el.overview.checked,
      title: state.name,
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), {
      href: url, download: `${state.name}-stencil-${el.paper.value}.pdf`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    showError(`Could not build the PDF: ${e.message}`);
  } finally {
    state.busy = false;
    el.download.textContent = label;
    update();
  }
});

update();
