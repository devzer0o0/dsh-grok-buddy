/**
 * 把成片投稿到 B 站。用本地已登录的凭证（~/.dsh/bili-duty/bili_credential.json）。
 * 流程：preupload → 分片 PUT → finish → 封面上传 → 稿件提交
 * 用法：node video/upload.mjs [--dry=1]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'out')
const VIDEO = fs.existsSync(path.join(OUT, 'final.mp4')) ? path.join(OUT, 'final.mp4') : path.join(OUT, 'dsh-grok-buddy-promo.mp4')
const COVER = path.join(OUT, 'cover.png')
const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + n + '='))
  return hit === undefined ? d : hit.slice(n.length + 3)
}
const DRY = arg('dry', '0') === '1'
const TITLE = arg('title', '')
const DESC_FILE = arg('desc', '')
const TID = Number(arg('tid', '232'))
const TAGS = arg('tags', '')
const ORIGINAL = arg('original', '1') === '1'

const credPath = path.join(os.homedir(), '.dsh', 'bili-duty', 'bili_credential.json')
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
const COOKIE = 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + cred.buvid3 + '; DedeUserID=' + cred.dedeuserid
const CSRF = cred.bili_jct
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const j = async (url, init) => {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Cookie: COOKIE, Referer: 'https://member.bilibili.com/', ...(init && init.headers ? init.headers : {}) } })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch (e) { body = { raw: text.slice(0, 300) } }
  return { status: res.status, body }
}

const size = fs.statSync(VIDEO).size
const name = path.basename(VIDEO)

// 1. preupload
const pre = await j('https://member.bilibili.com/preupload?name=' + encodeURIComponent(name) +
  '&size=' + size + '&r=upos&profile=ugcfx/bup&ssl=0', { method: 'GET' })
if (pre.body.code !== undefined && pre.body.code !== 0) { console.error('preupload failed', JSON.stringify(pre.body).slice(0, 400)); process.exit(1) }
const { endpoint, upos_uri, auth, biz_id, chunk_size } = pre.body
console.log(JSON.stringify({ step: 'preupload', endpoint, upos_uri, biz_id, chunk_size, size }))
if (DRY) process.exit(0)

const uploadUrl = 'https:' + endpoint + '/' + upos_uri.replace(/^upos:\/\//, '')
const total = Math.max(1, Math.ceil(size / chunk_size))
const fd = fs.openSync(VIDEO, 'r')
try {
  for (let i = 0; i < total; i++) {
    const startOffset = i * chunk_size
    const len = Math.min(chunk_size, size - startOffset)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, startOffset)
    const res = await fetch(uploadUrl + '?partNumber=' + (i + 1) + '&uploadId=' + encodeURIComponent(biz_id) + '&chunk=' + i + '&chunks=' + total + '&size=' + len + '&start=' + startOffset + '&end=' + (startOffset + len) + '&total=' + size + '&output=json&profile=ugcfx/bup&name=' + encodeURIComponent(name),
      { method: 'PUT', headers: { 'User-Agent': UA, Cookie: COOKIE, 'Content-Type': 'application/octet-stream', 'X-Upos-Auth': auth, Authorization: auth }, body: buf })
    if (!res.ok) { console.error('chunk ' + i + ' failed', res.status, (await res.text()).slice(0, 200)); process.exit(1) }
    if (i % 5 === 0 || i === total - 1) console.log('chunk ' + (i + 1) + '/' + total)
  }
} finally { fs.closeSync(fd) }

// 2. finish
const fin = await j(uploadUrl + '?output=json&name=' + encodeURIComponent(name) + '&profile=ugcfx/bup&uploadId=' + encodeURIComponent(biz_id) + '&biz_id=' + biz_id,
  { method: 'POST', headers: { 'X-Upos-Auth': auth, Authorization: auth } })
console.log(JSON.stringify({ step: 'finish', status: fin.status, body: String(JSON.stringify(fin.body)).slice(0, 300) }))
const filename = fin.body && fin.body.url ? fin.body.url : upos_uri.replace(/^upos:\/\//, '')

// 3. cover
let coverUrl = ''
if (fs.existsSync(COVER)) {
  const form = new FormData()
  form.append('cover', new Blob([fs.readFileSync(COVER)], { type: 'image/png' }), 'cover.png')
  form.append('csrf', CSRF)
  const c = await j('https://member.bilibili.com/x/vu/web/cover/up', { method: 'POST', body: form })
  coverUrl = (c.body && c.body.data && c.body.data.url) || ''
  console.log(JSON.stringify({ step: 'cover', ok: Boolean(coverUrl), body: coverUrl ? coverUrl.slice(0, 80) : String(JSON.stringify(c.body)).slice(0, 300) }))
}

// 4. submit
const desc = DESC_FILE && fs.existsSync(DESC_FILE) ? fs.readFileSync(DESC_FILE, 'utf8') : ''
const payload = {
  videos: [{ filename, title: TITLE.slice(0, 80), desc: '' }],
  cover: coverUrl,
  title: TITLE.slice(0, 80),
  tid: TID,
  tag: TAGS,
  source: 'https://github.com/devzer0o0/dsh-grok-buddy',
  desc,
  copyright: ORIGINAL ? 1 : 2,
  no_reprint: 1,
  open_elec: 0,
  dynamic: '',
}
const sub = await j('https://member.bilibili.com/x/vu/web/add?csrf=' + CSRF,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
console.log(JSON.stringify({ step: 'submit', status: sub.status, body: sub.body }))
