function shippingCost(weightKg) {
  // TODO: replace the flat rate with the carrier's table.
  return weightKg > 0 ? 4.5 : 0;
}

module.exports = { shippingCost };
