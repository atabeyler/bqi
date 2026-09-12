import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateReportDocx } from './docx.js';

async function documentXml(buf) {
  const zip = await JSZip.loadAsync(buf);
  return zip.file('word/document.xml').async('string');
}

// Extracts [{ text, bold }] per <w:r> run, in document order, so a test can
// assert bold is on the *specific* run it belongs to -- not just that a
// <w:b/> exists somewhere earlier in the XML (a loose match like that let a
// real bug -- bold applied to the wrong split segment -- pass unnoticed).
function runs(xml) {
  const matches = [...xml.matchAll(/<w:r>(?:(?!<w:r>).)*?<\/w:r>/gs)];
  return matches.map((m) => {
    const chunk = m[0];
    const text = [...chunk.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((t) => t[1]).join('');
    return { text, bold: /<w:b\/>/.test(chunk) };
  });
}

describe('generateReportDocx', () => {
  it('produces a valid .docx (ZIP) buffer from markdown content', async () => {
    const content = `## YÖNETİCİ ÖZETİ
Bu bir test raporudur.

- Madde bir
- Madde iki

| Senaryo | Olasılık |
|---|---|
| A | %50 |
| B | %50 |
`;
    const buf = await generateReportDocx({
      category: 'ekonomi',
      title: 'Test Raporu',
      content,
      userCode: 'BOLD-001',
      aiProvider: 'Test Provider',
    });

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    // .docx files are ZIP archives — the signature starts with "PK".
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('produces a document without crashing even for empty content', async () => {
    const buf = await generateReportDocx({
      category: 'savunma',
      title: 'Empty Report',
      content: '',
      userCode: 'BOLD-002',
      aiProvider: 'Test',
    });
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('sets tblGrid column widths to match the actual cell widths', async () => {
    // Regression test: docx-js defaults tblGrid to near-zero-width columns
    // when the Table isn't given an explicit columnWidths, independent of
    // the per-cell width set on each TableCell. Viewers that lay out
    // columns from tblGrid (rather than cell width) then wrap every word
    // one character per line. The cover-page table (customWidthsPct
    // [32, 68] of the 9360 DXA text width) is the reproduction case.
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content: 'Metin.',
      userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    const grid = xml.match(/<w:tblGrid>((?:<w:gridCol w:w="\d+"\/>)+)<\/w:tblGrid>/);
    expect(grid).not.toBeNull();
    const widths = [...grid[1].matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([2995, 6365]);
  });

  it('renders #### as a real heading instead of literal hashes', async () => {
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content: '#### Aktörler ve Niyetler\nMetin.',
      userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    expect(xml).not.toContain('####');
    expect(xml).toContain('Aktörler ve Niyetler');
  });

  it('renders mid-line **bold** as an actual bold run, not literal asterisks', async () => {
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content: '**Rosatom:** uzun vadeli kaldıraç olarak kullanma niyeti.',
      userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    expect(xml).not.toContain('**');
    const bodyRuns = runs(xml).filter((r) => r.text.includes('Rosatom') || r.text.includes('uzun vadeli'));
    expect(bodyRuns.find((r) => r.text === 'Rosatom:')?.bold).toBe(true);
    expect(bodyRuns.find((r) => r.text.includes('uzun vadeli'))?.bold).toBe(false);
  });

  it('renders a standalone --- divider as a rule instead of literal dashes', async () => {
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content: 'Birinci paragraf.\n---\nİkinci paragraf.',
      userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    expect(xml).not.toMatch(/<w:t[^>]*>-{3,}<\/w:t>/);
  });

  it('strips ** markers inside table cells and bullets, applying bold to the right run', async () => {
    const content = `| Senaryo | Olasılık |
|---|---|
| **SENARYO-A** | %50 |

- **Etiket:** açıklama
`;
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content, userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    expect(xml).not.toContain('**');
    const allRuns = runs(xml);
    expect(allRuns.find((r) => r.text === 'SENARYO-A')?.bold).toBe(true);
    expect(allRuns.find((r) => r.text === 'Etiket:')?.bold).toBe(true);
    expect(allRuns.find((r) => r.text.includes('açıklama'))?.bold).toBe(false);
  });

  it('turns <br> inside a table cell into a real paragraph break, not literal tag text', async () => {
    // Regression test: the AI represents a line break inside a markdown
    // table cell with <br> (there's no way to put a literal newline in a
    // GFM table cell). It must become a second paragraph in that cell, not
    // literal "<br>" text.
    const content = `| Senaryo | Kaskat Etki |
|---|---|
| SENARYO-A | Enerji: yüksek bağımlılık.<br>Savunma: entegrasyon ihtiyacı. |
`;
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content, userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    expect(xml).not.toContain('<br>');
    expect(xml).toContain('Enerji: yüksek bağımlılık.');
    expect(xml).toContain('Savunma: entegrasyon ihtiyacı.');
    // Two separate paragraphs, not one run with the tag stuck in the middle.
    const cellParaCount = (xml.match(/<w:t[^>]*>(Enerji: yüksek bağımlılık\.|Savunma: entegrasyon ihtiyacı\.)<\/w:t>/g) || []).length;
    expect(cellParaCount).toBe(2);
  });

  it('renders single *italic* markers inside a table cell as actual italics, not literal asterisks', async () => {
    const content = `| Senaryo | Olasılık |
|---|---|
| SENARYO-A<br>*"Kontrollü Gerilim"* | %45 |
`;
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content, userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    expect(xml).not.toContain('*');
    expect(xml).toContain('&quot;Kontrollü Gerilim&quot;');
  });

  it('renders single *italic* markers in prose as actual italics, not literal asterisks', async () => {
    const buf = await generateReportDocx({
      category: 'enerji', title: 'Test', content: 'Bu bir *vurgulu* ifadedir.',
      userCode: 'BOLD-001', aiProvider: 'Test',
    });
    const xml = await documentXml(buf);
    expect(xml).not.toContain('*vurgulu*');
    expect(xml).toMatch(/<w:i\/>[\s\S]{0,200}vurgulu/);
  });
});
