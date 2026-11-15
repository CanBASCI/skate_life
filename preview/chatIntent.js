/**
 * Chat intent: commands MUST start with `/`.
 * Turkish letters folded (ğ→g, ı→i…) so /saga == /sağa.
 * Plain chat (no leading /) = speech bubble only.
 * Profanity → { kind: "banned" }.
 */

const CROWD_COUNTS = [5, 10, 20, 30, 40, 50];

/** Folded cmd (no slash) → sceneId */
const SCENE_VOTE_ALIASES = {
  tennis: "tennis",
  tenis: "tennis",
  tenisesahnesi: "tennis",
  dc: "dogrulukmu_cesaretmi",
  dogrulukcesaret: "dogrulukmu_cesaretmi",
  dogrulukmucesaretmi: "dogrulukmu_cesaretmi",
  nc: "night_club_inside",
  nightclub: "night_club_inside",
  kulup: "night_club_inside",
  gecekulubu: "night_club_inside",
  rl: "red_light_green_light",
  redlight: "red_light_green_light",
  kirmiziisik: "red_light_green_light",
  street: "street",
  cadde: "street",
  sokak: "street",
};

const SCENE_VOTE_CANON = {
  tennis: "/tennis",
  dogrulukmu_cesaretmi: "/dc",
  night_club_inside: "/nc",
  red_light_green_light: "/rl",
  street: "/cadde",
};

/** Exact folded token → action slash (no args). */
const SIMPLE_ALIASES = {
  dance: "/dance",
  dans: "/dance",
  danset: "/dance",
  jump: "/jump",
  zipla: "/jump",
  sit: "/sit",
  otur: "/sit",
  stop: "/stop",
  dur: "/stop",
  durdur: "/stop",
  dansetme: "/stop",
  in: "/stop",
  e: "/e",
  bin: "/e",
  kaykayabin: "/e",
  aracabin: "/e",
  play: "/play",
  oyna: "/play",
  basla: "/play",
  baslat: "/play",
  macbaslat: "/play",
  oyunubaslat: "/play",
};

const SIGNIN_ALIASES = new Set([
  "signin",
  "join",
  "katil",
  "oyunakatil",
  "benial",
]);
const SIGNOUT_ALIASES = new Set([
  "signout",
  "leave",
  "ayril",
  "cikis",
  "cikisyap",
  "oyundancik",
]);

/** Turkish + common EN — matched as whole words after normalize. */
const BANNED_WORDS = [
  "amk",
  "amq",
  "aq",
  "a.q",
  "a q",
  "amına",
  "amina",
  "amini",
  "amınakoyim",
  "aminakoyim",
  "amınakoyayim",
  "aminakoyayim",
  "amcık",
  "amcik",
  "amık",
  "amik",
  "amınoğlu",
  "aminoglu",
  "amcığa",
  "amciga",
  "orospu",
  "orospuçocuğu",
  "orospucocugu",
  "oç",
  "o.ç",
  "piç",
  "pic",
  "piçkurusu",
  "pickurusu",
  "sik",
  "sikik",
  "sikiş",
  "sikis",
  "sikeyim",
  "sikerim",
  "siktir",
  "siktirgit",
  "sokayım",
  "sokayim",
  "sürtük",
  "surtuk",
  "yarrak",
  "yarak",
  "yarrrak",
  "yarram",
  "yarrakafa",
  "göt",
  "götveren",
  "gotveren",
  "götlek",
  "gotlek",
  "götüne",
  "gotune",
  "ananısikim",
  "ananisikim",
  "ananı sikeyim",
  "anani sikeyim",
  "anasını",
  "anasini",
  "bacını",
  "bacini",
  "pezevenk",
  "pezeveng",
  "kahpe",
  "kahpenin",
  "ibne",
  "ibnelik",
  "puşt",
  "pust",
  "gavat",
  "dalyarak",
  "malafat",
  "taşak",
  "tasak",
  "taşşak",
  "tassak",
  "boktan",
  "sikimsonik",
  "amına koyim",
  "amina koyim",
  "amına koyayım",
  "amina koyayim",
  "siktir lan",
  "hassiktir",
  "hasiktir",
  "awk",
  "awq",
  "fuck",
  "fucking",
  "fucker",
  "shit",
  "bitch",
  "asshole",
  "dick",
  "cunt",
  "motherfucker",
  "bastard",
  "whore",
  "slut",
];

const DIR_ALIASES = [
  [["solust", "kuzeybati", "northwest", "nw"], "north-west"],
  [["solalt", "guneybati", "southwest", "sw"], "south-west"],
  [["sagust", "kuzeydogu", "northeast", "ne"], "north-east"],
  [["sagalt", "guneydogu", "southeast", "se"], "south-east"],
  [["sola", "sol", "left", "west", "w", "l"], "west"],
  [["saga", "sag", "right", "east", "e", "r"], "east"],
  [["ileri", "yukari", "kuzey", "north", "n", "up"], "north"],
  [["geri", "asagi", "guney", "south", "s", "back", "down"], "south"],
];

const FACE_TO_SLASH = {
  west: "w",
  east: "e",
  north: "n",
  south: "s",
  "north-west": "nw",
  "north-east": "ne",
  "south-west": "sw",
  "south-east": "se",
};

export function normalizeChatText(s) {
  return String(s || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/[''`´]/g, "")
    .replace(/[^a-z0-9çğıöşü.\s/]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip Turkish diacritics for command matching. */
export function foldCmd(s) {
  return normalizeChatText(s)
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if text contains a banned word/phrase. */
export function containsBannedLanguage(raw) {
  const n = normalizeChatText(raw);
  if (!n) return false;
  const packed = n.replace(/\s+/g, "");
  for (const w of BANNED_WORDS) {
    const phrase = normalizeChatText(w);
    if (!phrase) continue;
    if (phrase.includes(" ")) {
      if (n.includes(phrase) || foldCmd(n).includes(foldCmd(phrase))) return true;
      continue;
    }
    const re = new RegExp(
      `(^|[^a-zçğıöşü0-9])${escapeRe(phrase)}([^a-zçğıöşü0-9]|$)`,
      "i",
    );
    if (re.test(n)) return true;
    if (
      /^(amk|amq|aq|awk|awq)$/i.test(phrase) &&
      packed.includes(phrase)
    ) {
      return true;
    }
  }
  return false;
}

function matchDirFace(token) {
  const t = foldCmd(token).replace(/\s+/g, "");
  if (!t) return null;
  for (const [aliases, face] of DIR_ALIASES) {
    if (aliases.includes(t)) return face;
  }
  return null;
}

/**
 * Parse /saga 3, /saga 3 adim git, /w3, /saga git, /3 saga
 * Body is folded text WITHOUT leading slash.
 */
function parseWalkSlash(body) {
  const b = foldCmd(body).replace(/\s+/g, " ").trim();
  if (!b) return null;

  // Classic compact: w3, ne2, n-e 2
  const compact = b.match(
    /^(n|s|e|w|r|l|ne|nw|se|sw|n-e|n-w|s-e|s-w)\s*(\d+(?:\.\d+)?)$/,
  );
  if (compact) {
    return { kind: "slash", cmd: `/${compact[1]}${compact[2]}` };
  }

  const dirTok =
    "sola|saga|sol|sag|ileri|geri|yukari|asagi|kuzey|guney|left|right|north|south|west|east|n|s|e|w|r|l|ne|nw|se|sw|solust|solalt|sagust|sagalt";

  // /saga 3 [adim|birim] [git|yuru]  OR  /ileri3 (glued)
  let m = b.match(
    new RegExp(
      `^(${dirTok})\\s*(\\d+(?:\\.\\d+)?)(?:\\s*(?:birim|adim|sn|saniye))?(?:\\s*(?:git|yuru|yurume))?$`,
    ),
  );
  if (m) {
    const face = matchDirFace(m[1]);
    const amount = Number(m[2]);
    if (face && Number.isFinite(amount) && amount > 0) {
      return { kind: "slash", cmd: `/${FACE_TO_SLASH[face]}${amount}` };
    }
  }

  // /3 saga …  OR  /3ileri (glued)
  m = b.match(
    new RegExp(
      `^(\\d+(?:\\.\\d+)?)\\s*(${dirTok})(?:\\s*(?:birim|adim))?(?:\\s*(?:git|yuru))?$`,
    ),
  );
  if (m) {
    const amount = Number(m[1]);
    const face = matchDirFace(m[2]);
    if (face && Number.isFinite(amount) && amount > 0) {
      return { kind: "slash", cmd: `/${FACE_TO_SLASH[face]}${amount}` };
    }
  }

  // /saga biraz | /saga git | /saga
  m = b.match(
    /^(sola|saga|sol|sag|ileri|geri|yukari|asagi|kuzey|guney|left|right|north|south|west|east|solust|solalt|sagust|sagalt)(?:\s+(?:biraz|azicik|git|yuru))?$/,
  );
  if (m) {
    const face = matchDirFace(m[1]);
    if (face) {
      return { kind: "slash", cmd: `/${FACE_TO_SLASH[face]}2` };
    }
  }

  return null;
}

function parseCrowdSlash(body) {
  const b = foldCmd(body).replace(/\s+/g, " ").trim();
  // /add50char
  let m = b.match(/^add(\d+)char$/);
  if (m && CROWD_COUNTS.includes(Number(m[1]))) {
    return { kind: "slash", cmd: `/add${m[1]}char` };
  }
  // /50karakter /kalabalik 50 /ekle 50
  m =
    b.match(/^(?:kalabalik|ekle|add)\s*(\d+)$/) ||
    b.match(/^(\d+)\s*(?:karakter|kisi|char)?$/) ||
    b.match(/^(\d+)karakter$/);
  if (m && CROWD_COUNTS.includes(Number(m[1]))) {
    return { kind: "slash", cmd: `/add${m[1]}char` };
  }
  return null;
}

/**
 * @returns {{ kind: string, cmd?: string, sceneId?: string } | null}
 */
export function tryResolveChatIntent(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  if (containsBannedLanguage(text)) {
    return { kind: "banned" };
  }

  // Commands require leading /
  if (!text.startsWith("/")) return null;

  const body = text.slice(1).trim();
  if (!body) return null;

  const folded = foldCmd(body);
  const packed = folded.replace(/\s+/g, "");
  const firstToken = folded.split(/\s+/)[0] || "";

  if (SIGNIN_ALIASES.has(packed) || SIGNIN_ALIASES.has(firstToken)) {
    return { kind: "signin" };
  }
  if (SIGNOUT_ALIASES.has(packed) || SIGNOUT_ALIASES.has(firstToken)) {
    return { kind: "signout" };
  }

  if (SCENE_VOTE_ALIASES[packed] || SCENE_VOTE_ALIASES[firstToken]) {
    const sceneId = SCENE_VOTE_ALIASES[packed] || SCENE_VOTE_ALIASES[firstToken];
    return {
      kind: "vote",
      cmd: SCENE_VOTE_CANON[sceneId] || `/${firstToken}`,
      sceneId,
    };
  }

  const crowd = parseCrowdSlash(body);
  if (crowd) return crowd;

  // Walk before simple aliases so /e3 isn't eaten by /e (bin)
  const walk = parseWalkSlash(body);
  if (walk) return walk;

  if (SIMPLE_ALIASES[packed]) {
    return { kind: "slash", cmd: SIMPLE_ALIASES[packed] };
  }
  // Single-token only (avoid "/e 3" → mount)
  if (!/\s/.test(folded) && SIMPLE_ALIASES[firstToken]) {
    return { kind: "slash", cmd: SIMPLE_ALIASES[firstToken] };
  }

  // Pass through classic /play /dance /W3 /add50char as-is
  return { kind: "slash", cmd: `/${body}` };
}
