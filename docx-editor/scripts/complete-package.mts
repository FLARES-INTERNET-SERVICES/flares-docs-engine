/**
 * Give a packed .docx the definitions its body refers to.
 *
 * The package writer preserves `word/numbering.xml` and `word/styles.xml` but
 * never creates or extends them, while the editor's toolbar refers to things that
 * may not be defined: its list buttons use numId 1 and 2 outright, and its style
 * picker offers Title and the headings whether or not the document defines them.
 *
 * In the editor that looks right, because the editor draws lists and styles from
 * the document model. In Word, a paragraph pointing at a definition that does not
 * exist is an ordinary paragraph: the bullets and the title are gone, silently.
 * This adds only what is missing, so an uploaded file's own definitions win.
 */
import JSZip from 'jszip';
import type { Node as PMNode } from 'prosemirror-model';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

type ListKind = { bullet: boolean; format: string };

/** The same sizes the style picker promises, so Word agrees with the editor. */
const STYLES: Record<string, { name: string; size: number; bold?: boolean; color?: string; outline?: number }> = {
  Title: { name: 'Title', size: 52, bold: true },
  Subtitle: { name: 'Subtitle', size: 30, color: '666666' },
  Heading1: { name: 'heading 1', size: 40, bold: true, outline: 0 },
  Heading2: { name: 'heading 2', size: 32, bold: true, outline: 1 },
  Heading3: { name: 'heading 3', size: 28, bold: true, outline: 2 },
  Heading4: { name: 'heading 4', size: 24, bold: true, outline: 3 },
  Heading5: { name: 'heading 5', size: 22, bold: true, outline: 4 },
  Heading6: { name: 'heading 6', size: 22, bold: true, outline: 5 },
};

const BULLETS = ['•', '◦', '▪'];
const NUMBER_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];

/** What the body refers to, in the terms the document model records it. */
function referencesIn(doc: PMNode): { lists: Map<number, ListKind>; styles: Set<string> } {
  const lists = new Map<number, ListKind>();
  const styles = new Set<string>();

  doc.descendants((node) => {
    if (node.type.name !== 'paragraph') return;

    const numId = node.attrs.numPr?.numId as number | undefined;

    // numId 0 is OOXML for "no numbering", not a reference to anything.
    if (numId && !lists.has(numId)) {
      // The toolbar's bullet list is numId 1, and says so in listIsBullet.
      const bullet = node.attrs.listIsBullet ?? numId === 1;
      lists.set(numId, { bullet, format: node.attrs.listNumFmt ?? 'decimal' });
    }

    if (node.attrs.styleId) styles.add(node.attrs.styleId as string);
  });

  return { lists, styles };
}

function abstractNumXml(id: number, kind: ListKind): string {
  const levels = Array.from({ length: 9 }, (_, level) => {
    const format = kind.bullet ? 'bullet' : level === 0 ? kind.format : NUMBER_FORMATS[level % 3];
    const text = kind.bullet ? BULLETS[level % 3] : `%${level + 1}.`;

    return (
      `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
      `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
    );
  }).join('');

  return (
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>` +
    `${levels}</w:abstractNum>`
  );
}

function styleXml(id: string): string | null {
  const style = STYLES[id];

  if (!style) return null;

  const properties = [
    style.bold ? '<w:b/>' : '',
    style.color ? `<w:color w:val="${style.color}"/>` : '',
    `<w:sz w:val="${style.size}"/>`,
    `<w:szCs w:val="${style.size}"/>`,
  ].join('');
  const outline = style.outline === undefined ? '' : `<w:outlineLvl w:val="${style.outline}"/>`;

  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${style.name}"/>` +
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/>${outline}</w:pPr><w:rPr>${properties}</w:rPr></w:style>`
  );
}

function idsOf(xml: string, pattern: RegExp): Set<string> {
  return new Set([...xml.matchAll(pattern)].map((match) => match[1] as string));
}

/** Insert before a closing tag, or open a self-closed root to make room. */
function appendToRoot(xml: string, root: string, inner: string): string {
  const closing = `</${root}>`;

  if (xml.includes(closing)) return xml.replace(closing, `${inner}${closing}`);

  return xml.replace(new RegExp(`<${root}([^>]*)/>`), `<${root}$1>${inner}${closing}`);
}

function withNumbering(existing: string | undefined, missing: Map<number, ListKind>): string {
  const xml = existing ?? `${HEADER}<w:numbering xmlns:w="${NS_W}"></w:numbering>`;
  const taken = [...idsOf(xml, /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"/g)].map(Number);
  let nextAbstract = Math.max(-1, ...taken) + 1;
  let abstracts = '';
  let nums = '';

  for (const [numId, kind] of missing) {
    abstracts += abstractNumXml(nextAbstract, kind);
    nums += `<w:num w:numId="${numId}"><w:abstractNumId w:val="${nextAbstract}"/></w:num>`;
    nextAbstract++;
  }

  // The schema requires every abstractNum before the first num.
  const firstNum = xml.search(/<w:num\s/);
  const placed = firstNum === -1
    ? appendToRoot(xml, 'w:numbering', abstracts)
    : `${xml.slice(0, firstNum)}${abstracts}${xml.slice(firstNum)}`;
  const lastNum = placed.lastIndexOf('</w:num>');

  return lastNum === -1
    ? appendToRoot(placed, 'w:numbering', nums)
    : `${placed.slice(0, lastNum + 8)}${nums}${placed.slice(lastNum + 8)}`;
}

/**
 * What the editor draws text in when a document says nothing. Without this a file
 * with no styles of its own opens in whatever each word processor defaults to,
 * which is a different font and size from the one the person wrote it in.
 */
const DOC_DEFAULTS =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>';

function withStyles(existing: string | undefined, missing: string[]): string {
  const xml = existing ?? `${HEADER}<w:styles xmlns:w="${NS_W}">${DOC_DEFAULTS}</w:styles>`;
  const defined = idsOf(xml, /w:styleId="([^"]+)"/g);
  const normal = defined.has('Normal')
    ? ''
    : '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>';

  return appendToRoot(xml, 'w:styles', normal + missing.map(styleXml).join(''));
}

/** Register a new part with the package, if it was not already. */
async function registerPart(zip: JSZip, part: 'numbering' | 'styles'): Promise<void> {
  const typesFile = zip.file('[Content_Types].xml');
  const relsPath = 'word/_rels/document.xml.rels';
  const types = (await typesFile?.async('string')) ?? '';

  if (!types.includes(`/word/${part}.xml`)) {
    zip.file(
      '[Content_Types].xml',
      appendToRoot(
        types,
        'Types',
        `<Override PartName="/word/${part}.xml" ContentType="${MAIN}.${part}+xml"/>`,
      ),
    );
  }

  const rels =
    (await zip.file(relsPath)?.async('string')) ??
    `${HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  if (!rels.includes(`${REL}/${part}"`)) {
    const used = [...idsOf(rels, /\bId="rId(\d+)"/g)].map(Number);
    const id = `rId${Math.max(0, ...used) + 1}`;

    zip.file(
      relsPath,
      appendToRoot(rels, 'Relationships', `<Relationship Id="${id}" Type="${REL}/${part}" Target="${part}.xml"/>`),
    );
  }
}

export async function completePackage(packed: Uint8Array, doc: PMNode): Promise<Uint8Array> {
  const { lists, styles } = referencesIn(doc);
  const zip = await JSZip.loadAsync(packed);

  const numbering = await zip.file('word/numbering.xml')?.async('string');
  const definedNums = idsOf(numbering ?? '', /<w:num\b[^>]*w:numId="(\d+)"/g);
  const missingLists = new Map([...lists].filter(([numId]) => !definedNums.has(String(numId))));

  const stylesXml = await zip.file('word/styles.xml')?.async('string');
  const definedStyles = idsOf(stylesXml ?? '', /w:styleId="([^"]+)"/g);
  // A style the editor did not invent and the file does not define is left alone:
  // nothing here knows what it was meant to look like.
  const missingStyles = [...styles].filter((id) => !definedStyles.has(id) && id in STYLES);

  if (missingLists.size > 0) {
    zip.file('word/numbering.xml', withNumbering(numbering, missingLists));
    await registerPart(zip, 'numbering');
  }

  // A document with words and no styles part gets one for its defaults, even with
  // nothing else to define. An empty document has nothing for them to apply to.
  const needsDefaults = stylesXml === undefined && doc.textContent.trim() !== '';

  if (missingStyles.length > 0 || needsDefaults) {
    zip.file('word/styles.xml', withStyles(stylesXml, missingStyles));
    await registerPart(zip, 'styles');
  }

  if (missingLists.size === 0 && missingStyles.length === 0 && !needsDefaults) return packed;

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/**
 * Refuse to return an empty file for a document with words in it.
 *
 * Every step above can succeed and still produce an empty body (the wrong
 * fragment name does exactly that). A person who gets an error can try again; a
 * person who gets a blank page may not look until it is too late.
 */
export async function assertTextSurvived(packed: Uint8Array, doc: PMNode): Promise<void> {
  if (doc.textContent.trim() === '') return;

  const zip = await JSZip.loadAsync(packed);
  const body = (await zip.file('word/document.xml')?.async('string')) ?? '';

  if (!/<w:t(\s[^>]*)?>[^<]*\S[^<]*<\/w:t>/.test(body)) {
    throw new Error('The document has text, but the exported file does not.');
  }
}
