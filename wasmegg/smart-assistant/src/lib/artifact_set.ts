import { Artifact, ArtifactSet, Farm, Inventory, Item, Modifiers } from 'lib';

import { Contender, PrestigeStrategy } from './recommendation';
import { ImpossibleError, notNull } from './utils';

export enum ArtifactAssemblyStatus {
  MISSING_CONSTITUENTS,
  AWAITING_ASSEMBLY,
  ASSEMBLED,
  EQUIPPED,
}

export type ArtifactAssemblyStatusNonMissing =
  | ArtifactAssemblyStatus.AWAITING_ASSEMBLY
  | ArtifactAssemblyStatus.ASSEMBLED
  | ArtifactAssemblyStatus.EQUIPPED;

export function artifactEqual(a1: Artifact, a2: Artifact): boolean {
  if (a1.key !== a2.key) {
    return false;
  }
  if (a1.stones.length !== a2.stones.length) {
    return false;
  }
  for (let i = 0; i < a1.stones.length; i++) {
    if (a1.stones[i].key !== a2.stones[i].key) {
      return false;
    }
  }
  return true;
}

export function artifactSetEqual(s1: ArtifactSet, s2: ArtifactSet): boolean {
  if (s1.artifacts.length !== s2.artifacts.length) {
    return false;
  }
  for (let i = 0; i < s1.artifacts.length; i++) {
    if (!artifactEqual(s1.artifacts[i], s2.artifacts[i])) {
      return false;
    }
  }
  return true;
}

export function contenderToArtifactSet(
  contender: Contender,
  guide: ArtifactSet,
  inventory: Inventory
): { artifactSet: ArtifactSet; assemblyStatuses: ArtifactAssemblyStatusNonMissing[] } {
  // First test if the currently equipped set is already optimal, and if so
  // directly return it.
  if (contender.equals(Contender.fromArtifactSet(guide))) {
    return {
      artifactSet: new ArtifactSet(guide.artifacts, false),
      assemblyStatuses: guide.artifacts.map(() => ArtifactAssemblyStatus.EQUIPPED),
    };
  }

  const unstonedArtifacts = [...contender.artifacts].sort((a1, a2) => {
    if (a1.slots !== a2.slots) {
      return a1.slots - a2.slots;
    }
    if (a1.baseCraftingPrice !== a2.baseCraftingPrice) {
      return a1.baseCraftingPrice - a2.baseCraftingPrice;
    }
    return a1.quality - a2.quality;
  });
  const stones = [...contender.stones];
  const guideArtifacts = guide.artifacts;
  const inventoryArtifacts = inventory.stoned;

  let constructedArtifacts: Artifact[] = [];
  for (const host of unstonedArtifacts) {
    if (host.slots === 0) {
      constructedArtifacts.push(new Artifact(host, []));
      continue;
    }
    // Attempt to find a match first in the guide set, then in the inventory.
    const match =
      findMatchingItem(host, stones, guideArtifacts) ||
      findMatchingItem(host, stones, inventoryArtifacts);
    const constructed = match !== null ? match : new Artifact(host, []);
    constructedArtifacts.push(constructed);
    for (const stone of constructed.stones) {
      const extracted = extractItem(stones, stone);
      if (extracted === null) {
        throw new ImpossibleError(
          `trying to slot ${stone.id} which doesn't exist in the recommendation`
        );
      }
    }
  }

  // Put in the remaining stones, less expensive ones first, so that future
  // replacements hopefully happen on cheaper hosts first.
  if (stones.length > 0) {
    stones.sort((s1, s2) => s1.baseCraftingPrice - s2.baseCraftingPrice);
    for (const constructed of constructedArtifacts) {
      while (stones.length > 0 && constructed.stones.length < constructed.slots) {
        constructed.stones.push(stones.shift()!);
      }
      if (stones.length === 0) {
        break;
      }
    }
  }
  if (stones.length > 0) {
    throw new ImpossibleError(
      `nowhere to slot some stones in the recommendation: ${stones.map(s => s.id).join(', ')}`
    );
  }

  // Reorder constructed artifacts to best match the guide set.
  const reordered: (Artifact | null)[] = [...constructedArtifacts];
  while (reordered.length < guideArtifacts.length) {
    reordered.push(null);
  }
  for (let i = 0; i < guideArtifacts.length; i++) {
    const guideAfxId = guideArtifacts[i].afxId;
    if (reordered[i]?.afxId === guideAfxId) {
      continue;
    }
    for (let j = 0; j < reordered.length; j++) {
      if (reordered[j]?.afxId === guideAfxId) {
        [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
        break;
      }
    }
  }
  constructedArtifacts = reordered.filter(notNull);
  const constructedSet = new ArtifactSet(constructedArtifacts, false);

  // Double check.
  const constructedContender = Contender.fromArtifactSet(constructedSet);
  if (!constructedContender.equals(contender)) {
    console.error(`constructed:`, constructedArtifacts);
    throw new ImpossibleError(
      `constructed set differ from contender generated by recommendataion engine: ` +
        `got ${constructedContender}, expected ${contender}`
    );
  }

  const guideArtifactKeys = new Set(guideArtifacts.map(artifact => artifact.completeKey));
  const inventoryArtifactKeys = new Set(inventoryArtifacts.map(artifact => artifact.completeKey));
  const assemblyStatuses = <ArtifactAssemblyStatusNonMissing[]>[];
  for (const artifact of constructedArtifacts) {
    const key = artifact.completeKey;
    if (guideArtifactKeys.has(key)) {
      assemblyStatuses.push(ArtifactAssemblyStatus.EQUIPPED);
    } else if (artifact.stones.length === 0) {
      // Unstoned artifacts are trivially "assembled".
      assemblyStatuses.push(ArtifactAssemblyStatus.ASSEMBLED);
      continue;
    } else {
      assemblyStatuses.push(
        inventoryArtifactKeys.has(key)
          ? ArtifactAssemblyStatus.ASSEMBLED
          : ArtifactAssemblyStatus.AWAITING_ASSEMBLY
      );
    }
  }

  return {
    artifactSet: constructedSet,
    assemblyStatuses,
  };
}

// Check if a stoned artifact in choices (1) has the specified host item and (2)
// all its stones are within the stonePool. If there are multiple candidates,
// choose one with the most stones.
function findMatchingItem(host: Item, stonePool: Item[], choices: Artifact[]): Artifact | null {
  const hostKey = host.key;
  const stonePoolCounter = new Counter(stonePool.map(s => s.key));
  let match: Artifact | null = null;
  let matchStoneCount = 0;
  for (const choice of choices) {
    if (choice.key !== hostKey || choice.stones.length <= matchStoneCount) {
      continue;
    }
    if (stonePoolCounter.contains(choice.stones.map(s => s.key))) {
      match = choice;
      matchStoneCount = choice.stones.length;
    }
  }
  return match;
}

class Counter<T> {
  counts: Map<T, number>;

  constructor(s: Iterable<T>) {
    this.counts = new Map<T, number>();
    for (const el of s) {
      this.counts.set(el, (this.counts.get(el) ?? 0) + 1);
    }
  }

  contains(c: Counter<T> | Iterable<T>) {
    const counts = c instanceof Counter ? c.counts : new Counter(c).counts;
    for (const [el, count] of counts.entries()) {
      if ((this.counts.get(el) ?? 0) < count) {
        return false;
      }
    }
    return true;
  }
}

// Extract an item from items if it exists (items is updated in place) and
// returns it. Returns null if it doesn't exist.
function extractItem(items: Item[], wantedItem: Item): Item | null {
  const wantedKey = wantedItem.key;
  for (let i = 0; i < items.length; i++) {
    if (items[i].key === wantedKey) {
      const extracted = items[i];
      items.splice(i, 1);
      return extracted;
    }
  }
  return null;
}

export function artifactSetVirtualEarningsMultiplier(
  farm: Farm,
  set: ArtifactSet,
  strategy: PrestigeStrategy,
  modifiers?: Modifiers,
): number {
  const bareFarm = new Farm(farm.backup, farm.farm);
  bareFarm.artifactSet = new ArtifactSet([], false);
  const equippedFarm = new Farm(farm.backup, farm.farm);
  equippedFarm.artifactSet = set;

  const earningBonusMultiplier =
    bareFarm.earningBonus > 0 ? equippedFarm.earningBonus / bareFarm.earningBonus : 1;
  const eggValueMultiplier = set.eggValueMultiplier;
  const eggLayingRateMultiplier = set.eggLayingRateMultiplier;
  const maxRunningChickenBonusMultiplier =
    equippedFarm.maxRunningChickenBonusWithMaxedCommonResearches /
    bareFarm.maxRunningChickenBonusWithMaxedCommonResearches;
  const virtualEarningsMultiplier = set.virtualEarningsMultiplier;

  let totalMultiplier =
    earningBonusMultiplier *
    eggValueMultiplier *
    eggLayingRateMultiplier *
    maxRunningChickenBonusMultiplier *
    virtualEarningsMultiplier;

  switch (strategy) {
    case PrestigeStrategy.STANDARD_PERMIT_SINGLE_PRELOAD:
    case PrestigeStrategy.PRO_PERMIT_SINGLE_PRELOAD:
      totalMultiplier *= set.habSpaceMultiplier * set.boostEffectMultiplier ** 2;
      break;
    case PrestigeStrategy.PRO_PERMIT_MULTI:
      totalMultiplier *= set.internalHatcheryRateMultiplier * set.boostEffectMultiplier ** 3;
      break;
    case PrestigeStrategy.PRO_PERMIT_LUNAR_PRELOAD_AIO:
      totalMultiplier *= set.habSpaceMultiplier * set.boostEffectMultiplier ** 2 * set.awayEarningsMultiplier * (modifiers?.awayEarnings ?? 1)/equippedFarm.maxRunningChickenBonusWithMaxedCommonResearches;
      break;
  }

  return totalMultiplier;
}
