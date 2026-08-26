// `ws` package shim for the Ignis (browser) build: the native browser
// WebSocket in ws-package clothing. Server-side classes fail loudly.
'use strict';

const BrowserWebSocket = globalThis.WebSocket;

class WebSocketServer {
  constructor() {
    throw new Error('ws.WebSocketServer is not available in the Ignis build');
  }
}

module.exports = BrowserWebSocket;
module.exports.WebSocket = BrowserWebSocket;
module.exports.WebSocketServer = WebSocketServer;
module.exports.Server = WebSocketServer;
module.exports.createWebSocketStream = () => {
  throw new Error('ws.createWebSocketStream is not available in the Ignis build');
};
module.exports.default = BrowserWebSocket;
