// Cart totals for the shop.
function computeTotal(items, discount = 0.15) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return Math.round(subtotal * (1 - discount) * 100) / 100;
}

module.exports = { computeTotal };
