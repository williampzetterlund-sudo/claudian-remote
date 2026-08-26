// Node `Buffer` shim for the Ignis (browser) build. Ignis ships a Uint8Array
// stand-in whose from()/toString() ignore encodings (base64/hex corrupt), so
// this build injects a real implementation over TypedArray + atob/btoa.
'use strict';

const utf8Encoder = new TextEncoder();

function normalizeEncoding(encoding) {
  const value = String(encoding || 'utf8').toLowerCase();
  if (value === 'utf-8') return 'utf8';
  if (value === 'ucs2' || value === 'ucs-2' || value === 'utf-16le') return 'utf16le';
  if (value === 'binary') return 'latin1';
  return value;
}

function bytesFromString(string, encoding) {
  switch (normalizeEncoding(encoding)) {
    case 'utf8':
      return utf8Encoder.encode(string);
    case 'base64':
    case 'base64url': {
      const normalized = string.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }
    case 'hex': {
      const clean = string.length % 2 === 0 ? string : string.slice(0, -1);
      const bytes = new Uint8Array(clean.length / 2);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16) || 0;
      }
      return bytes;
    }
    case 'latin1':
    case 'ascii': {
      const bytes = new Uint8Array(string.length);
      for (let index = 0; index < string.length; index += 1) {
        bytes[index] = string.charCodeAt(index) & 0xff;
      }
      return bytes;
    }
    case 'utf16le': {
      const bytes = new Uint8Array(string.length * 2);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < string.length; index += 1) {
        view.setUint16(index * 2, string.charCodeAt(index), true);
      }
      return bytes;
    }
    default:
      return utf8Encoder.encode(string);
  }
}

class Buffer extends Uint8Array {
  static from(value, encodingOrOffset, length) {
    if (typeof value === 'string') {
      const bytes = bytesFromString(value, encodingOrOffset);
      return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      return new Buffer(value, encodingOrOffset || 0, length ?? (value.byteLength - (encodingOrOffset || 0)));
    }
    if (ArrayBuffer.isView(value)) {
      const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const copy = new Buffer(source.length);
      copy.set(source);
      return copy;
    }
    if (Array.isArray(value) || typeof value?.length === 'number') {
      const copy = new Buffer(value.length);
      for (let index = 0; index < value.length; index += 1) copy[index] = value[index] & 0xff;
      return copy;
    }
    if (value && typeof value[Symbol.iterator] === 'function') {
      return Buffer.from([...value]);
    }
    throw new TypeError('Unsupported Buffer.from input');
  }

  static alloc(size, fill, encoding) {
    const buffer = new Buffer(size);
    if (fill !== undefined && fill !== 0) {
      if (typeof fill === 'string') {
        const pattern = bytesFromString(fill, encoding);
        for (let index = 0; index < size; index += 1) buffer[index] = pattern[index % pattern.length];
      } else if (typeof fill === 'number') {
        buffer.fill(fill & 0xff);
      }
    }
    return buffer;
  }

  static allocUnsafe(size) {
    return new Buffer(size);
  }

  static allocUnsafeSlow(size) {
    return new Buffer(size);
  }

  static isBuffer(value) {
    return value instanceof Buffer;
  }

  static isEncoding(encoding) {
    return ['utf8', 'base64', 'base64url', 'hex', 'latin1', 'ascii', 'utf16le'].includes(
      normalizeEncoding(encoding),
    );
  }

  static byteLength(value, encoding) {
    if (typeof value === 'string') return bytesFromString(value, encoding).length;
    return value?.byteLength ?? 0;
  }

  static concat(list, totalLength) {
    const total = totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
    const result = new Buffer(total);
    let offset = 0;
    for (const item of list) {
      if (offset >= total) break;
      const slice = item.length + offset > total
        ? item.subarray(0, total - offset)
        : item;
      result.set(slice, offset);
      offset += slice.length;
    }
    return result;
  }

  static compare(a, b) {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? -1 : 1;
  }

  toString(encoding, start, end) {
    const from = start ?? 0;
    const to = end ?? this.length;
    const view = this.subarray(from, to);
    switch (normalizeEncoding(encoding)) {
      case 'utf8':
        return new TextDecoder().decode(view);
      case 'base64':
      case 'base64url': {
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < view.length; offset += chunkSize) {
          binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
        }
        const base64 = btoa(binary);
        return normalizeEncoding(encoding) === 'base64url'
          ? base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
          : base64;
      }
      case 'hex': {
        let hex = '';
        for (const byte of view) hex += byte.toString(16).padStart(2, '0');
        return hex;
      }
      case 'latin1':
      case 'ascii': {
        let text = '';
        for (const byte of view) text += String.fromCharCode(byte);
        return text;
      }
      case 'utf16le':
        return new TextDecoder('utf-16le').decode(view);
      default:
        return new TextDecoder().decode(view);
    }
  }

  slice(start, end) {
    return this.subarray(start, end);
  }

  write(string, offset, length, encoding) {
    let writeOffset = 0;
    let writeEncoding = encoding;
    let maxLength;
    if (typeof offset === 'string') {
      writeEncoding = offset;
    } else if (typeof offset === 'number') {
      writeOffset = offset;
      if (typeof length === 'string') {
        writeEncoding = length;
      } else if (typeof length === 'number') {
        maxLength = length;
      }
    }
    const bytes = bytesFromString(string, writeEncoding);
    const available = this.length - writeOffset;
    const count = Math.min(bytes.length, maxLength ?? available, available);
    this.set(bytes.subarray(0, count), writeOffset);
    return count;
  }

  equals(other) {
    return Buffer.compare(this, other) === 0;
  }

  compare(other) {
    return Buffer.compare(this, other);
  }

  copy(target, targetStart, sourceStart, sourceEnd) {
    const source = this.subarray(sourceStart ?? 0, sourceEnd ?? this.length);
    target.set(source, targetStart ?? 0);
    return source.length;
  }

  indexOf(value, byteOffset) {
    if (typeof value === 'number') return super.indexOf(value, byteOffset);
    const needle = typeof value === 'string' ? bytesFromString(value, 'utf8') : value;
    if (needle.length === 0) return byteOffset ?? 0;
    outer: for (let index = byteOffset ?? 0; index <= this.length - needle.length; index += 1) {
      for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
        if (this[index + needleIndex] !== needle[needleIndex]) continue outer;
      }
      return index;
    }
    return -1;
  }

  includes(value, byteOffset) {
    return this.indexOf(value, byteOffset) !== -1;
  }

  readUInt8(offset = 0) {
    return this[offset];
  }

  readUInt16LE(offset = 0) {
    return new DataView(this.buffer, this.byteOffset).getUint16(offset, true);
  }

  readUInt16BE(offset = 0) {
    return new DataView(this.buffer, this.byteOffset).getUint16(offset, false);
  }

  readUInt32LE(offset = 0) {
    return new DataView(this.buffer, this.byteOffset).getUint32(offset, true);
  }

  readUInt32BE(offset = 0) {
    return new DataView(this.buffer, this.byteOffset).getUint32(offset, false);
  }

  writeUInt8(value, offset = 0) {
    this[offset] = value & 0xff;
    return offset + 1;
  }

  writeUInt32BE(value, offset = 0) {
    new DataView(this.buffer, this.byteOffset).setUint32(offset, value, false);
    return offset + 4;
  }

  writeUInt32LE(value, offset = 0) {
    new DataView(this.buffer, this.byteOffset).setUint32(offset, value, true);
    return offset + 4;
  }

  toJSON() {
    return { type: 'Buffer', data: [...this] };
  }
}

module.exports = {
  Buffer,
  kMaxLength: 0x7fffffff,
  constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffe8 },
  atob: (value) => atob(value),
  btoa: (value) => btoa(value),
};
module.exports.default = module.exports;
