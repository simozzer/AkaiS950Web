/*
 * A static server for this folder. The app works from file:// as well, but a
 * server is handy for testing and for anyone who wants to host it.
 *
 *   node serve.js [port]        default 8080
 */
var http = require('http');
var fs = require('fs');
var path = require('path');

var port = parseInt(process.argv[2], 10) || 8080;
var root = __dirname;

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.hfe': 'application/octet-stream',
  '.img': 'application/octet-stream'
};

http.createServer(function (req, res) {
  var rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  var file = path.join(root, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (file.indexOf(root) !== 0) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // Editing and reloading is the whole workflow here; a cached script would
      // silently test the previous version.
      'Cache-Control': 'no-store, must-revalidate'
    });
    res.end(data);
  });
}).listen(port, function () {
  console.log('serving ' + root + ' on http://localhost:' + port + '/');
});
