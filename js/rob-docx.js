// Word (.docx) writer for /tools/robvis/: a landscape page holding the traffic light as a
// shaded table, the legend, and the key to the domain codes. OOXML text parts zipped by
// js/zip.js, so nothing is fetched and nothing is uploaded.

import { LEVELS } from './rob-instruments.js';
import { escapeXml, textFile, zipBlob } from './zip.js';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// A4 landscape, in twentieths of a point.
const PAGE_WIDTH = 16838;
const PAGE_HEIGHT = 11906;
const MARGIN = 720;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const hex = (color) => String(color).replace('#', '').toUpperCase();

function run(text, { bold, color, size, italic } = {}) {
  const props = [
    bold ? '<w:b/>' : '',
    italic ? '<w:i/>' : '',
    color ? `<w:color w:val="${hex(color)}"/>` : '',
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(text, { align, bold, color, size, spaceAfter = 0, italic } = {}) {
  const props = [
    align ? `<w:jc w:val="${align}"/>` : '',
    `<w:spacing w:before="0" w:after="${spaceAfter}" w:line="240" w:lineRule="auto"/>`,
  ].join('');
  const body = text === '' ? '' : run(text, { bold, color, size, italic });
  return `<w:p><w:pPr>${props}</w:pPr>${body}</w:p>`;
}

function cell(content, { width, fill, valign = 'center' } = {}) {
  const props = [
    `<w:tcW w:w="${width}" w:type="dxa"/>`,
    fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(fill)}"/>` : '',
    `<w:vAlign w:val="${valign}"/>`,
  ].join('');
  const paragraphs = Array.isArray(content) ? content : [content];
  return `<w:tc><w:tcPr>${props}</w:tcPr>${paragraphs.join('')}</w:tc>`;
}

function table(rows, widths, align = 'center') {
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const border = (side) => `<w:${side} w:val="single" w:sz="6" w:space="0" w:color="FFFFFF"/>`;
  const total = widths.reduce((a, b) => a + b, 0);
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:jc w:val="${align}"/><w:tblBorders>${border('top')}${border('left')}${border('bottom')}${border('right')}${border('insideH')}${border('insideV')}</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

const headerRow = (cells) => `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${cells.join('')}</w:tr>`;
const bodyRow = (cells) => `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="440"/></w:trPr>${cells.join('')}</w:tr>`;

/**
 * rows: [{ study, cells: [{ level }], overall: { level } }]
 * columns: [{ id, label }] - the id goes in the grid header, the label into the key below.
 */
export function robDocxBlob({
  rows,
  columns,
  title = 'Risk of bias assessment',
  subtitle = '',
  includeOverall = true,
  showWords = false,
  legendLevels = [],
  note = '',
}) {
  const columnsOut = includeOverall ? [...columns, { id: 'Overall', label: 'Overall judgement' }] : columns;
  const studyWidth = showWords ? 2600 : 3400;
  const gridWidth = Math.floor((CONTENT_WIDTH - studyWidth) / Math.max(columnsOut.length, 1));
  const widths = [studyWidth, ...columnsOut.map(() => gridWidth)];

  const head = headerRow([
    cell(paragraph('Study', { bold: true, align: 'left' }), { width: studyWidth, fill: '#eef1f5' }),
    ...columnsOut.map((column) =>
      cell(paragraph(column.id, { bold: true, align: 'center' }), { width: gridWidth, fill: '#eef1f5' }),
    ),
  ]);

  const body = rows.map((row) => {
    const judgements = includeOverall ? [...row.cells, row.overall] : row.cells;
    return bodyRow([
      cell(paragraph(row.study || '', { align: 'left' }), { width: studyWidth }),
      ...judgements.map((item) => {
        const level = item && item.level ? LEVELS[item.level] : null;
        if (!level) return cell(paragraph('', {}), { width: gridWidth, fill: '#f4f6f8' });
        const content = showWords
          ? [paragraph(level.label, { align: 'center', bold: true, color: level.fg, size: 16 })]
          : [paragraph(level.symbol, { align: 'center', bold: true, color: level.fg, size: 28 })];
        return cell(content, { width: gridWidth, fill: level.bg });
      }),
    ]);
  });

  const legendWidths = [600, 3200, 600, 3200, 600, 3200];
  const legendRows = [];
  for (let i = 0; i < legendLevels.length; i += 3) {
    const trio = legendLevels.slice(i, i + 3);
    const cells = [];
    for (let k = 0; k < 3; k += 1) {
      const level = trio[k] ? LEVELS[trio[k]] : null;
      if (!level) {
        cells.push(cell(paragraph('', {}), { width: legendWidths[k * 2] }));
        cells.push(cell(paragraph('', {}), { width: legendWidths[k * 2 + 1] }));
      } else {
        cells.push(
          cell(paragraph(level.symbol, { align: 'center', bold: true, color: level.fg, size: 24 }), {
            width: legendWidths[k * 2],
            fill: level.bg,
          }),
        );
        cells.push(cell(paragraph(level.label, { align: 'left', size: 18 }), { width: legendWidths[k * 2 + 1] }));
      }
    }
    legendRows.push(bodyRow(cells));
  }

  const keyWidths = [1200, 12000];
  const keyRows = columnsOut.map((column) =>
    bodyRow([
      cell(paragraph(column.id, { bold: true, align: 'left' }), { width: keyWidths[0] }),
      cell(paragraph(column.label, { align: 'left' }), { width: keyWidths[1] }),
    ]),
  );

  const parts = [
    paragraph(title, { bold: true, size: 32, spaceAfter: 80 }),
    subtitle ? paragraph(subtitle, { size: 20, color: '#4A5465', spaceAfter: 200 }) : '',
    table([head, ...body], widths),
    paragraph('', { spaceAfter: 120 }),
    legendRows.length ? paragraph('Legend', { bold: true, size: 22, spaceAfter: 80 }) : '',
    legendRows.length ? table(legendRows, legendWidths, 'left') : '',
    paragraph('', { spaceAfter: 120 }),
    paragraph('Domains', { bold: true, size: 22, spaceAfter: 80 }),
    table(keyRows, keyWidths, 'left'),
    note ? paragraph('', { spaceAfter: 120 }) : '',
    note ? paragraph(note, { size: 18, color: '#4A5465', italic: true }) : '',
  ].filter(Boolean);

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}" w:orient="landscape"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;

  return zipBlob(
    [
      textFile(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ),
      textFile(
        '_rels/.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      textFile(
        'word/_rels/document.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
      textFile('word/styles.xml', stylesXml),
      textFile('word/document.xml', documentXml),
    ],
    DOCX_TYPE,
  );
}
