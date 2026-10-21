// Reads an uploaded HTML design and guesses its category.
// Pure string work (no DOM), so it runs the same in the browser and in Node.

// How much a keyword hit counts depending on where it was found.
const WEIGHTS = { file: 6, title: 6, screens: 4, headings: 2, body: 1 };
// Below this score the guess is too weak and the design goes to "unsorted".
const MIN_SCORE = 3;

const decodeBase64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

// Prototype viewing copies wrap each platform's page as base64 in `const DOCS = {...}`.
export function unwrap(html) {
  const m = html.match(/const DOCS\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!m) return { docs: [html], platforms: [] };
  try {
    const docs = JSON.parse(m[1]);
    return { docs: Object.values(docs).map(decodeBase64), platforms: Object.keys(docs) };
  } catch {
    return { docs: [html], platforms: [] };
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = s =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? all;
  });
const textOf = s => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const titleOf = s => textOf((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");

// Only the designer's part of the page counts: drop the shared prototype kit, scripts, styles, inline images.
function designPart(doc) {
  return doc
    .replace(/KIT:BEGIN[\s\S]*?KIT:END/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/data:[^"')\s]+/g, "");
}

const PLATFORM_WORDS = { ios: /\bios\b/i, android: /\bandroid\b/i, web: /\bweb\b/i };
const PLACEHOLDER_TITLES = /^(feature name|untitled|document)$/i;

const baseName = fileName => fileName.replace(/\.html?$/i, "");

function prettyFileName(fileName) {
  const s = baseName(fileName)
    .replace(/\.(ios|web|android)$/i, "")
    .replace(/[-_.\s]*live.?$/i, "")
    .replace(/[-_.]+/g, " ")
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Без названия";
}

// Cyrillic (Russian + Kazakh) to Latin, so "макет.html" and "дизайн.html" don't both become "design".
const TRANSLIT = Object.fromEntries(
  "а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:ts ч:ch ш:sh щ:sch ъ: ы:y ь: э:e ю:yu я:ya ә:a ғ:g қ:k ң:n ө:o ұ:u ү:u һ:h і:i"
    .split(" ")
    .map(p => p.split(":")),
);

export function slugify(fileName) {
  return (
    baseName(fileName)
      .toLowerCase()
      .replace(/[Ѐ-ӿ]/g, c => TRANSLIT[c] ?? "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "design"
  );
}

// Everything the classifier and the card need, pulled out of the file once.
export function analyze(html, fileName) {
  const { docs, platforms } = unwrap(html);
  const outerTitle = titleOf(html);
  const parts = docs.map(designPart);
  const titles = [outerTitle, ...docs.map(titleOf)].filter(t => t && !PLACEHOLDER_TITLES.test(t.split(" · ")[0].trim()));

  const firstTitle = (titles[0] || "").split(" · ")[0].trim();
  const name = firstTitle || prettyFileName(fileName);

  const found = new Set(platforms);
  for (const t of [outerTitle, fileName]) for (const [p, re] of Object.entries(PLATFORM_WORDS)) if (re.test(t)) found.add(p);

  const screens = parts.flatMap(p => [...p.matchAll(/data-screen="([^"]+)"/g)].map(m => m[1]));
  const headings = parts.flatMap(p => [...p.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => textOf(m[1])));
  const body = parts.map(p => textOf((p.match(/<body[^>]*>([\s\S]*)/i) || [, p])[1])).join(" ");

  return {
    name,
    platforms: [...found],
    screens,
    fields: {
      file: baseName(fileName),
      title: titles.join(" "),
      screens: screens.join(" "),
      headings: headings.join(" "),
      body,
    },
  };
}

const norm = s => " " + s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";

function hits(haystack, keyword) {
  const k = norm(keyword).trim();
  if (!k) return 0;
  let n = 0;
  for (const variant of [k, k + "s"]) {
    const needle = " " + variant + " ";
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  }
  return n;
}

// Returns the best category id ("unsorted" when nothing fits) and every category's score.
export function classify(analysis, categories) {
  const fields = Object.fromEntries(Object.entries(analysis.fields).map(([k, v]) => [k, norm(v)]));
  const scores = {};
  for (const cat of categories) {
    const words = [...new Set([cat.name, ...(cat.topics || []), ...(cat.keywords || [])].map(w => w.toLowerCase()))];
    let score = 0;
    for (const w of words)
      for (const [field, weight] of Object.entries(WEIGHTS)) score += weight * Math.min(hits(fields[field], w), field === "body" ? 3 : 2);
    scores[cat.id] = score;
  }
  const [best, top] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || [];
  return { category: top >= MIN_SCORE ? best : "unsorted", scores };
}
