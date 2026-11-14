/**
 * Chat intent: keep `/` commands; also extract Turkish natural phrases.
 * Profanity → { kind: "banned" }.
 */

const CROWD_COUNTS = [5, 10, 20, 30, 40, 50];

const SCENE_VOTE_SLASH = {
  "/tennis": "tennis",
  "/dc": "dogrulukmu_cesaretmi",
  "/nc": "night_club_inside",
  "/rl": "red_light_green_light",
};

/** Turkish + common EN — matched as whole words after normalize. */
const BANNED_WORDS = [
  // TR
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
];

const DIR_WORD_TO_FACE = [
  [/sol\s*üst|sol\s*ust|kuzey\s*bat[iı]|northwest|north\s*west/i, "north-west"],
  [/sol\s*alt|güney\s*bat[iı]|guney\s*bat[iı]|southwest|south\s*west/i, "south-west"],
  [/sağ\s*üst|sag\s*üst|sag\s*ust|sağ\s*ust|kuzey\s*doğu|kuzey\s*dogu|northeast|north\s*east/i, "north-east"],
  [/sağ\s*alt|sag\s*alt|güney\s*doğu|guney\s*dogu|southeast|south\s*east/i, "south-east"],
  [/sola|sol\s*tarafa|sol\s*taraf|sola\s*doğru|sola\s*dogru|\bsol\b|left|west/i, "west"],
  [/sağa|saga|sağ\s*tarafa|sag\s*tarafa|sağa\s*doğru|saga\s*dogru|\bsağ\b|\bsag\b|right|east/i, "east"],
  [/ileri|yukarı|yukari|kuzeye|\bkuzey\b|yukarıya|yukariya|north|\bup\b/i, "north"],
  [/geri|aşağı|asagi|güneye|guneye|\bgüney\b|\bguney\b|aşağıya|asagiya|south|\bback\b/i, "south"],
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
    .replace(/[^a-z0-9çğıöşü.\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if text contains a banned word/phrase (word-ish boundaries). */
export function containsBannedLanguage(raw) {
  const n = normalizeChatText(raw);
  if (!n) return false;
  const packed = n.replace(/\s+/g, "");
  for (const w of BANNED_WORDS) {
    const phrase = normalizeChatText(w);
    if (!phrase) continue;
    if (phrase.includes(" ")) {
      if (n.includes(phrase)) return true;
      continue;
    }
    const re = new RegExp(
      `(^|[^a-zçğıöşü0-9])${escapeRe(phrase)}([^a-zçğıöşü0-9]|$)`,
      "i",
    );
    if (re.test(n)) return true;
    // glued bypass: amk inside longer token already covered; also packed exact short toks
    if (phrase.length >= 2 && packed.includes(phrase) && phrase.length >= 3) {
      // only for short slang tokens without vowels sandwich — keep conservative:
      if (/^(amk|amq|aq|mk|mq|oç|oc|sg|awk|awq)$/i.test(phrase) && packed.includes(phrase)) {
        return true;
      }
    }
  }
  return false;
}

function matchDirFace(chunk) {
  for (const [re, face] of DIR_WORD_TO_FACE) {
    if (re.test(chunk)) return face;
  }
  return null;
}

function findWalkCommand(n) {
  // sola 3 birim git / sola 3 / 3 sola git / sola biraz / sola git
  const patterns = [
    /((?:sol\s*üst|sol\s*ust|sol\s*alt|sağ\s*üst|sag\s*üst|sağ\s*ust|sag\s*ust|sağ\s*alt|sag\s*alt|sola|sağa|saga|sol|sağ|sag|ileri|geri|yukarı|yukari|aşağı|asagi|kuzey|güney|guney|left|right|north|south|west|east)(?:\s*(?:tarafa|taraf|doğru|dogru))?)\s+(\d+(?:\.\d+)?)\s*(?:birim|ad[iı]m|sn|saniye)?\s*(?:git(?:\w*)?|yürü(?:\w*)?|yuru(?:\w*)?)?/,
    /(\d+(?:\.\d+)?)\s*((?:sol\s*üst|sol\s*ust|sol\s*alt|sağ\s*üst|sag\s*üst|sağ\s*ust|sag\s*ust|sağ\s*alt|sag\s*alt|sola|sağa|saga|sol|sağ|sag|ileri|geri|yukarı|yukari|aşağı|asagi|kuzey|güney|guney|left|right|north|south|west|east)(?:\s*(?:tarafa|taraf|doğru|dogru))?)\s*(?:birim|ad[iı]m)?\s*(?:git(?:\w*)?|yürü(?:\w*)?|yuru(?:\w*)?)?/,
    /((?:sol\s*üst|sol\s*ust|sol\s*alt|sağ\s*üst|sag\s*üst|sağ\s*ust|sag\s*ust|sağ\s*alt|sag\s*alt|sola|sağa|saga|sol|sağ|sag|ileri|geri|yukarı|yukari|aşağı|asagi|kuzey|güney|guney|left|right|north|south|west|east)(?:\s*(?:tarafa|taraf|doğru|dogru))?)\s+(biraz|azıcık|azicik|bi\s*tık|bi\s*tik)\s*(?:git(?:\w*)?|yürü(?:\w*)?|yuru(?:\w*)?)?/,
    /((?:sol\s*üst|sol\s*ust|sol\s*alt|sağ\s*üst|sag\s*üst|sağ\s*ust|sag\s*ust|sağ\s*alt|sag\s*alt|sola|sağa|saga|ileri|geri|yukarı|yukari|aşağı|asagi)(?:\s*(?:tarafa|taraf|doğru|dogru))?)\s+(?:git(?:\w*)?|yürü(?:\w*)?|yuru(?:\w*)?)/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = n.match(patterns[i]);
    if (!m) continue;
    let dirChunk;
    let amount = 2;
    if (i === 1) {
      amount = Number(m[1]);
      dirChunk = m[2];
    } else if (i === 0) {
      dirChunk = m[1];
      amount = Number(m[2]);
    } else if (i === 2) {
      dirChunk = m[1];
      amount = 2;
    } else {
      dirChunk = m[1];
      amount = 2;
    }
    const face = matchDirFace(dirChunk);
    if (!face || !Number.isFinite(amount) || amount <= 0) continue;
    const tok = FACE_TO_SLASH[face];
    if (!tok) continue;
    return { kind: "slash", cmd: `/${tok}${amount}` };
  }
  return null;
}

/** ASCII \\b breaks on Turkish letters (ı, ğ…) — use explicit edges. */
function hasPhrase(n, phrase) {
  const p = normalizeChatText(phrase);
  if (!p) return false;
  const re = new RegExp(
    `(^|[^a-zçğıöşü0-9])${escapeRe(p)}([^a-zçğıöşü0-9]|$)`,
    "i",
  );
  return re.test(n);
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

  if (text.startsWith("/")) {
    const lower = text.toLowerCase().trim();
    if (lower === "/signin" || lower === "/join") return { kind: "signin" };
    if (lower === "/signout" || lower === "/leave") return { kind: "signout" };
    if (SCENE_VOTE_SLASH[lower]) {
      return { kind: "vote", cmd: lower, sceneId: SCENE_VOTE_SLASH[lower] };
    }
    return { kind: "slash", cmd: text };
  }

  const n = normalizeChatText(text);

  // 1) stop / negative dance
  if (
    [
      "dur",
      "durdur",
      "in",
      "dans etme",
      "dansı bırak",
      "dansi birak",
      "dansı durdur",
      "dansi durdur",
      "dans yok",
      "stop",
    ].some((p) => hasPhrase(n, p))
  ) {
    return { kind: "slash", cmd: "/stop" };
  }

  // 2) dance / jump / sit
  if (
    ["dans et", "dans etsin", "dans etsene", "dans edelim", "dance", "dans"].some(
      (p) => hasPhrase(n, p),
    )
  ) {
    return { kind: "slash", cmd: "/dance" };
  }
  if (
    ["zıpla", "zipla", "zıplasana", "ziplasana", "zıplama", "ziplama", "jump"].some(
      (p) => hasPhrase(n, p),
    )
  ) {
    return { kind: "slash", cmd: "/jump" };
  }
  if (["otur", "otursana", "otursene", "sit"].some((p) => hasPhrase(n, p))) {
    return { kind: "slash", cmd: "/sit" };
  }

  // 3) walk
  const walk = findWalkCommand(n);
  if (walk) return walk;

  // 4) play
  if (
    [
      "oyna",
      "başla",
      "basla",
      "başlat",
      "baslat",
      "maç başlat",
      "mac baslat",
      "play",
      "oyunu başlat",
      "oyunu baslat",
    ].some((p) => hasPhrase(n, p))
  ) {
    return { kind: "slash", cmd: "/play" };
  }

  // 5) mount
  if (
    ["bin", "kaykaya bin", "araca bin", "bin bakalım", "bin bakalim"].some((p) =>
      hasPhrase(n, p),
    )
  ) {
    return { kind: "slash", cmd: "/e" };
  }

  // 6) crowd
  {
    const m =
      n.match(
        /(?:^|[^a-zçğıöşü0-9])(?:kalabalık|kalabalik|add|ekle)\s*(\d+)(?:[^a-zçğıöşü0-9]|$)/,
      ) ||
      n.match(
        /(?:^|[^a-zçğıöşü0-9])(\d+)\s*(?:karakter|kişi|kisi|char)?\s*(?:ekle|ekleyin|olsun)(?:[^a-zçğıöşü0-9]|$)/,
      ) ||
      n.match(/(?:^|[^a-zçğıöşü0-9])(\d+)\s*karakter(?:[^a-zçğıöşü0-9]|$)/);
    if (m) {
      const count = Number(m[1]);
      if (CROWD_COUNTS.includes(count)) {
        return { kind: "slash", cmd: `/add${count}char` };
      }
    }
  }

  // 7) scene votes
  if (
    ["tenis", "tenise geç", "tenise gec", "tenis sahnesi", "tennis"].some((p) =>
      hasPhrase(n, p),
    )
  ) {
    return { kind: "vote", cmd: "/tennis", sceneId: "tennis" };
  }
  if (
    ["doğruluk", "dogruluk", "doğruluk mu", "dogruluk mu", "cesaret", "dc"].some(
      (p) => hasPhrase(n, p),
    )
  ) {
    return { kind: "vote", cmd: "/dc", sceneId: "dogrulukmu_cesaretmi" };
  }
  if (
    [
      "night club",
      "nightclub",
      "kulüp",
      "kulup",
      "gece kulübü",
      "gece kulubu",
      "nc",
    ].some((p) => hasPhrase(n, p))
  ) {
    return { kind: "vote", cmd: "/nc", sceneId: "night_club_inside" };
  }
  if (
    [
      "red light",
      "kırmızı ışık",
      "kirmizi isik",
      "kırmızı isik",
      "rl",
    ].some((p) => hasPhrase(n, p))
  ) {
    return { kind: "vote", cmd: "/rl", sceneId: "red_light_green_light" };
  }

  // 8) join / leave — avoid bare "gir/çık" alone (too common in chat)
  if (
    [
      "oyuna katıl",
      "oyuna katil",
      "katıl",
      "katil",
      "beni al",
      "beni de al",
      "join",
      "signin",
    ].some((p) => hasPhrase(n, p))
  ) {
    return { kind: "signin" };
  }
  if (
    [
      "oyundan çık",
      "oyundan cik",
      "ayrıl",
      "ayril",
      "çıkış yap",
      "cikis yap",
      "leave",
      "signout",
    ].some((p) => hasPhrase(n, p))
  ) {
    return { kind: "signout" };
  }

  return null;
}
