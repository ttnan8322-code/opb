// lib/haki.js
// Haki system utilities

const BASIC_STARS = 0; // cards start with 0 stars by default (presence indicated separately)
const ADVANCED_STARS = 0; // advanced presence flag; stars tracked per-owner

// devil fruit users list (IDs as used in cards.js)
export const DEVIL_FRUIT_USERS = new Set([
  // examples from spec (use ids present in cards list where possible)
  'luffy_s_05','luffy_ur_06','monkeydragon_ss_02','portgasdace_s_02','portgasdace_s_03',
  'Smoker_s_04','bartolameo_s_02','usopp_b_04','GolDRoger_ss_01','GolDRoger_ss_02','GolDRoger_ur_03'
]);

export function parseHaki(card) {
  const haki = (card && Array.isArray(card.haki)) ? card.haki : [];
  const out = {
    armament: { present: false, advanced: false },
    observation: { present: false, advanced: false },
    conqueror: { present: false, advanced: false }
  };
  for (const h of haki) {
    const key = String(h).toLowerCase();
    if (key.includes('arm') || key.includes('armament')) {
      const adv = key.includes('advanced');
      out.armament.present = true;
      out.armament.advanced = out.armament.advanced || adv;
    }
    if (key.includes('obs') || key.includes('observation')) {
      const adv = key.includes('advanced');
      out.observation.present = true;
      out.observation.advanced = out.observation.advanced || adv;
    }
    if (key.includes('conq') || key.includes('conqueror')) {
      const adv = key.includes('advanced');
      out.conqueror.present = true;
      out.conqueror.advanced = out.conqueror.advanced || adv;
    }
  }
  return out;
}

export function hakiDisplayLines(card) {
  const p = parseHaki(card);
  function mapLine(name, obj) {
    if (!obj || obj.stars <= 0) return `${name}: No`;
    if (obj.advanced) return `${name}: Advanced`;
    return `${name}: Yes`;
  }
  return [mapLine('Observation', p.observation), mapLine('Armament', p.armament), mapLine("Conqueror's", p.conqueror)];
}

export function hakiStarsLine(card, ownedEntry) {
  const p = parseHaki(card);
  const owned = (ownedEntry && ownedEntry.haki) ? ownedEntry.haki : {};
  function starsFor(type) {
    if (!p[type] || !p[type].present) return '';
    const maxStars = p[type].advanced ? 5 : 3;
    const n = Math.max(0, Number(owned[type] || 0));
    const filled = '✮'.repeat(Math.min(maxStars, n));
    const empty = '☆'.repeat(Math.max(0, maxStars - Math.min(maxStars, n)));
    return (filled + empty).slice(0, maxStars);
  }
  return { armament: starsFor('armament'), observation: starsFor('observation'), conqueror: starsFor('conqueror') };
}

export function applyHakiStatBoosts(scaledObj, card, ownedEntry) {
  // scaledObj: { attackRange: [min,max], power }
  const pCard = parseHaki(card);
  const outHaki = {
    armament: { present: !!(pCard.armament && pCard.armament.present), advanced: !!(pCard.armament && pCard.armament.advanced), stars: 0 },
    observation: { present: !!(pCard.observation && pCard.observation.present), advanced: !!(pCard.observation && pCard.observation.advanced), stars: 0 },
    conqueror: { present: !!(pCard.conqueror && pCard.conqueror.present), advanced: !!(pCard.conqueror && pCard.conqueror.advanced), stars: 0 }
  };

  // Retrieve owned stars from the owner's card entry if present
  if (ownedEntry && ownedEntry.haki && typeof ownedEntry.haki === 'object') {
    if (outHaki.armament.present) outHaki.armament.stars = Math.max(0, Number(ownedEntry.haki.armament || 0));
    if (outHaki.observation.present) outHaki.observation.stars = Math.max(0, Number(ownedEntry.haki.observation || 0));
    if (outHaki.conqueror.present) outHaki.conqueror.stars = Math.max(0, Number(ownedEntry.haki.conqueror || 0));
  }
  // Armament: base +5% even at 0 stars, each star = +10% HP & ATK
  if (outHaki.armament.present) {
    const base = 0.05; // 5% base
    const perStar = 0.10; // 10% per star
    const mul = 1 + base + (outHaki.armament.stars * perStar);
    if (scaledObj.attackRange && Array.isArray(scaledObj.attackRange)) {
      scaledObj.attackRange[0] = Math.round(scaledObj.attackRange[0] * mul);
      scaledObj.attackRange[1] = Math.round(scaledObj.attackRange[1] * mul);
    }
    if (typeof scaledObj.power === 'number') scaledObj.power = Math.round(scaledObj.power * mul);
    outHaki.armament.multiplier = mul;
  } else {
    outHaki.armament.multiplier = 1;
  }

  return { scaled: scaledObj, haki: outHaki };
}

export default { parseHaki, hakiDisplayLines, hakiStarsLine, applyHakiStatBoosts, DEVIL_FRUIT_USERS };
