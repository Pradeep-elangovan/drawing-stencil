// Cutting machines we write instructions for, and what we know about each.
//
// What is confirmed (manufacturer / official help pages, checked while building this):
//  - Cricut Design Space opens SVG and DXF made of flat-colour shapes (no pattern fills,
//    clipping paths or live text). Explore and Maker use 12 x 12 in and 12 x 24 in mats;
//    Joy Xtra uses an 8.5 x 12 in mat. Only the Maker family has a perforation blade, and
//    it needs shapes of at least 3/4 in with 3/4 in between paths.
//  - Cricut Print Then Cut is too small for a full A4 / Letter sheet (about 7.2 x 10.6 in
//    on A4, 7.4 x 9.9 in on Letter), so these kits are cut-only with manual alignment.
//  - Silhouette Studio needs Designer Edition or higher to open SVG; the Silhouette Go app
//    opens SVG for everyone.
//  - Brother ScanNCut SDX models read SVG and FCM (USB or wireless) and have a built-in scanner.
// Mat clearances below are approximate and the guide says so. Nothing here has been run on
// a physical machine.

const IN = 25.4;
const MAT = {
  m12: { label: '12 x 12 in', w: 12 * IN, h: 12 * IN },
  m1224: { label: '12 x 24 in', w: 12 * IN, h: 24 * IN },
  joyX: { label: '8.5 x 12 in', w: 8.5 * IN, h: 12 * IN },
};
// A sheet must sit inside the mat with this much clearance on each side (about 0.25 in).
export const CLEARANCE_MM = 6.35;

const cricutSteps = (c) => [
  `Open Cricut Design Space and start a New Project. Choose Upload, Upload Image, Browse, and pick ${c.first}. Click Upload, then Add to Canvas. The file is a single cut layer.`,
  `Select the design and set Width to ${c.w} mm (${c.wIn} in) and Height to ${c.h} mm (${c.hIn} in). That is exactly the sheet size, so it must not be scaled. Units can be changed in Settings.`,
  'In the Layers panel check the Linetype is Cut. Do not use Flatten or Print Then Cut: this is a cut-only job.',
  `Click Make It and choose the ${c.mat || 'right'} mat. Leave Mirror off. The design sits at the top-left of the mat.`,
  'Stick the sheet on the mat with its top-left corner in the top-left corner of the mat grid, edges square to the grid lines, in the same orientation as the preview.',
  'Pick a paper or cardstock material setting that suits your paper. Do the alignment test (above) before the first real page.',
  'Load the mat, press Go, then unload. Peel the paper off the mat from the back (bend the mat, not the paper) so the bridges do not tear.',
  ...(c.maker ? ['Maker owners: the Maker has a perforation blade, but it needs shapes of at least 3/4 in with 3/4 in between paths, which small details will not meet. These dashed cuts work on any shape. To use the blade instead, make the kit with the Full cut style.'] : []),
];

export const MACHINES = {
  cricut: {
    name: 'Cricut Explore / Maker',
    mats: [MAT.m12, MAT.m1224],
    formats: ['svg'],
    steps: (c) => cricutSteps({ ...c, maker: true }),
  },
  'cricut-joy-xtra': {
    name: 'Cricut Joy Xtra',
    mats: [MAT.joyX],
    formats: ['svg'],
    steps: (c) => cricutSteps({ ...c, maker: false }),
  },
  silhouette: {
    name: 'Silhouette Cameo / Portrait',
    mats: [MAT.m12, MAT.m1224],
    formats: ['svg', 'dxf'],
    steps: (c) => [
      `Open Silhouette Studio, then File, Open, and pick ${c.first}. The free edition opens the DXF; opening the SVG needs Designer Edition or higher (or open it in the Silhouette Go app).`,
      `In Page Settings turn the Cutting Mat on, pick your mat size${c.mat ? ` (${c.mat})` : ''}, and turn Registration Marks off. This is a cut-only job.`,
      `Select the design and set its size to ${c.w} x ${c.h} mm (${c.wIn} x ${c.hIn} in) in the Transform panel. Move it so its top-left corner is at the top-left corner of the mat area.`,
      'Go to the Send tab and pick a paper or cardstock setting, then set the blade depth for your blade. Do the alignment test (above) before the first real page.',
      'Stick the sheet on the mat with its top-left corner in the mat grid corner, edges square to the grid, then load the mat and press Send.',
      'Unload and peel the paper off the mat from the back (bend the mat, not the paper) so the bridges do not tear.',
      'Portrait owners: your mat is narrower than a Cameo mat. Check that the sheet fits before cutting; a smaller paper size may be needed.',
    ],
  },
  scanncut: {
    name: 'Brother ScanNCut',
    mats: [MAT.m12, MAT.m1224],
    formats: ['svg'],
    steps: (c) => [
      `Copy ${c.first} to a USB stick (or send it over wireless) and load it on the machine as an SVG pattern.`,
      `On the edit screen set the size to ${c.w} x ${c.h} mm (${c.wIn} x ${c.hIn} in) and move the design to the top-left corner of the mat area.`,
      `Stick the sheet on the mat${c.mat ? ` (${c.mat})` : ''} with its top-left corner in the mat's top-left corner, edges square to the grid, and load the mat.`,
      'If your model has Background Scan, scan the loaded sheet first so the printed outlines show on screen, then nudge the cut lines onto them.',
      'Choose a paper or cardstock setting and a blade depth that suit your paper. Do the alignment test (above) before the first real page, then press Start.',
      'Unload and peel the paper off the mat from the back (bend the mat, not the paper) so the bridges do not tear.',
    ],
  },
  other: {
    name: 'Other cutter (SVG / DXF)',
    mats: [],
    formats: ['svg', 'dxf'],
    steps: (c) => [
      `Open ${c.first} in your cutter's software. SVG and DXF are both supplied. Units are millimetres.`,
      `Set the size to exactly ${c.w} x ${c.h} mm (${c.wIn} x ${c.hIn} in), which is the sheet size. Place its top-left corner at the cutter's origin corner for the sheet.`,
      'Make sure the lines are set to cut, with no fill, and that print-and-cut or registration marks are off.',
      'Place the sheet in the machine so its top-left corner is at the same origin. Do the alignment test (above) first.',
      'Cut one page at a time, then peel the paper off the mat or carrier from the back so the bridges do not tear.',
    ],
  },
};

export const MACHINE_IDS = Object.keys(MACHINES);

/** Does a sheet pw x ph (mm) fit the machine's usual mats? Approximate (see CLEARANCE_MM). */
export function fitReport(machineId, pw, ph) {
  const m = MACHINES[machineId];
  if (!m.mats.length) return { checked: false, ok: true, fits: [] };
  const fits = m.mats.filter((mat) => {
    const uw = mat.w - 2 * CLEARANCE_MM, uh = mat.h - 2 * CLEARANCE_MM;
    return (pw <= uw && ph <= uh) || (ph <= uw && pw <= uh);
  }).map((mat) => mat.label);
  return { checked: true, ok: fits.length > 0, fits, all: m.mats.map((x) => x.label) };
}
