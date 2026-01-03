import { getCardById, cards } from "../cards.js";

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function getRangeForRank(rank, mode) {
  // return [min,max] inclusive for given rank and mode. mode: 'single'|'both'|'special'
  switch ((rank || '').toUpperCase()) {
    case 'C':
      if (mode === 'single') return [1,10];
      if (mode === 'both') return [1,10];
      return null; // C doesn't grant special
    case 'B':
      if (mode === 'single') return [1,15];
      if (mode === 'both') return [1,15];
      return null;
    case 'A':
      if (mode === 'single') return [1,25];
      if (mode === 'both') return [1,20];
      if (mode === 'special') return [1,5];
      return null;
    case 'S':
      if (mode === 'single') return [1,40];
      if (mode === 'both') return [1,30];
      if (mode === 'special') return [1,8];
      return null;
    case 'SS':
      if (mode === 'single') return [1,75];
      if (mode === 'both') return [1,50];
      if (mode === 'special') return [1,15];
      return null;
    case 'UR':
      if (mode === 'single') return [1,100];
      if (mode === 'both') return [1,60];
      if (mode === 'special') return [1,25];
      return null;
    default:
      return null;
  }
}

export function generateBoostForRank(rank) {
  const r = (rank || 'C').toUpperCase();
  const options = (r === 'C') ? ['single'] : (r === 'B') ? ['single','single','both'] : (r === 'A') ? ['single','single','both','special'] : (r === 'S') ? ['single','single','both','special'] : (r === 'SS') ? ['single','single','both','special'] : (r === 'UR') ? ['single','single','special'] : ['single'];
  // pick mode
  const pick = options[Math.floor(Math.random()*options.length)];
  const out = { atk: 0, hp: 0, special: 0 };
  if (pick === 'both') {
    const range = getRangeForRank(r, 'both') || getRangeForRank(r, 'single');
    const [min,max] = range;
    const val = Math.floor(Math.random()*(max-min+1))+min;
    out.atk = val; out.hp = val;
  } else if (pick === 'special') {
    const range = getRangeForRank(r, 'special') || [1,1];
    const [min,max] = range;
    const val = Math.floor(Math.random()*(max-min+1))+min;
    out.special = val;
  } else { // single -> decide atk or hp
    const range = getRangeForRank(r, 'single') || [1,1];
    const [min,max] = range;
    const val = Math.floor(Math.random()*(max-min+1))+min;
    // choose atk or hp equally
    if (Math.random() < 0.5) out.hp = val; else out.atk = val;
  }
  return out;
}

// build a map from base id -> max stage number (e.g., nojiko -> 3)
const maxStageMap = (() => {
  const map = new Map();
  for (const c of (cards || [])) {
    if (!c.id) continue;
    const m = c.id.match(/_(\d{2})$/) || c.id.match(/_(\d+)$/);
    const stage = m ? parseInt(m[1], 10) : 1;
    const base = c.id.replace(/_(?:\d{2}|\d+)$/, '');
    const cur = map.get(base) || 0;
    if (stage > cur) map.set(base, stage);
  }
  return map;
})();

export function computeTeamBoosts(teamIds, userCardsMap = null, weaponInventory = null) {
  const out = { atk: 0, hp: 0, special: 0 };
  if (!teamIds || !Array.isArray(teamIds)) return out;

  for (const id of teamIds) {
    const c = getCardById(id);
    if (!c) continue;

    // Banner boosts are applied at per-card stat calculation, not to the team's cumulative boost totals.
    // Do not add banner boosts into `out` here; per-card code should apply banner multipliers only to signature cards.

    // If user-provided entry has an attached `boost`, prefer that
    if (userCardsMap) {
      let entry;
      if (typeof userCardsMap.get === 'function') entry = userCardsMap.get(id);
      else entry = (userCardsMap || {})[id];
      if (entry && entry.boost) {
        if (entry.boost.atk) out.atk += entry.boost.atk;
        if (entry.boost.hp) out.hp += entry.boost.hp;
        if (entry.boost.special) out.special += entry.boost.special;
        continue;
      }
    }

    // For support-type cards, do NOT use any explicit `c.boost` defined in cards.js.
    // Instead, generate a random boost for the rank so support boosts are randomized.
    const isSupport = (c.type && String(c.type).toLowerCase() === 'support');
    if (isSupport) {
      try {
        const gen = generateBoostForRank(c.rank);
        if (gen.atk) out.atk += gen.atk;
        if (gen.hp) out.hp += gen.hp;
        if (gen.special) out.special += gen.special;
      } catch (e) {
        // fallback: small HP boost
        out.hp += 5;
      }
      continue;
    }

    // explicit boost object on card takes precedence for non-support cards
    if (c.boost && (c.boost.atk || c.boost.hp || c.boost.special)) {
      if (c.boost.atk) out.atk += c.boost.atk;
      if (c.boost.hp) out.hp += c.boost.hp;
      if (c.boost.special) out.special += c.boost.special;
      continue;
    }

    // allow Support-type cards to act as boost cards (default to HP)
    const abilityRaw = (c.ability || "").trim();

    // if ability contains explicit percent, honor it for non-support cards
    if (abilityRaw) {
      const pctMatch = abilityRaw.match(/(\d{1,3})\s*%/);
      const ability = abilityRaw.toLowerCase();
      if (pctMatch && !isSupport) {
        const num = parseInt(pctMatch[1], 10);
        if (ability.includes('attack') || ability.includes('atk')) out.atk += num;
        else if (ability.includes('both')) { out.atk += num; out.hp += num; }
        else if (ability.includes('special')) out.special += num;
        else out.hp += num;
        continue;
      }
    }

    // Determine if this card should be treated as a boost card:
    // - explicit ability text -> inferred
    // - OR support-type cards (default to HP)
    if (!abilityRaw && !isSupport) continue; // not a boost card

    const ability = (abilityRaw || '').toLowerCase();

    // infer mode
    let mode = null;
    if (ability.includes('both')) mode = 'both';
    else if (ability.includes('attack') || ability.includes('atk')) mode = 'single';
    else if (ability.includes('special')) mode = 'special';
    else if (ability.includes('hp') || ability.includes('health')) mode = 'single';
    else if (isSupport) mode = 'single'; // default support -> hp

    if (!mode) continue;

    const range = getRangeForRank(c.rank, mode);
    if (!range) continue;
    const [min, max] = range;
    // compute stage-aware value
    const idStr = c.id || '';
    const m = idStr.match(/_(\d{2})$/) || idStr.match(/_(\d+)$/);
    const stage = m ? parseInt(m[1], 10) : 1;
    const base = idStr.replace(/_(?:\d{2}|\d+)$/, '');
    const maxStage = maxStageMap.get(base) || 1;
    let val;
    if (maxStage <= 1) val = Math.round((min + max) / 2);
    else {
      const computed = Math.round(min + (max - min) * (stage / maxStage));
      val = Math.min(max, computed + 1);
    }

    if (mode === 'both') { out.atk += val; out.hp += val; }
    else if (mode === 'single') {
      if (ability.includes('hp') || ability.includes('health') || isSupport) out.hp += val; else out.atk += val;
    } else if (mode === 'special') { out.special += val; }
  }
  return out;
}

export function computeTeamBoostsDetailed(teamIds, userCardsMap = null, weaponInventory = null) {
  const totals = { atk: 0, hp: 0, special: 0 };
  const details = [];
  if (!teamIds || !Array.isArray(teamIds)) return { totals, details };

  for (const id of teamIds) {
    const c = getCardById(id);
    if (!c) continue;
    let entry = { id: c.id, name: c.name, atk: 0, hp: 0, special: 0, reason: null };

    // Banner boosts are applied at per-card stat calculation and should not mark the card as a team-boost source.
    // We intentionally do not add banner boosts here; stat code will apply banner multipliers for signature cards.

    // prefer user-owned boost if available
    if (userCardsMap) {
      let userEntry;
      if (typeof userCardsMap.get === 'function') userEntry = userCardsMap.get(id);
      else userEntry = (userCardsMap || {})[id];
      if (userEntry && userEntry.boost) {
        entry.atk = userEntry.boost.atk || 0;
        entry.hp = userEntry.boost.hp || 0;
        entry.special = userEntry.boost.special || 0;
        entry.reason = 'user-assigned boost';
        totals.atk += entry.atk; totals.hp += entry.hp; totals.special += entry.special;
        details.push(entry);
        continue;
      }
    }

    if (c.boost && (c.boost.atk || c.boost.hp || c.boost.special) && !(c.type && String(c.type).toLowerCase() === 'support')) {
      entry.atk += c.boost.atk || 0;
      entry.hp += c.boost.hp || 0;
      entry.special += c.boost.special || 0;
      entry.reason = entry.reason ? entry.reason + ', explicit boost' : 'explicit boost';
    } else {
      const abilityRaw = (c.ability || "").trim();
      if (abilityRaw) {
        const pctMatch = abilityRaw.match(/(\d{1,3})\s*%/);
        const ability = abilityRaw.toLowerCase();
        const isSupport = (c.type && String(c.type).toLowerCase() === 'support');
        if (pctMatch && !isSupport) {
          const num = parseInt(pctMatch[1], 10);
          if (ability.includes('attack') || ability.includes('atk')) entry.atk = num;
          else if (ability.includes('both')) { entry.atk = num; entry.hp = num; }
          else if (ability.includes('special')) entry.special = num;
          else entry.hp = num;
          entry.reason = 'ability text';
        } else {
          // infer via ability text (support cards ignore explicit pct and use computed range/stage)
          let mode = null;
          if (ability.includes('both')) mode = 'both';
          else if (ability.includes('attack') || ability.includes('atk')) mode = 'single';
          else if (ability.includes('special')) mode = 'special';
          else if (ability.includes('hp') || ability.includes('health')) mode = 'single';
          if (mode) {
            const range = getRangeForRank(c.rank, mode);
            if (range) {
              const [min, max] = range;
              // compute stage-aware value
              const idStr = c.id || '';
              const m = idStr.match(/_(\d{2})$/) || idStr.match(/_(\d+)$/);
              const stage = m ? parseInt(m[1], 10) : 1;
              const base = idStr.replace(/_(?:\d{2}|\d+)$/, '');
              const maxStage = maxStageMap.get(base) || 1;
              let val;
              if (maxStage <= 1) val = Math.round((min + max) / 2);
              else {
                const computed = Math.round(min + (max - min) * (stage / maxStage));
                val = Math.min(max, computed + 1);
              }

              if (mode === 'both') { entry.atk = val; entry.hp = val; }
              else if (mode === 'single') { if (ability.includes('hp') || ability.includes('health')) entry.hp = val; else entry.atk = val; }
              else if (mode === 'special') entry.special = val;
              entry.reason = 'ability inferred';
            }
          }
        }
      } else if (c.type && String(c.type).toLowerCase() === 'support') {
        // For support cards, prefer user-provided boost; otherwise generate one randomly
        try {
          const gen = generateBoostForRank(c.rank);
          entry.atk = gen.atk || 0; entry.hp = gen.hp || 0; entry.special = gen.special || 0;
          entry.reason = 'support generated';
        } catch (e) {
          entry.hp = 5; entry.reason = 'support fallback';
        }
      }
    }

    totals.atk += entry.atk; totals.hp += entry.hp; totals.special += entry.special;
    details.push(entry);
  }
  return { totals, details };
}
