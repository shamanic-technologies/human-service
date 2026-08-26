// Business languages — the language(s) a person plausibly conducts business in.
//
// human-service is the canonical producer of the person, and it already threads a
// per-person `timezone` from the provider so downstream send-scheduling can land in
// the prospect's local business hours. `businessLanguages` is the same gesture for
// the same chain: content-generation-service writes each cold email in the language
// the recipient actually does business in, and must not re-derive that from
// geography on every single generation.
//
// CONTRACT (relied upon downstream):
//   - ORDERED, most plausible first. The consumer selects by position.
//   - ISO 639-1 lowercase codes ("de", "fr", "it", "nl", "en").
//   - EMPTY ARRAY = unknown. It is NEVER a guess and is distinguishable from
//     ["en"] (= known to be English). We never invent a language with no signal.
//
// The derivation is deterministic and geography-driven, from the geography already
// on the person (and, as a fallback only, on their organization). Region beats
// country wherever a country is genuinely multilingual — Swiss cantons, Belgian
// regions, Canadian provinces — because country alone cannot resolve those.
//
// Apollo's undocumented `organization.languages` array is deliberately NOT used:
// measured on 30,352 stored raw payloads it is non-empty on only 37%, skews heavily
// toward English, and describes the ORGANIZATION, which is frequently in a different
// country than the person. It would add noise to a signal geography already resolves.

export interface GeoSignal {
  city: string | null;
  state: string | null;
  country: string | null;
}

// lower-case, strip diacritics, collapse anything non-alphanumeric to one space.
function norm(v: string | null | undefined): string {
  if (!v) return "";
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Country (name or ISO-3166 alpha-2/alpha-3) → ordered business languages.
// Ordering inside a country is by prevalence in business use.
const COUNTRY_LANGUAGES: Record<string, string[]> = {
  // --- German ---
  germany: ["de"], deutschland: ["de"], de: ["de"], deu: ["de"],
  austria: ["de"], osterreich: ["de"], at: ["de"], aut: ["de"],
  liechtenstein: ["de"], li: ["de"], lie: ["de"],
  // --- French ---
  france: ["fr"], fr: ["fr"], fra: ["fr"],
  monaco: ["fr"], mc: ["fr"], mco: ["fr"],
  senegal: ["fr"], sn: ["fr"], sen: ["fr"],
  "ivory coast": ["fr"], "cote d ivoire": ["fr"], ci: ["fr"], civ: ["fr"],
  cameroon: ["fr", "en"], cm: ["fr", "en"], cmr: ["fr", "en"],
  morocco: ["fr", "ar"], ma: ["fr", "ar"], mar: ["fr", "ar"],
  tunisia: ["fr", "ar"], tn: ["fr", "ar"], tun: ["fr", "ar"],
  algeria: ["fr", "ar"], dz: ["fr", "ar"], dza: ["fr", "ar"],
  // --- Italian ---
  italy: ["it"], italia: ["it"], it: ["it"], ita: ["it"],
  "san marino": ["it"], sm: ["it"], smr: ["it"],
  "vatican city": ["it"], va: ["it"], vat: ["it"],
  // --- Dutch ---
  netherlands: ["nl"], "the netherlands": ["nl"], holland: ["nl"], nl: ["nl"], nld: ["nl"],
  suriname: ["nl"], sr: ["nl"], sur: ["nl"],
  // --- Multilingual, region-resolved below ---
  switzerland: ["de", "fr", "it"], suisse: ["de", "fr", "it"], schweiz: ["de", "fr", "it"],
  ch: ["de", "fr", "it"], che: ["de", "fr", "it"],
  belgium: ["nl", "fr"], belgique: ["nl", "fr"], belgie: ["nl", "fr"],
  be: ["nl", "fr"], bel: ["nl", "fr"],
  luxembourg: ["fr", "de"], lu: ["fr", "de"], lux: ["fr", "de"],
  canada: ["en", "fr"], ca: ["en", "fr"], can: ["en", "fr"],
  // --- English ---
  "united states": ["en"], "united states of america": ["en"], usa: ["en"], us: ["en"],
  "u s a": ["en"], america: ["en"],
  "united kingdom": ["en"], uk: ["en"], gb: ["en"], gbr: ["en"],
  "great britain": ["en"], england: ["en"], scotland: ["en"], wales: ["en"],
  "northern ireland": ["en"],
  ireland: ["en"], ie: ["en"], irl: ["en"],
  australia: ["en"], au: ["en"], aus: ["en"],
  "new zealand": ["en"], nz: ["en"], nzl: ["en"],
  singapore: ["en"], sg: ["en"], sgp: ["en"],
  india: ["en"], in: ["en"], ind: ["en"],
  "south africa": ["en"], za: ["en"], zaf: ["en"],
  nigeria: ["en"], ng: ["en"], nga: ["en"],
  kenya: ["en"], ke: ["en"], ken: ["en"],
  philippines: ["en"], ph: ["en"], phl: ["en"],
  // --- Spanish / Portuguese / Nordics / others (kept honest, not exhaustive) ---
  spain: ["es"], espana: ["es"], es: ["es"], esp: ["es"],
  mexico: ["es"], mx: ["es"], mex: ["es"],
  argentina: ["es"], ar: ["es"], arg: ["es"],
  chile: ["es"], cl: ["es"], chl: ["es"],
  colombia: ["es"], co: ["es"], col: ["es"],
  peru: ["es"], pe: ["es"], per: ["es"],
  uruguay: ["es"], uy: ["es"], ury: ["es"],
  brazil: ["pt"], brasil: ["pt"], br: ["pt"], bra: ["pt"],
  portugal: ["pt"], pt: ["pt"], prt: ["pt"],
  sweden: ["sv"], se: ["sv"], swe: ["sv"],
  norway: ["no"], no: ["no"], nor: ["no"],
  denmark: ["da"], dk: ["da"], dnk: ["da"],
  finland: ["fi", "sv"], fi: ["fi", "sv"], fin: ["fi", "sv"],
  iceland: ["is"], is: ["is"], isl: ["is"],
  poland: ["pl"], pl: ["pl"], pol: ["pl"],
  "czech republic": ["cs"], czechia: ["cs"], cz: ["cs"], cze: ["cs"],
  slovakia: ["sk"], sk: ["sk"], svk: ["sk"],
  hungary: ["hu"], hu: ["hu"], hun: ["hu"],
  romania: ["ro"], ro: ["ro"], rou: ["ro"],
  greece: ["el"], gr: ["el"], grc: ["el"],
  turkey: ["tr"], turkiye: ["tr"], tr: ["tr"], tur: ["tr"],
  japan: ["ja"], jp: ["ja"], jpn: ["ja"],
  "south korea": ["ko"], korea: ["ko"], kr: ["ko"], kor: ["ko"],
  china: ["zh"], cn: ["zh"], chn: ["zh"],
  "hong kong": ["zh", "en"], hk: ["zh", "en"], hkg: ["zh", "en"],
  taiwan: ["zh"], tw: ["zh"], twn: ["zh"],
  israel: ["he", "en"], il: ["he", "en"], isr: ["he", "en"],
  "united arab emirates": ["en", "ar"], uae: ["en", "ar"], ae: ["en", "ar"], are: ["en", "ar"],
  "saudi arabia": ["ar"], sa: ["ar"], sau: ["ar"],
  egypt: ["ar"], eg: ["ar"], egy: ["ar"],
  indonesia: ["id"], id: ["id"], idn: ["id"],
  vietnam: ["vi"], vn: ["vi"], vnm: ["vi"],
  thailand: ["th"], th: ["th"], tha: ["th"],
  ukraine: ["uk"], ua: ["uk"], ukr: ["uk"],
  russia: ["ru"], ru: ["ru"], rus: ["ru"],
};

// Region (state / province / canton — or, failing that, the city, which in CH and BE
// usually names the canton/region anyway) → ordered languages, keyed per country.
// This is what country alone cannot answer.
const REGION_LANGUAGES: Record<string, Record<string, string[]>> = {
  // Swiss cantons. German-speaking is the majority; French and Italian cantons are
  // the whole reason this table exists.
  ch: {
    // French-speaking
    geneva: ["fr", "de"], geneve: ["fr", "de"], genf: ["fr", "de"],
    vaud: ["fr", "de"], lausanne: ["fr", "de"], waadt: ["fr", "de"],
    valais: ["fr", "de"], wallis: ["fr", "de"], sion: ["fr", "de"],
    neuchatel: ["fr", "de"], jura: ["fr", "de"], delemont: ["fr", "de"],
    fribourg: ["fr", "de"], freiburg: ["fr", "de"],
    // Italian-speaking
    ticino: ["it", "de"], tessin: ["it", "de"], lugano: ["it", "de"],
    bellinzona: ["it", "de"], locarno: ["it", "de"],
    // German-speaking
    zurich: ["de"], zuerich: ["de"], "basel stadt": ["de"], "basel landschaft": ["de"],
    basel: ["de"], "st gallen": ["de"], "sankt gallen": ["de"], zug: ["de"],
    bern: ["de", "fr"], berne: ["de", "fr"], lucerne: ["de"], luzern: ["de"],
    aargau: ["de"], thurgau: ["de"], solothurn: ["de"], schwyz: ["de"],
    schaffhausen: ["de"], glarus: ["de"], uri: ["de"], obwalden: ["de"],
    nidwalden: ["de"], appenzell: ["de"], "appenzell ausserrhoden": ["de"],
    "appenzell innerrhoden": ["de"], winterthur: ["de"], grisons: ["de", "it"],
    graubunden: ["de", "it"], chur: ["de"],
  },
  // Belgian regions. Brussels is genuinely mixed — both, French first (its
  // working-language majority), and it stays a two-value answer on purpose.
  be: {
    flanders: ["nl"], "vlaams gewest": ["nl"], "flemish region": ["nl"],
    "east flanders": ["nl"], "west flanders": ["nl"], "oost vlaanderen": ["nl"],
    "west vlaanderen": ["nl"], antwerp: ["nl"], antwerpen: ["nl"],
    "flemish brabant": ["nl"], "vlaams brabant": ["nl"], limburg: ["nl"],
    ghent: ["nl"], gent: ["nl"], bruges: ["nl"], brugge: ["nl"], leuven: ["nl"],
    mechelen: ["nl"], hasselt: ["nl"], kortrijk: ["nl"], aalst: ["nl"],
    wallonia: ["fr"], "walloon region": ["fr"], "region wallonne": ["fr"],
    "waals gewest": ["fr"], hainaut: ["fr"], liege: ["fr"], namur: ["fr"],
    luxembourg: ["fr"], "walloon brabant": ["fr"], "brabant wallon": ["fr"],
    charleroi: ["fr"], mons: ["fr"], tournai: ["fr"], "la louviere": ["fr"],
    brussels: ["fr", "nl"], bruxelles: ["fr", "nl"], brussel: ["fr", "nl"],
    "brussels capital region": ["fr", "nl"], "brussels hoofdstedelijk gewest": ["fr", "nl"],
  },
  // Canadian provinces. Quebec is French-first; New Brunswick is officially bilingual.
  ca: {
    quebec: ["fr", "en"], qc: ["fr", "en"], montreal: ["fr", "en"],
    "quebec city": ["fr", "en"], laval: ["fr", "en"], gatineau: ["fr", "en"],
    "new brunswick": ["fr", "en"], nb: ["fr", "en"], moncton: ["fr", "en"],
    ontario: ["en"], on: ["en"], "british columbia": ["en"], bc: ["en"],
    alberta: ["en"], ab: ["en"], manitoba: ["en"], mb: ["en"],
    saskatchewan: ["en"], sk: ["en"], "nova scotia": ["en"], ns: ["en"],
    "prince edward island": ["en"], pe: ["en"], pei: ["en"],
    "newfoundland and labrador": ["en"], nl: ["en"],
    yukon: ["en"], "northwest territories": ["en"], nunavut: ["en"],
    toronto: ["en"], vancouver: ["en"], calgary: ["en"], edmonton: ["en"],
    ottawa: ["en", "fr"], winnipeg: ["en"], halifax: ["en"],
  },
};

// Which country keys are multilingual enough that a region lookup is meaningful.
const REGION_COUNTRY_ALIASES: Record<string, string> = {
  switzerland: "ch", suisse: "ch", schweiz: "ch", ch: "ch", che: "ch",
  belgium: "be", belgique: "be", belgie: "be", be: "be", bel: "be",
  canada: "ca", ca: "ca", can: "ca",
};

function languagesForGeo(geo: GeoSignal | null | undefined): string[] | null {
  if (!geo) return null;
  const country = norm(geo.country);
  if (!country) return null;
  const countryLangs = COUNTRY_LANGUAGES[country];
  if (!countryLangs) return null;

  const regionKey = REGION_COUNTRY_ALIASES[country];
  if (regionKey) {
    const table = REGION_LANGUAGES[regionKey];
    // State/province/canton first — that is the authoritative subdivision. The city
    // is only consulted when the region is absent (providers often fill one, not both).
    const state = norm(geo.state);
    if (state && table[state]) return table[state];
    const city = norm(geo.city);
    if (city && table[city]) return table[city];
  }
  return countryLangs;
}

/**
 * Ordered business languages for a person, most plausible first.
 * Empty array = unknown (no usable geography, or a country we hold no mapping for).
 * The person's own geography always wins; the organization's is a fallback only,
 * because the organization is frequently located in a different country than the
 * person it employs.
 */
export function deriveBusinessLanguages(
  person: GeoSignal | null | undefined,
  organization?: GeoSignal | null,
): string[] {
  return languagesForGeo(person) ?? languagesForGeo(organization) ?? [];
}
