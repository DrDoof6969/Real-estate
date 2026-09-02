// lib/address.js
//
// Cache-key normalization. This looks cosmetic and isn't: the cache is
// the difference between paying RentCast once for an address and paying
// per visitor, and a cache keyed on the raw string treats
// "214 Maple St, Columbia, SC" and "214 maple street columbia sc 29201"
// as two different addresses — two paid lookups for one property.
// Normalizing the obvious variations is the cheapest hit-rate improvement
// available.
//
// Deliberately conservative: it only collapses forms that unambiguously
// mean the same thing. It does NOT try to be a geocoder — two genuinely
// different addresses must never collide onto one key, because that would
// serve one property's numbers for another.

const SUFFIXES = {
  street: "st", str: "st",
  avenue: "ave", av: "ave",
  road: "rd",
  drive: "dr",
  court: "ct",
  lane: "ln",
  boulevard: "blvd", boul: "blvd",
  place: "pl",
  terrace: "ter",
  circle: "cir",
  parkway: "pkwy",
  highway: "hwy",
  square: "sq",
  trail: "trl",
  way: "way",
  crossing: "xing",
  heights: "hts",
  junction: "jct",
  landing: "lndg",
  extension: "ext"
};

const DIRECTIONS = {
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw"
};

const UNIT_WORDS = { apartment: "apt", suite: "ste", unit: "unit", building: "bldg", floor: "fl" };

export function normalizeAddress(address) {
  let s = String(address || "").toLowerCase();

  // Punctuation carries no meaning in an address string; "#" becomes a
  // space so "#4" and "apt 4" don't produce different tokens.
  s = s.replace(/[.,#]/g, " ").replace(/[^a-z0-9\s-]/g, " ");

  const words = s.split(/\s+/).filter(Boolean).map(w => {
    if (SUFFIXES[w]) return SUFFIXES[w];
    if (DIRECTIONS[w]) return DIRECTIONS[w];
    if (UNIT_WORDS[w]) return UNIT_WORDS[w];
    return w;
  });

  // A zip+4 and its bare zip are the same delivery point for our purposes.
  return words
    .map(w => (/^\d{5}-\d{4}$/.test(w) ? w.slice(0, 5) : w))
    .join(" ")
    .trim();
}
