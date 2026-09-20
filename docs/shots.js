/*
 * Regenerates the screenshots in docs/images.
 *
 * Drives a real browser over the DevTools protocol rather than posing the shots by hand,
 * so they can be taken again whenever the interface moves and never quietly go out of
 * date. Each shot names the state it wants; the ones that want a detail are clipped to an
 * element rather than shrunk.
 *
 *   node serve.js 8099                        (in another terminal)
 *   node docs/shots.js [disk] [port]
 *
 * The disk is any .hfe or .img in this folder - the shots just need something on screen,
 * and a program with a few keygroups makes the better picture. It defaults to the bench
 * disk, which is not in this repository: see .gitignore.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');

var DISK = process.argv[2] || 'DSKA0000-bench.hfe';
var PORT = process.argv[3] || '8099';
var OUT = path.join(__dirname, 'images');
var CHROME = process.env.CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

var WIDTH = 1500, HEIGHT = 940;
var nextId = 1;

function rpc(ws, method, params) {
  var id = nextId++;
  return new Promise(function (resolve, reject) {
    var onMsg = function (ev) {
      var m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) reject(new Error(method + ': ' + m.error.message));
      else resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}

function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function shoot(ws) {
  function evaluate(body) {
    return rpc(ws, 'Runtime.evaluate',
      { expression: '(function(){var d=document,w=window;' + body + '}())',
        returnByValue: true, awaitPromise: true })
      .then(function (r) {
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      });
  }

  /** Polls rather than waits: under a virtual clock timers outrun the real file reading. */
  function until(test, tries) {
    tries = tries === undefined ? 200 : tries;
    return evaluate('return !!(' + test + ');').then(function (ok) {
      if (ok) return true;
      if (tries <= 0) throw new Error('gave up waiting for: ' + test);
      return pause(100).then(function () { return until(test, tries - 1); });
    });
  }

  function save(name, selector) {
    var shot = selector
      ? evaluate("var r=d.querySelector('" + selector + "').getBoundingClientRect();" +
                 'return {x:Math.round(r.left),y:Math.round(r.top),' +
                 'width:Math.round(r.width),height:Math.round(r.height)};')
      : Promise.resolve(null);

    return shot.then(function (box) {
      var params = box ? { clip: { x: box.x, y: box.y, width: box.width,
                                   height: box.height, scale: 1 } } : {};
      return rpc(ws, 'Page.captureScreenshot', params);
    }).then(function (r) {
      var file = path.join(OUT, name + '.png');
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('  ' + name + '.png  ' + (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
    });
  }

  var steps = [
    function () { return rpc(ws, 'Page.enable'); },
    function () { return rpc(ws, 'Page.navigate', { url: 'http://localhost:' + PORT + '/index.html' }); },
    function () { return pause(1500); },
    function () { return until("d.getElementById('intro')"); },
    function () { return save('intro'); },

    // load the disk and open the first program, which opens on its first keygroup
    function () {
      return evaluate(
        "fetch('" + DISK + "').then(function(b){return b.arrayBuffer();}).then(function(buf){" +
        "var dt=new DataTransfer();dt.items.add(new File([buf],'" + DISK + "'));" +
        "d.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));});" +
        'return true;');
    },
    function () { return until("d.querySelectorAll('nav .item').length"); },
    function () { return evaluate("d.querySelectorAll('nav .item')[0].click();return true;"); },
    function () { return until("(d.getElementById('keygroups').tBodies[0]||{rows:[]}).rows.length"); },
    function () { return pause(900); },
    function () { return save('overview'); },

    // several keygroups at once
    function () {
      return evaluate(
        "var rows=d.getElementById('keygroups').tBodies[0].rows;" +
        "function hit(n,m){rows[n].dispatchEvent(new MouseEvent('click'," +
        'Object.assign({bubbles:true,cancelable:true},m||{})));}' +
        'hit(1);hit(4,{shiftKey:true});hit(7,{ctrlKey:true});return true;');
    },
    function () { return pause(600); },
    function () { return save('multi-select', '#kgWrap'); },

    // the keyboard taking a key range
    function () {
      return evaluate(
        "d.getElementById('keygroups').tBodies[0].rows[2].click();" +
        "d.getElementById('kgSetRange').click();" +
        "var p=d.getElementById('piano'),b=p.getBoundingClientRect();" +
        "function at(fx,type){p.dispatchEvent(new MouseEvent(type,{bubbles:true," +
        'clientX:b.left+b.width*fx,clientY:b.top+b.height*0.78}));}' +
        "at(0.30,'mousedown');at(0.52,'mousemove');return true;");
    },
    function () { return pause(600); },
    function () { return save('key-range', '#piano'); },
    function () {
      return evaluate("d.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));" +
                      'return true;');
    },

    // the loop finder, on a sample - the first one in the Samples group, which is a
    // played note rather than the test tones a bench disk keeps at the end
    function () {
      return evaluate(
        "var groups=d.querySelectorAll('nav details');" +
        'for (var i=0;i<groups.length;i++) {' +
        '  var head=groups[i].querySelector(\x27summary\x27);' +
        '  if (!head || !/^Samples/.test(head.textContent)) continue;' +
        '  var first=groups[i].querySelector(\x27.item\x27);' +
        '  if (first) { first.click(); return true; }' +
        '}' +
        "var items=d.querySelectorAll('nav .item');items[items.length-1].click();return true;");
    },
    function () { return until("!d.getElementById('waveWrap').hidden"); },
    function () { return evaluate("d.getElementById('opLoop').click();return true;"); },
    function () { return until("/match/.test(d.getElementById('lpSummary').textContent)"); },
    function () { return pause(400); },
    function () { return save('find-loop', '#loopDlg'); },
    function () { return evaluate("d.getElementById('lpCancel').click();return true;"); },

    // slicing a break: a sample that actually has hits in it, if the disk has one
    function () {
      return evaluate(
        "var groups=d.querySelectorAll('nav details');" +
        'for (var g=0;g<groups.length;g++) {' +
        '  var head=groups[g].querySelector(\x27summary\x27);' +
        '  if (!head || !/^Samples/.test(head.textContent)) continue;' +
        '  var items=groups[g].querySelectorAll(\x27.item\x27);' +
        '  for (var i=0;i<items.length;i++)' +
        '    if (/AMEN|BREAK|DRUM|LOOP/i.test(items[i].textContent)) { items[i].click(); return true; }' +
        '}' +
        'return true;');
    },
    function () { return until("!d.getElementById('waveWrap').hidden"); },
    function () { return pause(500); },
    function () { return evaluate("d.getElementById('opSlice').click();return true;"); },
    function () { return until("d.getElementById('sliceDlg').open"); },
    function () { return pause(1200); },
    function () { return save('slice', '#sliceDlg'); },
    function () { return evaluate("d.getElementById('slCancel').click();return true;"); }
  ];

  console.log('writing to ' + OUT);
  return steps.reduce(function (chain, step) { return chain.then(step); }, Promise.resolve())
              .then(function () { ws.close(); });
}

function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  var chrome = require('child_process').spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=' + WIDTH + ',' + HEIGHT,
    '--remote-debugging-port=9222',
    '--user-data-dir=' + path.join(os.tmpdir(), 'akai-shots')
  ], { stdio: 'ignore' });

  var done = pause(2500)
    .then(function () { return fetch('http://127.0.0.1:9222/json'); })
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var page = list.filter(function (t) { return t.type === 'page'; })[0];
      var ws = new WebSocket(page.webSocketDebuggerUrl);
      return new Promise(function (r) { ws.addEventListener('open', function () { r(ws); }); });
    })
    .then(shoot);

  return done.then(function () { chrome.kill(); },
                   function (e) { chrome.kill(); throw e; });
}

main().then(function () { console.log('done'); process.exit(0); },
            function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
