type MapPoint = { id: string; equipment: string; rack: string };

function stableSlot(value: string, slots: number) {
  let hash = 0;
  for (const char of value.trim().toUpperCase())
    hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return hash % slots;
}

// Stable layout slots in the illustration only; never measured plant coordinates.
export function conceptPosition(point: MapPoint) {
  const equipment = point.equipment.trim();
  const rack = point.rack.trim();
  if (!equipment || !rack) return null;
  const zone = stableSlot(equipment, 3);
  const numericRack = /^\d+$/.test(rack) ? Number(rack) : 0;
  const row =
    numericRack > 0 && Number.isSafeInteger(numericRack)
      ? (numericRack - 1) % 5
      : stableSlot(rack, 5);
  const offset = stableSlot(point.id, 5) - 2;
  return {
    x: 257 + zone * 100 + row * 31 + offset * 3,
    y: 119 + zone * 25 - row * 13 + offset * 3,
  };
}

export function visibleMapPoints<T extends MapPoint>(
  points: T[],
  selectedId: string,
) {
  const located = points.filter((point) => conceptPosition(point));
  if (selectedId) return located.filter((point) => point.id === selectedId);
  return [...located].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 12);
}
