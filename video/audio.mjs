/**
 * 生成 promo 片的背景音乐（纯程序合成，无版权素材）。
 * 用法：node video/audio.mjs [--dur=47] → video/out/audio.m4a
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'out')
const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + n + '='))
  return hit === undefined ? d : Number(hit.split('=')[1])
}
const DUR = arg('dur', 47)
const SR = 44100
const N = Math.ceil(DUR * SR)
const L = new Float32Array(N)
const R = new Float32Array(N)

const BPM = 92
const BEAT = 60 / BPM
const BAR = BEAT * 4
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12)
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const n = (s) => {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s)
  return NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12
}

const CHORDS = [
  ['A2', 'A3', 'C4', 'E4'],
  ['F2', 'F3', 'A3', 'C4'],
  ['C3', 'C3', 'E4', 'G4'],
  ['G2', 'G3', 'B3', 'D4'],
]

const add = (i, v, pan) => {
  if (i < 0 || i >= N) return
  const l = Math.cos((pan + 1) * Math.PI / 4)
  const r = Math.sin((pan + 1) * Math.PI / 4)
  L[i] += v * l
  R[i] += v * r
}

// --- pad：四声部和弦，慢起慢落
for (let bar = 0; ; bar++) {
  const t0 = bar * BAR
  if (t0 > DUR) break
  const chord = CHORDS[bar % 4]
  const dur = BAR * 1.35
  const start = Math.floor(t0 * SR)
  const len = Math.floor(dur * SR)
  for (let k = 1; k < chord.length; k++) {
    const f = hz(n(chord[k]))
    const pan = (k - 1.5) * 0.42
    for (let i = 0; i < len; i++) {
      const t = i / SR
      const atk = Math.min(1, t / 0.75)
      const rel = t > dur - 1.1 ? Math.max(0, (dur - t) / 1.1) : 1
      const env = atk * rel * 0.055
      const w = Math.sin(2 * Math.PI * f * t) + 0.34 * Math.sin(2 * Math.PI * f * 2.002 * t) + 0.12 * Math.sin(2 * Math.PI * f * 3.004 * t)
      add(start + i, w * env, pan)
    }
  }
}

// --- 琶音：八分音符，跟随和弦上行
const ARP = [1, 2, 3, 2, 1, 3, 2, 3]
for (let step = 0; step * BEAT * 0.5 < DUR; step++) {
  const bar = Math.floor((step * 0.5) / 4)
  const chord = CHORDS[bar % 4]
  const idx = ARP[step % 8]
  const f = hz(n(chord[idx]) + 12)
  const t0 = step * BEAT * 0.5
  const start = Math.floor(t0 * SR)
  const len = Math.floor(1.15 * SR)
  const vel = 0.075 * (step % 8 === 0 ? 1 : step % 2 === 0 ? 0.78 : 0.55)
  const pan = (step % 2 === 0 ? -0.28 : 0.28)
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = Math.exp(-t * 5.2) * Math.min(1, t / 0.004) * vel
    const w = Math.sin(2 * Math.PI * f * t + 0.9 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t * 9))
    add(start + i, w * env, pan)
  }
}

// --- 低音：每小节第 1 拍
for (let bar = 0; ; bar++) {
  const t0 = bar * BAR
  if (t0 > DUR) break
  const f = hz(n(CHORDS[bar % 4][0]))
  const start = Math.floor(t0 * SR)
  const len = Math.floor(BAR * 0.9 * SR)
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = Math.exp(-t * 1.5) * Math.min(1, t / 0.02) * 0.13
    add(start + i, Math.sin(2 * Math.PI * f * t) * env, 0)
  }
}

// --- 混响：三抽头反馈延迟
const mkReverb = (src, out, delays, fb, damp) => {
  for (const d of delays) {
    const ds = Math.floor(d * SR)
    let lp = 0
    for (let i = ds; i < N; i++) {
      lp = lp + (src[i - ds] - lp) * damp
      out[i] += lp * fb
    }
  }
}
mkReverb(L.slice(), L, [0.031, 0.047, 0.061], 0.33, 0.42)
mkReverb(R.slice(), R, [0.037, 0.053, 0.067], 0.33, 0.42)

// --- 归一化 + 首尾淡入淡出
let peak = 0
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
const gain = peak > 0 ? 0.62 / peak : 1
const fadeIn = 1.4
const fadeOut = 3.0
for (let i = 0; i < N; i++) {
  const t = i / SR
  const e = Math.min(1, t / fadeIn) * Math.min(1, Math.max(0, (DUR - t) / fadeOut))
  L[i] = Math.tanh(L[i] * gain * e * 1.05)
  R[i] = Math.tanh(R[i] * gain * e * 1.05)
}

// --- 写 16bit WAV
const buf = Buffer.alloc(44 + N * 4)
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8)
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22)
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40)
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4)
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4)
}
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'bed.wav'), buf)

await new Promise((resolve, reject) => {
  const c = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, 'bed.wav'),
    '-c:a', 'aac', '-b:a', '192k', path.join(OUT, 'audio.m4a')], { stdio: ['ignore', 'ignore', 'pipe'] })
  let e = ''
  c.stderr.on('data', (d) => { e += String(d) })
  c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(e.slice(-400)))))
})
console.log(JSON.stringify({ m4a: path.join(OUT, 'audio.m4a'), dur: DUR, peak: peak.toFixed(3) }))
