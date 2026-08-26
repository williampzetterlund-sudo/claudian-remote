// Node `url` shim for the Ignis (browser) build.
'use strict';

function fileURLToPath(input) {
  const href = typeof input === 'string' ? input : input?.href;
  if (!href || !href.startsWith('file://')) {
    return String(href ?? input);
  }
  const url = new URL(href);
  return decodeURIComponent(url.pathname) || '/';
}

function pathToFileURL(path) {
  const encoded = String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(`file://${encoded.startsWith('/') ? '' : '/'}${encoded}`);
}

module.exports = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  domainToASCII: (domain) => String(domain),
  domainToUnicode: (domain) => String(domain),
  format: (url) => String(url?.href ?? url),
  parse: (value) => new URL(value, 'http://localhost/'),
};
module.exports.default = module.exports;
