import type { Content, ContentTable, ContentText, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import regularFont from '$lib/assets/pdf/LiberationSerif-Regular.ttf?url';
import boldFont from '$lib/assets/pdf/LiberationSerif-Bold.ttf?url';
import italicFont from '$lib/assets/pdf/LiberationSerif-Italic.ttf?url';
import boldItalicFont from '$lib/assets/pdf/LiberationSerif-BoldItalic.ttf?url';

const MM = 72 / 25.4;
const CONTENT_WIDTH = (210 - 18 - 14) * MM;

/** Read the displayed slip, so PDF and paper use the same values, template and preparer. */
function text(element: Element | null): string {
  return element?.textContent?.trim().normalize('NFC') ?? '';
}

function inline(node: Node): ContentText[] {
  if (node.nodeType === Node.TEXT_NODE) return [{ text: node.textContent?.normalize('NFC') ?? '' }];
  if (!(node instanceof Element)) return [];
  if (node.tagName === 'BR') return [{ text: '\n' }];
  const runs = Array.from(node.childNodes).flatMap(inline);
  if (node.matches('b, strong')) return runs.map((run) => ({ ...run, bold: true }));
  if (node.matches('i, em, small')) {
    const styled = runs.map((run) => ({ ...run, italics: true, ...(node.tagName === 'SMALL' ? { fontSize: 8.25 } : {}) }));
    return node.classList.contains('line-kind') ? [{ text: '\n' }, ...styled] : styled;
  }
  return runs;
}

function paragraph(element: Element | null, style: Omit<ContentText, 'text'> = {}): ContentText {
  return { text: element ? inline(element) : '', ...style };
}

function rows(elements: HTMLTableRowElement[], count: number, bordered: boolean): TableCell[][] {
  return elements.map((row) => {
    const result: TableCell[] = [];
    for (const cell of Array.from(row.cells)) {
      const heading = row.parentElement?.tagName === 'THEAD';
      const total = row.parentElement?.tagName === 'TFOOT';
      const first = result.length === 0;
      const last = result.length + cell.colSpan === count;
      result.push({
        ...paragraph(cell),
        colSpan: cell.colSpan,
        bold: heading,
        alignment: heading || cell.classList.contains('center') ? 'center'
          : cell.matches('.amount, .rate') ? 'right' : 'left',
        ...(cell.classList.contains('caption') ? { fontSize: 8.25 } : {}),
        border: bordered ? [!total || first, true, !total || last, true] : [false, false, false, false],
      });
      for (let index = 1; index < cell.colSpan; index += 1) result.push({});
    }
    return result;
  });
}

function lines(table: HTMLTableElement): Content[] {
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup col'));
  const specified = columns.map((column) => parseFloat(column.style.width) || 0);
  const remaining = (100 - specified.reduce((sum, width) => sum + width, 0)) / (specified.filter((width) => !width).length || 1);
  const widths = specified.map((width) => (width || remaining) / 100 * (CONTENT_WIDTH - (columns.length + 1) * 0.5) - 7.5);
  const layout = {
    hLineWidth: () => 0.5, vLineWidth: () => 0.5,
    paddingLeft: () => 3.75, paddingRight: () => 3.75,
    paddingTop: () => 1.5, paddingBottom: () => 1.5,
  };
  const main: ContentTable = {
    fontSize: 9, lineHeight: 1.15, layout,
    table: {
      widths, headerRows: table.tHead?.rows.length ?? 0, keepWithHeaderRows: 1, dontBreakRows: true,
      body: rows(Array.from(table.rows).filter((row) => row.parentElement !== table.tFoot), columns.length, true),
    },
  };
  if (!table.tFoot) return [main];
  return [main, {
    // Keep all totals together, while allowing long item lists to continue on another page.
    unbreakable: true, fontSize: 9, lineHeight: 1.15, layout,
    table: { widths, dontBreakRows: true, body: rows(Array.from(table.tFoot.rows), columns.length, true) },
  }];
}

function definition(sheet: HTMLElement, slipNo: string): TDocumentDefinitions {
  const content: Content[] = [];
  for (const element of Array.from(sheet.children)) {
    if (element.matches('.watermark, .void-stamp')) continue;
    if (element.classList.contains('company')) {
      content.push({ columns: [
        { width: '*', stack: Array.from(element.children[0]?.children ?? []).map((line) => paragraph(line)) },
        { width: 'auto', ...paragraph(element.children[1] ?? null) },
      ], columnGap: 12, fontSize: 9, lineHeight: 1.1 });
    } else if (element.tagName === 'H1') {
      content.push(paragraph(element, { fontSize: 14.25, bold: true, alignment: 'center', margin: [0, 13.5, 0, 3] }));
    } else if (element.matches('.date, .no')) {
      content.push(paragraph(element, { fontSize: 9, bold: true, alignment: 'center', margin: [0, 1.5, 0, element.classList.contains('no') ? 7.5 : 1.5] }));
    } else if (element instanceof HTMLTableElement && element.classList.contains('buyer')) {
      content.push({ table: { widths: [94, '*', 83, 61], body: rows(Array.from(element.rows), 4, false) },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 5, paddingTop: () => 1.1, paddingBottom: () => 1.1 } });
    } else if (element.classList.contains('currency')) {
      content.push(paragraph(element, { alignment: 'right', margin: [0, 4.5, 0, 2.25] }));
    } else if (element instanceof HTMLTableElement && element.classList.contains('lines')) {
      content.push(...lines(element));
    } else if (element.classList.contains('closing')) {
      const signers = Array.from(element.querySelectorAll('.signatures > div'));
      const weights = signers.length === 5 ? [1, 1, 1.25, 0.9, 1.2] : signers.map(() => 1);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      content.push({ unbreakable: true, margin: [0, 8, 0, 0], stack: [
        paragraph(element.querySelector('.sign-date'), { alignment: 'right', margin: [0, 0, 11, 3] }),
        { columns: signers.map((signer, index) => ({
          width: CONTENT_WIDTH * weights[index]! / total, alignment: 'center',
          stack: [
            paragraph(signer.querySelector('b'), { bold: true }),
            paragraph(signer.querySelector('i'), { italics: true, fontSize: 9 }),
            paragraph(signer.querySelector('span'), { margin: [0, 15 * MM, 0, 0], fontSize: 9.375 }),
          ],
        })) },
      ] });
    } else {
      content.push(paragraph(element, { margin: element.classList.contains('words') ? [0, 3, 0, 6] : [0, 0, 0, 7.5] }));
    }
  }
  const stamp = sheet.querySelector('.void-stamp, .watermark');
  return {
    pageSize: 'A4', pageMargins: [18 * MM, 10 * MM, 14 * MM, 10 * MM],
    defaultStyle: { font: 'LiberationSerif', fontSize: 9.75, lineHeight: 1.15, color: '#000000' },
    info: { title: slipNo, author: 'INOXPRAN', creator: 'INOXPRAN ERP' },
    content,
    ...(stamp ? { watermark: { text: text(stamp), color: '#b42318', opacity: 0.15, angle: -24, fontSize: 32, bold: true } } : {}),
    footer: (currentPage, pageCount) => pageCount > 1 ? {
      text: `${slipNo} · ${currentPage}/${pageCount}`, fontSize: 8, alignment: 'right', margin: [18 * MM, 0, 14 * MM, 0],
    } : '',
  };
}

/** Lazy-load the PDF engine and self-hosted fonts only when the user exports. */
export async function downloadSalesIssuePdf(sheet: HTMLElement, slipNo: string): Promise<void> {
  const document = definition(sheet, slipNo);
  const { default: pdfMake } = await import('pdfmake/build/pdfmake');
  pdfMake.addFonts({ LiberationSerif: {
    normal: new URL(regularFont, window.location.href).href,
    bold: new URL(boldFont, window.location.href).href,
    italics: new URL(italicFont, window.location.href).href,
    bolditalics: new URL(boldItalicFont, window.location.href).href,
  } });
  await pdfMake.createPdf(document).download(`${slipNo.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.pdf`);
}
