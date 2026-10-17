// Cochrane-style traffic light plot for /tools/robvis/. Builds the figure as SVG markup so
// the same string can go in the page, into a downloaded .svg, and through a canvas to .png.

import { LEVELS } from './rob-instruments.js';

const esc = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';

/**
 * rows: [{ study, cells: [{ level, label }], overall: { level, label } }]
 * columns: [{ id, label }] for the domains, without the overall column.
 */
export function trafficLightSvg({ rows, columns, title = '', includeOverall = true, legendLevels = [] }) {
  const cell = 46;
  const radius = 15;
  const studyWidth = Math.min(
    280,
    Math.max(130, 16 + 8.2 * rows.reduce((max, r) => Math.max(max, String(r.study || '').length), 6)),
  );
  const columnsOut = includeOverall ? [...columns, { id: 'overall', label: 'Overall' }] : columns;
  // The headers are set at -50 degrees, so a long domain name needs headroom above the grid
  // and overhangs to the right of its own column. Both are measured off the label length
  // rather than fixed, or "Deviations from intended interventions" runs off the top.
  const ANGLE = (50 * Math.PI) / 180;
  const textWidth = (label) => 6.15 * String(label).length;
  const longest = columnsOut.reduce((max, column) => Math.max(max, textWidth(column.label)), 0);
  const headerHeight = Math.max(70, Math.ceil(Math.sin(ANGLE) * longest) + 16);
  const rightPad = Math.ceil(Math.cos(ANGLE) * textWidth(columnsOut[columnsOut.length - 1].label)) + 16;
  const titleHeight = title ? 34 : 0;
  const legendColumns = 3;
  const legendRows = legendLevels.length ? Math.ceil(legendLevels.length / legendColumns) : 0;
  const legendHeight = legendRows ? 20 + legendRows * 24 : 0;
  const gridWidth = columnsOut.length * cell;
  const width = Math.max(studyWidth + gridWidth + rightPad, legendRows ? 520 : 0);
  const gridTop = titleHeight + headerHeight;
  const height = gridTop + rows.length * cell + legendHeight + 16;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" role="img" aria-label="Risk of bias traffic light plot">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  if (title) {
    parts.push(`<text x="12" y="22" font-size="15" font-weight="600" fill="#1c2430">${esc(title)}</text>`);
  }

  // Column headers, turned so a long domain name fits over a 46px column.
  columnsOut.forEach((column, index) => {
    const x = studyWidth + index * cell + cell / 2 + 4;
    const y = gridTop - 12;
    parts.push(
      `<text transform="translate(${x} ${y}) rotate(-50)" font-size="12" fill="#1c2430">${esc(column.label)}</text>`,
    );
  });

  rows.forEach((row, r) => {
    const y = gridTop + r * cell;
    parts.push(
      `<text x="${studyWidth - 14}" y="${y + cell / 2 + 4}" font-size="13" text-anchor="end" fill="#1c2430">${esc(row.study)}</text>`,
    );
    const cells = includeOverall ? [...row.cells, row.overall] : row.cells;
    cells.forEach((item, c) => {
      const cx = studyWidth + c * cell + cell / 2;
      const cy = y + cell / 2;
      const level = item && item.level ? LEVELS[item.level] : null;
      if (!level) {
        parts.push(
          `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#ffffff" stroke="#c9d0d9" stroke-width="1.5" stroke-dasharray="3 3"/>`,
        );
        return;
      }
      const isOverall = includeOverall && c === cells.length - 1;
      parts.push(
        `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${level.bg}" stroke="${isOverall ? '#1c2430' : '#ffffff'}" stroke-width="${isOverall ? 1.6 : 1.2}"><title>${esc((item && item.label) || level.label)}</title></circle>`,
      );
      parts.push(
        `<text x="${cx}" y="${cy + 6}" font-size="18" font-weight="700" text-anchor="middle" fill="${level.fg}">${esc(level.symbol)}</text>`,
      );
    });
  });

  if (legendRows) {
    const legendTop = gridTop + rows.length * cell + 28;
    const columnWidth = (width - 24) / legendColumns;
    legendLevels.forEach((key, index) => {
      const level = LEVELS[key];
      if (!level) return;
      const x = 12 + (index % legendColumns) * columnWidth;
      const y = legendTop + Math.floor(index / legendColumns) * 24;
      parts.push(`<circle cx="${x + 10}" cy="${y}" r="10" fill="${level.bg}" stroke="#ffffff" stroke-width="1"/>`);
      parts.push(
        `<text x="${x + 10}" y="${y + 4}" font-size="12" font-weight="700" text-anchor="middle" fill="${level.fg}">${esc(level.symbol)}</text>`,
      );
      parts.push(`<text x="${x + 26}" y="${y + 4}" font-size="12" fill="#4a5465">${esc(level.label)}</text>`);
    });
  }

  parts.push('</svg>');
  return parts.join('');
}

export function svgBlob(svg) {
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
}

/** Rasterise the SVG at a given scale. Resolves with a PNG blob. */
export function svgToPngBlob(svg, scale = 3) {
  return new Promise((resolve, reject) => {
    const size = svg.match(/width="(\d+)" height="(\d+)"/);
    if (!size) {
      reject(new Error('Could not read the figure size.'));
      return;
    }
    const width = Number(size[1]);
    const height = Number(size[2]);
    const url = URL.createObjectURL(svgBlob(svg));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The browser refused to write the PNG.'))),
        'image/png',
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The figure could not be rasterised.'));
    };
    image.src = url;
  });
}
