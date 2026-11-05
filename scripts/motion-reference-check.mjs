/** Independent original-renderer fixture vs production SVG raster comparison.
 * node scripts/motion-reference-check.mjs --out /tmp/dsgb-motion-reference [--frames]
 * The fixture is captured from upstream, never synthesized by product code.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return fallback
  return process.argv[idx + 1] || fallback
}

const OUT_DIR = argValue('--out', path.join(os.tmpdir(), 'dsgb-browser'))
const CAPTURE = process.argv.includes('--capture-official')
let officialBundle = null

/** 起一个只读静态服务器，绑定 127.0.0.1 的随机端口。 */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      if (url === '/__official-motion.js' && officialBundle) { res.writeHead(200, {'Content-Type':'text/javascript'}); res.end(officialBundle); return }
      const rel = url === '/' ? '/test/fixtures/motion-comparison.html' : url
      const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''))
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 极简 CDP 客户端：只用 WebSocket 发 Runtime.evaluate / Page.captureScreenshot。 */
async function connect(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000)
  let target = null
  while (Date.now() < deadline) {
    try {
      const list = await fetch('http://127.0.0.1:' + port + '/json/list')
      const items = await list.json()
      target = items.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target !== undefined) break
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 120))
  }
  if (target === null) throw new Error('没有找到可连接的 page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (err) {
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  return { send, close: () => ws.close() }
}


async function main() {
 const sourceURL='https://x.ai/_next/static/chunks/1mp92zs10hzdq.js'
 const expectedHash='d8f547b53e44ea81efcfdd4e4a749ee5f0d077d36e58b521a6ba5beb673c1a41'
 if(CAPTURE){
  const response=await fetch(sourceURL,{signal:AbortSignal.timeout(30000)})
  if(!response.ok)throw Error('Official capture download: '+response.status)
  const raw=await response.text(),hash=createHash('sha256').update(raw).digest('hex')
  if(hash!==expectedHash)throw Error('Upstream changed; review before replacing the oracle: '+hash)
  if(!raw.includes('tW=(0,m.forwardRef)')||!raw.includes('e.s(['))throw Error('Upstream capture anchors changed')
  officialBundle=raw.replace('tW=(0,m.forwardRef)','tW=globalThis.RefRenderer=(0,m.forwardRef)').replace('e.s([','(globalThis.RefData={shapes:tn,eyes:eK,tune:tX,options:t_},e.s)([')
 }
 fs.mkdirSync(OUT_DIR,{recursive:true});const {server,port}=await startServer();const chrome=chromePath();if(!chrome)throw Error('Chrome required');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'dsgb-reference-check-'));const debugPort=9800+Math.floor(Math.random()*100);
 const child=spawn(chrome,['--headless=new','--disable-gpu','--hide-scrollbars','--force-device-scale-factor=1','--remote-debugging-port='+debugPort,'--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--window-size=1000,2000','http://127.0.0.1:'+port+(CAPTURE?'/scripts/reference-capture.html':'/test/fixtures/motion-comparison.html')],{stdio:'ignore'});
 try{
  const cdp=await connect(debugPort);const evaluate=async expression=>{const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  for(let i=0;i<100;i++){try{if(await evaluate(CAPTURE?'!!window.ref':'window.comparisonReady'))break}catch{}await new Promise(r=>setTimeout(r,100))}
  if(CAPTURE){
   const captured=await evaluate(`({bodyPath:RefData.shapes.blob.path,clips:['working','celebrate'].map(state=>{ref.mount(state);return {state,frames:[200,500,800,1200,1500,2000,2400,2800,3200,3600,4000,4400,5000,6000].filter(t=>state==='celebrate'||t<4600).map(t=>{ref.advance(t);return ref.snapshot()})}})})`)
   const result={source:'https://x.ai/news/designing-grok-bot',chunk:sourceURL,chunkSha256:expectedHash,capture:'Original renderer in isolated Chrome, seed=1, size=128, fixed 60Hz RAF, native coordinates, no product imports. Each state independently mounted with lifecycle face tuning.',...captured}
   fs.writeFileSync(path.join(OUT_DIR,'motion-reference.json'),JSON.stringify(result)+'\n');console.log('Captured original renderer to '+OUT_DIR+' (review before updating test fixture)');cdp.close();return
  }
  const results=await evaluate('compareAll()');
  const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:640,height:1800,scale:1}});fs.writeFileSync(path.join(OUT_DIR,'reference-comparison.png'),Buffer.from(shot.data,'base64'));
  fs.writeFileSync(path.join(OUT_DIR,'report.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({total:results.length,failed:results.filter(r=>!r.pass),maxMAE:Math.max(...results.map(r=>r.mae)),out:OUT_DIR},null,2));
  if(process.argv.includes('--frames'))for(const [motion,ms]of [['spin',4600],['orbit',6200]]){
    const dir=path.join(OUT_DIR,motion+'-frames');fs.mkdirSync(dir,{recursive:true});
    for(let frame=0;frame<ms/1000*30;frame++){await evaluate('motionDemo('+JSON.stringify(motion)+','+frame*(1000/30)+')');const shot=await cdp.send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:580,height:260,scale:1}});fs.writeFileSync(path.join(dir,String(frame).padStart(3,'0')+'.png'),Buffer.from(shot.data,'base64'))}
  }
  cdp.close();if(results.some(r=>!r.pass))process.exitCode=1;
 }finally{child.kill('SIGKILL');server.close();fs.rmSync(profile,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
