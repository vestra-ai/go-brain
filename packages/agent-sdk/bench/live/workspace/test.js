const { add, multiply } = require('./src/math.js');

if (add(2, 3) !== 5 || add(-1, 1) !== 0 || multiply(3, 4) !== 12) {
  console.error('FAIL');
  process.exit(1);
}
console.log('ok');
