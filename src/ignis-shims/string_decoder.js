// Node `string_decoder` shim for the Ignis (browser) build.
'use strict';

class StringDecoder {
  constructor(encoding) {
    const normalized = String(encoding || 'utf8').toLowerCase().replace('utf8', 'utf-8');
    this._decoder = new TextDecoder(normalized === 'utf-8' ? 'utf-8' : normalized);
  }

  write(buffer) {
    if (typeof buffer === 'string') return buffer;
    return this._decoder.decode(buffer, { stream: true });
  }

  end(buffer) {
    let text = '';
    if (buffer !== undefined) text += this.write(buffer);
    text += this._decoder.decode();
    return text;
  }

  text(buffer) {
    return this.write(buffer);
  }
}

module.exports = { StringDecoder };
module.exports.default = module.exports;
