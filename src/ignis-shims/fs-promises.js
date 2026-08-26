// Node `fs/promises` shim for the Ignis (browser) build: the promise surface
// of the augmented fs shim. The Ignis host registry has no fs/promises entry.
'use strict';

module.exports = require('./fs.js').promises;
module.exports.default = module.exports;
