// Builds the cutting kit: cut files for every page, an instruction PDF, and a copy of the
// print PDF, in one ZIP. (The printable PDF itself stays a single combined file.)

import { computeLayout } from './tiling.js';
import {
  buildDashes, pagePolylines, punchPolylines, toSvg, toDxf, BRIDGE_MM,
} from './cutfiles.js';
import { buildGuidePdf } from './guide.js';
import { buildPdf } from './pdf.js';
import { MACHINES } from './machines.js';
import { makeZip } from './zip.js';

const pad2 = (n, width) => String(n).padStart(width, '0');

/**
 * @param {object} o everything buildPdf takes, plus:
 * @param {string} o.machineId @param {boolean} o.perforated @param {'small'|'medium'|'large'} o.bridge
 * @returns {Promise<{bytes: Uint8Array, name: string, pages: number}>}
 */
export async function buildKit(o) {
  const machine = MACHINES[o.machineId];
  const bridgeMm = BRIDGE_MM[o.bridge] ?? BRIDGE_MM.medium;
  const scale = o.widthMm / o.bbox.w;
  const L = computeLayout(o.widthMm, o.bbox.h * scale, o.paper, o.orientation, { mode: o.mode, strokeMm: o.strokeMm });

  const enc = new TextEncoder();
  const files = [];
  const dashes = buildDashes(o.subpaths, o.bbox, o.widthMm, o.strokeMm, { perforated: o.perforated, bridgeMm });
  const width = String(L.pages).length;
  const punches = punchPolylines(L);
  const emit = (base, polys) => {
    const names = [];
    files.push({ name: `cut-files/${base}.svg`, data: enc.encode(toSvg(polys, L)) });
    names.push(`${base}.svg`);
    if (machine.formats.includes('dxf')) {
      files.push({ name: `cut-files/${base}.dxf`, data: enc.encode(toDxf(polys, L)) });
      names.push(`${base}.dxf`);
    }
    return names;
  };

  const testFiles = emit('00_alignment-test', punches);
  const pages = [];
  let n = 0;
  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.cols; c++) {
      n++;
      const polys = [...pagePolylines(dashes, L, r, c), ...punches];
      pages.push({ n, r: r + 1, c: c + 1, files: emit(`page-${pad2(n, width)}_R${r + 1}-C${c + 1}`, polys) });
    }
  }

  const guide = await buildGuidePdf({
    machineId: o.machineId, L, pages, perforated: o.perforated, bridgeMm, paper: o.paper,
    orientation: o.orientation, title: o.title, hasGuide: !!o.order, testFiles,
  });
  files.unshift({ name: `cutting-guide-${o.machineId}.pdf`, data: guide });

  const print = await buildPdf(o);
  files.push({ name: `${o.title}-stencil-${o.paper}.pdf`, data: print });

  return { bytes: makeZip(files), name: `${o.title}-cutting-kit-${o.machineId}.zip`, pages: L.pages };
}
