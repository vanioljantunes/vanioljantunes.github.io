/* Where the viewer gets its images.
 *
 * Public DICOMweb servers come and go. Probed on 2026-10-01, three endpoints that older
 * browser-viewer demos all point at no longer resolve in DNS at all:
 * d3t6nz73ql33tx.cloudfront.net, d33do7qe4w26qo.cloudfront.net and server.dcmjs.org.
 * So the viewer never hardcodes a single host: it keeps a registry, probes a source before
 * trusting it, and always offers local files, which need no network.
 */

export type SourceId = 'idc' | 'orthanc' | 'custom' | 'local';

export interface Source {
  id: SourceId;
  label: string;
  /* DICOMweb root, no trailing slash. Empty for the local-file source. */
  root: string;
  /* Shown under the picker, one line. */
  note: string;
  /* Required credit line, rendered on the page when the source is in use. */
  attribution?: string;
  /* Some public servers return almost nothing from QIDO without an explicit field list. */
  needsIncludeField: boolean;
}

/* NCI Imaging Data Commons, reached through the public proxy that the Imaging Data Commons
   publishes for browser viewers. Verified CORS-open: it echoes our origin back in
   access-control-allow-origin. The path says viewer-only-no-downloads, and the viewer
   honours that - it renders pixels and never offers a "download series" action. */
const IDC_ROOT =
  'https://proxy.imaging.datacommons.cancer.gov/current/' +
  'viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb';

export const SOURCES: readonly Source[] = [
  {
    id: 'idc',
    label: 'NCI Imaging Data Commons',
    root: IDC_ROOT,
    note: 'Public de-identified cancer imaging. Viewing only, no downloads.',
    attribution:
      'Data from the NCI Imaging Data Commons, which hosts collections from ' +
      'The Cancer Imaging Archive (TCIA).',
    needsIncludeField: true,
  },
  {
    id: 'orthanc',
    label: 'Orthanc public demo',
    /* Served without CORS headers, so it is reached through a same-origin rewrite
       declared in vercel.json rather than fetched cross-origin. */
    root: '/dicomweb/orthanc',
    note: 'Small mixed-modality demo set, proxied because it sends no CORS headers.',
    attribution: 'Orthanc public demo server, orthanc.uclouvain.be.',
    needsIncludeField: false,
  },
  {
    id: 'custom',
    label: 'Your own DICOMweb server',
    root: '',
    note: 'Paste a DICOMweb root. It must send CORS headers for this origin.',
    needsIncludeField: false,
  },
  {
    id: 'local',
    label: 'Files on this computer',
    root: '',
    note: 'Drag DICOM files in. They are read in the browser and never uploaded.',
    needsIncludeField: false,
  },
];

export function sourceById(id: SourceId): Source {
  const found = SOURCES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown source: ${id}`);
  return found;
}

/* The series the page opens with, so a first-time visitor sees an image rather than a
   form. An NLST lung-screening chest CT from IDC: 277 slices at 512x512, uncompressed,
   1.25 mm thick, 0.703 mm in plane, rescaled to true Hounsfield units. */
export const DEMO = {
  sourceId: 'idc' as const,
  studyInstanceUID: '1.3.6.1.4.1.14519.5.2.1.7009.9004.300669778921232190173497193723',
  seriesInstanceUID: '1.3.6.1.4.1.14519.5.2.1.7009.9004.224609210365038688332814633445',
  label: 'Chest CT, lung screening, 277 slices',
};
