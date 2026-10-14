(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Selection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function idsBetween(orderedIds, anchorId, targetId) {
    const end = orderedIds.indexOf(targetId);
    if (end < 0) return [];
    const start = orderedIds.indexOf(anchorId);
    if (start < 0) return [orderedIds[end]];
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    return orderedIds.slice(from, to + 1);
  }

  function applyClick(orderedIds, selected, anchorId, targetId, mods) {
    const next = new Set(selected);
    let anchor = anchorId;
    if (mods.shift && anchorId) {
      const range = idsBetween(orderedIds, anchorId, targetId);
      if (!mods.toggle) next.clear();
      range.forEach((id) => next.add(id));
    } else if (mods.toggle) {
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      anchor = targetId;
    } else {
      next.clear();
      next.add(targetId);
      anchor = targetId;
    }
    return { selected: next, anchorId: anchor };
  }

  return { idsBetween, applyClick };
});
