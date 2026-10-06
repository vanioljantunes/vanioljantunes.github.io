/* What makes each viewer its own thing rather than one page relabelled.
 *
 * The four modalities are not variations on a theme. A CT number is calibrated against
 * water and means the same on every scanner in the world; an MR signal is not calibrated at
 * all, and what a radiologist asks of it is the weighting, not the window. A radiograph is
 * one or two projections, so the question is which view. Ultrasound is operator-held, so the
 * useful metadata is the probe.
 *
 * Each profile therefore sets what the picker is called, and which extra DICOM fields the
 * overlay shows under the common ones.
 */

import { TAG } from './dicomweb';

export interface OverlayField {
  label: string;
  tag: string;
  /** Appended when a value is present. */
  unit?: string;
  /** Decimal places for numeric values; omitted means show the raw text. */
  decimals?: number;
}

export interface ModalityProfile {
  /** Matches the modality group used by the catalog: CT, MR, XR, MG, US. */
  group: string;
  /** Page heading and document title. */
  title: string;
  /** One line under the heading. */
  blurb: string;
  /** What the sequence picker is called for this modality. */
  pickerLabel: string;
  /** Extra readout rows, shown under the shared ones. */
  extra: OverlayField[];
  /** Short note shown under the controls, where the modality needs explaining. */
  note?: string;
}

const PROFILES: Record<string, ModalityProfile> = {
  CT: {
    group: 'CT',
    title: 'CT viewer',
    blurb:
      'Computed tomography read in the browser. Pixel values are true Hounsfield units, so ' +
      'the window presets mean what they mean on a workstation.',
    pickerLabel: 'Reconstruction',
    extra: [
      { label: 'kVp', tag: TAG.KVP, decimals: 0 },
      { label: 'Kernel', tag: TAG.ConvolutionKernel },
      { label: 'Contrast', tag: TAG.ContrastBolusAgent },
    ],
    note:
      'A CT number is calibrated so that air is -1000 and water is 0, which is why the same ' +
      'window means the same thing on any scanner.',
  },

  MR: {
    group: 'MR',
    title: 'MRI viewer',
    blurb:
      'Magnetic resonance read in the browser. Pick the weighting to see how the same ' +
      'anatomy changes between T1, T2 and diffusion.',
    pickerLabel: 'Weighting',
    extra: [
      { label: 'Field', tag: TAG.MagneticFieldStrength, unit: ' T', decimals: 1 },
      { label: 'TR', tag: TAG.RepetitionTime, unit: ' ms', decimals: 0 },
      { label: 'TE', tag: TAG.EchoTime, unit: ' ms', decimals: 0 },
    ],
    note:
      'MR signal is not calibrated against anything, so there are no fixed windows here. ' +
      'What changes the picture is the weighting: TR and TE are shown so the contrast on ' +
      'screen can be tied to how it was acquired.',
  },

  XR: {
    group: 'XR',
    title: 'X-ray viewer',
    blurb:
      'Plain radiographs read in the browser. A study is one or two projections rather than ' +
      'a stack, so the view matters more than scrolling.',
    pickerLabel: 'View',
    extra: [
      { label: 'View', tag: TAG.ViewPosition },
      { label: 'kVp', tag: TAG.KVP, decimals: 0 },
    ],
    note:
      'A radiograph is a shadow of the whole thickness of the body at once, so structures ' +
      'overlap. That is why the view, AP against PA or lateral, changes what can be seen.',
  },

  US: {
    group: 'US',
    title: 'Ultrasound viewer',
    blurb:
      'Ultrasound read in the browser. These are held studies rather than reconstructed ' +
      'volumes, so what the probe was doing matters.',
    pickerLabel: 'Acquisition',
    extra: [{ label: 'Probe', tag: TAG.TransducerData }],
    note:
      'Ultrasound is acquired by hand, so the plane is whatever the operator chose rather ' +
      'than a fixed axial, coronal or sagittal one.',
  },

  MG: {
    group: 'MG',
    title: 'Mammography viewer',
    blurb:
      'Mammography read in the browser. The findings are small and the images are large, so ' +
      'zoom is the control that matters most.',
    pickerLabel: 'View',
    extra: [{ label: 'View', tag: TAG.ViewPosition }],
  },
};

/** Every modality with its own page, in the order the imaging index lists them. */
export const PROFILE_ORDER = ['CT', 'MR', 'XR', 'US'] as const;

export function profileFor(group: string | undefined): ModalityProfile | undefined {
  if (!group) return undefined;
  return PROFILES[group];
}

/**
 * The modality this page is locked to, declared on the body as data-modality.
 * A page without it is the combined viewer and shows everything.
 */
export function pageModality(): string | undefined {
  const value = document.body.dataset.modality;
  return value && PROFILES[value] ? value : undefined;
}
