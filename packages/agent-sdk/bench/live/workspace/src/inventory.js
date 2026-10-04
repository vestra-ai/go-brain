// TODO: load stock levels from the warehouse feed instead of this fixed list.
const stock = { apples: 12, pears: 4 };

// TODO: warn when an item drops below its reorder point.
function inStock(name) {
  return (stock[name] ?? 0) > 0;
}

module.exports = { inStock };
