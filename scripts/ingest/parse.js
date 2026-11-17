import { XMLParser } from 'fast-xml-parser';
import { cleanText, decodeEntities, truncate, hash } from './text.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// The parser leaves entities alone, so URLs arrive as "?a=1&amp;b=2": decode them.
const cleanUrl = (u) => decodeEntities(String(u).trim());

// Audience-measurement pixels some feeds (Expansión) put in media:content.
const TRACKER = /imrworldwide\.com|doubleclick\.net|\/pixel\.gif/i;

// "… Leer" / "Leer más": the link label Unidad Editorial (El Mundo, Marca, Expansión) appends.
// Case-sensitive on purpose: "…aprender a leer" is text, not the label.
const READ_MORE = /\s*(Leer( más)?|Seguir leyendo|Read more)\s*[.…]*$/;

function pickLink(item) {
  // Atom: <link href rel="alternate"/>; RSS: <link>text</link>
  for (const l of asArray(item.link)) {
    if (typeof l === 'string') return cleanUrl(l);
    if (l['@href'] && (!l['@rel'] || l['@rel'] === 'alternate')) return cleanUrl(l['@href']);
    if (l['#text']) return cleanUrl(l['#text']);
  }
  if (typeof item.guid === 'string' && item.guid.startsWith('http')) return cleanUrl(item.guid);
  if (item.guid?.['#text']?.startsWith?.('http')) return cleanUrl(item.guid['#text']);
  return '';
}

function pickImage(item) {
  const candidates = [
    ...asArray(item['media:content']),
    ...asArray(item['media:group']?.['media:content']),
    ...asArray(item['media:thumbnail']),
    ...asArray(item.enclosure),
  ];
  for (const c of candidates) {
    const url = c?.['@url'] && cleanUrl(c['@url']);
    if (!url || TRACKER.test(url)) continue;
    const type = c?.['@type'] ?? c?.['@medium'] ?? 'image';
    if (/image/.test(type)) return url;
    if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) return url;
  }
  const html = String(item['content:encoded'] ?? item.description ?? '');
  const src = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  return src && !TRACKER.test(src) ? cleanUrl(src) : null;
}

function pickDate(item) {
  const raw = item.pubDate ?? item['dc:date'] ?? item.published ?? item.updated;
  const d = raw ? new Date(typeof raw === 'object' ? raw['#text'] : raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export function parseFeed(xml, source) {
  const doc = parser.parse(xml);
  const rawItems = doc.rss?.channel?.item ?? doc['rdf:RDF']?.item ?? doc.feed?.entry ?? [];
  const out = [];
  for (const item of asArray(rawItems)) {
    const title = cleanText(item.title);
    const url = pickLink(item);
    if (!title || !url) continue;
    const summary = truncate(cleanText(item.description ?? item.summary ?? item['content:encoded'] ?? item.content).replace(READ_MORE, ''), 240);
    const categories = asArray(item.category).map((c) => cleanText(typeof c === 'object' ? c['#text'] ?? c['@term'] : c)).filter(Boolean);
    out.push({
      id: hash(url),
      title,
      summary: summary === title ? '' : summary,
      url,
      sourceId: source.id,
      source: source.name,
      lang: source.lang,
      publishedAt: pickDate(item),
      image: pickImage(item),
      categories,
      feedSections: source.sections ?? [],
    });
  }
  return out;
}

// Does the body start, after a BOM, the XML declaration, processing instructions and comments, with
// an RSS, Atom or RDF root? A linear scan with indexOf, not a regex: the body comes from the network.
function isFeedXml(body) {
  let i = 0;
  const n = body.length;
  if (body.charCodeAt(0) === 0xfeff) i = 1;
  for (;;) {
    while (i < n && ' \t\r\n'.includes(body[i])) i++;
    if (body.startsWith('<?', i)) {
      const end = body.indexOf('?>', i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else if (body.startsWith('<!--', i)) {
      const end = body.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else break;
  }
  return ['<rss', '<feed', '<rdf:RDF'].some((tag) => body.startsWith(tag, i) && /[\s>\/]/.test(body[i + tag.length] ?? ''));
}

// parseFeed for the ingest: an empty or non-XML body (an HTML error page, a CDN challenge) with no
// items is an error, so the source shows ok:false in the status instead of a silent ok:true, count 0.
// A real feed that is just empty right now still comes back as [].
export function readFeed(body, source) {
  if (!String(body ?? '').trim()) throw new Error('respuesta vacía: 0 items');
  const items = parseFeed(body, source);
  if (!items.length && !isFeedXml(body)) throw new Error('no es un feed RSS/Atom: 0 items');
  return items;
}
