import { EmbedBuilder } from "discord.js";
import { getRankInfo, getCardById } from "../cards.js";
import { cards } from "../cards.js";
import { buildWeaponEmbed } from "./weaponEmbed.js";
import { roundNearestFive } from "./stats.js";

export function fuzzyFindCard(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  let card = cards.find((c) => c.id.toLowerCase() === q);
  if (card) return card;
  card = cards.find((c) => c.name.toLowerCase() === q);
  if (card) return card;
  card = cards.find((c) => c.name.toLowerCase().startsWith(q));
  if (card) return card;
  card = cards.find((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  return card || null;
}

export function buildCardEmbed(card, ownedEntry, viewer) {
  // If this card is a weapon, delegate to weapon embed
  if (card && card.type && String(card.type).toLowerCase() === "weapon") {
    return buildWeaponEmbed(card, viewer);
  }
  // Show base card stats (no level multipliers)
  const basePower = roundNearestFive(card.power || 0);
  const baseAttackMin = roundNearestFive((card.attackRange?.[0] || 0));
  const baseAttackMax = roundNearestFive((card.attackRange?.[1] || 0));
  const baseHealth = roundNearestFive(card.health || 0);

  const rankInfo = getRankInfo(card.rank);

  // Build stats parts, only include non-empty fields
  const statsParts = [];
  
  if (basePower > 0) {
    statsParts.push(`**Power:** ${basePower}`);
  }

  if (baseHealth > 0) {
    statsParts.push(`**Health:** ${baseHealth}`);
  }

  if (baseAttackMin > 0 || baseAttackMax > 0) {
    statsParts.push(`**Attack:** ${baseAttackMin} - ${baseAttackMax}`);
  }

  if (card.specialAttack) {
    statsParts.push(`**Special:** ${card.specialAttack.name} (${card.specialAttack.range[0]}-${card.specialAttack.range[1]} damage)`);
  }

  if (card.type) {
    statsParts.push(`**Type:** ${card.type}`);
  }

  if (card.ability) {
    statsParts.push(`**Effect:** ${card.ability}`);
  }


  // Add signature weapon field if card has one
  if (card.signatureWeapon) {
    const sigWeapon = getCardById(card.signatureWeapon);
    if (sigWeapon) {
      statsParts.push(`**Signature Weapon:** ${sigWeapon.name}`);
    }
  }

  // Check for weapons field
  if (card.weapons && card.weapons.length > 0) {
    statsParts.push(`**Weapons:** ${card.weapons.join(", ")}`);
  }

  const statsText = statsParts.join("\n");

  // 'Owned' text only for base stats
  const owned = !!(ownedEntry && (ownedEntry.count || 0) > 0);
  const ownedText = `Owned: ${owned ? 'Yes' : 'No'}`;

  const descParts = [];
  if (card.title) descParts.push(card.title);
  descParts.push(ownedText);
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(card.name)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (card.image) embed.setImage(card.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  // Determine upgrade position among same-name cards
  const same = cards.filter(c => (c.name || "").toLowerCase() === (card.name || "").toLowerCase());
  let footerText = card.name;
  if (same.length > 1) {
    // try to sort by rank value if available
    const sorted = same.slice().sort((a,b) => {
      const va = getRankInfo(a.rank)?.value || 0;
      const vb = getRankInfo(b.rank)?.value || 0;
      return va - vb;
    });
    const idx = sorted.findIndex(c => c.id === card.id);
    if (idx !== -1) footerText = `${card.name} • Upgrade ${idx+1}/${sorted.length}`;
  }

  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}

export function buildDropEmbed(card, level = 1, viewer) {
  // Build embed suitable for a drop message. Shows base stats and a random level, omits Owned field.
  const rankInfo = getRankInfo(card.rank);

  const basePower = roundNearestFive(card.power || 0);
  const baseAttackMin = roundNearestFive((card.attackRange?.[0] || 0));
  const baseAttackMax = roundNearestFive((card.attackRange?.[1] || 0));
  const baseHealth = roundNearestFive(card.health || 0);

  const statsParts = [];
  statsParts.push(`**Level:** ${level}`);
  if (basePower > 0) statsParts.push(`**Power:** ${basePower}`);
  if (baseHealth > 0) statsParts.push(`**Health:** ${baseHealth}`);
  if (baseAttackMin > 0 || baseAttackMax > 0) statsParts.push(`**Attack:** ${baseAttackMin} - ${baseAttackMax}`);
  if (card.specialAttack) statsParts.push(`**Special:** ${card.specialAttack.name} (${card.specialAttack.range[0]}-${card.specialAttack.range[1]} damage)`);
  if (card.type) statsParts.push(`**Type:** ${card.type}`);
  if (card.ability) statsParts.push(`**Effect:** ${card.ability}`);

  const statsText = statsParts.join("\n");

  const descParts = [];
  if (card.title) descParts.push(card.title);
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(card.name)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (card.image) embed.setImage(card.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  const same = cards.filter(c => (c.name || "").toLowerCase() === (card.name || "").toLowerCase());
  let footerText = card.name;
  if (same.length > 1) {
    const sorted = same.slice().sort((a,b) => {
      const va = getRankInfo(a.rank)?.value || 0;
      const vb = getRankInfo(b.rank)?.value || 0;
      return va - vb;
    });
    const idx = sorted.findIndex(c => c.id === card.id);
    // Only show upgrade label when this is not the base (1/?) version
    if (idx > 0) footerText = `${card.name} • Upgrade ${idx+1}/${sorted.length}`;
  }

  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}

export function buildUserCardEmbed(card, ownedEntry, viewer, equippedWeapon = null) {
  // Show card stats with user's level multipliers
  if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
    return null; // User doesn't own this card
  }

  // For weapons, the user-owned view is handled separately via WeaponInventory
  if (card && card.type && String(card.type).toLowerCase() === "weapon") {
    return null;
  }

  const userLevel = ownedEntry.level || 0;
  const rankInfo = getRankInfo(card.rank);
  
  // Calculate stats with level multiplier (1% per level)
  const levelMultiplier = 1 + (userLevel * 0.01);
  let basePower = (card.power || 0) * levelMultiplier;
  let baseAttackMin = (card.attackRange?.[0] || 0) * levelMultiplier;
  let baseAttackMax = (card.attackRange?.[1] || 0) * levelMultiplier;
  let baseHealth = (card.health || 0) * levelMultiplier;
  
  // Apply weapon boosts if equipped signature weapon
  let sigBoost = 0;
  let atkBoost = 0, hpBoost = 0;
  if (equippedWeapon && equippedWeapon.card && card.signatureWeapon === equippedWeapon.id) {
    const sigWeaponCard = getCardById(card.signatureWeapon);
    if (sigWeaponCard && Array.isArray(sigWeaponCard.signatureCards)) {
      const idx = sigWeaponCard.signatureCards.indexOf(card.id);
      if (idx > 0) sigBoost = 0.25;
    }

    const weaponCard = equippedWeapon.card;
    const weaponLevel = equippedWeapon.level || 1;
    if (weaponCard.boost) {
      atkBoost = Math.round((weaponCard.boost.atk || 0) * (1 + (weaponLevel - 1) * 0.01));
      hpBoost = Math.round((weaponCard.boost.hp || 0) * (1 + (weaponLevel - 1) * 0.01));
      // Apply signature boost if applicable
      if (sigBoost > 0) atkBoost = Math.round(atkBoost * 1.25);
      basePower += atkBoost;
      baseAttackMin += atkBoost;
      baseAttackMax += atkBoost;
      baseHealth += hpBoost;
    }
  }
  
  const userPower = roundNearestFive(Math.round(basePower));
  const userAttackMin = roundNearestFive(Math.round(baseAttackMin));
  const userAttackMax = roundNearestFive(Math.round(baseAttackMax));
  const userHealth = roundNearestFive(Math.round(baseHealth));

  // Build stats parts, only include non-empty fields
  const statsParts = [];
  
  if (userLevel >= 0) {
    // Display level and current XP out of required XP for next level
    const currentXP = ownedEntry.xp || 0;
    const requiredXP = 100;
    statsParts.push(`**Level:** ${userLevel} (${currentXP}/${requiredXP})`);
  }
  
  if (userPower > 0) {
    statsParts.push(`**Power:** ${userPower}`);
  }
  if (userHealth > 0) {
    let healthText = `**Health:** ${userHealth}`;
    if (hpBoost > 0) {
      healthText += ` (includes +${hpBoost} from weapon)`;
    }
    statsParts.push(healthText);
  }

  if (userAttackMin > 0 || userAttackMax > 0) {
    let attackText = `**Attack:** ${userAttackMin} - ${userAttackMax}`;
    statsParts.push(attackText);
  }

  if (card.specialAttack) {
    statsParts.push(`**Special:** ${card.specialAttack.name} (${card.specialAttack.range[0]}-${card.specialAttack.range[1]} damage)`);
  }

  if (card.type) {
    statsParts.push(`**Type:** ${card.type}`);
  }

  if (card.ability) {
    statsParts.push(`**Effect:** ${card.ability}`);
  }
  

  // Add signature weapon field if card has one and is a valid upgrade (not Zoro 1/5)
  if (card.signatureWeapon) {
    // Only show for Zoro upgrades 2+ (not 1/5)
    let showSig = true;
    if (card.name === "Roronoa Zoro") {
      // Find upgrade index for Zoro
      const zoroUpgrades = cards.filter(c => c.name === "Roronoa Zoro").sort((a,b) => (getRankInfo(a.rank)?.value||0)-(getRankInfo(b.rank)?.value||0));
      const idx = zoroUpgrades.findIndex(c => c.id === card.id);
      if (idx === 0) showSig = false;
    }
    if (showSig) {
      const sigWeapon = getCardById(card.signatureWeapon);
      if (sigWeapon) {
        statsParts.push(`**Signature Weapon:** ${sigWeapon.name}`);
      }
    }
  }

  // Show equipped weapon if one is passed
  if (equippedWeapon) {
    const weaponName = equippedWeapon.card ? equippedWeapon.card.name : equippedWeapon.name || "Unknown";
    statsParts.push(`**Equipped Weapon:** ${weaponName}`);
  }

  // Check for weapons field
  if (card.weapons && card.weapons.length > 0) {
    statsParts.push(`**Weapons:** ${card.weapons.join(", ")}`);
  }

  const statsText = statsParts.join("\n");

  // 'Obtained from' should be in user stats
  const obtained = card.source || "Card Pulls";

  const descParts = [];
  if (card.title) descParts.push(card.title);
  descParts.push(`Obtained from: ${obtained}`);
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(card.name)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (card.image) embed.setImage(card.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  // Determine upgrade position among same-name cards
  const same = cards.filter(c => (c.name || "").toLowerCase() === (card.name || "").toLowerCase());
  let footerText = card.name;
  if (same.length > 1) {
    const sorted = same.slice().sort((a,b) => {
      const va = getRankInfo(a.rank)?.value || 0;
      const vb = getRankInfo(b.rank)?.value || 0;
      return va - vb;
    });
    const idx = sorted.findIndex(c => c.id === card.id);
    if (idx !== -1) footerText = `${card.name} • Upgrade ${idx+1}/${sorted.length}`;
  }

  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}
