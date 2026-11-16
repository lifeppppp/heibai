'use strict'
/* ============================================================================
 *  文字击穿 —— 可移植的 2D 文字物理骨架
 *  ---------------------------------------------------------------------------
 *  这个文件不依赖任何库、不用 fetch、不用 ES module，所以从 file:// 直接打开
 *  （双击 index.html）就能跑，压缩包换台电脑解压照样能跑。
 *
 *  想改的东西都在 CFG 里：文字内容、字号、重力、爆炸力度、回弹刚度、配乐路径。
 * ========================================================================== */

const CFG = {
  // —— 文字内容 ——
  line: '深度求索',
  hero: '击',
  ambient: '求索者不畏路远星光不负赶路人夜以继日',
  fontFamily: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
  lineSize: 72,
  tracking: 22,
  heroScale: 1.45,
  title: '文字击穿',
  subtitle: '点击开始',

  // —— 物理：掉落与爆散 ——
  gravity: 2600,        // px/s²
  scatterSpeed: 900,    // 爆散初速上限（越远的字越接近这个值）
  scatterUpBias: 0.45,  // 向上偏置
  damping: 1.6,         // 速度指数衰减
  spin: 0.0022,         // 水平速度 → 自转

  // —— 物理：弹回原位（弹簧阻尼）——
  springK: 26,
  springC: 7.5,

  // —— 求解段：精确停在中心 ——
  smoothTime: 0.42,

  // —— 节奏 ——
  introTime: 0.55,
  impactHold: 0.07,
  ambientDelay: 0.45,
  ambientCount: 24,

  // —— 配乐（相对路径：整个文件夹搬走也不会断）——
  // 多首就按顺序排队，播完自动接下一首；只有一首时无限循环。
  musicTracks: ['audio/bgm.mp3'],
  musicVolume: 0.45,
}

/* 内容层：content.js 里的 CONTENT 会覆盖上面这些同名项。
   game.js 里的是"兜底默认值"，正常情况下你只需要改 content.js。 */
if (typeof CONTENT === 'object' && CONTENT) {
  for (const key of ['title', 'subtitle', 'line', 'hero', 'ambient', 'musicTracks', 'musicVolume']) {
    if (CONTENT[key] !== undefined) CFG[key] = CONTENT[key]
  }
}

/* ============================ 工具 ============================ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const rand = (a, b) => a + Math.random() * (b - a)
const easeOut = (k) => 1 - Math.pow(1 - k, 3)
// 缓入缓出：镜头起势和收势都要慢，中段匀速，"拉远"才不会像被猛地推了一下
const easeInOut = (k) => k * k * (3 - 2 * k)

// Unity 的 SmoothDamp：收敛到精确目标，速度连续、不过冲
function smoothDamp(cur, target, vel, smoothTime, dt) {
  const omega = 2 / Math.max(0.0001, smoothTime)
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = cur - target
  const temp = (vel + omega * change) * dt
  const nvel = (vel - omega * temp) * exp
  return [target + (change + temp) * exp, nvel]
}

/* ============================ 画布 ============================ */

const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
let W = 0, H = 0, DPR = 1

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1)
  W = canvas.clientWidth
  H = canvas.clientHeight
  canvas.width = Math.floor(W * DPR)
  canvas.height = Math.floor(H * DPR)
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  layout()
}

/* ============================ 主体 ============================ */
/* 物理只认下面这些字段，主体长什么样由 drawGlyph() 决定。 */

function body(ch, x, y, size) {
  return {
    ch, x, y, size,
    vx: 0, vy: 0,
    rot: 0, rotVel: 0,
    alpha: 1,
    scale: 1,
    homeX: x, homeY: y,
    alive: true,
    floatPhase: rand(0, Math.PI * 2),
    floatAmp: rand(3, 9),
    tint: rand(0, 1),
  }
}

const S = {
  mode: 'title',        // title | intro | play
  phase: 'in',          // intro 内部相位
  t: 0,
  paused: false,
  cx: 0, cy: 0,
  line: [],
  field: [],
  fallers: [],
  waves: [],
  flash: 0,
  curtain: 0,
  fade: null,
  heroSize: 0,
  fps: 0,
  error: null,
  // 本次演出的内容（可被 startIntro({line, hero}) 覆盖，不写死配置）
  lineText: CFG.line,
  heroChar: CFG.hero,
  ambientText: CFG.ambient,
  onDone: null,
}

function measureWidths(chars, size) {
  ctx.font = `600 ${size}px ${CFG.fontFamily}`
  return chars.map((c) => ctx.measureText(c).width)
}

function totalWidth(widths, tracking) {
  return widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * tracking
}

const MIN_LINE_SIZE = 20      // 低于这个字号就不硬缩了，改成换行
const LINE_HEIGHT = 1.35

// 让这行字在任何屏宽、任何长度下都完整可见：
// 用二分找"放得下的最大字号"（逐字实测宽度、算上字距）；
// 缩到下限还放不下才均分成几行。
function fitsAt(chars, size, maxW) {
  return totalWidth(measureWidths(chars, size), CFG.tracking) <= maxW
}

function fitLine(chars, maxW, startSize) {
  const hiStart = Math.min(CFG.lineSize, startSize)
  if (fitsAt(chars, hiStart, maxW)) return { size: hiStart, lines: [chars] }

  let lo = 12
  let hi = hiStart
  let best = 0
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (fitsAt(chars, mid, maxW)) { best = mid; lo = mid } else { hi = mid }
  }
  if (best >= MIN_LINE_SIZE) return { size: best, lines: [chars] }

  // 单行缩到下限仍放不下 → 均分成 k 行，再按最宽那行定字号
  const totalAtFloor = totalWidth(measureWidths(chars, MIN_LINE_SIZE), CFG.tracking)
  const k = Math.min(6, Math.max(2, Math.ceil(totalAtFloor / maxW)))
  const per = Math.ceil(chars.length / k)
  const lines = []
  for (let i = 0; i < chars.length; i += per) lines.push(chars.slice(i, i + per))

  let size = MIN_LINE_SIZE
  for (let i = 0; i < 6; i++) {
    const widest = Math.max(...lines.map((l) => totalWidth(measureWidths(l, size), CFG.tracking)))
    if (widest <= maxW) break
    size = Math.max(12, size * (maxW / widest))
  }
  // 还有余量就再往上顶到刚好放得下
  if (size === MIN_LINE_SIZE) {
    let s = MIN_LINE_SIZE
    let hiS = Math.min(CFG.lineSize, startSize * 2)
    for (let i = 0; i < 12; i++) {
      const mid = (s + hiS) / 2
      const widest = Math.max(...lines.map((l) => totalWidth(measureWidths(l, mid), CFG.tracking)))
      if (widest <= maxW) s = mid
      else hiS = mid
    }
    size = s
  }
  return { size, lines }
}

// 在给定字号下把这串字切成若干行（超宽才切）
function wrapAt(chars, size, maxW) {
  const total = totalWidth(measureWidths(chars, size), CFG.tracking)
  if (total <= maxW) return [chars]
  const k = Math.min(8, Math.max(2, Math.ceil(total / maxW)))
  const per = Math.ceil(chars.length / k)
  const out = []
  for (let i = 0; i < chars.length; i += per) out.push(chars.slice(i, i + per))
  return out
}

function layout() {
  S.cx = W / 2
  S.cy = H * 0.52

  // 那一排字。换行符是"真的换行"（分段），不是当一个字去排。
  const margin = Math.max(16, W * 0.05)
  const maxW = W - margin * 2
  const paragraphs = String(S.lineText).split('\n')

  // 先给每段各自算一个"放得下的字号"，取最小的那个当统一字号
  let size = CFG.lineSize
  for (const p of paragraphs) {
    const chars = [...p]
    if (!chars.length) continue
    const fitted = fitLine(chars, maxW, W / (chars.length + 2.2))
    size = Math.min(size, fitted.size)
  }
  S.heroSize = size * CFG.heroScale

  const lines = []
  for (const p of paragraphs) {
    const chars = [...p]
    if (!chars.length) { lines.push([]); continue }     // 空行保留成行间距
    for (const l of wrapAt(chars, size, maxW)) lines.push(l)
  }

  const lineH = size * LINE_HEIGHT
  const blockH = lineH * lines.length
  S.line = []
  lines.forEach((lineChars, li) => {
    if (!lineChars.length) return
    const widths = measureWidths(lineChars, size)
    const total = totalWidth(widths, CFG.tracking)
    let x = S.cx - total / 2
    const y = S.cy - blockH / 2 + lineH * (li + 0.5)
    for (let i = 0; i < lineChars.length; i++) {
      const w = widths[i]
      const b = body(lineChars[i], x + w / 2, y, size)
      b.alpha = 0
      S.line.push(b)
      x += w + CFG.tracking
    }
  })

  // 周围环境字：环绕中心，各自弹回自己的家
  // 位置用"拒绝采样"摊开，避免字叠字；字符池打乱后取，尽量不重复。
  S.field = []
  const pool = [...new Set([...S.ambientText])]     // 去重：同屏不出现同一个字
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const maxR = Math.min(W, H) * 0.46
  const count = Math.min(CFG.ambientCount, pool.length)   // 不超过字符池大小，避免同屏重字
  for (let i = 0; i < count; i++) {
    const bsize = size * rand(0.42, 0.72)
    const minGap = bsize * 1.55
    let pos = null
    for (let k = 0; k < 30; k++) {
      const a = (i / count) * Math.PI * 2 + rand(-0.35, 0.35)
      const r = rand(150, maxR)
      const x = S.cx + Math.cos(a) * r
      const y = S.cy + Math.sin(a) * r
      if (S.field.every((o) => Math.hypot(o.x - x, o.y - y) > minGap)) { pos = { x, y }; break }
    }
    if (!pos) continue          // 这个尺寸放不下就少放一个，不硬叠
    const b = body(pool[i % pool.length], pos.x, pos.y, bsize)
    b.alpha = 0
    b.delay = rand(0, 0.9)
    S.field.push(b)
  }
}

/* ============================ 渲染主体 ============================ */
/* 换主体只需要改这一个函数：fillText ↔ drawImage。物理完全不用动。 */

function drawGlyph(b, color, glow) {
  if (b.alpha <= 0.001 || !b.alive) return
  // glow 参数保留只为兼容旧调用；美术方向已定：字不发光
  ctx.save()
  ctx.globalAlpha = b.alpha
  ctx.translate(b.x, b.y)
  ctx.rotate(b.rot)
  ctx.scale(b.scale, b.scale)
  ctx.font = `600 ${b.size}px ${CFG.fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(b.ch, 0, 0)
  ctx.restore()
}

/* ============================ 物理 ============================ */

// 爆散冲量：从落点向外。
// 注意这里没用"越近推得越猛"的经典衰减 —— 因为没有刚体互撞，近处的字飞太快
// 会追上前面的字、叠成一团。改成"越远推得越快"，整行被从落点向外拉开，
// 视觉上才是真正的"爆炸扩散"。
function blast(ox, oy, list, scale = 1) {
  let maxD = 1
  for (const b of list) if (b.alive) maxD = Math.max(maxD, Math.hypot(b.x - ox, b.y - oy))
  for (const b of list) {
    if (!b.alive) continue
    const dx = b.x - ox
    const dy = b.y - oy
    const d = Math.hypot(dx, dy) || 1
    const t = clamp(d / maxD, 0, 1)
    const speed = CFG.scatterSpeed * (0.30 + 0.70 * Math.pow(t, 0.7)) * rand(0.94, 1.06) * scale
    b.vx += (dx / d) * speed
    b.vy += (dy / d) * speed - speed * CFG.scatterUpBias
    b.rotVel += b.vx * CFG.spin + rand(-1.2, 1.2)
  }
}

// 环境字：弹簧拉回家 + 阻尼。这是"散开后慢慢收回来"的来源。
function stepField(b, dt) {
  const damp = Math.exp(-CFG.springC * dt)
  b.vx += (b.homeX - b.x) * CFG.springK * dt
  b.vy += (b.homeY - b.y) * CFG.springK * dt
  b.vx *= damp
  b.vy *= damp
  b.x += b.vx * dt
  b.y += b.vy * dt
  b.rot += b.rotVel * dt
  b.rotVel *= Math.exp(-3 * dt)
}

/* ============================ 开场序列 ============================ */

// 可编程接口：换一段演出内容不用改代码
//   playImpact({ line:'天地玄黄', hero:'破', ambient:'…', onDone(){ … } })
function startIntro(opts = {}) {
  if (typeof opts.line === 'string') S.lineText = opts.line
  if (typeof opts.hero === 'string') S.heroChar = opts.hero
  if (typeof opts.ambient === 'string') S.ambientText = opts.ambient
  S.onDone = typeof opts.onDone === 'function' ? opts.onDone : null
  S.doneFired = false

  S.mode = 'intro'
  S.phase = 'in'
  S.t = 0
  S.flash = 0
  S.waves.length = 0
  S.fallers.length = 0
  S.fallY = undefined
  S.fallVy = undefined
  S.heroY = undefined
  S.heroVy = undefined
  layout()
}

function updateIntro(dt) {
  S.t += dt
  const p = S.phase

  if (p === 'in') {
    const k = clamp(S.t / CFG.introTime, 0, 1)
    const e = easeOut(k)
    for (const b of S.line) { b.alpha = e; b.y = b.homeY + (1 - e) * 18 }
    if (k >= 1) { S.phase = 'fall'; S.t = 0 }
    return
  }

  if (p === 'fall') {
    // 纯物理：自由落体（用一个坠字主体代替，命中后切求解段）
    S.fallY = (S.fallY ?? -H * 0.45) + (S.fallVy = (S.fallVy ?? 0) + CFG.gravity * dt) * dt
    if (S.fallY >= S.cy + S.heroSize * 0.4) {
      S.phase = 'impact'
      S.t = 0
      S.flash = 1
      S.waves.push({ x: S.cx, y: S.cy, r: 10, a: 1, w: 3 })
      blast(S.cx, S.cy, S.line, 1)
      S.heroY = S.fallY
      S.heroVy = S.fallVy
    }
    return
  }

  if (p === 'impact') {
    S.flash = Math.max(0, 1 - S.t / CFG.impactHold)
    for (const w of S.waves) { w.r += 900 * dt; w.a = Math.max(0, w.a - dt * 6) }
    if (S.t >= CFG.impactHold) { S.phase = 'scatter'; S.t = 0; S.flash = 0 }
    return
  }

  if (p === 'scatter') {
    const damp = Math.exp(-CFG.damping * dt)
    let alive = 0
    for (const b of S.line) {
      if (!b.alive) continue
      b.vx *= damp
      b.vy = b.vy * damp + CFG.gravity * 0.55 * dt
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.rot += b.rotVel * dt
      b.alpha = Math.max(0, 1 - S.t / 1.15)
      if (b.y > H + 260 || b.x < -320 || b.x > W + 320 || b.alpha <= 0) b.alive = false
      else alive++
    }
    for (const w of S.waves) { w.r += 620 * dt; w.a = Math.max(0, w.a - dt * 2.2) }

    // 求解段：坠字从穿透点收敛回精确中心
    const [ny, nvy] = smoothDamp(S.heroY, S.cy, S.heroVy, CFG.smoothTime, dt)
    S.heroY = ny
    S.heroVy = nvy

    if (alive === 0 && Math.abs(S.heroVy) < 8) { S.phase = 'settle'; S.t = 0 }
    if (S.t > 3) { S.phase = 'settle'; S.t = 0 }
    return
  }

  if (p === 'settle') {
    const [ny, nvy] = smoothDamp(S.heroY, S.cy, S.heroVy, CFG.smoothTime, dt)
    S.heroY = ny
    S.heroVy = nvy
    for (const w of S.waves) { w.r += 420 * dt; w.a = Math.max(0, w.a - dt * 2.4) }
    if (Math.abs(S.heroVy) < 1 && S.t > CFG.smoothTime) {
      S.heroY = S.cy      // 吸附到精确中心，不留零点几像素的余量
      S.heroVy = 0
      S.phase = 'ambient'
      S.t = 0
    }
    return
  }

  if (p === 'ambient') {
    const base = Math.max(0, S.t - CFG.ambientDelay)
    for (const b of S.field) {
      const k = clamp((base - b.delay) / 1.1, 0, 1)
      b.alpha = easeOut(k) * (b.tint > 0.6 ? 0.5 : 0.32)
    }
    if (S.t > CFG.ambientDelay + 2.2) {
      S.mode = 'play'     // 交给玩法层
      S.t = 0
      if (S.onDone && !S.doneFired) { S.doneFired = true; S.onDone() }
    }
  }
}

/* ============================ 玩法层 ============================ */
/* 这里现在是"可玩的最小内核"：点哪，字就砸哪，周围文字被炸开再慢慢弹回。
   你的真正玩法替换 spawnFaller / updatePlay 即可，物理和渲染都能直接复用。 */

function spawnFaller(x, y) {
  const pool = [...S.lineText].filter((c) => c.trim())   // 别把换行/空格当坠落字
  S.spawned = (S.spawned || 0) + 1      // 累计生成数，给耐久测试和调试用
  S.fallers.push({
    ch: pool[Math.floor(rand(0, pool.length))],
    x,
    y: -S.heroSize,
    vy: 200,
    targetY: y,
    size: S.heroSize * rand(0.7, 1.05),
    rot: 0,
    rotVel: rand(-2.2, 2.2),
  })
}

function updatePlay(dt) {
  for (const b of S.field) stepField(b, dt)

  for (const f of S.fallers) {
    f.vy += CFG.gravity * dt
    f.y += f.vy * dt
    f.rot += f.rotVel * dt
    if (f.y >= f.targetY) {
      f.done = true
      S.flash = 0.7
      S.waves.push({ x: f.x, y: f.targetY, r: 8, a: 1, w: 3 })
      blast(f.x, f.targetY, S.field, 1)
    }
  }
  S.fallers = S.fallers.filter((f) => !f.done && f.y < H + 200)

  for (const w of S.waves) { w.r += 780 * dt; w.a = Math.max(0, w.a - dt * 2.8) }
  S.waves = S.waves.filter((w) => w.a > 0.01)
  S.flash = Math.max(0, S.flash - dt * 3)
}

/* ============================ 渲染 ============================ */

function render() {
  // 每帧把画布状态复位：任何一次 save/restore 失衡都会让 globalAlpha 卡在低位，
  // 于是背景清屏变成"半透明擦除"，画面上就会留下上一层字的残影。
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'

  // 纯黑背景，不留任何灯光/渐变
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, H)

  if (S.mode === 'act0') return renderAct0()
  if (S.mode === 'room') { renderRoom(); drawRoomHint(); drawA0Sub(); drawTip(); return }
  if (S.mode === 'desk') return renderDesk()
  if (S.mode === 'title') return renderTitle()
  if (S.mode === 'act2') return renderAct2()
  if (S.mode === 'act3') return renderAct3()
  if (S.mode === 'act4') return renderFinal()
  if (S.mode === 'act5') return renderAct5()
  if (S.mode === 'act6') return renderAct6()
  if (S.mode === 'act1') return renderAct1()

  // 周围环境字
  const now = performance.now() / 1000
  for (const b of S.field) {
    if (b.alpha <= 0.001) continue
    const fy = Math.sin(now * 0.5 + b.floatPhase) * b.floatAmp
    drawGlyph({ ...b, y: b.y + fy }, 'rgba(140,170,220,1)')
  }

  // 那行字
  for (const b of S.line) drawGlyph(b, 'rgba(220,232,255,1)')

  // 冲击波
  for (const w of S.waves) {
    ctx.save()
    ctx.globalAlpha = w.a * 0.5
    ctx.strokeStyle = 'rgba(150,200,255,1)'
    ctx.lineWidth = w.w
    ctx.beginPath()
    ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // 玩法层的坠落字
  for (const f of S.fallers) {
    drawGlyph({ x: f.x, y: f.y, rot: f.rot, size: f.size, alpha: 0.95, alive: true, ch: f.ch, scale: 1 },
      'rgba(235,246,255,1)', 'rgba(120,200,255,0.85)')
  }

  // 开头那个坠字：淡入阶段还不存在，落下来之后才登场，此后常驻中心
  if (S.mode === 'play' || (S.mode === 'intro' && S.phase !== 'in')) {
    const y = S.phase === 'fall' ? S.fallY : (S.heroY ?? S.cy)
    drawGlyph({ x: S.cx, y, rot: 0, size: S.heroSize, alpha: 1, alive: true, ch: S.heroChar, scale: 1 },
      'rgba(235,246,255,1)', 'rgba(120,200,255,0.9)')
  }

  // 碰撞闪光：从落点向外衰减的辉光，而不是整屏刷白（整屏刷白会把画面洗成灰板）
  if (S.flash > 0.001) {
    const R = Math.max(W, H) * 0.62
    const fg = ctx.createRadialGradient(S.cx, S.cy, 0, S.cx, S.cy, R)
    fg.addColorStop(0, `rgba(205,228,255,${0.55 * S.flash})`)
    fg.addColorStop(0.12, `rgba(140,185,255,${0.22 * S.flash})`)
    fg.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = fg
    ctx.fillRect(0, 0, W, H)
  }

  // HUD
  if (S.mode === 'play') {
    const hud = pickHudText()
    ctx.save()
    ctx.shadowColor = 'rgba(7,8,12,0.95)'   // 深色描边，压在环境字上也读得清
    ctx.shadowBlur = 10
    ctx.fillStyle = 'rgba(130,150,180,0.9)'
    ctx.font = `${hud.size}px ui-monospace,Consolas,monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(hud.text, W / 2, H - Math.max(18, Math.min(26, H * 0.032)))
    ctx.restore()
  }

}

/* 过场黑幕：必须画在所有模式之后（各 renderXxx 都是 return 提前退出，
   写在 render() 末尾根本执行不到 → 所以挪到 frame() 里统一画）。 */
function drawCurtain() {
  if (S.curtain <= 0.001) return
  ctx.save()
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.globalAlpha = clamp(S.curtain, 0, 1)
  ctx.fillStyle = '#05060a'
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
}

/* 底部提示在小窗/竖屏里会顶出屏幕，按宽度自动降级：长句 → 短句 → 极简，再不行缩字号 */
const HUD_VARIANTS = [
  '点击任意位置：一个字从天而降，砸开周围的字　·　R 重播开场　·　M 静音',
  '点击任意位置 · R 重播开场 · M 静音',
  '点击 · R 重播 · M 静音',
]
const HUD_MAX = 13
const HUD_MIN = 10

function pickHudText() {
  const maxW = W - 32
  for (const text of HUD_VARIANTS) {
    for (let size = HUD_MAX; size >= HUD_MIN; size--) {
      ctx.font = `${size}px ui-monospace,Consolas,monospace`
      if (ctx.measureText(text).width <= maxW) return { text, size }
    }
  }
  return { text: HUD_VARIANTS[HUD_VARIANTS.length - 1], size: HUD_MIN }
}

function renderTitle() {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // 标题也不发光：黑底白字
  ctx.fillStyle = 'rgba(255,255,255,1)'
  ctx.font = `700 ${Math.min(96, W / 8)}px ${CFG.fontFamily}`
  ctx.fillText(CFG.title, S.cx, S.cy - 30)

  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.font = `400 ${Math.min(22, W / 26)}px ${CFG.fontFamily}`
  ctx.fillText(CFG.subtitle, S.cx, S.cy + 60)

  ctx.fillStyle = 'rgba(80,95,120,0.8)'
  ctx.font = '12px ui-monospace,Consolas,monospace'
  ctx.fillText('建议戴耳机 · M 静音', S.cx, S.cy + 108)
}

/* ============================ 配乐 ============================ */
/* 多音轨：CFG.musicTracks 里按顺序排队，播完一首自动接下一首，播完最后一首回到第一首。
   只有一首时退化成无限循环。加歌 = 把 mp3 丢进 audio/ 再往数组里加一行。 */

const bgm = document.getElementById('bgm')
const badge = document.getElementById('badge')
let muted = false
let audioBroken = false
let trackIndex = 0

function trackLabel() {
  const n = CFG.musicTracks.length
  return n > 1 ? ` (${trackIndex + 1}/${n})` : ''
}

// 所有路径都相对于本文件夹，浏览器从 file:// 打开也能找到
function loadTrack(i) {
  audioBroken = false
  // 单文件版（黑白.html）里 <audio> 已内联 data URI，别用相对路径覆盖掉
  const inlineSrc = bgm.getAttribute("src") || ""
  if (!inlineSrc.startsWith("data:")) {
    bgm.src = CFG.musicTracks[i % CFG.musicTracks.length]
  }
  bgm.loop = CFG.musicTracks.length === 1   // 多首时靠 ended 事件接力，不能 loop
  bgm.volume = CFG.musicVolume
}
loadTrack(0)

function setBadge(text, on) {
  if (!badge) return
  badge.textContent = text
  badge.className = 'badge' + (on ? '' : ' off')
}

// 浏览器不允许无交互自动播放：第一次点击/按键时才真正开始
function startMusic() {
  if (!bgm) return
  bgm.play().then(
    () => setBadge('♪ 播放中' + trackLabel(), true),
    (err) => {
      // 换了电脑/浏览器拦住了，或用户还没换掉示例音轨
      // 若本身就是文件缺失，别用"未播放"覆盖掉"音轨缺失"这条更有用的提示
      if (audioBroken) return
      setBadge('♪ 未播放（点一下页面）', false)
      console.warn('[music] 播放被拦下：', err && err.message)
    },
  )
}

// 一首放完就接下一首
bgm.addEventListener('ended', () => {
  if (CFG.musicTracks.length <= 1) return
  trackIndex = (trackIndex + 1) % CFG.musicTracks.length
  loadTrack(trackIndex)
  if (!muted) startMusic()
})

function toggleMute() {
  muted = !muted
  bgm.muted = muted
  setBadge(muted ? '♪ 已静音' : '♪ 播放中' + trackLabel(), !muted)
}

bgm.addEventListener('error', () => {
  // 音乐文件缺失/损坏时不要让整个游戏挂掉
  audioBroken = true
  setBadge('♪ 音轨缺失：' + CFG.musicTracks[trackIndex % CFG.musicTracks.length], false)
})

/* ============================ 状态切换 ============================ */

function startGame(auto) {
  startIntro()
  if (!auto) startMusic()
}

/* ============================ 第一章 第一幕 ============================ */
/* 分镜（按大纲 + 第一轮反馈）：
 *   ① 正上方逐字打出：「谨以此作，纪念长征中运输队的同志」（节奏放慢）
 *   ② 「我」从上方落下，击穿这行字——这行字不消失，而是被撞得稍微散开
 *   ③ 散开的字像浮上水面一样，慢慢浮到屏幕上六分之一处，成为上下隔断
 *   ④ 「我」停在屏幕正中，字号 / 明暗与其它字完全一致（纯白、无发光）
 *   ⑤ 「我」的上下慢慢浮出一列名字（暂用「无名氏」占位），列顶不越过那行字
 */

const ACT1 = {
  dedication: '谨以此作，纪念长征中运输队的同志',
  hero: '我',
  nameText: '无名氏',
  typeInterval: 0.32,      // 每个字的间隔（放慢）
  holdAfterType: 4.0,      // 打完字之后停多久，才让「我」落下来
  commaPause: 1.0,          // 打到逗号处停多久
  holdAfterSettle: 2.0,    // 「我」停稳之后再等多久，名字才浮现
  lineStartRatio: 0.235,   // 打字时那行字的位置
  dividerRatio: 1 / 6,     // 最终浮到 1/6 处
  lineFontRatio: 0.044,
  nameFontRatio: 0.026,
  nameGapRatio: 1.55,      // 名字行距 = 字号 × 1.55（排得更密 → 队列更长）
  nameFade: 1.8,           // 单个名字淡入用时（0.9 × 2，整体放慢一倍）
  nameStaggerRatio: 1 / 6, // 下一个名字在上一个进场 1/6 的时间点就进来（不等它演完）
  // —— 名字全部出现后，两侧画出道路（俯视）——
  roadDelay: 0.5,          // 名字出完后等多久开始画
  roadGrowTime: 2.6,       // 从中间向两端长满需要多久
  roadAlpha: 0.72,         // 路比人名暗一点，别抢注意力
  roadGapRatio: 1.7,       // 路与名字列之间的留白（按字号）
  // —— 道路铺到尽头后：视角拉远 ——
  zoomDelay: 0.6,          // 路铺完后等多久开始拉远
  zoomTime: 9.0,           // 整段拉远用时
  zoomEnd: 0.222,          // 最终缩放：太小会成一条白线；0.222 正好让最终行数落在 80 行
  extraFade: 0.8,          // 新补出来的名字淡入用时
  extraGapFill: 0.92,      // 补行时留的余量（1 = 铺满到边界）
  ringSpeed: 300,          // 圆环扩散速度（px/秒）
  ringDelay: 2.5,         // 拉远到最远后停 2.5 秒再出圆环
  ringPad: 220,            // 环形扩散到画面外还有多少余量
  ringWidth: 26,           // 圆环线宽
  squareLife: 0.5,         // 变成白方块后存活多久
  roadTailRatio: 1.16,     // 道路尾巴延伸到哪里（>1 = 越过屏幕下缘，看不到尽头）
  // —— 拉远时出现的两侧像素山（和名字共用一套镜头，所以缩得一样快）——
  // 每座山都在表里写死："拉远结束时它该出现在画面哪个位置"，代码再除以 zoomEnd 倒推世界坐标。
  //   side  = -1 左 / +1 右
  //   depth = 远近（0 最近，画在最上层；2 最远，先画，会被近山挡掉一角）
  //   dx    = 结束时山的内边离中心多远（占半屏宽的比例）
  //   y     = 结束时山脚在哪（占画面高的比例；<1 = 浮在画面里）
  //   block = 结束时方块多大（像素）；peak = 峰高几块
  // 15 座：远层浮在上半部负责填顶部，中层接腰，近层压在下半部当地面。
  mountainSpots: [
    // 左：4 座 —— 越大越靠中间，越小越靠边，相邻两座的水平间隔拉大
    { side: -1, depth: 2, dx: 0.86, y: 0.24, block: 5.6, peak: [11, 14] },
    { side: -1, depth: 1, dx: 0.62, y: 0.44, block: 7.6, peak: [12, 15] },
    { side: -1, depth: 1, dx: 0.40, y: 0.64, block: 7.2, peak: [11, 14] },
    { side: -1, depth: 0, dx: 0.30, y: 0.88, block: 11.0, peak: [13, 17] },
    // 右：5 座 —— 与左边错开一档，避免左右镜像
    { side: 1, depth: 2, dx: 0.90, y: 0.18, block: 5.6, peak: [10, 13] },
    { side: 1, depth: 2, dx: 0.66, y: 0.36, block: 5.2, peak: [9, 12] },
    { side: 1, depth: 1, dx: 0.44, y: 0.54, block: 7.4, peak: [12, 15] },
    { side: 1, depth: 0, dx: 0.34, y: 0.74, block: 10.8, peak: [13, 16] },
    { side: 1, depth: 0, dx: 0.52, y: 0.94, block: 10.0, peak: [12, 15] },
  ],
  mountainSpread: 1.0,         // 水平位置系数（1 = 按表里的 dx）
  mountainStackGap: 26,        // 同侧上下相邻两座之间的空隙（px）
  mountainGapMul: 1.5,         // 空隙再乘 1.5（= 山与山之间间距 1.5 倍）
  mountainBaseEdge: 1.03,      // 最下面那座的山脚落在画面高的几倍处
  cloudAlpha: 0.16,            // 云的透明度（透明但看得见）
  cloudDrift: 9,               // 云左右漂移幅度（px）
  mountainSizeScale: 1.5,      // 山的大小回到"原大小"（= 1.5 倍基准）
  mountainLift: 0.06,          // 整体上抬，让山浮起来填住上方黑区
  mountainHeightScale: 0.7,    // 山高压缩（1 = 原始峰高；太高的山会把画面压满）
  settleTime: 0.55,        // 「我」聚到中心
  burstSpeed: 90,          // 被撞散时每个字的初速（要"稍微"，不能炸飞）
  burstUpBias: -0.30,      // 负数 = 略微往下压，像被砸下去
  floatK: 6.5,             // 浮回 1/6 的弹簧刚度（越小越慢）
  floatC: 3.4,             // 浮动的阻尼
  nameList: null,
}

// 内容层覆盖：content.js 里的 act1 段优先于上面的默认值
if (typeof CONTENT === 'object' && CONTENT && CONTENT.act1) {
  const c1 = CONTENT.act1
  if (typeof c1.dedication === 'string') ACT1.dedication = c1.dedication
  if (typeof c1.hero === 'string') ACT1.hero = c1.hero
  if (typeof c1.nameText === 'string') ACT1.nameText = c1.nameText
  if (Array.isArray(c1.names) && c1.names.length) ACT1.nameList = c1.names
}

const A1 = {
  phase: 'type',           // type → fall → impact → names → hold
  t: 0,
  shown: 0,
  typeHold: 0,
  commaDone: false,
  commaIndex: -1,
  settleT: 0,
  lineSize: 30,
  nameSize: 20,
  heroSize: 20,            // 与名字同号
  lineChars: [],           // 那行字：逐字实体
  names: [],
  heroY: 0,
  heroVy: 0,
  namesT: 0,
  shake: 0,
  particles: [],           // 撞击时的小爆炸粒子
  burst: false,
  roadRows: [],            // 两侧道路：每行一组符号
  roadT: 0,                // 道路生长的计时（只在 hold 阶段累加）
  roadLeftX: 0,
  roadRightX: 0,
  // —— 视角拉远 ——
  zoom: 1,                 // 当前整体缩放（1 → 0.1）
  zoomT: 0,
  halfAbove: 0,            // 原始队列中心到最上一行（未缩放）
  halfBelow: 0,            // 原始队列中心到最下一行（未缩放）
  extra: [],               // 拉远时补出来的新名字（屏幕坐标）
  extraTop: 0,             // 已经补到哪一行（上方）
  extraBottom: 0,          // 已经补到哪一行（下方）
  roadTail: [],            // 名字到底之后，路继续往下延伸出画面的那几行
  mountains: [],           // 两侧的像素山
  clouds: [],              // 山旁边的云（半透明）
  cloudT: 0,
  mountainPx: 56,          // 世界坐标里的方块边长（按屏幕算出来的）
}

// 道路符号：以竖线为主，偶尔出现斜线/括号/点缀，形成"大体笔直、局部自然过渡"
function roadSymbol(prev) {
  const r = Math.random()
  if (r < 0.62) return '|'
  if (r < 0.74) return '/'
  if (r < 0.86) return '\\'
  if (r < 0.90) return '{'
  if (r < 0.94) return '}'
  if (r < 0.97) return '*'
  return Math.random() < 0.5 ? '+' : '：'
}

// 一列符号：斜线会带一点点横向偏移，看起来像路在微微拐弯
function makeRoadColumn(n) {
  const col = []
  for (let i = 0; i < n; i++) {
    const sym = roadSymbol()
    const dx = sym === '/' ? 0.16 : sym === '\\' ? -0.16 : 0
    col.push({ sym, dx })
  }
  return col
}

/* ============================ 两侧的像素山 ============================ */
/* 山不是贴在屏幕上的装饰，它和名字在同一张地图上：
 *     屏幕位置 = 画面中心 + 世界坐标 × zoom
 *     屏幕大小 = 世界大小 × zoom
 * 所以镜头拉远时，山缩小的速度和名字完全一致，整幅画才读成"镜头在往后退"，
 * 而不是"字在缩、山在旁边自己滑"。
 * 每座山独立生成：峰位、山形、雪线、岩层都不同，而且中间留缝、互不重叠。
 */

// 固定种子的伪随机：每座山的长相稳定，刷新页面不会变
function seededRandom(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 山形：一条从左山脚爬到峰顶、再落到右山脚的脊线，可以有 1~2 个峰
// 峰顶留一段平台 + 最后把单列尖刺削掉 → 山是钝的、有肩的，不是尖锥
function mountainRidge(cols, peak, rnd) {
  const pts = [{ t: 0, v: 0.2 + rnd() * 0.12 }]          // 左山脚
  const p1t = 0.3 + rnd() * 0.16                         // 主峰位置
  const p1h = 0.9 + rnd() * 0.1                          // 主峰高度（相对 peak）
  const f1 = 0.08 + rnd() * 0.06                         // 峰顶平台半宽（宽一点才钝）
  pts.push({ t: Math.max(0.1, p1t - f1), v: p1h })
  pts.push({ t: Math.min(0.62, p1t + f1), v: p1h })
  if (cols >= 10 && rnd() < 0.75) {
    const vt = p1t + 0.2 + rnd() * 0.08                  // 山坳
    const p2t = Math.min(0.86, vt + 0.16 + rnd() * 0.08)
    const p2h = 0.62 + rnd() * 0.24                      // 次峰
    const f2 = 0.06 + rnd() * 0.04
    pts.push({ t: vt, v: 0.46 + rnd() * 0.12 })
    pts.push({ t: p2t - f2, v: p2h })
    pts.push({ t: p2t + f2, v: p2h })
  }
  pts.push({ t: 1, v: 0.18 + rnd() * 0.1 })              // 右山脚

  const h = []
  for (let i = 0; i < cols; i++) {
    const t = cols > 1 ? i / (cols - 1) : 0
    let k = 0
    while (k < pts.length - 2 && t > pts[k + 1].t) k++
    const a = pts[k]
    const b = pts[k + 1]
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t)
    h.push(Math.round((a.v + (b.v - a.v) * u) * peak))
  }
  // 几处台阶式错动：山脊不该是一条光滑的斜线（峰顶那几列不动，免得长出尖刺）
  const nTerr = 3 + (rnd() < 0.5 ? 1 : 0)
  for (let k = 0; k < nTerr; k++) {
    const start = 1 + Math.floor(rnd() * Math.max(1, cols - 3))
    const len = 1 + Math.floor(rnd() * 3)
    const d = rnd() < 0.5 ? 1 : -1
    for (let i = start; i < Math.min(cols, start + len); i++) {
      if (h[i] < peak - 1) h[i] += d
    }
  }
  for (let i = 0; i < cols; i++) h[i] = clamp(h[i], 1, peak)
  // 削掉单列尖刺：一列比别人高出两格以上就压低，山才不会长成针
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < cols - 1; i++) {
      const side = Math.max(h[i - 1], h[i + 1])
      if (h[i] - side >= 2) h[i] = side + 1
    }
  }
  // 山脚两侧各垫两列碎石坡：山像"长在地上"，不是被切下来的方块
  const foot = rnd() < 0.5 ? [1, 2] : [2, 1]
  h.unshift(foot[0], foot[1])
  h.push(foot[1], foot[0])
  return h
}

// 明暗：迎光坡亮、背光坡暗、峰顶压雪；山体上再撒几块零散的岩块/裂缝
function mountainShading(h, rnd) {
  const cols = h.length
  const top = Math.max(...h)
  // 先抹一遍再求斜率，否则一列一列的取整跳变会让亮暗面变成棋盘格
  const smooth = h.map((v, i) => {
    const a = h[Math.max(0, i - 1)]
    const b = h[Math.min(cols - 1, i + 1)]
    return (a + v + b) / 3
  })
  const face = []
  const snow = []
  const markFlag = []
  for (let i = 0; i < cols; i++) {
    const prev = smooth[Math.max(0, i - 1)]
    const next = smooth[Math.min(cols - 1, i + 1)]
    face.push(next - prev > 0.2 ? 0 : next - prev < -0.2 ? 2 : 1)   // 0 亮面 / 1 中调 / 2 暗面
    // 雪冠：贴着山顶压 2~3 块，越往下越薄；雪线故意咬得参差，不是一条等高线
    let s = 0
    if (h[i] >= 4) {
      const d = top - h[i]
      s = d <= 1 ? 3 : d <= 3 ? 2 : d <= 5 ? 1 : 0
      if (s > 0 && rnd() < 0.3) s -= 1
    }
    snow.push(Math.min(s, h[i]))
    // 山体上的零散岩块 / 裂缝：故意画得稀，太密就成噪点了
    let mark = 0
    if (h[i] > 4) {
      const r = rnd()
      mark = r < 0.16 ? 2 : r < 0.46 ? 1 : 0
    }
    markFlag.push(mark)
  }
  // 岩层所在的"第几块"：整座山共用一条，横向才能连起来
  const bandRow = Math.max(2, Math.round(top * (0.42 + rnd() * 0.1)))
  return { face, snow, mark: markFlag, bandRow }
}

// 摆山：按 ACT1.mountainSpots 里"结束时该出现的位置"倒推世界坐标。
// 山和名字同一套镜头，所以只要把"结束时刻的屏幕位置"除以 zoomEnd 就得到世界坐标；
// 镜头拉远时它们自然从画面外滑进来，落位正好填住道路两旁。
// 分三层：同一层里留缝不打架，不同层**允许重叠**——画的时候远的先画、近的后画，
// 于是远山的山脚被近山挡掉一角，才有"一层压一层"的真实山峦感。
function buildMountains() {
  A1.mountains = []
  const zEnd = ACT1.zoomEnd
  const cy = H / 2
  const halfW = W / 2
  let seed = 0x51a2c3
  for (const side of [-1, 1]) {
    const list = []
    for (const sp of ACT1.mountainSpots) {
      if (sp.side !== side) continue                     // 表里已经写明左右，别两边都生成一遍
      const rnd = seededRandom(seed++)
      const ridgeCols = 14 + Math.floor(rnd() * 6)      // 更宽、更钝，不是尖锥
      const peakBase = sp.peak[0] + Math.floor(rnd() * (sp.peak[1] - sp.peak[0] + 1))
      const peak = Math.max(3, Math.round(peakBase * ACT1.mountainHeightScale))
      const h = mountainRidge(ridgeCols, peak, rnd)
      const shade = mountainShading(h, rnd)
      const block = sp.block * ACT1.mountainSizeScale * (1 + (rnd() - 0.5) * 0.12)
      list.push({
        side, depth: sp.depth,
        innerWant: sp.dx * halfW * ACT1.mountainSpread * (1 + (rnd() - 0.5) * 0.08),   // 想要的内边位置（屏幕 px）
        baseFinal: 0,   // 山脚位置由后面的「叠放」统一算，表里的 y 只作参考
        block,
        cols: h.length, h,
        face: shade.face, snow: shade.snow, mark: shade.mark, bandRow: shade.bandRow,
        widthFinal: h.length * block,
      })
    }
    // 同一层内横向排开留缝；不同层故意让它重叠
    const byDepth = new Map()
    for (const m of list) {
      if (!byDepth.has(m.depth)) byDepth.set(m.depth, [])
      byDepth.get(m.depth).push(m)
    }
    // 每座山单独处理：太大就按屏幕缩一缩；位置按 dx 定。
    // 允许外侧露出画面（山本来就连着画外），但要保证至少 55% 在屏内，别整座跑没。
    for (const m of list) {
      const maxW = halfW * 1.9
      if (m.widthFinal > maxW) {
        const k = maxW / m.widthFinal
        m.block *= k
        m.widthFinal *= k
      }
      const maxInner = halfW - m.widthFinal * 0.35
      m.innerFinal = Math.min(m.innerWant, maxInner)
      if (m.innerFinal < 10) m.innerFinal = 10
    }

    // 竖直方向叠放：大的在下、小的在上，山脚/山顶依次相扣，中间留出固定空隙。
    // 空隙目标 = mountainStackGap × mountainGapMul，但若总高放不下会自动收紧（保证不飞出画面）。
    const stack = [...list].sort((a, b) => Math.max(...b.h) * b.block - Math.max(...a.h) * a.block)
    const heights = stack.map((m) => Math.max(...m.h) * m.block)
    const totalH = heights.reduce((s, v) => s + v, 0)
    const avail = H * ACT1.mountainBaseEdge
    const wantGap = ACT1.mountainStackGap * ACT1.mountainGapMul
    const fitGap = stack.length > 1 ? (avail - totalH) / (stack.length - 1) : wantGap
    const gap = Math.max(2, Math.min(wantGap, fitGap))
    let edge = avail
    for (let i = 0; i < stack.length; i++) {
      stack[i].baseFinal = edge
      edge -= heights[i] + gap
    }
    for (const m of list) {
      m.near = m.innerFinal / zEnd                    // 世界坐标：离中心多远
      m.px = m.block / zEnd                           // 世界坐标：一个方块多大
      m.baseY = cy + (m.baseFinal - cy) / zEnd        // 世界坐标：山脚高度
      delete m.innerWant
      delete m.innerFinal
      delete m.baseFinal
      delete m.widthFinal
      buildMountainSprite(m)
      A1.mountains.push(m)
    }
  }
  buildClouds()
  // 远的先画、近的后画（同层按横向位置），这样近山会盖住远山的山脚
  A1.mountains.sort((a, b) => b.depth - a.depth || a.side - b.side || a.near - b.near)
}

// 把一座山预渲染成"1 像素 = 1 格"的精灵图。
// 之后整座山按连续的 zoom 放大（最近邻），所以缩小时是平滑的，
// 不会因为"方块边长取整"而整座山一格一格地跳。
function buildMountainSprite(m) {
  const top = Math.max(...m.h)
  const cv = document.createElement('canvas')
  cv.width = m.cols
  cv.height = top
  const g = cv.getContext('2d')
  const faceColor = [MTN.lit, MTN.mid, MTN.shadow]
  const lowColor = [MTN.litLow, MTN.midLow, MTN.shadowLow]
  const snowColor = [MTN.snowLit, MTN.snowLit, MTN.snowShade]
  for (let i = 0; i < m.cols; i++) {
    const blocks = m.h[i]
    const f = m.face[i]
    const yTop = top - blocks
    g.fillStyle = faceColor[f]
    g.fillRect(i, yTop, 1, blocks)
    // 下半截压一档
    const split = top - Math.max(1, Math.round(blocks * 0.55))
    g.fillStyle = lowColor[f]
    g.fillRect(i, split, 1, top - split)
    // 雪冠
    const sn = Math.min(m.snow[i], blocks)
    if (sn > 0) {
      g.fillStyle = snowColor[f]
      g.fillRect(i, yTop, 1, sn)
    } else if (f === 0) {
      g.fillStyle = MTN.rim
      g.fillRect(i, yTop, 1, 1)
    }
    // 岩块 / 裂缝：只是暗一点的石头，别做成"洞"
    if (m.mark[i] && m.bandRow < blocks - sn) {
      g.fillStyle = f === 2 ? MTN.rockDark : MTN.rock
      g.fillRect(i, top - (m.bandRow + 1), 1, m.mark[i])
    }
    // 山脚压深：贴地处比山体暗得多，山才不会像浮在黑底上
    g.fillStyle = f === 2 ? MTN.footDark : MTN.foot
    g.fillRect(i, top - 1, 1, 1)
  }
  m.sprite = cv
  m.topH = top
}

// 一座山此刻在屏幕上的矩形。drawMountains 和回归测试共用这一份计算，
// 所以测试能直接验"缩得平不平滑"。
function mountainRect(m) {
  const z = A1.zoom
  const s = m.px * z                       // 一个方块在屏幕上多少像素（可以是小数！）
  const w = m.cols * s
  const hh = m.topH * s
  const inner = m.near * z
  return {
    s,
    x: S.cx + (m.side < 0 ? -inner - w : inner),
    y: (H / 2) + (m.baseY - H / 2) * z - hh,
    w,
    h: hh,
  }
}

function layoutAct1() {
  // 找到题记里的第一个逗号，打字到那里要停一下
  A1.commaIndex = ACT1.dedication.search(/[，,、]/)
  A1.nameSize = Math.round(clamp(H * ACT1.nameFontRatio, 12, 26))
  A1.heroSize = A1.nameSize                       // 与其它字同号
  A1.lineSize = Math.round(clamp(H * ACT1.lineFontRatio, 14, 46))

  const margin = Math.max(16, W * 0.05)
  const maxW = W - margin * 2
  const startY = H * ACT1.lineStartRatio
  const homeY = H * ACT1.dividerRatio

  // 那行字：算出能放下的一行字号，再逐字定位
  // 字距按字号比例算（全局 CFG.tracking 是给早期 72px 演示用的，套这里会散得不像话）
  const chars = [...ACT1.dedication]
  let size = A1.lineSize
  let track = Math.max(1.5, size * 0.12)
  for (let i = 0; i < 8; i++) {
    const ws = measureWidths(chars, size)
    const total = ws.reduce((a, b) => a + b, 0) + (chars.length - 1) * track
    if (total <= maxW) break
    size = Math.max(12, size * (maxW / total))
    track = Math.max(1.5, size * 0.12)
  }
  A1.lineSize = size

  const widths = measureWidths(chars, size)
  const total = widths.reduce((a, b) => a + b, 0) + (chars.length - 1) * track
  let x = S.cx - total / 2
  A1.lineChars = chars.map((ch, i) => {
    const w = widths[i]
    const cx0 = x + w / 2
    x += w + track
    return { ch, x: cx0, y: startY, homeX: cx0, homeY, vx: 0, vy: 0, rot: 0, rotVel: 0, size }
  })

  // 名字槽：以「我」为中心，按同一行距上下排；上界永远卡在那行字下面
  const cy = H / 2
  const gap = A1.nameSize * ACT1.nameGapRatio
  const stagger = ACT1.nameFade * ACT1.nameStaggerRatio   // 进场节奏 = 淡入时长 / 6
  const topLimit = homeY + A1.lineSize * 0.5 + 2   // 贴到那行字的下边缘（留 2px），不越线也不用空着
  const bottomLimit = H * 0.96
  const above = []
  const below = []
  for (let k = 1; ; k++) {
    const y = cy - k * gap
    if (y - A1.nameSize * 0.5 < topLimit) break
    above.push(y)                        // 由近到远
  }
  for (let k = 1; ; k++) {
    const y = cy + k * gap
    if (y + A1.nameSize * 0.5 >= bottomLimit) break
    below.push(y)
  }

  // 出现顺序：①「我」上方最近的一个 ②「我」下方最近的一个 ③其余随机
  // 间隔一律等于 nameStagger，不加抖动 —— 像说话一样匀速
  const aboveRest = [...above]      // 用拷贝做 shift，别把原始数组掏空（后面还要建槽位）
  const belowRest = [...below]
  const order = []
  if (aboveRest.length) order.push(aboveRest.shift())
  if (belowRest.length) order.push(belowRest.shift())
  const rest = [...aboveRest, ...belowRest]
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  order.push(...rest)

  const delayOf = new Map()
  order.forEach((y, k) => delayOf.set(y, k * stagger))

  const slots = [...above, ...below].sort((a, b) => a - b)
  A1.names = slots.map((y, i) => ({
    y, alpha: 0, delay: delayOf.get(y) ?? i * stagger,
    text: ACT1.nameList ? String(ACT1.nameList[i % ACT1.nameList.length]) : ACT1.nameText,
  }))

  // 两侧道路：与人名同排、等长，横向让开名字列
  ctx.font = `400 ${A1.nameSize}px ${CFG.fontFamily}`
  const nameW = ctx.measureText(ACT1.nameText).width
  const gapX = A1.nameSize * ACT1.roadGapRatio
  A1.roadLeftX = S.cx - nameW / 2 - gapX
  A1.roadRightX = S.cx + nameW / 2 + gapX
  const n = slots.length
  A1.roadRows = []
  if (n > 0) {
    const leftCol = makeRoadColumn(n)
    const rightCol = makeRoadColumn(n)
    for (let i = 0; i < n; i++) {
      A1.roadRows.push({ y: slots[i], left: leftCol[i], right: rightCol[i] })
    }
  }

  // 记录原始队列的半高（拉远时用来算"缩放后还剩多少空间"）
  A1.halfAbove = slots.length ? cy - Math.min(...slots) : 0
  A1.halfBelow = slots.length ? Math.max(...slots) - cy : 0
  A1.nameWidth = nameW
  A1.topLimit = topLimit
  A1.bottomLimit = bottomLimit

  // 两侧像素山：和名字共用同一套镜头（世界坐标），这里只生成山形与排位
  buildMountains()
}

function startAct1(auto) {
  try { stopMarchAudio() } catch (e) {}
  try { if (A2_FIGHT.crowds) A2_FIGHT.crowds.forEach(c => c.pause()); A2_FIGHT.crowds = []; A2_FIGHT.crowd = null; A2_FIGHT.on = false } catch (e) {}
  S.mode = 'act1'
  S.paused = false
  S.error = null
  layoutAct1()
  A1.phase = 'type'
  A1.t = 0
  A1.shown = 0
  A1.typeHold = 0
  A1.commaDone = false
  A1.settleT = 0
  A1.namesT = 0
  A1.heroY = -A1.heroSize * 2
  A1.heroVy = 0
  A1.shake = 0
  A1.particles = []
  A1.roadT = 0
  A1.zoom = 1
  A1.zoomT = 0
  A1.extra = []
  A1.roadTail = []
  A1.cloudT = 0
  A1.heroHit = {}
  A1.ringOn = false
  A1.holdT = 0
  A1.ringR = 0
  A1.ringT = 0
  A1.blackT = 0
  A1.burst = false
  if (!auto) startMusic()
}

/* 拉远时，把缩放后空出来的上下区域补满新名字（含延伸的道路） */
function growExtraRows(dt) {
  const z = A1.zoom
  const gap = A1.nameSize * ACT1.nameGapRatio * z
  if (gap < 0.6) return
  const cy = H / 2
  const halfAbove = A1.halfAbove * z
  const halfBelow = A1.halfBelow * z
  const bands = [
    { dir: -1, edge: A1.topLimit },
    { dir: 1, edge: A1.bottomLimit },
  ]
  for (const band of bands) {
    const inner = cy + band.dir * (band.dir < 0 ? halfAbove : halfBelow)
    const span = Math.abs(band.edge - inner) * ACT1.extraGapFill
    const want = Math.max(0, Math.floor(span / gap))
    let have = 0
    for (const e of A1.extra) if (e.dir === band.dir) have++
    for (let j = have + 1; j <= want; j++) {
      const symL = roadSymbol()
      const symR = roadSymbol()
      A1.extra.push({
        dir: band.dir, j,
        y: inner + band.dir * j * gap,
        text: ACT1.nameList
          ? String(ACT1.nameList[(j * 7 + (band.dir < 0 ? 3 : 11)) % ACT1.nameList.length])
          : ACT1.nameText,
        left: { sym: symL, dx: symL === '/' ? 0.16 : symL === '\\' ? -0.16 : 0 },
        right: { sym: symR, dx: symR === '/' ? 0.16 : symR === '\\' ? -0.16 : 0 },
        alpha: 0,
      })
    }
    // 已有行按当前几何重排并淡入
    for (const e of A1.extra) {
      if (e.dir !== band.dir) continue
      e.y = inner + band.dir * e.j * gap
      e.alpha = Math.min(1, e.alpha + dt / ACT1.extraFade)
    }
  }

  // 道路尾巴：从"最后一个名字行"的下一个行距接着往下排，一直延伸出画面
  // （用真实的末行位置，不要用 bottomLimit —— 补行有 0.92 的余量，直接接会在中间留一个洞）
  const innerB = cy + halfBelow
  const wantB = Math.max(0, Math.floor(Math.abs(A1.bottomLimit - innerB) * ACT1.extraGapFill / gap))
  const tailBase = innerB + wantB * gap
  const tailEnd = H * ACT1.roadTailRatio
  const tailWant = Math.max(0, Math.floor((tailEnd - tailBase) / gap))
  for (let j = A1.roadTail.length + 1; j <= tailWant; j++) {
    const symL = roadSymbol()
    const symR = roadSymbol()
    A1.roadTail.push({
      j,
      y: 0,
      left: { sym: symL, dx: symL === '/' ? 0.16 : symL === '\\' ? -0.16 : 0 },
      right: { sym: symR, dx: symR === '/' ? 0.16 : symR === '\\' ? -0.16 : 0 },
      alpha: 0,
    })
  }
  for (const t of A1.roadTail) {
    t.y = tailBase + t.j * gap
    t.alpha = Math.min(1, t.alpha + dt / ACT1.extraFade)
  }
}

// 撞击时的小爆炸：一圈白色小粒子四散，不是发光，是碎屑
function spawnParticles(x, y) {
  const count = 52
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand(-0.18, 0.18)
    const sp = rand(55, 300)
    A1.particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp * 0.85 - rand(0, 60),   // 稍微往上甩一点
      life: rand(0.28, 0.72),
      t: 0,
      size: rand(1.2, 3),
    })
  }
}

// 撞击：把那行字朝外轻轻推开（不炸飞），随后靠弹簧浮回 1/6
function burstLine(ox, oy) {
  for (const c of A1.lineChars) {
    const dx = c.x - ox
    const dy = c.y - oy
    const d = Math.hypot(dx, dy) || 1
    const sp = ACT1.burstSpeed * rand(0.6, 1.25)
    c.vx += (dx / d) * sp
    c.vy += (dy / d) * sp - sp * ACT1.burstUpBias
    c.rotVel += rand(-1.0, 1.0)
  }
  A1.burst = true
}

function updateAct1(dt) {
  A1.t += dt
  const cy = H / 2

  if (A1.phase === 'type') {
    // 逗号处停一下再继续打
    if (A1.typeHold > 0) { A1.typeHold -= dt; return }
    const before = Math.floor(A1.shown)
    A1.shown = Math.min(ACT1.dedication.length, A1.shown + dt / ACT1.typeInterval)
    const after = Math.floor(A1.shown)
    const comma = A1.commaIndex
    if (!A1.commaDone && comma >= 0 && before <= comma && after > comma) {
      A1.shown = comma + 1
      A1.typeHold = ACT1.commaPause
      A1.commaDone = true
      return
    }
    if (A1.shown >= ACT1.dedication.length) { A1.phase = 'wait'; A1.t = 0 }
    return
  }

  if (A1.phase === 'wait') {
    if (A1.t >= ACT1.holdAfterType) { A1.phase = 'fall'; A1.t = 0 }
    return
  }

  if (A1.phase === 'fall') {
    A1.heroVy += CFG.gravity * dt
    A1.heroY += A1.heroVy * dt
    if (A1.heroY >= A1.lineChars[0]?.y ?? H * ACT1.lineStartRatio) {
      A1.heroY = H * ACT1.lineStartRatio
      A1.phase = 'impact'
      A1.t = 0
      A1.shake = 1
      spawnParticles(S.cx, A1.heroY)
      burstLine(S.cx, A1.heroY)
    }
    return
  }

  // impact / names / hold
  const [ny, nvy] = smoothDamp(A1.heroY, cy, A1.heroVy, ACT1.settleTime, dt)
  A1.heroY = ny
  A1.heroVy = nvy

  A1.shake = Math.max(0, A1.shake - dt * 6)

  // 撞击粒子：一点重力 + 阻力，寿命到了就消失
  if (A1.particles.length) {
    const pd = Math.exp(-2.4 * dt)
    for (const p of A1.particles) {
      p.t += dt
      p.vy += 320 * dt
      p.vx *= pd
      p.vy *= pd
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
    A1.particles = A1.particles.filter((p) => p.t < p.life)
  }

  // 那行字：阻尼弹簧 → 像浮上水面一样慢慢回到 1/6
  if (A1.burst) {
    const damp = Math.exp(-ACT1.floatC * dt)
    for (const c of A1.lineChars) {
      c.vx += (c.homeX - c.x) * ACT1.floatK * dt
      c.vy += (c.homeY - c.y) * ACT1.floatK * dt
      c.vx *= damp
      c.vy *= damp
      c.x += c.vx * dt
      c.y += c.vy * dt
      // 角度也要收回 0：只阻尼角速度会让字停在一个歪着的角度上
      c.rot += c.rotVel * dt
      c.rotVel -= c.rot * ACT1.floatK * 0.55 * dt
      c.rotVel *= Math.exp(-2.2 * dt)
    }
  }

  // impact 0.22 秒后进入 settle：等「我」真正停稳，再静置 2 秒，然后名字才浮现
  if (A1.phase === 'impact' && A1.t >= 0.22) { A1.phase = 'settle'; A1.t = 0; A1.settleT = 0 }

  if (A1.phase === 'settle') {
    if (Math.abs(A1.heroY - cy) < 1.2) A1.settleT += dt
    if (A1.settleT >= ACT1.holdAfterSettle) {
      A1.phase = 'names'
      A1.t = 0
      A1.namesT = 0
    }
    return
  }

  if (A1.phase === 'names' || A1.phase === 'hold') {
    A1.namesT += dt
    let allDone = true
    for (const n of A1.names) {
      const k = clamp((A1.namesT - n.delay) / ACT1.nameFade, 0, 1)
      n.alpha = easeOut(k)
      if (k < 1) allDone = false
    }
    if (A1.phase === 'names' && allDone) { A1.phase = 'hold'; A1.t = 0 }
    // 名字全部出现后，道路从最底部开始向上延伸
    if (A1.phase === 'hold') {
      A1.roadT += dt
      const k = clamp((A1.roadT - ACT1.roadDelay) / ACT1.roadGrowTime, 0, 1)
      const n = A1.roadRows.length
      for (let i = 0; i < n; i++) {
        // i=0 是最上面一行；d 从底部的 0 递增到顶部的 1
        const d = n > 1 ? 1 - i / (n - 1) : 0
        A1.roadRows[i].shown = clamp((k - d * 0.9) / 0.18, 0, 1)
      }
      // 路铺到尽头 → 开始拉远
      if (A1.roadT >= ACT1.roadDelay + ACT1.roadGrowTime + ACT1.zoomDelay) {
        A1.phase = 'zoom'
        A1.zoomT = 0
        A1.t = 0
      }
    }
  }

  // 视角拉远：整体缩小，同时上下空出来的地方补出更多名字，道路跟着延伸
  if (A1.phase === 'zoom') {
    A1.zoomT += dt
    const k = clamp(A1.zoomT / ACT1.zoomTime, 0, 1)
    A1.zoom = 1 + (ACT1.zoomEnd - 1) * a6Ease(k)
    growExtraRows(dt)
    if (k >= 1) {
      A1.phase = 'ringHold'
      A1.holdT = 0
    }
  }

  // 拉远到最远之后先停一会儿，再放圆环
  if (A1.phase === 'ringHold') {
    A1.holdT += dt
    if (A1.holdT >= ACT1.ringDelay) {
      A1.phase = 'ring'
      A1.ringOn = true
      A1.ringT = 0
      A1.ringR = 0
    }
  }

  // ring sweeps outward from the centre of "我", converting everything to white squares
  if (A1.phase === 'ring') {
    A1.ringT += dt
    A1.ringR = A1.ringT * ACT1.ringSpeed
    const far = Math.hypot(W, H) / 2 + ACT1.ringPad
    if (A1.ringR > far) {
      A1.phase = 'black'
      A1.blackT = 0
    }
  }
  if (A1.phase === 'black') {
    A1.blackT += dt
    if (A1.blackT > 1.2 && !A2.started) { A2.started = true; startAct2() }
  }
}

// 山的颜色：纯色、不透明，靠明暗面拉开层次；整体比白字暗，只当远景
const MTN = {
  lit: '#b0b0b0',        // 迎光坡（上半）
  litLow: '#949494',     // 迎光坡（下半，压一档才有体积）
  mid: '#8b8b8b',
  midLow: '#727272',
  shadow: '#5e5e5e',     // 背光坡（上半）
  shadowLow: '#484848',  // 背光坡（下半）
  rim: '#c9c9c9',        // 迎光侧山脊上的一道亮边
  rock: '#7a7a7a',       // 亮面上的岩块（只是暗一点的石头，不是洞）
  rockDark: '#464646',   // 暗面上的岩块
  foot: '#2e2e2e',       // 山脚压深：和背景几乎融在一起，山才"坐得住"
  footDark: '#242424',
  snowLit: '#e9e9e9',    // 亮面雪
  snowShade: '#bdbdbd',  // 暗面雪
}

// 两侧的像素山：和名字过同一个 camera（位置、大小都乘 zoom），所以缩得一样快。
// 每座山是一张 1px=1格 的精灵图，按连续的 zoom 放大（最近邻），
// 缩小时是平滑的——不要再把方块边长取整，取整就会一格一格地跳。
function drawMountains() {
  if (!A1.mountains.length) return
  if (A1.ringOn && A1.ringR > Math.hypot(W, H) * 0.34) return
  if (A1.zoom >= 0.999) return                 // 还没开始拉远：山在画外
  ctx.save()
  ctx.imageSmoothingEnabled = false            // 像素画放大：块边要硬，不要插值糊掉
  for (const m of A1.mountains) {
    const r = mountainRect(m)
    if (r.y > H || r.y + r.h < 0) continue     // 整座在画外，跳过
    if (r.x > W || r.x + r.w < 0) continue
    ctx.drawImage(m.sprite, Math.round(r.x), Math.round(r.y), r.w, r.h)
  }
  ctx.restore()
}

/* 云：挂在山旁边的半透明像素云。用屏幕坐标存当前位置，画的时候按 zoom 往中心缩放。 */
function buildClouds() {
  A1.clouds = []
  const list = [
    // side, 横向离中心（结束时，px）, 纵向（结束时，占画面高）, 列数, 行数, 方块大小
    { side: -1, gx: 340, gy: 0.21, cols: 20, rows: 5, block: 12 },
    { side: -1, gx: 430, gy: 0.34, cols: 24, rows: 6, block: 11 },
    { side: -1, gx: 300, gy: 0.55, cols: 18, rows: 5, block: 13 },
    { side: -1, gx: 455, gy: 0.72, cols: 22, rows: 5, block: 12 },
    { side: 1, gx: 330, gy: 0.16, cols: 21, rows: 5, block: 12 },
    { side: 1, gx: 455, gy: 0.44, cols: 25, rows: 6, block: 11 },
    { side: 1, gx: 335, gy: 0.66, cols: 19, rows: 5, block: 13 },
  ]
  for (const c of list) {
    // 像素云的经典画法：顶上留一两个鼓包，下面几行整条，底边平
    const cells = []
    for (let j = 0; j < c.rows; j++) {
      const frac = j === 0 ? 0.52 : j === 1 ? 0.88 : j === c.rows - 1 ? 0.94 : 1
      let start = Math.round((c.cols * (1 - frac)) / 2)
      let len = Math.max(3, Math.round(c.cols * frac))
      if (j === 0) {
        start = Math.round(c.cols * (0.16 + Math.random() * 0.4))
        len = Math.max(3, Math.round(c.cols * (0.16 + Math.random() * 0.18)))
      }
      cells.push({ row: j, start, len: Math.min(len, c.cols - start) })
    }
    A1.clouds.push({ ...c, gy: c.gy * H, cells, phase: Math.random() * 6.28 })
  }
}

function drawClouds() {
  if (A1.ringOn && A1.ringR > Math.hypot(W, H) * 0.30) return
  if (!A1.clouds.length || A1.zoom >= 0.999) return
  // 表里的数值是"拉远结束时"的屏幕尺寸：k = 当前缩放 / 结束缩放。
  // 结束时 k=1（正好 1:1），拉远过程中云跟着镜头一起缩小。
  const k = A1.zoom / ACT1.zoomEnd
  const cx = S.cx
  const cy = H / 2
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,1)'
  ctx.globalAlpha = ACT1.cloudAlpha
  for (const c of A1.clouds) {
    const drift = Math.sin(A1.cloudT * 0.35 + c.phase) * ACT1.cloudDrift
    const s = c.block * k
    const w = c.cols * s
    const innerEdge = cx + c.side * c.gx * k
    const x0 = c.side < 0 ? innerEdge - w : innerEdge
    const y = cy + (c.gy - cy) * k
    for (const run of c.cells) {
      ctx.fillRect(x0 + run.start * s + drift * k, y + run.row * s, run.len * s, s)
    }
  }
  ctx.restore()
}

// 环形扫描判定：live = 照常画；white = 画成白方块；gone = 不画
function ringState(obj, x, y) {
  if (!A1.ringOn) return 'live'
  if (obj.__hit == null) {
    const d = Math.hypot(x - S.cx, y - H / 2)
    if (d <= A1.ringR) obj.__hit = A1.ringT
    else return 'live'
  }
  return (A1.ringT - obj.__hit) < ACT1.squareLife ? 'white' : 'gone'
}

// 白方块：尺寸 = 元素体积（这里用字号/宽度近似）
function drawWhiteSquare(x, y, size) {
  ctx.globalAlpha = 1
  ctx.fillStyle = 'rgba(255,255,255,1)'
  ctx.fillRect(x - size / 2, y - size / 2, size, size)
}

function renderAct1() {
  const WHITE = 'rgba(255,255,255,1)'   // 纯白，不发光

  drawMountains()   // 最底层：两侧像素山
  drawClouds()      // 山旁边飘着的云

  // ① 那行字（逐字，打字机揭示；撞击后散开再浮回）
  const revealed = Math.floor(A1.shown)
  const sx = A1.shake > 0 ? Math.sin(A1.t * 120) * 4 * A1.shake : 0
  ctx.save()
  ctx.font = `500 ${A1.lineSize}px ${CFG.fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = WHITE
  for (let i = 0; i < revealed && i < A1.lineChars.length; i++) {
    const c = A1.lineChars[i]
    const st = ringState(c, c.x, c.y)
    if (st === 'gone') continue
    if (st === 'white') { drawWhiteSquare(c.x, c.y, A1.lineSize * 0.86); continue }
    ctx.save()
    ctx.translate(c.x + sx, c.y)
    ctx.rotate(c.rot)
    ctx.fillText(c.ch, 0, 0)
    ctx.restore()
  }
  ctx.restore()

  // 打字光标
  if (A1.phase === 'type' && Math.floor(A1.t * 3) % 2 === 0 && revealed < A1.lineChars.length) {
    const last = A1.lineChars[Math.min(revealed, A1.lineChars.length - 1)]
    if (last) {
      ctx.save()
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillRect(last.x + A1.lineSize * 0.6, last.y - A1.lineSize * 0.42, 2, A1.lineSize * 0.84)
      ctx.restore()
    }
  }

  // ② 那一列名字（与「我」同号、同色）——拉远时整体绕中心缩放
  ctx.save()
  if (A1.zoom !== 1) {
    ctx.translate(S.cx, H / 2)
    ctx.scale(A1.zoom, A1.zoom)
    ctx.translate(-S.cx, -H / 2)
  }
  ctx.font = `400 ${A1.nameSize}px ${CFG.fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = WHITE
  for (const n of A1.names) {
    if (n.alpha <= 0.005) continue
    // 判定用屏幕坐标（名字列跟着缩放，所以先换算回去）
    const sy = H / 2 + (n.y - H / 2) * A1.zoom
    const st = ringState(n, S.cx, sy)
    if (st === 'gone') continue
    if (st === 'white') { drawWhiteSquare(S.cx, sy, A1.nameSize * A1.zoom * 0.95); continue }
    ctx.globalAlpha = n.alpha
    ctx.fillText(n.text, S.cx, n.y + (1 - n.alpha) * 7)
  }

  // ②.5 两侧道路（俯视）：从最底部向上延伸，不压住人名
  if (A1.roadRows.length) {
    ctx.font = `400 ${A1.nameSize}px ${CFG.fontFamily}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = WHITE
    for (const row of A1.roadRows) {
      const local = row.shown ?? 0
      if (local <= 0.01) continue
      const off = A1.nameSize * local
      const lx2 = A1.roadLeftX + row.left.dx * off
      const rx2 = A1.roadRightX + row.right.dx * off
      const sy = H / 2 + (row.y - H / 2) * A1.zoom
      const stL = ringState(row.left, lx2, sy)
      const stR = ringState(row.right, rx2, sy)
      if (stL !== 'gone') {
        if (stL === 'white') drawWhiteSquare(lx2, sy, A1.nameSize * A1.zoom * 0.7)
        else { ctx.globalAlpha = ACT1.roadAlpha * local; ctx.fillText(row.left.sym, lx2, row.y) }
      }
      if (stR !== 'gone') {
        if (stR === 'white') drawWhiteSquare(rx2, sy, A1.nameSize * A1.zoom * 0.7)
        else { ctx.globalAlpha = ACT1.roadAlpha * local; ctx.fillText(row.right.sym, rx2, row.y) }
      }
    }
  }
  ctx.restore()

  // ②.6 拉远时补出来的名字与延伸的道路（屏幕坐标，字号随缩放变小）
  if (A1.extra.length && A1.zoom < 0.999) {
    const fs = A1.nameSize * A1.zoom
    if (fs > 0.9) {
      const nameHalf = (A1.nameWidth * A1.zoom) / 2
      const gapX = fs * ACT1.roadGapRatio
      const lx = S.cx - nameHalf - gapX
      const rx = S.cx + nameHalf + gapX
      ctx.save()
      ctx.font = `400 ${fs}px ${CFG.fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = WHITE
      for (const e of A1.extra) {
        if (e.alpha <= 0.01) continue
        const stN = ringState(e, S.cx, e.y)
        if (stN === 'gone') continue
        if (stN === 'white') { drawWhiteSquare(S.cx, e.y, fs * 0.95); continue }
        ctx.globalAlpha = e.alpha
        ctx.fillText(e.text, S.cx, e.y)
        const xl = lx + e.left.dx * fs, xr = rx + e.right.dx * fs
        const sl = ringState(e.left, xl, e.y)
        if (sl === 'white') drawWhiteSquare(xl, e.y, fs * 0.7)
        else if (sl !== 'gone') { ctx.globalAlpha = ACT1.roadAlpha * e.alpha; ctx.fillText(e.left.sym, xl, e.y) }
        const sr = ringState(e.right, xr, e.y)
        if (sr === 'white') drawWhiteSquare(xr, e.y, fs * 0.7)
        else if (sr !== 'gone') { ctx.globalAlpha = ACT1.roadAlpha * e.alpha; ctx.fillText(e.right.sym, xr, e.y) }
      }
      // 道路尾巴：只有路桩，没有名字，一路延伸出屏幕
      for (const t of A1.roadTail) {
        if (t.alpha <= 0.01) continue
        const xl = lx + t.left.dx * fs, xr = rx + t.right.dx * fs
        const sl = ringState(t.left, xl, t.y)
        if (sl === 'white') drawWhiteSquare(xl, t.y, fs * 0.7)
        else if (sl !== 'gone') { ctx.globalAlpha = ACT1.roadAlpha * t.alpha; ctx.fillText(t.left.sym, xl, t.y) }
        const sr = ringState(t.right, xr, t.y)
        if (sr === 'white') drawWhiteSquare(xr, t.y, fs * 0.7)
        else if (sr !== 'gone') { ctx.globalAlpha = ACT1.roadAlpha * t.alpha; ctx.fillText(t.right.sym, xr, t.y) }
      }
      ctx.restore()
    }
  }

  // ③ 撞击粒子：白色碎屑，不是发光的圆环
  if (A1.particles.length) {
    ctx.save()
    ctx.fillStyle = WHITE
    for (const p of A1.particles) {
      const k = 1 - p.t / p.life
      if (k <= 0) continue
      ctx.globalAlpha = Math.min(1, k * 1.6)
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
    }
    ctx.restore()
  }

  // ④ 「我」：与名字同号、同色、无发光；拉远时跟着一起缩
  ctx.save()
  ctx.font = `400 ${A1.heroSize * A1.zoom}px ${CFG.fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = WHITE
  const heroScrY = H / 2 + (A1.heroY - H / 2) * A1.zoom
  const stH = ringState(A1.heroHit, S.cx, heroScrY)
  if (stH === 'white') drawWhiteSquare(S.cx, heroScrY, A1.heroSize * A1.zoom)
  else if (stH !== 'gone') ctx.fillText(ACT1.hero, S.cx, heroScrY)
  ctx.restore()

  // ring itself: a thick white circle expanding outward
  if (A1.ringOn && A1.phase !== 'black') {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'
    ctx.lineWidth = ACT1.ringWidth
    ctx.beginPath()
    ctx.arc(S.cx, H / 2, Math.max(1, A1.ringR), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // final black
  if (A1.phase === 'black') {
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,1)'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  }
}

/* ============================ 输入 ============================ */

// 拖动窗口时：重排几何，并把当前状态修复到一个自洽的位置
// （否则 layout() 会把字重置成 alpha=0，而序列已经过了那一帧 —— 屏幕就空了）
addEventListener('resize', () => {
  // 截图模式也重排：否则窗口尺寸变了画面还是按旧尺寸裁的
  if (jumpT !== null) { resize(); applyJump(); return }
  resize()
  if (S.mode === 'intro') { startIntro(); return }
  if (S.mode === 'play') {
    S.heroY = S.cy
    S.heroVy = 0
    for (const b of S.field) b.alpha = b.tint > 0.6 ? 0.5 : 0.32
  }
})

addEventListener('contextmenu', (e) => { if (S.mode === 'act2' || S.mode === 'act3') e.preventDefault() })
addEventListener('mousedown', (e) => { if (S.mode === 'act2' && e.button === 1) e.preventDefault() })

addEventListener('pointerdown', (e) => {
  if (S.mode !== 'act3' || !A3.game.active) return
  const G = A3.game
  // 第 6 阶段：任意左键 → 开枪
  if (G.phase === 6) {
    if (!G.done) return
    if (e.button === 0) {
      G.clicked = true
    }
    return
  }
  if (G.phase > 5 || G.nextPhase != null) return
  const r = canvas.getBoundingClientRect()
  const mx = (e.clientX - r.left) * (W / r.width)
  const my = (e.clientY - r.top) * (H / r.height)
  const hit = (b2) => b2 && mx >= b2.x && mx <= b2.x + b2.w && my >= b2.y && my <= b2.y + b2.h
  // 浮动词
  for (const b2 of (A3.FLOATBOX || [])) {
    if (hit(b2)) { G.dragChar = b2.f; G.floats.splice(G.floats.indexOf(b2.f), 1); G.dragX = mx; G.dragY = my; return }
  }
  // 环形字
  for (const b2 of (A3.RINGBOX || [])) {
    if (hit(b2)) { G.dragChar = { ch: b2.ch, ring: true }; G.dragX = mx; G.dragY = my; return }
  }
  // 句子里的可拖字
  const moveSet = (A3_P[G.phase] && A3_P[G.phase].move) || []
  for (const c of (A3.CELLS || [])) {
    if (!c || c.empty) continue
    if (!hit(c)) continue
    const canMove = moveSet.indexOf(c.idx) >= 0 || (G.phase === 3 && c.ch === '没')
    if (canMove) {
      G.dragChar = { ch: G.slots[c.idx] }
      G.slots[c.idx] = ''
      G.dragX = mx; G.dragY = my
    }
    return
  }
})
addEventListener('pointermove', (e) => {
  if (S.mode !== 'act3' || !A3.game.active || !A3.game.dragChar) return
  const r = canvas.getBoundingClientRect()
  A3.game.dragX = (e.clientX - r.left) * (W / r.width)
  A3.game.dragY = (e.clientY - r.top) * (H / r.height)
})
addEventListener('pointerup', () => {
  const G = A3.game
  if (S.mode !== 'act3' || !G.active || !G.dragChar) return
  const dc = G.dragChar
  G.dragChar = null
  if (G.phase > 5 || G.nextPhase != null) return
  const moveSet = (A3_P[G.phase] && A3_P[G.phase].move) || []
  // 找最近的合法格子
  let target = -1, bestD = 1e9
  for (const c of (A3.CELLS || [])) {
    if (!c) continue
    const canDrop = (moveSet.indexOf(c.idx) >= 0) || (G.phase === 5 && c.idx === G.slots.length - 1)
    if (!canDrop) continue
    const d = Math.hypot((c.x + c.w / 2) - G.dragX, (c.y + c.h / 2) - G.dragY)
    if (d < bestD) { bestD = d; target = c.idx }
  }
  if (target >= 0 && bestD < H * 0.16) {
    // 第 5 阶段：只有「枪」能放进空位，别的字直接弹回字圈
    if (G.phase === 5 && dc.ch === '枪') {
      // 放进去的瞬间就停战斗音乐
      stopBattleMusic()
      if (A3_BGM) { try { A3_BGM.volume = 0; A3_BGM.pause() } catch (e) {} }
    }
    if (G.phase === 5 && dc.ch !== '枪') {
      G.floats.push({ ch: dc.ch, x: G.dragX, y: G.dragY })
      a3CheckWin()
      return
    }
    const oc = G.slots[target]
    G.slots[target] = dc.ch
    if (oc) G.floats.push({ ch: oc, x: G.dragX, y: G.dragY - H * 0.10 })
  } else {
    G.floats.push({ ch: dc.ch, x: G.dragX, y: G.dragY })
  }
  a3CheckWin()
})

addEventListener('pointerlockchange', () => {
  A2.locked = (document.pointerLockElement != null)
})

addEventListener('mousemove', (e) => {
  if (!document.pointerLockElement) return
  if (S.mode === 'room') {
    const cam = A0.cam
    cam.yaw = (cam.yaw || 0) - (e.movementX || 0) * 0.0022
    cam.pitch = Math.max(-1.1, Math.min(1.1, (cam.pitch || 0) + (e.movementY || 0) * 0.0022))
    return
  }
  if (S.mode === 'act4') {
    A4.yaw -= (e.movementX || 0) * 0.0022
    A4.pitch = Math.max(-0.9, Math.min(0.9, A4.pitch - (e.movementY || 0) * 0.0022))
    return
  }
  if (S.mode !== 'act2') return
  A2.cam.yaw -= (e.movementX || 0) * 0.0022
  A2.cam.pitch = Math.max(-0.9, Math.min(0.9, A2.cam.pitch + (e.movementY || 0) * 0.0022))
})

addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  if (S.mode === 'act0') { act0Click(x, y); return }
  if (S.mode === 'room') {
    if (canvas && canvas.requestPointerLock && !document.pointerLockElement && !WAKE.active) {
      try { canvas.requestPointerLock() } catch (err) {}
    }
    A0.turning = false
    return
  }
  if (S.mode === 'act2' || S.mode === 'act4') {
    if (canvas && canvas.requestPointerLock && !document.pointerLockElement) {
      try { canvas.requestPointerLock() } catch (err) {}
    }

    if (A2.run.active && e.button === 0) { runShoot(); return }
    A2.dragging = true; A2.lastX = x; A2.lastY = y; return
  }
  if (S.mode === 'title') {
    startCurrent(false)
  } else if (S.mode === 'play') {
    spawnFaller(clamp(x, 60, W - 60), clamp(y, 80, H - 80))
  }
})

addEventListener('keydown', (e) => {
  // 主界面按任意键 → 进入苏醒序列（Esc 留给关弹窗，功能键不算）
  if (S.mode === 'act0' && !WAKE.active && !A0.modal &&
      !['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'F5', 'F12'].includes(e.key)) {
    startRoom()
    return
  }
  // E：靠近书架的笔记本 → 取下；拿着它靠近椅子 → 坐下
  if (S.mode === 'room' && !WAKE.active && (e.key === 'e' || e.key === 'E')) {
    if (A0.nearShelf) { takeShelfBook(); return }
    if (A0.nearSeat) { sitAtDesk(); return }
  }
  if (e.code === 'Space' && S.mode === 'act2' && A2.run.active) {
    e.preventDefault()
    roomKeys['Space'] = true     // 持续按住也能判定
    runPressSpace()
    return
  }
  if (S.mode === 'room' || S.mode === 'act2' || S.mode === 'act3' || S.mode === 'act4') { roomKeys[e.code] = true }
  if (S.mode === 'act0' && e.key === 'Escape') { A0.modal = null; return }
  if (S.mode === 'room' && (e.key === 'l' || e.key === 'L')) { A0.lampOn = A0.lampOn === false; return }
  if ((e.key === 'm' || e.key === 'M') && A0.devMode && S.mode !== 'act0') { skipCurrentAct(); return }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault()
    if (S.mode === 'title') startCurrent(false)
    else if (S.mode === 'play') spawnFaller(S.cx, S.cy)
  }
  if (e.key === 'r' || e.key === 'R') { S.error = null; S.paused = false; startCurrent(false) }
  if (e.key === 'm' || e.key === 'M') { if (!A0.devMode) toggleMute() }
})

/* ============================ 第 0 幕：开始界面 ============================ */
/* 标题「黑白」+ 两个木牌按钮 + 一行灰字提示；背景是 blur 过的 3D 卧室。
   点「设置」「开发人员」开面板，点别处 → 进 3D 卧室（WASD 走动）。 */

const A0 = {
  mx: -1, my: -1,
  t: 0,
  modal: null,             // null | 'settings' | 'dev'
  bookState: 'shelf',      // shelf = 还在书架上 / held = 已拿在手里
  bookTaken: false,        // 书架上那本是否已被拿走
  devMode: false,          // 开发者模式：默认关（M 跳过演出 + 碰撞线框）
  lampOn: true,           // 吊灯开关（房间里可以按 L 切换）
  btns: [],                // 每帧刷新的按钮命中区 { id, x, y, w, h }
  dragVol: false,
  bg: null,                // 模糊后的房间背景（缓存）
  bgW: 0,
  bgH: 0,
  cam: { x: 0, z: 2.2, yaw: 0, pitch: 0.12 },
  keys: Object.create(null),
  walked: 0,
}

const ACT0 = {
  titleText: '黑白',
  hintText: '点击任意处开始游戏',
  titleFont: '"SimSun", "宋体", "STSong", serif',
  titleSizeRatio: 0.20,    // 字号 = 画面高 × 0.20
  titleOffsetRatio: 1 / 3, // 两个字上下错开 1/3 字高
  titleYRatio: 0.34,       // 标题在画面 34% 高处
  btnYRatio: 0.70,         // 按钮在画面 70% 高处
  roomW: 9.0,
  roomD: 11.0,
  roomH: 3.1,
  eyeHeight: 1.55,
  fov: 1.02,
  walkSpeed: 2.3,
  pixel: 3,                // 3D 内部按 1/3 分辨率画，再整倍放大 → 像素风
}

/* ---------- 3D 卧室：一个长方体房间，第一人称 ---------- */

function roomProject(g, w, h, cam, x, y, z) {
  const f = (h / 2) / Math.tan(ACT0.fov / 2)
  const dx = x - cam.x
  const dy = y - ACT0.eyeHeight
  const dz = z - cam.z
  const cs = Math.cos(cam.yaw)
  const sn = Math.sin(cam.yaw)
  const rx = dx * cs - dz * sn
  const rz0 = dx * sn + dz * cs
  // 俯仰：让镜头稍微往下看，地板才进画面
  const pitch = cam.pitch ?? 0
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const ry = dy * cp - rz0 * sp
  const rz = dy * sp + rz0 * cp
  if (rz > -0.12) return null
  const iz = -rz
  return { x: w / 2 + (rx * f) / iz, y: h / 2 - (ry * f) / iz, z: iz }
}

function fillQuad(g, a, b, c, d, color) {
  if (!a || !b || !c || !d) return false
  g.fillStyle = color
  g.beginPath()
  g.moveTo(a.x, a.y)
  g.lineTo(b.x, b.y)
  g.lineTo(c.x, c.y)
  g.lineTo(d.x, d.y)
  g.closePath()
  g.fill()
  return true
}

function drawRoom(g, w, h, cam) {
  const hw = ACT0.roomW / 2
  const hd = ACT0.roomD / 2
  const hh = ACT0.roomH
  const P = (x, y, z) => roomProject(g, w, h, cam, x, y, z)
  // 星露谷式暖木配色：亮/中/暗三档 + 深棕勾边
  const PAL = {
    ceil: '#4a3320',
    wallHigh: '#e0b57e',   // 上半墙（壁纸）
    wallLow: '#a97445',    // 护墙板
    trim: '#f4d8a6',       // 腰线 / 压条
    base: '#6b4626',       // 踢脚
    floor: ['#cd8f52', '#bf8046', '#b0733c'],
    seam: 'rgba(58,32,14,0.5)',
  }
  const WAINSCOT = 1.15     // 护墙板高度（米）

  // 天花板：和地板一样切成小块，否则整块会因为"有角在镜头后面"被整块丢掉（看起来就没天花板）
  const ctile = 1.0
  for (let x = -hw; x < hw - 0.001; x += ctile) {
    for (let z = -hd; z < hd - 0.001; z += ctile) {
      const x2 = Math.min(x + ctile, hw)
      const z2 = Math.min(z + ctile, hd)
      fillQuad(g, P(x, hh, z), P(x2, hh, z), P(x2, hh, z2), P(x, hh, z2), PAL.ceil)
    }
  }

  // 墙：切成小片投影（整面墙会有一部分跑到镜头后面）
  const panel = 1.2
  const wallSpecs = [
    { fixed: 'z', const: -hd, from: -hw, to: hw },
    { fixed: 'x', const: -hw, from: -hd, to: hd },
    { fixed: 'x', const: hw, from: -hd, to: hd },
    { fixed: 'z', const: hd, from: -hw, to: hw },   // 背后那面墙（转身才看得到）
  ]
  for (const wl of wallSpecs) {
    for (let t = wl.from; t < wl.to - 0.001; t += panel) {
      const t2 = Math.min(t + panel + 0.03, wl.to)
      const pt = (y, u) => (wl.fixed === 'z' ? P(u, y, wl.const) : P(wl.const, y, u))
      // 上半墙（壁纸）
      fillQuad(g, pt(WAINSCOT, t), pt(WAINSCOT, t2), pt(hh, t2), pt(hh, t), PAL.wallHigh)
      // 护墙板
      fillQuad(g, pt(0.17, t), pt(0.17, t2), pt(WAINSCOT, t2), pt(WAINSCOT, t), PAL.wallLow)
      // 腰线
      fillQuad(g, pt(WAINSCOT, t), pt(WAINSCOT, t2), pt(WAINSCOT + 0.05, t2), pt(WAINSCOT + 0.05, t), PAL.trim)
      // 踢脚
      fillQuad(g, pt(0, t), pt(0, t2), pt(0.17, t2), pt(0.17, t), PAL.base)
      // 护墙板竖缝（每 1.2m 一条暗线，像一块块木板）
      g.strokeStyle = 'rgba(52,28,12,0.35)'
      g.lineWidth = 1
      const s0 = pt(0.17, t)
      const s1 = pt(WAINSCOT, t)
      if (s0 && s1) { g.beginPath(); g.moveTo(s0.x, s0.y); g.lineTo(s1.x, s1.y); g.stroke() }
      // 壁纸竖缝（更淡）
      g.strokeStyle = 'rgba(90,56,26,0.16)'
      const w0 = pt(WAINSCOT, t)
      const w1 = pt(hh, t)
      if (w0 && w1) { g.beginPath(); g.moveTo(w0.x, w0.y); g.lineTo(w1.x, w1.y); g.stroke() }
    }
  }

  // 墙脚压一条深色勾边（星露谷那种硬边感）
  g.strokeStyle = 'rgba(40,22,10,0.5)'
  g.lineWidth = 2
  for (const wl of wallSpecs) {
    const a = wl.fixed === 'z' ? P(wl.from, 0, wl.const) : P(wl.const, 0, wl.from)
    const b = wl.fixed === 'z' ? P(wl.to, 0, wl.const) : P(wl.const, 0, wl.to)
    if (a && b) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() }
  }

  // 地板：按"木条"排，一条 0.55m 宽，颜色三档轮换，缝用暗线压边
  const plank = 0.42
  for (let x = -hw; x < hw - 0.001; x += plank) {
    const x2 = Math.min(x + plank, hw)
    const band = Math.floor((x + hw) / plank + 0.001) % 3
    const col = PAL.floor[band]
    for (let z = -hd; z < hd - 0.001; z += 1.1) {   // 每条木条再分几段，才有"一块块"的感觉
      const z2 = Math.min(z + 1.1, hd)
      fillQuad(g, P(x, 0, z), P(x2, 0, z), P(x2, 0, z2), P(x, 0, z2), col)
      // 段与段之间的拼缝（细一点）
      g.strokeStyle = PAL.seam
      g.lineWidth = 1
      const a = P(x, 0, z2)
      const b = P(x2, 0, z2)
      if (a && b) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() }
    }
    // 木条之间的长缝
    g.strokeStyle = PAL.seam
    g.lineWidth = 1
    const a = P(x, 0, -hd)
    const b = P(x, 0, hd)
    if (a && b) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() }
  }

  // 灯光：地板中间一小片暖光（像屋里点了灯），外加四周压暗
  const cx2 = w / 2
  const cy2 = h * 0.72
  const glow = g.createRadialGradient(cx2, cy2, 2, cx2, cy2, w * 0.42)
  glow.addColorStop(0, 'rgba(255,228,170,0.22)')
  glow.addColorStop(1, 'rgba(255,222,160,0)')
  g.fillStyle = glow
  g.fillRect(0, 0, w, h)
  const vig = g.createRadialGradient(cx2, h * 0.5, h * 0.28, cx2, h * 0.5, Math.max(w, h) * 0.72)
  vig.addColorStop(0, 'rgba(0,0,0,0)')
  vig.addColorStop(1, 'rgba(0,0,0,0.26)')
  g.fillStyle = vig
  g.fillRect(0, 0, w, h)
}

// 把房间画到低分辨率离屏画布，再整倍放大 → 硬边像素风
// scale：目标画布的像素比（DPR）。漏了它就会只画在左上角一小块。
function drawRoomPixels(target, w, h, cam, blurPx, scale = 1) {
  const s = ACT0.pixel
  const lw = Math.max(2, Math.round(w / s))
  const lh = Math.max(2, Math.round(h / s))
  let low = target._low
  if (!low || low.width !== lw || low.height !== lh) {
    low = document.createElement('canvas')
    low.width = lw
    low.height = lh
    target._low = low
  }
  const g = low.getContext('2d')
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = '#1a1310'
  g.fillRect(0, 0, lw, lh)
  drawRoom(g, lw, lh, cam)

  target.save()
  target.setTransform(1, 0, 0, 1, 0, 0)
  target.imageSmoothingEnabled = false
  if (blurPx) target.filter = `blur(${blurPx}px)`
  target.drawImage(low, 0, 0, w * scale, h * scale)
  target.filter = 'none'
  target.restore()
}

/* ---------- 开始界面 ---------- */

function boxHit(x, y, b) {
  return b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
}

// 木牌按钮：外深框 + 内木纹 + 高光边
function drawWoodButton(g, x, y, w, h, label, hot) {
  const s = h / 64
  g.save()
  g.fillStyle = '#3a2213'
  g.fillRect(x, y, w, h)
  const grd = g.createLinearGradient(x, y, x, y + h)
  grd.addColorStop(0, hot ? '#d9a462' : '#c98f4e')
  grd.addColorStop(1, hot ? '#b5793c' : '#a9703a')
  g.fillStyle = grd
  g.fillRect(x + 4 * s, y + 4 * s, w - 8 * s, h - 8 * s)
  g.strokeStyle = 'rgba(240,205,150,0.75)'
  g.lineWidth = 2 * s
  g.strokeRect(x + 7 * s, y + 7 * s, w - 14 * s, h - 14 * s)
  // 木纹
  g.strokeStyle = 'rgba(90,52,24,0.35)'
  g.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    const yy = y + (h * i) / 4
    g.beginPath(); g.moveTo(x + 10 * s, yy); g.lineTo(x + w - 10 * s, yy); g.stroke()
  }
  g.font = `700 ${Math.round(h * 0.42)}px ${ACT0.titleFont}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#3a2213'
  g.fillText(label, x + w / 2, y + h / 2 + 1)
  g.fillStyle = '#f6e3c2'
  g.fillText(label, x + w / 2, y + h / 2)
  g.restore()
}

function renderAct0() {
  const g = ctx
  g.save()
  g.setTransform(DPR, 0, 0, DPR, 0, 0)

  // 背景：模糊的卧室（优先用真 3D 渲染一帧）
  if (!A0.bg || A0.bgW !== W || A0.bgH !== H) {
    A0.bg = makeRoomBackdrop(W, H, { x: 0, z: 2.6, yaw: 0, pitch: 0.14 })
    A0.bgW = W
    A0.bgH = H
  }
  g.filter = 'blur(6px)'
  g.drawImage(A0.bg, 0, 0, W, H)
  g.filter = 'none'
  g.fillStyle = 'rgba(8,6,4,0.30)'       // 压暗一点，字才读得清
  g.fillRect(0, 0, W, H)

  // 标题：黑 / 白，宋体，大号，错开 1/3 字高
  const size = Math.round(H * ACT0.titleSizeRatio)
  const cx = W / 2
  const cy = H * ACT0.titleYRatio
  const off = size * ACT0.titleOffsetRatio
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `${size}px ${ACT0.titleFont}`
  g.fillStyle = '#000000'
  g.fillText('黑', cx - size * 0.62, cy - off)
  g.fillStyle = '#ffffff'
  g.fillText('白', cx + size * 0.62, cy + off)

  // 灰字提示
  g.font = `400 ${Math.round(H * 0.022)}px ${CFG.fontFamily}`
  g.fillStyle = 'rgba(190,190,190,0.9)'
  g.fillText(ACT0.hintText, cx, cy + size * 0.95)

  // 两个木牌按钮
  A0.btns = []
  const bw = Math.min(240, W * 0.19)
  const bh = Math.min(72, H * 0.095)
  const gap = bw * 0.16
  const by = H * ACT0.btnYRatio
  const totalW = bw * 2 + gap
  const specs = [
    { id: 'settings', label: '设置' },
    { id: 'dev', label: '开发人员' },
  ]
  specs.forEach((sp, i) => {
    const bx = cx - totalW / 2 + i * (bw + gap)
    const hot = boxHit(A0.mx, A0.my, { x: bx, y: by, w: bw, h: bh })
    drawWoodButton(g, bx, by, bw, bh, sp.label, hot)
    A0.btns.push({ id: sp.id, x: bx, y: by, w: bw, h: bh })
  })

  // 面板
  if (A0.modal) drawAct0Modal(g, W, H)
  g.restore()
}

function drawAct0Modal(g, W, H) {
  g.save()
  g.fillStyle = 'rgba(0,0,0,0.55)'
  g.fillRect(0, 0, W, H)
  const mw = Math.min(560, W * 0.52)
  const mh = A0.modal === 'settings' ? Math.min(300, H * 0.42) : Math.min(240, H * 0.34)
  const mx = (W - mw) / 2
  const my = (H - mh) / 2
  // 面板：木框 + 纸面
  g.fillStyle = '#3a2213'
  g.fillRect(mx, my, mw, mh)
  g.fillStyle = '#e8d3ac'
  g.fillRect(mx + 6, my + 6, mw - 12, mh - 12)
  g.strokeStyle = 'rgba(120,80,40,0.6)'
  g.lineWidth = 2
  g.strokeRect(mx + 14, my + 14, mw - 28, mh - 28)

  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#3a2213'
  g.font = `700 ${Math.round(mh * 0.12)}px ${ACT0.titleFont}`
  g.fillText(A0.modal === 'settings' ? '设置' : '开发人员简介', W / 2, my + mh * 0.2)

  g.font = `400 ${Math.round(mh * 0.085)}px ${CFG.fontFamily}`
  if (A0.modal === 'dev') {
    g.fillText('开发者：生命', W / 2, my + mh * 0.46)
    g.fillText('使用 ai：deep seek', W / 2, my + mh * 0.62)
  } else {
    // 音量
    const labelY = my + mh * 0.36
    g.textAlign = 'left'
    g.font = `400 ${Math.round(mh * 0.085)}px ${CFG.fontFamily}`
    g.fillText('音量', mx + mw * 0.10, labelY)
    const sx = mx + mw * 0.26
    const sw = mw * 0.56
    const sh = 10
    g.fillStyle = 'rgba(58,34,19,0.22)'
    g.fillRect(sx, labelY - sh / 2, sw, sh)
    g.fillStyle = '#8a5a2f'
    g.fillRect(sx, labelY - sh / 2, sw * A0.volume, sh)
    g.fillStyle = '#3a2213'
    g.fillRect(sx + sw * A0.volume - 7, labelY - 13, 14, 26)
    g.textAlign = 'right'
    g.fillText(`${Math.round(A0.volume * 100)}%`, mx + mw * 0.92, labelY)
    A0.hits = A0.hits || {}
    A0.hits.vol = { x: sx - 12, y: labelY - 24, w: sw + 24, h: 48 }

    // 开发者模式开关
    const rowY = my + mh * 0.60
    g.textAlign = 'left'
    g.fillText('开发者模式', mx + mw * 0.10, rowY)
    const togW = 84
    const togH = 32
    const tx = mx + mw * 0.92 - togW
    const ty = rowY - togH / 2
    g.fillStyle = A0.devMode ? '#5c8a3a' : 'rgba(58,34,19,0.25)'
    g.fillRect(tx, ty, togW, togH)
    g.fillStyle = '#fff'
    g.font = `700 ${Math.round(togH * 0.5)}px ${CFG.fontFamily}`
    g.textAlign = 'center'
    g.fillText(A0.devMode ? '开' : '关', tx + togW / 2, rowY)
    A0.hits.toggle = { x: tx, y: ty, w: togW, h: togH }
    // 说明
    g.textAlign = 'left'
    g.font = `400 ${Math.round(mh * 0.062)}px ${CFG.fontFamily}`
    g.fillStyle = 'rgba(58,34,19,0.62)'
    g.fillText('开启后，按 M 键跳过当前这一段演出', mx + mw * 0.10, rowY + mh * 0.12)
    g.textAlign = 'center'
    g.fillStyle = '#3a2213'
  }
  g.textAlign = 'center'
  g.font = `400 ${Math.round(mh * 0.075)}px ${CFG.fontFamily}`
  g.fillStyle = 'rgba(58,34,19,0.65)'
  g.fillText('点击面板外关闭', W / 2, my + mh * 0.88)
  A0.modalRect = { x: mx, y: my, w: mw, h: mh }
  g.restore()
}

function act0Click(x, y) {
  A0.mx = x
  A0.my = y
  if (A0.modal) {
    const r = A0.modalRect
    if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      if (A0.modal === 'settings' && A0.hits) {
        const v = A0.hits.vol
        if (v && x >= v.x && x <= v.x + v.w && y >= v.y && y <= v.y + v.h) {
          A0.volume = clamp((x - (v.x + 12)) / (v.w - 24), 0, 1)
          bgm.volume = A0.volume
          A0.dragVol = true
          return
        }
        const tg = A0.hits.toggle
        if (tg && x >= tg.x && x <= tg.x + tg.w && y >= tg.y && y <= tg.y + tg.h) {
          A0.devMode = !A0.devMode
          return
        }
      }
      return
    }
    A0.modal = null
    return
  }
  for (const b of A0.btns) {
    if (boxHit(x, y, b)) {
      A0.modal = b.id
      return
    }
  }
  // 点其它任何地方 → 开始游戏
  startRoom()
}

/* ============================ 家具碰撞体 ============================ */
/* 每件家具一个轴对齐方块（比模型本身每边小 5cm），玩家当成半径 0.20 的圆柱去碰。
   只做"挡住"不做物理：分轴判定，所以贴着家具也能顺着滑过去。 */
const ROOM_COLLIDERS = [
  { n: '床',       x0: -4.58, z0: -5.43, x1: -2.02, z1: -2.27, h: 1.30 },
  { n: '床头柜',   x0: -1.97, z0: -5.39, x1: -1.12, z1: -4.89, h: 0.80 },
  { n: '五斗柜',   x0: -4.33, z0: -0.85, x1: -3.88, z1:  0.95, h: 1.05 },
  { n: '衣柜',     x0:  3.80, z0: -3.35, x1:  4.45, z1: -1.35, h: 2.50 },
  { n: '书架',     x0:  1.75, z0: -5.30, x1:  4.05, z1: -4.80, h: 2.30 },
  { n: '书桌',     x0:  3.45, z0:  1.05, x1:  4.35, z1:  3.15, h: 0.85 },
  { n: '椅子',     x0:  2.70, z0:  1.90, x1:  3.20, z1:  2.40, h: 1.10 },
  { n: '木箱',     x0:  3.65, z0:  4.55, x1:  4.50, z1:  5.40, h: 0.80 },
  { n: '盆栽',     x0: -4.25, z0:  3.90, x1: -3.65, z1:  4.50, h: 1.30 },
]

const PLAYER_RADIUS = 0.20

function hitsFurniture(x, z, r = PLAYER_RADIUS) {
  for (const b of ROOM_COLLIDERS) {
    if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return b
  }
  return null
}

let roomKeys = Object.create(null)

function startRoom() {
  roomKeys = Object.create(null)
  A0.t = 0
  startWake()       // 不再直接切场景：走"苏醒序列"，由相机控制器实时驱动
}

/* ============================ 苏醒音效（WebAudio 现场合成） ============================ */
/* 不用外部音频文件：噪声 + 滤波器 + 包络现场生成，所以不占空间、无授权问题、断网也能响。
   四个声音：blink 眼睑摩擦 / breath 呼吸 / cloth 布料 / creak 床板吱呀。 */

// 浏览器要求"有用户手势"才能出声：第一次点击/按键时唤醒 AudioContext
;['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
  addEventListener(ev, () => SFX.resume(), { passive: true }))

const SFX = {
  /* ⚠️ 总开关：false = 完全不发声（文件加载与 play 接口都保留）。想启用改成 true 即可。 */
  enabled: false,
  ctx: null, master: null, noiseBuf: null, vol: 0.55,

  ensure() {
    if (this.ctx) return true
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return false
      const ctx = new AC()
      const master = ctx.createGain()
      master.gain.value = 1
      master.connect(ctx.destination)
      const len = Math.floor(ctx.sampleRate * 2)
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      this.ctx = ctx
      this.master = master
      this.noiseBuf = buf
      return true
    } catch (e) {
      return false
    }
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
  },

  // 噪声 + 带通/低通 + 指数包络
  noise(dur, opt) {
    const o = opt || {}
    const ctx = this.ctx
    const now = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    const filt = ctx.createBiquadFilter()
    filt.type = o.type || 'bandpass'
    filt.frequency.setValueAtTime(o.freq || 900, now)
    if (o.sweepTo) filt.frequency.exponentialRampToValueAtTime(o.sweepTo, now + dur * (o.sweepAt || 0.8))
    filt.Q.value = o.q == null ? 0.9 : o.q
    const g = ctx.createGain()
    const peak = (o.gain == null ? 0.12 : o.gain) * this.vol
    const atk = o.attack == null ? 0.03 : o.attack
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + atk)
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur)
    src.connect(filt)
    filt.connect(g)
    g.connect(this.master)
    src.start(now)
    src.stop(now + dur + 0.05)
  },

  // 正弦 + 快速衰减（床板、木头）
  tone(freq, dur, gain, type) {
    const ctx = this.ctx
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = type || 'sine'
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.72), now + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * this.vol), now + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur)
    osc.connect(g)
    g.connect(this.master)
    osc.start(now)
    osc.stop(now + dur + 0.05)
  },

  /* 真实录音优先：assets/sfx/ 下的 mp3；文件缺失或没加载好就退回现场合成。 */
  files: {
    blink:  "assets/sfx/rustle.mp3",
    breath: "assets/sfx/breath.mp3",
    cloth:  "assets/sfx/rustle.mp3",
    creak:  "assets/sfx/creak.mp3",
  },
  vol: { blink: 0.20, breath: 0.60, cloth: 0.55, creak: 0.45 },
  els: {},

  initFiles() {
    if (!this.enabled) return   // 总开关关着就不预加载，省流量
    for (const name in this.files) {
      const a = new Audio()
      a.src = this.files[name]
      a.preload = "auto"
      a.addEventListener("error", () => { this.els[name] = null })   // 加载失败 → 用合成
      this.els[name] = a
    }
  },

  play(name) {
    if (!this.enabled || muted) return   // 总开关关着就完全不发声
    if (muted) return
    // ① 有真实录音就用录音（不需要 AudioContext）
    const el = this.els[name]
    if (el && el.readyState >= 2) {
      try {
        el.currentTime = 0
        el.volume = Math.min(1, this.vol[name] == null ? 0.5 : this.vol[name])
        const pr = el.play()
        if (pr && pr.catch) pr.catch(() => {})
        return
      } catch (e) { /* 落到合成 */ }
    }
    // ② 兜底：现场合成
    if (!this.ensure()) return
    this.resume()
    switch (name) {
      case "blink":
        this.noise(0.42, { freq: 1500, sweepTo: 420, q: 1.4, gain: 0.055, attack: 0.05 })
        break
      case "breath":
        this.noise(1.7, { type: "lowpass", freq: 460, q: 0.6, gain: 0.075, attack: 0.55 })
        break
      case "cloth":
        this.noise(0.5, { freq: 950, sweepTo: 620, q: 1.1, gain: 0.13, attack: 0.015 })
        break
      case "creak":
        this.tone(132, 0.42, 0.05, "triangle")
        this.noise(0.3, { freq: 700, sweepTo: 380, q: 2.2, gain: 0.05, attack: 0.01 })
        break
    }
  },
}

/* ============================ 苏醒序列（相机实时驱动） ============================ */
/* Idle → FadeOut → Black → EyeOpen → Lying → TurnOver → Sitting → Done
   全部是每帧算出来的相机位姿 + 全屏遮罩，不播视频、不用动画文件。 */

const WAKE = {
  active: false,
  state: 'idle',
  t: 0,            // 当前状态内的时间
  black: 0,        // 全屏黑幕 0..1
  lid: 1,          // 眼睑开合 0=闭合 1=全开
  blur: 0,         // 画面模糊像素
  exposure: 1,     // 曝光 1=正常
  hud: true,       // 是否显示操作提示
}

const WAKE_T = { fade: 2.5, black: 1.0, eye: 4.70, lying: 1.8, turn: 2.8, sit: 3.7 }

/* 相机关键帧（房间坐标）：躺姿 → 侧身 → 看床头柜 → 坐起 */
const WAKE_POSE = {
  lying: { x: -3.02, eye: 0.98, z: -4.45, yaw: Math.PI, pitch: -0.32, roll: 0.00 },
  rollA: { x: -3.00, eye: 0.94, z: -4.42, yaw: Math.PI + 0.36, pitch: -0.22, roll: 0.52 },
  look:  { x: -2.98, eye: 0.98, z: -4.36, yaw: Math.PI + 1.97, pitch: 0.11, roll: 0.08 },
  mid:   { x: -2.38, eye: 1.14, z: -4.28, yaw: Math.PI + 1.97, pitch: 0.09, roll: 0.00 },   // 坐到一半停一下
  sit:   { x: -1.74, eye: 1.36, z: -4.18, yaw: Math.PI + 1.97, pitch: 0.05, roll: 0.00 },   // 坐起时移到床沿外侧，起身后不会站进床里
}

const wLerp = (a, b, k) => a + (b - a) * k
const wEaseInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const wEaseOut = (t) => 1 - Math.pow(1 - t, 3)
const wEaseIn = (t) => t * t * t
const wOver = (t) => { const u = t - 1; return 1 + 2.2 * u * u * u + 1.2 * u * u }   // 轻微过冲
/* 很难睁开：先抬一点点 → 卡住 → 再一口气睁开 */
const wStruggle = (t) => {
  if (t < 0.35) return 0.16 * wEaseOut(t / 0.35)
  if (t < 0.58) return 0.16 + 0.05 * ((t - 0.35) / 0.23)
  return 0.21 + 0.79 * wEaseOut((t - 0.58) / 0.42)
}

const wPose = (a, b, k) => ({
  x: wLerp(a.x, b.x, k), eye: wLerp(a.eye, b.eye, k), z: wLerp(a.z, b.z, k),
  yaw: wLerp(a.yaw, b.yaw, k), pitch: wLerp(a.pitch, b.pitch, k), roll: wLerp(a.roll, b.roll, k),
})

function applyWakePose(p, t, extra) {
  const cam = A0.cam
  cam.x = p.x; cam.z = p.z
  cam.eye = p.eye
  cam.yaw = p.yaw
  cam.pitch = p.pitch
  cam.roll = p.roll
  if (extra && extra.breath) {
    // 呼吸：0.3Hz 低频正弦，叠在俯仰和高度上（幅度极小）
    const br = Math.sin(t * Math.PI * 2 * 0.3)
    cam.pitch += br * 0.012
    cam.eye += br * 0.007
    // 手持抖动：两个不同频率的正弦叠加，避免机械感
    cam.yaw += Math.sin(t * 1.7) * 0.0026 + Math.sin(t * 3.3) * 0.0011
    cam.roll += Math.sin(t * 1.3 + 1.1) * 0.004
  }
}

function startWake() {
  if (!SFX._init) { SFX._init = true; SFX.initFiles() }
  SFX.ensure(); SFX.resume()
  WAKE.nextBreath = 0
  WAKE.active = true
  WAKE.state = 'fade'
  WAKE.t = 0
  WAKE.black = 0
  WAKE.lid = 0
  WAKE.blur = 0
  WAKE.exposure = 1
  WAKE.hud = false
  S.mode = 'act0'                     // 先留在开始界面，黑幕盖过去再换场景
  applyWakePose(WAKE_POSE.lying, 0, null)
  A0.cam.fov = 55 * Math.PI / 180     // 略窄，模拟刚睁眼的对焦
  A0.cam.roll = 0
}

function updateWake(dt) {
  if (!WAKE.active) return
  WAKE.t += dt
  const cam = A0.cam
  const st = WAKE.state
  const t = WAKE.t

  if (st === 'fade') {
    const k = clamp(t / WAKE_T.fade, 0, 1)
    WAKE.black = k                              // 线性淡入黑幕
    WAKE.exposure = 1
    if (k >= 1) { WAKE.state = 'black'; WAKE.t = 0; S.mode = 'room' }   // 全黑时才换场
  } else if (st === 'black') {
    WAKE.black = 1
    if (t >= WAKE_T.black) { WAKE.state = 'eye'; WAKE.t = 0 }
  } else if (st === "eye") {
    // 早上很难睁眼的感觉：
    // ① 第一遍先抬一点点 → 卡住 → 再一口气睁开（wStruggle 曲线）
    // ② 两次之间眼皮慢慢垂下来（合眼 0.7s，不是啪一下闭上）
    // ③ 中间全黑停 0.5s，第二遍才顺畅睁开
    const OPEN = 1.6          // 张开到看全画面的时间
    const CLOSE = 0.7         // 眼皮垂下来的时间
    const GAP = 0.5           // 全黑停住
    let lid = 0, blur = 0, fov = 55, exp = 0.18
    const t1 = 0.30 + OPEN            // 第一遍睁完
    const t2 = t1 + CLOSE             // 合眼完成
    const t3 = t2 + GAP               // 全黑结束
    if (t < 0.30) {
      lid = 0
    } else if (t < t1) {
      const k = (t - 0.30) / OPEN
      lid = wStruggle(k); blur = 9 - 4 * k; fov = 55 + 7 * k; exp = 0.18 + 0.37 * k
    } else if (t < t2) {
      // 眼皮慢慢下垂（ezInOut，越到后面越沉）
      const k = (t - t1) / CLOSE
      lid = 1 - wEaseInOut(k); blur = 5; fov = 62; exp = 0.55
    } else if (t < t3) {
      lid = 0; blur = 5; fov = 62; exp = 0.55
    } else {
      const k = clamp((t - t3) / OPEN, 0, 1)
      lid = wEaseInOut(k); blur = 5 * (1 - k); fov = 62 + 8 * k; exp = 0.55 + 0.45 * k
    }
    // 两次睁眼各响一声眼睑摩擦
    if (t >= 0.30 && !WAKE._snd1) { WAKE._snd1 = true; SFX.play('blink') }
    if (t >= 3.10 && !WAKE._snd2) { WAKE._snd2 = true; SFX.play('blink') }
    WAKE.lid = lid
    WAKE.black = 0                      // 黑幕交给眼睑那条来画
    WAKE.blur = Math.max(0, blur)
    WAKE.exposure = Math.min(1, exp)
    cam.fov = fov * Math.PI / 180
    applyWakePose(WAKE_POSE.lying, A0.t, { breath: true })
    if (t >= WAKE_T.eye) {
      WAKE.state = "lying"; WAKE.t = 0; WAKE.blur = 0; WAKE.exposure = 1
      cam.fov = 70 * Math.PI / 180
    }
  } else if (st === 'lying') {
    if (A0.t >= (WAKE.nextBreath || 0)) { SFX.play('breath'); WAKE.nextBreath = A0.t + 3.4 }
    WAKE.exposure = 1
    applyWakePose(WAKE_POSE.lying, A0.t, { breath: true })
    if (t >= WAKE_T.lying) { WAKE.state = 'turn'; WAKE.t = 0; SFX.play('cloth') }
  } else if (st === 'turn') {
    // 三段：侧身(0.9) → 停顿(0.25) → 转向(1.45) → 收尾(0.2)
    let p, blur
    if (t < 0.9) {
      p = wPose(WAKE_POSE.lying, WAKE_POSE.rollA, wEaseInOut(t / 0.9))
      blur = 2.4 * Math.sin((t / 0.9) * Math.PI)
    } else if (t < 1.15) {
      p = WAKE_POSE.rollA
      blur = 0                                   // 身体调整的停顿
    } else if (t < 2.6) {
      const k = (t - 1.15) / 1.45
      p = wPose(WAKE_POSE.rollA, WAKE_POSE.look, wEaseInOut(k))
      blur = 2.6 * Math.sin(k * Math.PI)
    } else {
      p = WAKE_POSE.look
      blur = 0
    }
    WAKE.blur = blur
    applyWakePose(p, A0.t, { breath: true })
    if (t >= WAKE_T.turn) { WAKE.state = 'sit'; WAKE.t = 0; SFX.play('cloth'); setTimeout(() => SFX.play('creak'), 220) }
  } else if (st === 'sit') {
    // 起身：两段平移，中间顿一下（速度放慢了一档）
    // 第一段 1.05s → 顿 0.5s → 第二段 1.05s → 过冲回正 0.3s → 站直
    const SEG1 = 1.05, PAUSE = 0.5, SEG2 = 1.05, SETTLE = 0.3
    const t1 = SEG1
    const t2 = t1 + PAUSE
    const t3 = t2 + SEG2
    const t4 = t3 + SETTLE
    let p
    if (t < t1) {
      p = wPose(WAKE_POSE.look, WAKE_POSE.mid, wEaseOut(t / SEG1))       // 撑起来，先快后慢
    } else if (t < t2) {
      p = { ...WAKE_POSE.mid }                                           // 顿住，只有呼吸
    } else if (t < t3) {
      p = wPose(WAKE_POSE.mid, WAKE_POSE.sit, wEaseInOut((t - t2) / SEG2))  // 把腿挪过去，两头都慢
    } else if (t < t4) {
      const k = (t - t3) / SETTLE                                         // 过冲回正
      p = { ...WAKE_POSE.sit }
      p.eye += Math.sin(k * Math.PI) * 0.022
      p.pitch += Math.sin(k * Math.PI) * 0.012
    } else if (t < WAKE_T.sit) {
      const k = (t - t4) / (WAKE_T.sit - t4)                              // 站直，交还控制
      p = wPose(WAKE_POSE.sit, { ...WAKE_POSE.sit, eye: ACT0.eyeHeight }, wEaseInOut(k))
    } else {
      p = { ...WAKE_POSE.sit, eye: ACT0.eyeHeight }
    }
    WAKE.blur = 0
    applyWakePose(p, A0.t, { breath: true })
    if (t >= WAKE_T.sit) finishWake()
  }
}

function finishWake() {
  // 第 0 幕起床后：底部旁白
  A0_SUB.on = true
  A0_SUB.t = 0
  A0_SUB.done = false
  WAKE.active = false
  WAKE.state = 'done'
  WAKE.blur = 0
  WAKE.black = 0
  WAKE.exposure = 1
  WAKE.lid = 1
  WAKE.hud = true
  const cam = A0.cam
  cam.eye = undefined            // 回到正常的走路视高
  cam.fov = undefined
  cam.roll = 0
  cam.pitch = clamp(cam.pitch, -0.2, 0.2)
}

/* 调试/自动化用：立刻结束苏醒序列，直接站到床前 */
function skipWake() {
  if (!WAKE.active) return
  S.mode = 'room'
  finishWake()
  const cam = A0.cam
  cam.x = WAKE_POSE.sit.x
  cam.z = WAKE_POSE.sit.z
  cam.yaw = WAKE_POSE.sit.yaw
  cam.pitch = WAKE_POSE.sit.pitch
  cam.roll = 0
  cam.eye = undefined
}

/* 全屏后处理：黑幕 / 眼睑 / 曝光 */
function drawWakeOverlay() {
  if (!WAKE.active) return
  const g = ctx
  g.save()
  g.setTransform(DPR, 0, 0, DPR, 0, 0)

  // 曝光不足：整体压暗
  if (WAKE.exposure < 0.999) {
    g.fillStyle = `rgba(0,0,0,${(1 - WAKE.exposure).toFixed(3)})`
    g.fillRect(0, 0, W, H)
  }

  if (WAKE.state === 'eye') {
    // 上下两条眼睑，从中间向上下退开；边缘带一点柔和过渡
    const half = (H / 2) * (1 - WAKE.lid)
    const soft = Math.max(6, H * 0.02)
    let grd = g.createLinearGradient(0, Math.max(0, half - soft), 0, half)
    grd.addColorStop(0, 'rgba(0,0,0,1)')
    grd.addColorStop(1, 'rgba(0,0,0,0)')
  
  g.fillStyle = '#000'
    g.fillRect(0, 0, W, Math.max(0, half - soft))
    g.fillStyle = grd
    g.fillRect(0, Math.max(0, half - soft), W, soft)
    grd = g.createLinearGradient(0, H - half, 0, Math.min(H, H - half + soft))
    grd.addColorStop(0, 'rgba(0,0,0,0)')
    grd.addColorStop(1, 'rgba(0,0,0,1)')
    g.fillStyle = grd
    g.fillRect(0, H - half, W, soft)
    g.fillStyle = '#000'
    g.fillRect(0, Math.min(H, H - half + soft), W, half)
  } else if (WAKE.black > 0.001) {
    g.fillStyle = `rgba(0,0,0,${WAKE.black.toFixed(3)})`
    g.fillRect(0, 0, W, H)
  }

  g.restore()
}

/* ============================ 房间里的两个交互点 ============================ */
/* ① 书架上那本红皮笔记本：靠近按 E 取下
   ② 书桌前的椅子：拿着书靠近按 E 坐下 → 坐姿过场 → 第一幕 */
const SHELF_BOOK = { x: 2.54, y: 1.06, z: -5.01, r: 1.55 }     // 书架上那本书
const DESK_SEAT = { x: 3.05, z: 1.88, r: 1.75 }                // 书桌前的椅子

function distTo(p) {
  return Math.hypot(A0.cam.x - p.x, A0.cam.z - p.z)
}
function nearShelfBook() {
  return A0.bookState !== "held" && distTo(SHELF_BOOK) <= SHELF_BOOK.r
}
function nearDeskSeat() {
  return A0.bookState === "held" && distTo(DESK_SEAT) <= DESK_SEAT.r
}

function takeShelfBook() {
  if (A0.locked || A0.bookState === "held") return
  showTip('现在去书桌前构思构思吧', 3)
  A0.bookState = "held"
  A0.bookTaken = true
  refreshFurniture()          // 让它从书架上消失
}

/* 家具是初始化时烘焙的静态顶点缓冲；拿走书之后重建一次 */
function refreshFurniture() {
  if (!GL3D.ready) return
  const furn = buildFurniture()
  const gl = GL3D.gl
  gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.furn)
  gl.bufferData(gl.ARRAY_BUFFER, furn.data, gl.STATIC_DRAW)
  GL3D.furnCount = furn.count
  gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.emit)
  gl.bufferData(gl.ARRAY_BUFFER, furn.emit, gl.STATIC_DRAW)
  GL3D.emitCount = furn.emitCount
}

function sitAtDesk() {
  if (A0.locked || A0.bookState !== "held") return
  startDeskScene()
}

function updateRoom(dt) {
  A0.t += dt
  const cam = A0.cam
  if (WAKE.active) return          // 苏醒序列期间由相机控制器接管，锁输入
  A0.nearShelf = !A0.locked && nearShelfBook()
  A0.nearSeat = !A0.locked && nearDeskSeat()
  if (A0.locked) return            // 转场淡出期间不给动
  const hw = ACT0.roomW / 2 - 0.35
  const hd = ACT0.roomD / 2 - 0.35
  let fx = 0, fz = 0
  if (roomKeys['KeyW'] || roomKeys['ArrowUp']) fz -= 1
  if (roomKeys['KeyS'] || roomKeys['ArrowDown']) fz += 1
  if (roomKeys['KeyA'] || roomKeys['ArrowLeft']) fx -= 1
  if (roomKeys['KeyD'] || roomKeys['ArrowRight']) fx += 1
  A4.walking = false
  const len = Math.hypot(fx, fz)
  if (len > 0.001) {
    fx /= len
    fz /= len
    // 相机前方向 = (-sin, -cos)、右方向 = (cos, -sin)。
    // 之前用 (sin, -cos) 当前方向，只有 yaw=0 时才对得上，一转视角走路就歪 → "没法正常移动"。
    const cs = Math.cos(cam.yaw)
    const sn = Math.sin(cam.yaw)
    const wx = fx * cs + fz * sn
    const wz = -fx * sn + fz * cs
    const sp = ACT0.walkSpeed * dt
    // 分轴移动：先试 X 再试 Z；撞到家具只废掉那一根轴，另一根还能走 → 能顺着家具边滑
    const nx2 = clamp(cam.x + wx * sp, -hw, hw)
    if (!hitsFurniture(nx2, cam.z)) cam.x = nx2
    const nz2 = clamp(cam.z + wz * sp, -hd, hd)
    if (!hitsFurniture(cam.x, nz2)) cam.z = nz2
    A0.walked += sp
  }
  // 上下看：Q/E 或 PageUp/PageDown
  if (roomKeys['KeyQ'] || roomKeys['PageUp']) cam.pitch = clamp((cam.pitch ?? 0) - dt * 0.9, -1.1, 1.1)   // Q = 抬头
  if (roomKeys['KeyE'] || roomKeys['PageDown']) cam.pitch = clamp((cam.pitch ?? 0) + dt * 0.9, -1.1, 1.1)  // E = 低头
}

/* 开发者模式：把家具碰撞体画成线框（只用相机投影，不改 3D） */
function drawColliderWireframe(g) {
  if (!A0.devMode || WAKE.active) return   // 苏醒演出期间不画，免得穿帮
  const box3d = (b) => {
    const y0 = 0.02, y1 = b.h ?? 1.0
    return {
      bottom: [[b.x0, y0, b.z0], [b.x1, y0, b.z0], [b.x1, y0, b.z1], [b.x0, y0, b.z1]],
      top: [[b.x0, y1, b.z0], [b.x1, y1, b.z0], [b.x1, y1, b.z1], [b.x0, y1, b.z1]],
    }
  }
  if (A6.started) return   // 片尾演出时不显示家具高亮框和标签
  g.save()
  g.setTransform(DPR, 0, 0, DPR, 0, 0)
  g.lineWidth = 1.5
  g.font = `500 ${Math.round(H * 0.014)}px ${CFG.fontFamily}`
  g.textAlign = 'center'
  g.textBaseline = 'bottom'
  for (const b of ROOM_COLLIDERS) {
    const { bottom, top } = box3d(b)
    const pb = bottom.map((p) => worldToScreen(p[0], p[1], p[2], W, H))
    const pt = top.map((p) => worldToScreen(p[0], p[1], p[2], W, H))
    if (pb.some((p) => !p) || pt.some((p) => !p)) continue
    // 底面 / 顶面
    for (const [ring, col] of [[pb, 'rgba(90,200,255,0.85)'], [pt, 'rgba(90,200,255,0.45)']]) {
      g.strokeStyle = col
      g.beginPath()
      g.moveTo(ring[0].x, ring[0].y)
      for (let i = 1; i < 4; i++) g.lineTo(ring[i].x, ring[i].y)
      g.closePath()
      g.stroke()
    }
    // 四根立边
    g.strokeStyle = 'rgba(90,200,255,0.55)'
    g.beginPath()
    for (let i = 0; i < 4; i++) {
      g.moveTo(pb[i].x, pb[i].y)
      g.lineTo(pt[i].x, pt[i].y)
    }
    g.stroke()
    // 名字
    if (pt[0] && pt[2]) {
      const cx2 = (pt[0].x + pt[2].x) / 2
      const cy2 = Math.min(pt[0].y, pt[1].y, pt[2].y, pt[3].y)
      g.fillStyle = 'rgba(90,200,255,0.95)'
      g.fillText(b.n, cx2, cy2 - 4)
    }
  }
  g.restore()
}

/* ============================ 坐姿过场：桌面 + 笔记本 ============================ */
/* 相机固定在椅面头部高度俯视桌面；笔记本由代码生成几何，每帧重建顶点（几百个，
   走 GL3D.book 动态缓冲），封面开合与翻页都是实时算的旋转+弯曲，不是预烘焙动画。 */

const BOOKV = []          // 每帧重建：封面/书脊（走材质图集）
const BOOKP = []          // 每帧重建：内页（走页面纹理）
const BOOKC = []          // 每帧重建：牛皮封面/封底/书脊（走牛皮纹理）
const BOOKA = []          // 右侧第一页（带字）
const BOOKB = []          // 左侧主页 / 翻起那叠的页背（带字）
let BOOK_RAW_UV = false   // true = UV 直接用 0..1，不经过图集

const DESK = {
  active: false,
  t: 0,
  seatX: 3.00, seatZ: 1.90, seatEye: 1.24, seatYaw: -Math.PI / 2, seatPitch: 0.44,
  // 本子状态
  pos: { x: 0, y: 0, z: 0 },
  yaw: Math.PI / 2, tilt: 0,
  cover: 0,          // 封面翻开角度 0..PI
  flip: 0,           // 当前正在翻的那一页 0..PI
  flipOn: false,
  flipped: 0,        // 已翻页数
  flipP: 0,
  leftH: 0, rightH: 0,      // 左右页堆厚度（离散，翻动中左边不长）
  blockOn: false, blockAng: 0,   // 正在翻的那一大叠
  showA: false, showB: false,
  push: 0, pushNow: 0,      // 读页面时相机前凑    // 右侧第一页 / 左侧主页是否显示
  pages: 0,          // 总页数（动画用）
  lean: 0,           // 相机前倾
  phase: 'idle',
  // 本子尺寸（米）
  W: 0.215, H: 0.300, BK: 0.014,
  COVER: 0.009,      // 封面厚度
  RIGHT: 0.040,      // 当前右侧页堆厚度（会变）
  RIGHT0: 0.040,     // 合着时的总厚（定转轴用，不变）
  RIGHT_FINAL: 0.016, // 翻走 20 页之后剩下的
  BLOCK20: 0.024,    // 那 20 页的厚度
  PAGE: 0.0045,      // 单张纸厚度
  cvAng: 0, p1Ang: 0, blk20Ang: 0, blk20On: false,
  deskX: 3.62, deskY: 0.841, deskZ: 1.93,
}

/* 书本局部坐标 → 世界坐标：先绕书脊（局部 x 轴）转 th，再绕竖轴转 yaw，再平移到 pos */
function bookPt(u, y, v, th, pivotY) {
  const py = pivotY || 0
  const yy = y - py
  const c = Math.cos(th), s = Math.sin(th)
  const x1 = u * c - yy * s
  const y1 = u * s + yy * c + py
  const cy = Math.cos(DESK.yaw), sy = Math.sin(DESK.yaw)
  const x2 = x1 * cy - v * sy
  const z2 = x1 * sy + v * cy
  return [DESK.pos.x + x2, DESK.pos.y + y1 + DESK.tilt * 0.0001, DESK.pos.z + z2]
}

function bq(out, pts, th, pivotY, mat, shade) {
  const P = pts.map((p) => bookPt(p[0], p[1], p[2], th, pivotY))
  const a = P[0], b = P[1], d = P[3]
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len; ny /= len; nz /= len
  const uvq = [[0, 0], [1, 0], [1, 1], [0, 1]]
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const p = P[i]
    const uv = BOOK_RAW_UV ? uvq[i] : tileUV(mat, uvq[i][0], uvq[i][1])
    out.push(p[0], p[1], p[2], uv[0], uv[1], shade, shade, shade, nx, ny, nz)
  }
}

/* 一块板（6 面） */
function bSlab(out, u0, u1, y0, y1, v0, v1, th, pivotY, mat, shade) {
  bq(out, [[u0, y1, v1], [u1, y1, v1], [u1, y1, v0], [u0, y1, v0]], th, pivotY, mat, shade)        // 顶
  bq(out, [[u0, y0, v0], [u1, y0, v0], [u1, y1, v0], [u0, y1, v0]], th, pivotY, mat, shade * 0.9)  // 边
  bq(out, [[u1, y0, v1], [u0, y0, v1], [u0, y1, v1], [u1, y1, v1]], th, pivotY, mat, shade * 0.9)
  bq(out, [[u0, y0, v0], [u0, y0, v1], [u0, y1, v1], [u0, y1, v0]], th, pivotY, mat, shade * 0.86)
  bq(out, [[u1, y0, v1], [u1, y0, v0], [u1, y1, v0], [u1, y1, v1]], th, pivotY, mat, shade * 0.86)
  bq(out, [[u0, y0, v0], [u1, y0, v0], [u1, y0, v1], [u0, y0, v1]], th, pivotY, mat, shade * 0.7)  // 底
}

/* 一张纸（会被弯曲）：沿 u 方向切成 seg 段，每段角度从 th0 渐变到 th1 */
function bPage(out, u0, u1, y, v0, v1, th0, th1, seg, mat, shade, pivotY) {
  const py = pivotY || 0
  for (let i = 0; i < seg; i++) {
    const k0 = i / seg, k1 = (i + 1) / seg
    const ua = u0 + (u1 - u0) * k0, ub = u0 + (u1 - u0) * k1
    const ta = th0 + (th1 - th0) * k0, tb = th0 + (th1 - th0) * k1
    const A = bookPt(ua, y, v0, ta, py), B = bookPt(ua, y, v1, ta, py)
    const C = bookPt(ub, y, v1, tb, py), D = bookPt(ub, y, v0, tb, py)
    const ux = C[0] - A[0], uy = C[1] - A[1], uz = C[2] - A[2]
    const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    const uvq = [[0, 0], [0, 1], [1, 1], [1, 0]]
    const P = [A, B, C, D]
    for (const idx2 of [0, 1, 2, 0, 2, 3]) {
      const p = P[idx2]
      const uv = BOOK_RAW_UV ? uvq[idx2] : tileUV(mat, uvq[idx2][0], uvq[idx2][1])
      out.push(p[0], p[1], p[2], uv[0], uv[1], shade, shade, shade, nx, ny, nz)
    }
  }
}

/* 一张平整的纸（贴文字用）；mirrorU = 翻过来让背面文字仍然正着读 */
function bSheet(out, u0, u1, y, v0, v1, th, pivotY, mirrorU) {
  const py = pivotY || 0
  const A = bookPt(u0, y, v0, th, py), B = bookPt(u0, y, v1, th, py)
  const C = bookPt(u1, y, v1, th, py), D = bookPt(u1, y, v0, th, py)
  const ux = C[0] - A[0], uy = C[1] - A[1], uz = C[2] - A[2]
  const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len; ny /= len; nz /= len
  const uA = mirrorU ? 1 : 0, uB = mirrorU ? 0 : 1
  const P = [A, B, C, D]
  const UV = [[uA, 0], [uA, 1], [uB, 1], [uB, 0]]
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const p = P[i]
    out.push(p[0], p[1], p[2], UV[i][0], UV[i][1], 1, 1, 1, nx, ny, nz)
  }
}

/* 重建整本书：四个独立部件，每个都有正反两面
   ① 封面（牛皮，外深内浅）  ② 第一页（正面贴文字 A）
   ③ 20 页那一摞（背面贴文字 B）  ④ 右侧没翻的页堆
   四个部件共用同一条转轴：书脊外侧（u=0, y=pivot）。
   pivot 取"合着时整本书的中间高度"，于是翻转 180° 后：
   封面落到桌面(0) → 第一页落到封面背面(BKC) → 20 页摞落到第一页上，自然摞成一叠。 */
function buildBook() {
  BOOKV.length = 0
  BOOKP.length = 0
  BOOKC.length = 0
  BOOKA.length = 0
  BOOKB.length = 0
  const W = DESK.W, H = DESK.H, BK = DESK.BK
  const v0 = -H / 2, v1 = H / 2
  const BKC = DESK.COVER        // 封面厚度
  const RH = DESK.RIGHT         // 右侧页堆总厚
  const BTH = DESK.BLOCK20      // 那 20 页的厚度
  const PT = DESK.PAGE         // 单张纸厚度（够厚，正面贴图不会穿到背面）
  const pivot = BK + DESK.RIGHT0 + BKC   // 同一条转轴：书脊外侧（合着时的书顶面）
  const lifted = DESK.blk20On ? BTH : 0  // 20 页被掀起时离开右页堆
  const Rstack = Math.max(0.002, RH - PT - BTH)   // 右堆 = 总厚 - 那一整块
  // 各自的落定角（和 updateDesk 里一致），用来把"弯曲"归一化到 0..1 的进度
  const AC = DESK.angC || Math.PI
  const AP = DESK.angP1 || Math.PI
  const A20 = DESK.ang20 || Math.PI
  // 弯曲：翻动中先弯起来，落到页面上时完全摊平（起 0 → 中间最大 → 落定 0）
  const bendAt = (ang, final, amp) =>
    Math.sin(Math.PI * Math.max(0, Math.min(1, ang / Math.max(0.001, final)))) * amp

  // ① 接触阴影
  BOOK_RAW_UV = false
  const shPad = 0.024
  bq(BOOKV, [[-shPad, -0.0006, v0 - shPad], [W + shPad, -0.0006, v0 - shPad],
             [W + shPad, -0.0006, v1 + shPad], [-shPad, -0.0006, v1 + shPad]], 0, 0, MAT.woodD, 0.60)

  // ② 封底 + 书脊（牛皮；书脊从底连到顶）
  BOOK_RAW_UV = true
  bSlab(BOOKC, -0.006, W + 0.006, 0, BK, v0 - 0.006, v1 + 0.006, 0, 0, MAT.woodD, 0.90)
  bSlab(BOOKC, -0.013, 0.004, 0, BK + RH, v0 - 0.006, v1 + 0.006, 0, 0, MAT.woodD, 0.74)
  BOOK_RAW_UV = false

  // ③ 右侧没翻的页堆（20 页被掀起时变薄）
  const rH = Math.max(0.002, Rstack - lifted)
  BOOK_RAW_UV = true
  bSlab(BOOKP, 0, W, BK, BK + rH, v0, v1, 0, 0, MAT.paper, 1.0)
  BOOK_RAW_UV = false

  // ④ 一整块（第一页 + 20 页合并）：正面贴文字 A，背面贴文字 B
  {
    const th = DESK.blk20Ang
    const BT2 = PT + BTH                      // 第一页 + 20 页的总厚
    const y0 = BK + Rstack + 0.002
    const layers = 5
    for (let i = 0; i < layers; i++) {
      const lag = bendAt(th, A20, 0.03) * (i - (layers - 1) / 2)
      const bow = bendAt(th, A20, 0.30)
      const yl = y0 + (BT2 - 0.002) * i / layers
      BOOK_RAW_UV = true
      bPage(BOOKP, 0, W, yl, v0, v1, th + lag, th + lag + bow, 10, MAT.paper, 1.0, pivot)
      BOOK_RAW_UV = false
    }
    BOOK_RAW_UV = true
    bSheet(BOOKA, 0, W, y0 + BT2 + 0.0016, v0, v1, th, pivot, false)   // 正面：文字 A
    bSheet(BOOKB, 0, W, y0 - 0.003, v0, v1, th, pivot, true)           // 背面：文字 B
    BOOK_RAW_UV = false
  }

  // ⑥ 封面：绕同一条轴翻开，落到桌面；外侧牛皮、内侧浅色
  {
    const th = DESK.cvAng
    const bow = bendAt(th, AC, 0.10)
    const yTop = BK + RH + BKC                // 合着时盖在最上面
    BOOK_RAW_UV = true
    bPage(BOOKC, 0, W + 0.006, yTop, v0 - 0.006, v1 + 0.006, th, th + bow, 5, MAT.woodD, 1.0, pivot)
    bPage(BOOKC, 0, W + 0.006, yTop - BKC, v0 - 0.006, v1 + 0.006, th, th + bow, 5, MAT.woodD, 0.62, pivot)
    BOOK_RAW_UV = false
  }
}

/* ============================ 墨点（第二步） ============================ */
/* 纯 2D 叠加层：每个墨点是一个"有机形状"（极坐标半径乘多段正弦），
   诞生瞬间膨胀→收缩，随后持续洇开；随时间不断从左侧后方冒新点。 */
const INK3D = []          // 每帧重建的墨块顶点（走 GL）
const INK = {
  on: false,
  t: 0,
  blobs: [],
  seed: 1,
}

function inkRand() {
  INK.seed = (INK.seed * 1103515245 + 12345) & 0x7fffffff
  return INK.seed / 0x7fffffff
}

function startInk() {
  INK.on = true
  INK.t = 0
  INK.blobs = []
  INK.seed = 20251022
}

function updateInk(dt, W2, H2) {
  if (!INK.on) return
  INK.t += dt
  // 前 3.2 秒不断冒新点，密度递增
  const rate = 26 * Math.min(1, INK.t / 3.2)
  if (INK.blobs.length < rate) {
    // 位置偏向画面左下 / 左中（左后方那片区域）
    // 世界坐标：房间左后方那一带（x 小、z 小），y 在腰到顶之间
    const wx = -4.2 + inkRand() * 3.4
    const wy = 0.2 + inkRand() * 2.6
    const wz = -5.2 + inkRand() * 4.2
    INK.blobs.push({
      x: wx, y: wy, z: wz,
      born: INK.t,
      r: 0.22 + inkRand() * 0.30,
      grow: 0.55 + inkRand() * 0.75,
      seed: inkRand() * 100,
      wob: 3 + Math.floor(inkRand() * 3),
    })
  }
  // 覆盖度：新点 + 每个点的半径增长
  let cover = 0
  for (const b of INK.blobs) {
    const age = INK.t - b.born
    const pop = age < 0.12 ? 1.15 : (age < 0.26 ? 1 - (age - 0.12) / 0.14 * 0.18 : 0.82)
    b.rad = b.r * pop * (1 + age * b.grow * 2.4)
    cover += Math.PI * b.rad * b.rad
  }
  INK.cover = Math.min(1, cover / (9 * 11 * 3.1 * 0.55))
  buildInk3D()
}

/* 世界坐标的三角形（直接写进 PUSH_TARGET，不套用书本变换） */
function inkTri(a, b, c, shade) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len; ny /= len; nz /= len
  const uv = tileUV(MAT.dark, 0.5, 0.5)
  for (const p of [a, b, c]) {
    PUSH_TARGET.push(p[0], p[1], p[2], uv[0], uv[1], shade, shade, shade, nx, ny, nz)
  }
}

function drawFlash() {
  const g = ctx
  g.save()
  g.setTransform(DPR, 0, 0, DPR, 0, 0)
  const f = DESK.flash || 0
  const d = DESK.dive || 0
  const T = A0.t
  const a0 = Math.min(1, 0.55 * f + 0.5 * d)

  // Tyndall: hard-edged light shafts from the window, not a soft radial bloom
  const wx = W * 0.66, wy = H * 0.26
  const beams = 7
  for (let i = 0; i < beams; i++) {
    const k = (i / (beams - 1)) - 0.5
    const spread = 0.10 + 0.05 * Math.sin(T * 0.7 + i)
    const y1 = H * (0.10 + k * spread * 2.2 - d * 0.5)
    const y2 = H * (0.98 + k * spread * 2.6 - d * 0.3)
    g.beginPath()
    g.moveTo(wx, wy)
    g.lineTo(W * 1.25, y1)
    g.lineTo(W * 1.25, y2)
    g.closePath()
    const lg = g.createLinearGradient(wx, wy, W * 1.1, (y1 + y2) / 2)
    const aa = a0 * (0.16 + 0.10 * Math.cos(k * 3.1 + T * 0.5))
    lg.addColorStop(0, "rgba(255,251,235," + aa.toFixed(3) + ")")
    lg.addColorStop(0.55, "rgba(255,249,228," + (aa * 0.45).toFixed(3) + ")")
    lg.addColorStop(1, "rgba(255,248,225,0.012)")
    g.fillStyle = lg
    g.fill()
  }

  // dust drifting in the beams
  const specks = 90
  for (let i = 0; i < specks; i++) {
    const hx = Math.sin(i * 12.9898) * 43758.5453
    const hy = Math.sin(i * 78.233) * 43758.5453
    const sx = (hx - Math.floor(hx)) * W
    const sy = ((hy - Math.floor(hy)) + T * 0.02 * (0.4 + (i % 5) * 0.15)) % 1 * H
    const sz = 0.8 + (i % 4) * 0.5
    g.fillStyle = "rgba(255,252,238," + (a0 * 0.55).toFixed(3) + ")"
    g.beginPath()
    g.arc(sx, sy, sz, 0, Math.PI * 2)
    g.fill()
  }

  // window blown to pure white
  if (f > 0.05) {
    const rg = g.createRadialGradient(wx, wy, 0, wx, wy, H * (0.35 + f * 0.5))
    rg.addColorStop(0, "rgba(255,255,252," + Math.min(1, f * 1.2).toFixed(3) + ")")
    rg.addColorStop(0.5, "rgba(255,255,250," + Math.min(1, f * 0.5).toFixed(3) + ")")
    rg.addColorStop(1, "rgba(255,255,250,0)")
    g.fillStyle = rg
    g.fillRect(0, 0, W, H)
  }

  // falling into the light: whole screen to pure white, then hold
  if (d > 0.35) {
    const k = Math.min(1, (d - 0.35) / 0.65)
    g.fillStyle = "rgba(255,255,255," + k.toFixed(3) + ")"
    g.fillRect(0, 0, W, H)
  }
  g.restore()
}

function buildInk3D() {
  INK3D.length = 0
  if (!INK.on) return
  const keep = PUSH_TARGET
  PUSH_TARGET = INK3D

  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
  const R = (n, a, b) => a + hash(n) * (b - a)

  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    const uv = tileUV(MAT.dark, 0.5, 0.5)
    for (const p of [a, b, c]) {
      PUSH_TARGET.push(p[0], p[1], p[2], uv[0], uv[1], 0.06, 0.06, 0.06, nx, ny, nz)
    }
  }

  // 一个墨点：编号 i 决定位置、朝向、大小，出现后永不变
  const drawBlob = (i) => {
    const r = R(i * 11.1 + 1, 0.16, 0.42)
    const x = R(i * 13.7 + 2, -4.4, 4.4)
    const y = R(i * 17.3 + 3, 0.04, 2.95)
    const z = R(i * 19.1 + 4, -5.4, 5.4)
    const sel = hash(i * 7.3)
    let axis
    if (y < 0.3 || y > 2.7) axis = 'y'
    else if (Math.abs(x) > 4.0) axis = 'x'
    else if (Math.abs(z) > 4.9) axis = 'z'
    else axis = sel < 0.34 ? 'y' : (sel < 0.67 ? 'x' : 'z')
    const seed = i * 1.7
    const SEG = 8
    for (let k = 0; k < SEG; k++) {
      const a1 = (k / SEG) * Math.PI * 2
      const a2 = ((k + 1) / SEG) * Math.PI * 2
      const w1 = 1 + 0.20 * Math.sin(a1 * 3 + seed) + 0.10 * Math.sin(a1 * 5 + seed * 1.7)
      const w2 = 1 + 0.20 * Math.sin(a2 * 3 + seed) + 0.10 * Math.sin(a2 * 5 + seed * 1.7)
      const u1 = Math.cos(a1) * r * w1, v1 = Math.sin(a1) * r * w1
      const u2 = Math.cos(a2) * r * w2, v2 = Math.sin(a2) * r * w2
      let A, B, C
      if (axis === 'y') { A = [x, y, z]; B = [x + u1, y, z + v1]; C = [x + u2, y, z + v2] }
      else if (axis === 'x') { A = [x, y, z]; B = [x, y + u1, z + v1]; C = [x, y + u2, z + v2] }
      else { A = [x, y, z]; B = [x + u1, y + v1, z]; C = [x + u2, y + v2, z] }
      tri(A, B, C)
    }
  }

  // 滚动生成：每秒 12 个，永不停止；同时最多保留 260 个
  const STEP = 1 / 160
  const nowI = Math.floor(INK.t / STEP)
  const from = Math.max(0, nowI - 1500)
  let n = 0
  for (let i = from; i <= nowI; i++) {
    if (INK.t - i * STEP < 0.10) continue
    drawBlob(i)
    n++
  }
  INK.drawn = n
  INK.born = nowI + 1
  INK.cover = Math.min(1, INK.born / 1480)
  PUSH_TARGET = keep
}
function drawInk(g, W2, H2) {
  if (!INK.on || !INK.blobs.length) return
  g.save()
  g.setTransform(DPR, 0, 0, DPR, 0, 0)
  for (const b of INK.blobs) {
    const r = b.rad || b.r
    if (r < 0.5) continue
    // 有机边缘：半径乘 1 + 0.18*sin(3θ+seed) + 0.1*sin(7θ)
    g.beginPath()
    const steps = 42
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const k = 1 + 0.18 * Math.sin(a * b.wob + b.seed) + 0.1 * Math.sin(a * 7 + b.seed * 1.7)
      const px = b.x + Math.cos(a) * r * k
      const py = b.y + Math.sin(a) * r * k * 0.92
      if (i === 0) g.moveTo(px, py)
      else g.lineTo(px, py)
    }
    g.closePath()
    g.fillStyle = 'rgba(5,4,6,0.96)'
    g.fill()
    g.strokeStyle = 'rgba(120,126,146,0.34)'
    g.lineWidth = 1.6
    g.stroke()
    // 湿润反光：一道很淡的弧形高光
    const hg = g.createRadialGradient(b.x - r * 0.3, b.y - r * 0.35, r * 0.1, b.x, b.y, r * 1.05)
    hg.addColorStop(0, 'rgba(90,95,110,0.18)')
    hg.addColorStop(0.45, 'rgba(20,18,24,0.06)')
    hg.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = hg
    g.fill()
  }
  g.restore()
}

/* 进入坐姿过场 */
function startDeskScene() {
  A0.locked = true
  roomKeys = Object.create(null)
  fadeTo(1, 0.8, () => {
    S.mode = 'desk'
    DESK.active = true
    DESK.t = 0
    DESK.phase = 'seated'
    DESK.cover = 0
    DESK.flip = 0
    DESK.flipOn = false
    DESK.flipped = 0
    DESK.flipP = 0
    DESK.RIGHT = 0.040
    DESK.cvAng = 0
    DESK.p1Ang = 0
    DESK.blk20Ang = 0
    DESK.blk20On = false
    DESK.push = 0
    DESK.pushNow = 0
  DESK.shake = 0
  DESK.cine = 0
  DESK.flash = 0
  DESK.flashStart = 0
  DESK.roll = 0
  DESK.dive = 0
  DESK.finished = false
  DESK.cineNow = 0
  DESK.yawAdd = 0
  DESK.blurNow = 0
    DESK.lean = 0
    DESK.tilt = 0
    DESK.yaw = -0.30
    DESK.pos = { x: 3.02, y: 0.52, z: 1.94 }     // 先藏在桌沿下方的"手里"
    fadeTo(0, 1.2)
  })
}

const easeIO = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const easeO = (t) => 1 - Math.pow(1 - t, 3)
const easeI = (t) => t * t * t

function updateDesk(dt) {
  if (!DESK.active) return
  DESK.t += dt
  A0.t += dt          // 呼吸与震动的噪声都以 A0.t 为时间基，这里必须推进
  const t = DESK.t
  // 落定角：书脊一侧架在 pivot 高度、另一侧搭在下面的东西上 → 相对桌面自然倾斜
  const _W = DESK.W, _BK = DESK.BK, _BKC = DESK.COVER, _RH = DESK.RIGHT0, _PT = DESK.PAGE
  // 转轴 = 书脊外侧（合着时整本书的顶面）
  const _pivot = _BK + _RH + _BKC
  // 静止角：二分求解，保证零件最低点正好压到支撑面上（厚摞不能用薄壳公式，会悬空）
  const restAngle = (support, ya) => {
    const f = (d) => -_W * Math.sin(d) + (ya - _pivot) * Math.cos(d) + _pivot - support
    let lo = 0, hi = Math.PI / 2
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m }
    return Math.PI + (lo + hi) / 2
  }
  const _yTop = _BK + _RH
  const ANG_COVER = restAngle(0, _yTop - _BKC)                    // 封面底面搭桌面
  const ANG_P1 = restAngle(_BKC, _yTop - _PT)                     // 第一页底面搭封面
  const ANG_20 = restAngle(_BKC + _PT, _yTop - DESK.BLOCK20)
  DESK.angC = ANG_COVER; DESK.angP1 = ANG_P1; DESK.ang20 = ANG_20      // 20 页底面搭第一页
  const cam = A0.cam

  // —— 坐姿相机：固定位置 + 呼吸 + 极轻手持；读页面时整体往前凑 ——
  DESK.pushNow = (DESK.pushNow || 0) + ((DESK.push || 0) - (DESK.pushNow || 0)) * Math.min(1, dt * 2.0)
  const push = DESK.pushNow
  DESK.leanNow = (DESK.leanNow || 0) + ((DESK.lean || 0) - (DESK.leanNow || 0)) * Math.min(1, dt * 3.0)
  DESK.cineNow = (DESK.cineNow || 0) + ((DESK.cine || 0) - (DESK.cineNow || 0)) * Math.min(1, dt * 2.0)
  cam.x = DESK.seatX + push * 0.30
  cam.z = DESK.seatZ
  cam.eye = DESK.seatEye - push * 0.035
  // 转头量 + 高频震动（8~12Hz 噪声），震动强度由 DESK.shake 控制
  const _q = DESK.shake || 0
  const _qy = (Math.sin(A0.t * 71) * 0.6 + Math.sin(A0.t * 113) * 0.4) * 0.0225 * _q
  const _qp = (Math.sin(A0.t * 89) * 0.6 + Math.sin(A0.t * 137) * 0.4) * 0.0175 * _q
  cam.yaw = DESK.seatYaw + (DESK.yawAdd || 0) + _qy + Math.sin(A0.t * 1.3) * 0.0018 + Math.sin(A0.t * 0.7) * 0.0012
  cam.pitch = DESK.seatPitch + Math.sin(A0.t * Math.PI * 2 * 0.3) * 0.007 + (DESK.leanNow || 0) + push * 0.07 + _qp + Math.sin(A0.t * 2.1) * 0.0016
  cam.roll = Math.sin(A0.t * 1.1) * 0.0024 + (DESK.roll || 0)
  if (DESK.dive) cam.pitch -= DESK.dive * 0.25
  cam.fov = 62 * Math.PI / 180
  // 过场段：视角抬到站立高度、转到与地板平行（pitch = 0）
  const _cine = DESK.cineNow || 0
  if (_cine > 0.001) {
    cam.eye = cam.eye * (1 - _cine) + 1.58 * _cine
    cam.pitch = cam.pitch * (1 - _cine) + (0 + _qp * 2.4) * _cine
  }
  A0.lampOn = true

  // —— 时间轴：只有两次翻动（封面 → 一整块）——
  const T_RISE = 1.20, RISE = 2.00
  const T_LAND = T_RISE + RISE                  // 3.20 落桌
  const STILL = 0.80
  const T_COVER = T_LAND + 0.12 + STILL         // 4.12 开始翻封面
  const COVER_T = 2.20
  const T_READA = T_COVER + COVER_T             // 6.32 封面翻完，露出第一页文字
  const HOLD_A = 6.00                           // 封面翻开后停 6 秒（读第一页）
  const T_BLK = T_READA + HOLD_A                // 9.32 开始翻那一整块
  const BLK_T = 3.30
  const T_SETTLE = T_BLK + BLK_T                // 12.62
  const SETTLE = 1.60
  const T_END = T_SETTLE + SETTLE

  const flipCurve = (k) => {
    if (k <= 0) return 0
    if (k >= 1) return Math.PI
    const a = k < 0.12 ? (k / 0.12) * 0.10 : 0.10 + ((k - 0.12) / 0.88) * 0.90
    const e = a < 0.5 ? 2 * a * a : 1 - Math.pow(-2 * a + 2, 2) / 2
    const tail = k > 0.85 ? (k - 0.85) / 0.15 : 0
    return Math.PI * Math.min(1, e - tail * 0.035 * Math.sin(tail * Math.PI))
  }

  if (t < T_RISE) {
    DESK.pos = { x: 3.02, y: 0.52, z: 1.94 }
    DESK.yaw = -0.30
    DESK.phase = "seated"
  } else if (t < T_LAND) {
    const k = (t - T_RISE) / RISE
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    DESK.pos = {
      x: 3.02 + (DESK.deskX - 3.02) * e,
      y: 0.52 + (DESK.deskY - 0.52) * e + Math.sin(k * Math.PI) * 0.10,
      z: 1.94 + (DESK.deskZ - 1.94) * e,
    }
    DESK.yaw = (-0.30 + 0.30 * e) + (Math.PI / 2) * e + Math.sin(k * Math.PI * 2.2) * 0.05 * (1 - e)
    DESK.tilt = Math.sin(k * Math.PI * 3) * 2.4 * (1 - e)
    DESK.phase = "rise"
  } else if (t < T_COVER - 0.01) {
    const k = Math.min(1, (t - T_LAND) / 0.12)
    DESK.pos = { x: DESK.deskX, y: DESK.deskY - Math.sin(k * Math.PI) * 0.006, z: DESK.deskZ }
    DESK.yaw = Math.PI / 2; DESK.tilt = 0
    DESK.lean = 0.06
    DESK.phase = "still"
  } else if (t < T_READA) {
    DESK.pos = { x: DESK.deskX, y: DESK.deskY, z: DESK.deskZ }
    DESK.yaw = Math.PI / 2; DESK.tilt = 0
    DESK.lean = 0.10
    DESK.push = 1
    const k = (t - T_COVER) / COVER_T
    DESK.cvAng = flipCurve(k) * (ANG_COVER / Math.PI)
    DESK.phase = "cover"
  } else if (t < T_BLK) {
    DESK.cvAng = ANG_COVER
    DESK.push = 1
    DESK.lean = 0.10
    DESK.phase = "readA"
  } else if (t < T_SETTLE) {
    DESK.cvAng = ANG_COVER
    DESK.push = 1
    const k = (t - T_BLK) / BLK_T
    let a
    if (k < 0.10) a = (k / 0.10) * (Math.PI * 8 / 180)
    else if (k < 0.44) a = Math.PI * 8 / 180 + easeIO((k - 0.10) / 0.34) * (Math.PI * 82 / 180)
    else if (k < 0.76) a = Math.PI * 90 / 180 + ((k - 0.44) / 0.32) * (Math.PI * 40 / 180)
    else a = Math.PI * 130 / 180 + easeO((k - 0.76) / 0.24) * (ANG_20 - Math.PI * 130 / 180)
    DESK.blk20Ang = a
    DESK.blk20On = true
    DESK.phase = "block"
  } else if (t < T_END) {
    DESK.cvAng = ANG_COVER
    DESK.blk20Ang = ANG_20
    DESK.blk20On = false
    DESK.RIGHT = DESK.RIGHT_FINAL
    DESK.push = 1
    DESK.phase = "settle"
  } else if (t < T_END + 1.50) {
    // 阶段1：房间开始震动，由弱渐强
    DESK.phase = "quake"
    DESK.shake = Math.min(1, (t - T_END) / 1.5)
    DESK.cine = Math.min(1, (t - T_END) / 1.0)
    if (!INK.on && t >= T_END + 1.0) startInk()
  } else if (t < T_END + 1.50 + 1.10) {
    // 阶段2：快速看向左侧，先快后缓 + 过冲回正
    const k = (t - T_END - 1.50) / 1.10
    const e = 1 - Math.pow(1 - k, 3)
    const over = Math.sin(Math.min(1, k / 0.85) * Math.PI) * 0.09 * (1 - k)
    DESK.yawAdd = 1.22 * e + over
    DESK.shake = 0.55
    DESK.blurNow = 3.0 * Math.sin(Math.min(1, k) * Math.PI)
    DESK.cine = 1
    DESK.phase = "turnL"
  } else if (t < T_END + 1.50 + 1.10 + 1.30) {
    // 阶段3：停住观察（只留呼吸与震动）
    DESK.yawAdd = 1.22
    DESK.shake = 0.55
    DESK.cine = 1
    DESK.phase = "pauseL"
  } else if (t < T_END + 1.50 + 1.10 + 1.30 + 1.30) {
    // 阶段4：迟疑地继续转向左后方
    const k = (t - T_END - 3.90) / 1.30
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    DESK.yawAdd = 1.22 + 1.31 * e
    DESK.shake = 0.55
    DESK.cine = 1
    DESK.phase = "turnB"
  } else {
    // keep spawning ink until it covers the screen, then go to the next act
    DESK.yawAdd = 2.53
    DESK.cine = 1
    if (!INK.on) startInk()
    DESK.shake = Math.max(0.12, 0.7 - (INK.cover || 0) * 0.6)
    DESK.flash = 0
    DESK.roll = 0
    DESK.dive = 0
    if ((INK.cover || 0) >= 0.97) {
      DESK.phase = "inkdone"
      if (!DESK.finished) {
        DESK.finished = true
        INK.on = false
        DESK.active = false
        fadeTo(1, 1.4, () => { startAct1(); fadeTo(0, 0.9) })
      }
    } else {
      DESK.phase = "ink"
    }
  }

  if (INK.on) updateInk(dt, W, H)
  buildBook()
}


/* ============================ 第二幕：山谷（3D） ============================ */
/* 黑白像素风山谷：地面 + 两侧山 + 树 + 一条队伍（前后各 20 人）。
   所有几何按"离原点的距离"排序后写进一个顶点缓冲，
   每帧只改 drawArrays 的 count —— 光圈扫到多远就画多少，天然实现"扫到才出现"。 */
// 队伍里传出来的话（按逗号/句号切成短句，一句一句播，不循环）
const A2_LINES = [
  '终于甩掉他们了，前面就是村子了，我们去前面修整一下，马上就可以跟上大部队了。',
  '什么声音？悉悉索索的，',
  '有敌人！快跑！',
  '你！快拿着地图！往前面的村子跑！',
  '你们！掩护！',
]
const A2_SEGS = []
for (let li = 0; li < A2_LINES.length; li++) {
  const line = A2_LINES[li]
  const shout = line.indexOf('！') >= 0
  const parts = line.match(/[^，。！？]+[，。！？]?/g) || [line]
  for (let pi = 0; pi < parts.length; pi++) {
    // 第 2 句（什么声音…）之前额外停 5 秒
    const pre = (li === 1 && pi === 0) ? 5.0 : 0
    A2_SEGS.push({ text: parts[pi], shout: shout, pre: pre })
  }
}

const A2 = {
  cam: { x: 0, z: 0, eye: 1.6, yaw: 0, pitch: 0.02 },
  walk: 0,
  sub: { i: 0, t: 0, wait: 0, holdT: 0, done: false },
  stopT: -1,          // 队伍开始停步后的计时（-1 = 还没开始停）
  cover: false,       // 是否进入"掩护"阶段
  bullets: [],        // 红色子弹（我方）
  ebullets: [],       // 黄色子弹（敌方，从镜头后方打过来）
  run: {              // 奔跑小游戏
    active: false, dist: 0, stamina: 0, shake: 0, hurt: 0, aim: false,
    parts: [], enemies: [], ebullets: [], pbullets: [], spawnT: 0, done: false, breath: null, endT: 0, hp: 10,
  },
  t: 0,
  ringR: 0,
  ringOn: false,
  done: false,
  built: false,
  order: [],     // 每个元素的 { d, count }
  total: 0,
}

function a2Quad(out, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, tint) {
  // 两个三角形，顶点格式 11 float：pos3 uv2 color3 normal3
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const vx = dx - ax, vy = dy - ay, vz = dz - az
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const L = Math.hypot(nx, ny, nz) || 1
  nx /= L; ny /= L; nz /= L
  const P = [[ax, ay, az], [bx, by, bz], [cx, cy, cz], [ax, ay, az], [cx, cy, cz], [dx, dy, dz]]
  for (const v of P) out.push(v[0], v[1], v[2], 0.5, 0.5, tint[0], tint[1], tint[2], nx, ny, nz)
}

function a2Box(out, x, y, z, w, h, d, tint, topTint) {
  const x0 = x - w / 2, x1 = x + w / 2
  const z0 = z - d / 2, z1 = z + d / 2
  const y0 = y, y1 = y + h
  const top = topTint || [tint[0] * 1.35, tint[1] * 1.35, tint[2] * 1.35]
  const front = tint
  const side = [tint[0] * 0.62, tint[1] * 0.62, tint[2] * 0.64]
  const back = [tint[0] * 0.45, tint[1] * 0.45, tint[2] * 0.47]
  // 六个面：真 3D 方块，任意角度都成立
  a2Quad(out, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, top)       // 顶
  a2Quad(out, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, front)     // +z
  a2Quad(out, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, side)      // +x
  a2Quad(out, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, back)      // -z
  a2Quad(out, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, side)      // -x
  a2Quad(out, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, back)      // 底
}

/* 体素山：每根柱子单独返回一个块 → 出现时是一根根被光圈扫出来的，不是整座山突然冒 */
// 山体在某个归一化坐标处的柱高（0..14 格）
function mtnColCount(fx, fz, seed) {
  const d = Math.hypot(fx, fz)
  if (d > 1.02) return 0
  const n1 = Math.sin(fx * 11.3 + seed * 1.3) * Math.cos(fz * 9.7 + seed)
  const n2 = Math.sin(fx * 23.1 - seed * 0.7) * Math.cos(fz * 19.3 + seed * 2.2)
  const n3 = Math.sin((fx + fz) * 31.7 + seed * 3.1)
  const noise = 1 + 0.22 * n1 + 0.14 * n2 + 0.08 * n3
  const t = Math.max(0, 1 - d * 0.92)
  return Math.max(1, Math.round(t * t * 14 * noise))
}

/* 红军战士剪影（黑白）：贝塞尔曲线画的真人比例，不用几何体拼。
   帽子、上衣、腰带、宽裤、绑腿、布鞋、肩上的步枪都保留；
   头部位置留空 —— 由火焰粒子填。 */
let SOLDIER_SPRITE = null
// 网上抠来的多张士兵剪影（白色化后使用），按序号轮流给 20 个战士
// 只保留"透明底 + 单人"的图；白底 jpg 和群像图会渲染成大白块，已剔除
// 只有 s0 是"透明底 + 单人"，其余下载到的图是白底或群像，染白后会变成大白块
// 只用"背影 + 单人 + 透明底"的 5 张；配合左右镜像 → 10 种不同样子
// 全部是"单人 + 透明底"的图（多人图已经用 Pillow 按列切开）
// 只保留"背影"的 5 张单人图；侧身扛枪(s5_0)、蹲跪端枪(p3_0/p4_0) 已删除
const SOLDIER_SRC = [
  'assets/soldiers/single/s0_0.png',
  'assets/soldiers/single/x13_0.png',
  'assets/soldiers/single/p7_0.png',
  'assets/soldiers/single/p7_1.png',
  'assets/soldiers/single/s6_1.png',
]
const SOLDIER_IMGS = []
// 每张剪影里"头"的位置（占图片宽/高的比例），用 Pillow 量顶部 16% 不透明像素的水平质心得出
const SOLDIER_HEADS = [
  { fx: 0.388 },  // s0_0
  { fx: 0.631 },  // x13_0
  { fx: 0.529 },  // p7_0
  { fx: 0.562 },  // p7_1
  { fx: 0.501 },  // s6_1
]
let SOLDIER_LOADING = false
function loadSoldierImages() {
  if (SOLDIER_LOADING) return
  SOLDIER_LOADING = true
  SOLDIER_SRC.forEach((src, idx) => {
    const img = new Image()
    img.onload = () => {
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const g = cv.getContext('2d')
      g.drawImage(img, 0, 0)
      g.globalCompositeOperation = 'source-in'
      g.fillStyle = '#eaeaea'
      g.fillRect(0, 0, cv.width, cv.height)
      SOLDIER_IMGS[idx] = cv
    }
    img.src = src
  })
}
function makeSoldierSprite() {
  if (SOLDIER_SPRITE) return SOLDIER_SPRITE
  const CW = 220, CH = 460
  const cv = document.createElement('canvas')
  cv.width = CW; cv.height = CH
  const g = cv.getContext('2d')
  g.clearRect(0, 0, CW, CH)
  const cx = CW / 2
  // 单位：1m = 250px，脚在 y=455，帽顶在 y=25
  const Y = (m) => 455 - m * 250
  g.fillStyle = '#dcdcdc'   // white silhouette

  // —— 躯干 + 军装：肩宽 > 下摆，收腰，才像人不像钟 ——
  g.beginPath()
  g.moveTo(cx - 30, Y(1.50))                                       // 左肩内
  g.bezierCurveTo(cx - 54, Y(1.48), cx - 56, Y(1.30), cx - 48, Y(1.12))
  g.bezierCurveTo(cx - 44, Y(1.02), cx - 40, Y(0.98), cx - 38, Y(0.94))   // 腰
  g.bezierCurveTo(cx - 44, Y(0.88), cx - 46, Y(0.82), cx - 46, Y(0.76))   // 下摆（比肩窄）
  g.lineTo(cx + 46, Y(0.76))
  g.bezierCurveTo(cx + 46, Y(0.82), cx + 44, Y(0.88), cx + 38, Y(0.94))
  g.bezierCurveTo(cx + 40, Y(0.98), cx + 44, Y(1.02), cx + 48, Y(1.12))
  g.bezierCurveTo(cx + 56, Y(1.30), cx + 54, Y(1.48), cx + 30, Y(1.50))
  g.closePath()
  g.fill()

  // —— 腰带（留一条亮缝）——
  g.globalCompositeOperation = 'destination-out'
  g.fillRect(cx - 60, Y(1.00), 120, 5)
  g.globalCompositeOperation = 'source-over'

  // —— 手臂：从肩头垂到大腿，略向外 ——
  for (const sgn of [-1, 1]) {
    g.beginPath()
    g.moveTo(cx + sgn * 30, Y(1.48))
    g.bezierCurveTo(cx + sgn * 54, Y(1.42), cx + sgn * 58, Y(1.16), cx + sgn * 52, Y(0.96))
    g.bezierCurveTo(cx + sgn * 50, Y(0.86), cx + sgn * 48, Y(0.80), cx + sgn * 48, Y(0.74))
    g.lineTo(cx + sgn * 40, Y(0.74))
    g.bezierCurveTo(cx + sgn * 40, Y(0.82), cx + sgn * 42, Y(0.90), cx + sgn * 44, Y(0.98))
    g.bezierCurveTo(cx + sgn * 46, Y(1.16), cx + sgn * 42, Y(1.34), cx + sgn * 24, Y(1.46))
    g.closePath()
    g.fill()
  }

  // —— 宽裤：大腿饱满、膝盖收、裤脚扎紧 ——
  for (const sgn of [-1, 1]) {
    g.beginPath()
    g.moveTo(cx + sgn * 6, Y(0.78))
    g.bezierCurveTo(cx + sgn * 26, Y(0.76), cx + sgn * 34, Y(0.64), cx + sgn * 30, Y(0.48))
    g.bezierCurveTo(cx + sgn * 27, Y(0.40), cx + sgn * 24, Y(0.38), cx + sgn * 22, Y(0.36))
    g.lineTo(cx + sgn * 10, Y(0.37))
    g.bezierCurveTo(cx + sgn * 12, Y(0.50), cx + sgn * 10, Y(0.64), cx + sgn * 2, Y(0.78))
    g.closePath()
    g.fill()
  }

  // —— 绑腿 ——
  for (const sgn of [-1, 1]) {
    g.beginPath()
    g.moveTo(cx + sgn * 21, Y(0.37))
    g.bezierCurveTo(cx + sgn * 19, Y(0.26), cx + sgn * 18, Y(0.16), cx + sgn * 17, Y(0.09))
    g.lineTo(cx + sgn * 9, Y(0.09))
    g.bezierCurveTo(cx + sgn * 9, Y(0.18), cx + sgn * 10, Y(0.27), cx + sgn * 8, Y(0.38))
    g.closePath()
    g.fill()
  }

  // —— 布鞋 ——
  for (const sgn of [-1, 1]) {
    g.beginPath()
    g.moveTo(cx + sgn * 17, Y(0.09))
    g.bezierCurveTo(cx + sgn * 24, Y(0.05), cx + sgn * 28, Y(0.01), cx + sgn * 20, Y(0.0))
    g.lineTo(cx + sgn * 7, Y(0.0))
    g.lineTo(cx + sgn * 7, Y(0.09))
    g.closePath()
    g.fill()
  }

  // —— 肩上的步枪（细斜杆）——
  g.save()
  g.translate(cx + 34, Y(1.34))
  g.rotate(-0.24)
  g.fillRect(-3.5, -220, 8, 240)
  g.restore()

  // —— 八角帽：贴着脖子往上一点，中间只留一小段给火 ——
  g.beginPath()
  g.moveTo(cx - 26, Y(1.70))
  g.bezierCurveTo(cx - 27, Y(1.78), cx - 20, Y(1.82), cx, Y(1.82))
  g.bezierCurveTo(cx + 20, Y(1.82), cx + 27, Y(1.78), cx + 26, Y(1.70))
  g.closePath()
  g.fill()
  // 帽檐
  g.beginPath()
  g.moveTo(cx - 32, Y(1.70))
  g.bezierCurveTo(cx - 16, Y(1.665), cx + 16, Y(1.665), cx + 32, Y(1.70))
  g.lineTo(cx + 30, Y(1.725))
  g.lineTo(cx - 30, Y(1.725))
  g.closePath()
  g.fill()

  SOLDIER_SPRITE = cv
  return cv
}

/* 光滑圆柱：给人物用，绕轴一圈多段，所以不是方块感 */
function a2Cyl(out, cx, cz, y0, y1, r0, r1, segs, tint, sx, sz, rotY) {
  sx = sx || 1
  sz = sz || 1
  rotY = rotY || 0
  const top = [tint[0] * 1.25, tint[1] * 1.25, tint[2] * 1.25]
  const bot = [tint[0] * 0.55, tint[1] * 0.55, tint[2] * 0.58]
  for (let i = 0; i < segs; i++) {
    const a0 = rotY + (i / segs) * Math.PI * 2
    const a1 = rotY + ((i + 1) / segs) * Math.PI * 2
    const c0 = Math.cos(a0), s0 = Math.sin(a0)
    const c1 = Math.cos(a1), s1 = Math.sin(a1)
    // 侧面
    a2Quad(out,
      cx + c0 * r0 * sx, y0, cz + s0 * r0 * sz,
      cx + c1 * r0 * sx, y0, cz + s1 * r0 * sz,
      cx + c1 * r1 * sx, y1, cz + s1 * r1 * sz,
      cx + c0 * r1 * sx, y1, cz + s0 * r1 * sz, tint)
    // 顶盖
    a2Quad(out, cx, y1, cz,
      cx + c0 * r1 * sx, y1, cz + s0 * r1 * sz,
      cx + c1 * r1 * sx, y1, cz + s1 * r1 * sz, cx, y1, cz, top)
    // 底盖
    a2Quad(out, cx, y0, cz,
      cx + c1 * r0 * sx, y0, cz + s1 * r0 * sz,
      cx + c0 * r0 * sx, y0, cz + s0 * r0 * sz, cx, y0, cz, bot)
  }
}

function a2VoxelMountain(cx, cz, spanX, spanZ, height, seed, outL) {
  const cols = []
  const NX = 10, NZ = 14
  const cw = (spanX * 2) / NX
  const cd = (spanZ * 2) / NZ
  const cellH = height / 14
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      const fx = (ix + 0.5) / NX * 2 - 1
      const fz = (iz + 0.5) / NZ * 2 - 1
      const d = Math.hypot(fx, fz)
      if (d > 1.02) continue
      const n1 = Math.sin(fx * 11.3 + seed * 1.3) * Math.cos(fz * 9.7 + seed)
      const n2 = Math.sin(fx * 23.1 - seed * 0.7) * Math.cos(fz * 19.3 + seed * 2.2)
      const n3 = Math.sin((fx + fz) * 31.7 + seed * 3.1)
      const noise = 1 + 0.22 * n1 + 0.14 * n2 + 0.08 * n3
      const t = Math.max(0, 1 - d * 0.92)
      const col = Math.max(1, Math.round(t * t * 14 * noise))
      const h = col * cellH
      const x0 = cx + fx * spanX - cw / 2
      const z0 = cz + fz * spanZ - cd / 2
      const x1 = x0 + cw, z1 = z0 + cd
      const out = []
      // 六个面全涂纯黑
      a2Box(out, (x0 + x1) / 2, 0, (z0 + z1) / 2, cw, h, cd, [0, 0, 0], [0, 0, 0])
      // 12 条棱画成白线
      const ex = [x0, x1], ez = [z0, z1], ey = [0, h]
      for (const yy of ey) {
        for (const zz of ez) outL.push(x0, yy, zz, 0, 0, 1, 1, 1, 0, 0, 1, x1, yy, zz, 0, 0, 1, 1, 1, 0, 0, 1)
        for (const xx of ex) outL.push(xx, yy, z0, 0, 0, 1, 1, 1, 0, 0, 1, xx, yy, z1, 0, 0, 1, 1, 1, 0, 0, 1)
      }
      for (const xx of ex) {
        for (const zz of ez) outL.push(xx, 0, zz, 0, 0, 1, 1, 1, 0, 0, 1, xx, h, zz, 0, 0, 1, 1, 1, 0, 0, 1)
      }
      cols.push({ out, lineFrom: outL.length })
      cols[cols.length - 1].lineIdx = cols.length - 1
    }
  }
  return cols
}

/* 体素松树（照网上 voxel tree 的做法）：树干 + 8 层越来越小的菱形树冠，
   每层用 5x5/7x7 的小方块随机缺角，一棵树 100 个方块以上。 */
function a2Tree(out, x, z, h, seed, y0) {
  y0 = y0 || 0
  const cube = h * 0.062
  // 树干：从地面到 1/3 高
  const trunkN = 6
  for (let i = 0; i < trunkN; i++) {
    const v = 0.18 + 0.02 * i
    a2Box(out, x, y0 + i * (h * 0.055), z, cube * 1.2, h * 0.056, cube * 1.2, [v, v, v + 0.01])
  }
  // 树冠：8 层
  const tiers = 8
  for (let i = 0; i < tiers; i++) {
    const k = i / (tiers - 1)
    const n = Math.max(0, Math.round(3 - k * 3))     // 3,3,2,2,1,1,0,0
    const y = y0 + h * (0.22 + k * 0.72)
    for (let gx = -n; gx <= n; gx++) {
      for (let gz = -n; gz <= n; gz++) {
        if (Math.abs(gx) + Math.abs(gz) > n) continue       // 菱形
        const r = Math.sin(gx * 5.7 + gz * 3.1 + seed * 2.3 + i * 1.7)
        if (r < -0.18) continue                              // 随机缺角
        const v = 0.24 + 0.10 * r + 0.10 * (1 - k)
        a2Box(out, x + gx * cube * 1.02, y, z + gz * cube * 1.02,
              cube, cube * 1.05, cube, [v, v + 0.02, v + 0.03])
      }
    }
  }
}

/* 红军战士（长征时期）：八角帽 + 束腰上衣 + 宽裤 + 布鞋，黑白两色，
   头部不做几何，改成头顶跳动的火焰粒子（在 2D 层画）。 */
function a2Soldier(out, x, z, dir, seed) {
  const S = 1.0                       // 整体缩放
  const y0 = 0
  const dark = 0.06, mid = 0.13, light = 0.30
  // 鞋（两只布鞋）
  a2Box(out, x - 0.09 * S, y0, z + dir * 0.03, 0.13 * S, 0.07 * S, 0.26 * S, [mid, mid, mid])
  a2Box(out, x + 0.09 * S, y0, z - dir * 0.02, 0.13 * S, 0.07 * S, 0.26 * S, [mid, mid, mid])
  // 裤腿：上粗下细，裤脚扎起来
  a2Cyl(out, x - 0.09 * S, z, y0 + 0.06 * S, 0.46 * S, 0.075 * S, 0.10 * S, 10, [dark, dark, dark])
  a2Cyl(out, x + 0.09 * S, z, y0 + 0.06 * S, 0.46 * S, 0.075 * S, 0.10 * S, 10, [dark, dark, dark])
  // 绑腿
  a2Cyl(out, x - 0.09 * S, z, y0 + 0.07 * S, 0.22 * S, 0.085 * S, 0.085 * S, 10, [mid, mid, mid])
  a2Cyl(out, x + 0.09 * S, z, y0 + 0.07 * S, 0.22 * S, 0.085 * S, 0.085 * S, 10, [mid, mid, mid])
  // 臀/腰
  a2Cyl(out, x, z, 0.44 * S, 0.60 * S, 0.17 * S, 0.185 * S, 14, [dark, dark, dark])
  // 上衣（束腰，下摆略阔）
  a2Cyl(out, x, z, 0.58 * S, 1.02 * S, 0.20 * S, 0.19 * S, 16, [mid, mid, mid])
  // 腰带
  a2Cyl(out, x, z, 0.62 * S, 0.70 * S, 0.205 * S, 0.205 * S, 16, [light, light, light])
  // 肩
  a2Cyl(out, x, z, 1.00 * S, 1.10 * S, 0.185 * S, 0.20 * S, 16, [mid, mid, mid])
  // 手臂（略向外张）
  a2Cyl(out, x - 0.21 * S, z, 0.66 * S, 1.04 * S, 0.055 * S, 0.065 * S, 10, [mid, mid, mid])
  a2Cyl(out, x + 0.21 * S, z, 0.66 * S, 1.04 * S, 0.055 * S, 0.065 * S, 10, [mid, mid, mid])
  // 脖子（头没了，只留一小截）
  a2Cyl(out, x, z, 1.08 * S, 1.16 * S, 0.07 * S, 0.075 * S, 10, [dark, dark, dark])
  // 八角帽：八边形帽身 + 帽檐 + 红星
  const capY = 1.14 * S
  a2Cyl(out, x, z, capY, capY + 0.10 * S, 0.145 * S, 0.155 * S, 8, [light, light, light])
  a2Cyl(out, x, z, capY - 0.012 * S, capY + 0.006 * S, 0.175 * S, 0.165 * S, 12, [mid, mid, mid])
  // 红星（正面一小块亮面）
  a2Box(out, x, capY + 0.035 * S, z + 0.15 * S, 0.05 * S, 0.05 * S, 0.02 * S, [1, 1, 1])
}

function buildValley() {
  const items = []
  const lines = []
  const edgeAll = []
  const edgeItems = []
  const litemsRaw = []
  A2.fires = []
  const push = (out) => {
    // 该元素离原点（相机脚下）的距离：取所有顶点里最近的那个
    let best = 1e9
    for (let i = 0; i < out.length; i += 11) {
      const d = Math.hypot(out[i], out[i + 2])
      if (d < best) best = d
    }
    items.push({ d: best, out })
  }

  // 地面：一条狭长带（宽 12m，长 240m），切成一格一格，好按距离排序
  for (let z = -718; z < 118; z += 4) {
    const out = []
    a2Quad(out, -6, 0, z, 6, 0, z, 6, 0, z + 4, -6, 0, z + 4, [0.015, 0.015, 0.015])
    push(out)
  }

  // 两侧山：每 6m 一座，错落高度
  for (let z = -708; z <= 108; z += 10) {
    for (const side of [-1, 1]) {
      const out = []
      const jitter = Math.sin(z * 0.7 + side) * 0.5 + Math.cos(z * 0.31) * 0.5
      const baseW = 16 + jitter * 6
      const h = 15 + jitter * 7
      // 远处的山更浅（空气透视）：|z| 越大 shade 越高
      const depth = Math.min(1, Math.abs(z) / 400)
      const shade = 0.10 + depth * 0.22 + 0.03 * jitter
      // 山谷是弯的：让两侧山按 sin(z) 左右岔开
      const curve = Math.sin(z * 0.045) * 2.2 + Math.sin(z * 0.013) * 3.0
      const mc = side * (10 + baseW * 0.22) + curve
      const mz = z + jitter * 2
      const seed2 = z * 0.13 + side
      const startE = edgeAll.length
      const mcols = a2VoxelMountain(mc, mz, baseW * 0.55, baseW * 0.45, h, seed2, edgeAll)
      if (!A2.mtns) A2.mtns = []
      A2.mtns.push({ cx: mc, cz: mz, sx: baseW * 0.55, sz: baseW * 0.45, h: h, seed: seed2 })
      for (const c of mcols) { push(c.out) }
      // 这一座山的所有棱线作为一个块（和山一起出现）
      if (edgeAll.length > startE) {
        let best = 1e9
        for (let q = startE; q < edgeAll.length; q += 11) {
          const d = Math.hypot(edgeAll[q], edgeAll[q + 2])
          if (d < best) best = d
        }
        edgeItems.push({ d: best, out: edgeAll.slice(startE) })
      }
      // 山坡上也种树
      for (let t = 0; t < 10; t++) {
        // 只种在朝峡谷的那一侧坡面（side=+1 在 x<中心 一侧，side=-1 反过来）
        const fx = -side * (0.28 + 0.42 * ((t % 4) / 3))
        const fz = -0.85 + 1.7 * (t / 9) + Math.sin(z * 0.9 + t * 3.1) * 0.12
        const cnt = mtnColCount(fx, fz, seed2)
        if (cnt < 2) continue
        const ty = cnt * (h / 14)
        const o3 = []
        a2Tree(o3, mc + fx * baseW * 0.55, mz + fz * baseW * 0.45, 2.6 + 1.3 * Math.abs(Math.sin(z + t * 1.7)), seed2 + t * 3.7, ty - 0.5)
        push(o3)
      }
      push(out)
    }
  }

  // 树：沿着谷底两侧，密一点
  for (let z = -710; z <= 110; z += 4) {
    for (const side of [-1, 1]) {
      const j = Math.sin(z * 1.7 + side * 2.1)
      if (j < -0.1) continue
      const out = []
      const tcurve = Math.sin((z + j * 3) * 0.045) * 2.2 + Math.sin((z + j * 3) * 0.013) * 3.0
      a2Tree(out, side * (4.6 + j * 1.6) + tcurve, z + j * 3, 3.2 + j * 1.4, z * 0.21 + side)
      push(out)
    }
  }

  // 队伍：前后各 20 人，间距 1.5m；人站在谷底正中线上
  // 队伍 40 人：身后 8 人、身前 32 人 → 主角站在队列后 1/5 处
  const QUEUE = []
  for (let i = 0; i < 8; i++) QUEUE.push({ z: 2.2 + i * 1.5, side: i % 2 === 0 ? 1 : -1, i: i })
  for (let i = 0; i < 32; i++) QUEUE.push({ z: -(2.2 + i * 1.5), side: i % 2 === 0 ? -1 : 1, i: i + 8 })
  for (const q of QUEUE) {
    const i = q.i, dir = q.side
    A2.fires.push({
      kind: (i * 3 + (dir > 0 ? 0 : 2)) % 5,
      mirror: (i % 3 === 0),
      x: ([-4.2, -2.1, 0.1, 2.2, 4.1][(i + (dir > 0 ? 0 : 3)) % 5] + Math.sin(i * 7.3 + (dir > 0 ? 0 : 1.7)) * 0.55),
      y: 1.60, z: q.z,
      seed: i * 3.1 + (dir > 0 ? 0 : 1.3),
      fireT: 0,
      stopDelay: ((i * 7 + (dir > 0 ? 0 : 3)) % 17) / 17 * 3.0,
      dist: Math.abs(q.z),
    })
  }

  // 棱线缓冲（按距离排序，和实体一起出现）
  edgeItems.sort((a, b) => a.d - b.d)
  const allE = []
  let accE = 0
  A2.edgeOrder = []
  A2.edgeTotal = 0
  for (const it of edgeItems) {
    accE += it.out.length / 11
    for (const v of it.out) allE.push(v)
    A2.edgeOrder.push({ d: it.d, count: accE })
    A2.edgeTotal = accE
  }
  if (gl3dInit() && allE.length) {
    const gl0 = GL3D.gl
    if (!GL3D.a2edges) GL3D.a2edges = gl0.createBuffer()
    gl0.bindBuffer(gl0.ARRAY_BUFFER, GL3D.a2edges)
    gl0.bufferData(gl0.ARRAY_BUFFER, new Float32Array(allE), gl0.STATIC_DRAW)
  }

  items.sort((a, b) => a.d - b.d)
  const all = []
  let acc = 0
  A2.order = []
  for (const it of items) {
    acc += it.out.length / 11
    for (const v of it.out) all.push(v)
    A2.order.push({ d: it.d, count: acc })
  }
  A2.total = acc

  if (!gl3dInit()) return
  const gl = GL3D.gl
  if (!GL3D.valley) GL3D.valley = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.valley)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(all), gl.STATIC_DRAW)
  A2.built = true
}

function startAct2() {
  A2.done = false
  A2.t = 0
  A2.ringR = 0
  A2.ringOn = false
  S.mode = 'act2'
  S.paused = false
  if (!A2.built) buildValley()
}

// 行军脚步声（来自 B 站素材，循环播放）
let A2_MARCH = null
function ensureMarchAudio() {
  if (A2_MARCH) return A2_MARCH
  A2_MARCH = new Audio('assets/sfx/march.mp3')
  A2_MARCH.loop = true
  A2_MARCH.volume = 0.32
  return A2_MARCH
}
function playMarchAudio() {
  const a = ensureMarchAudio()
  if (a && a.paused) a.play().catch(() => {})
}
function stopMarchAudio() {
  if (A2_MARCH && !A2_MARCH.paused) A2_MARCH.pause()
}

// 遭遇敌人的战斗音效：枪声 / 爆炸 / 子弹呼啸 / 人群喧闹
const A2_FIGHT = {
  on: false,
  nextShot: 0,
  nextBoom: 0,
  nextWhizz: 0,
  crowd: null,
}
function fightSfx(name, vol) {
  try {
    const a = new Audio('assets/sfx/' + name + '.mp3')
    a.volume = vol
    a.play().catch(() => {})
    return a
  } catch (e) { return null }
}
function startFight() {
  if (A2_FIGHT.on) return
  A2_FIGHT.on = true
  // 随机挑一半人换成"端着枪"的那张（index 3 = p7_1），并且标记为前冲的人
  if (A2.fires) {
    const idx = A2.fires.map((f, i) => i)
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t
    }
    const half = Math.floor(idx.length / 2)
    for (let i = 0; i < half; i++) {
      const f = A2.fires[idx[i]]
      f.kind = 3
      f.runner = true
    }
  }
  A2_FIGHT.nextShot = 0
  A2_FIGHT.nextBoom = 6
  A2_FIGHT.nextWhizz = 0.4
  try {
    // 三层不同音高叠在一起，听着才不像一条循环
    A2_FIGHT.crowds = []
    const rates = [0.82, 1.0, 1.19]
    const vols = [0.26, 0.19, 0.14]
    for (let i = 0; i < 3; i++) {
      const c = new Audio('assets/sfx/crowd.mp3')
      c.loop = true
      c.volume = vols[i]
      c.playbackRate = rates[i]
      c.play().catch(() => {})
      A2_FIGHT.crowds.push(c)
    }
    A2_FIGHT.crowd = A2_FIGHT.crowds[0]
  } catch (e) {}
  fightSfx('explosion', 0.55)
}
function updateFight(dt) {
  if (!A2_FIGHT.on) return
  // 如果之前被浏览器拦了（没有用户手势），这里每帧重试，一有手势就播上了
  if (A2_FIGHT.crowds) {
    for (const c of A2_FIGHT.crowds) if (c && c.paused) c.play().catch(() => {})
  }
  A2_FIGHT.nextShot -= dt
  A2_FIGHT.nextBoom -= dt
  A2_FIGHT.nextWhizz -= dt
  if (A2_FIGHT.nextShot <= 0) {
    // 每次随机音高/音量，听不出是同一条
    const a = fightSfx('gunshot', 0.12 + Math.random() * 0.16)
    if (a) a.playbackRate = 0.72 + Math.random() * 0.75
    A2_FIGHT.nextShot = 0.25 + Math.random() * 1.5
  }
  if (A2_FIGHT.nextWhizz <= 0) {
    const b = fightSfx('whizz', 0.08 + Math.random() * 0.10)
    if (b) b.playbackRate = 0.8 + Math.random() * 0.9
    A2_FIGHT.nextWhizz = 0.5 + Math.random() * 2.2
  }
  if (A2_FIGHT.nextBoom > 0) {
    // 开打时已经响过一次，这里 6 秒后再响一次，之后不再响
    if (A2_FIGHT.nextBoom - dt <= 0) {
      const c = fightSfx('explosion', 0.45)
      if (c) c.playbackRate = 0.95
      A2_FIGHT.nextBoom = -1
    }
  }
}

/* ============================ 第四幕：悬崖 ============================ */
const A4_LINES = ['山谷被围，', '村口也不能走，', '唯一赶上大部队的方式……就是这个悬崖了。']
const A4 = { t: 0, started: false, built: false, cols: [], peaks: [], yaw: 0, pitch: 0.26, eye: 1.7, px: 0, pz: 46, img: null,
  sub: { i: 0, t: 0, done: false }, fadeOut: -1 }
function loadA4Image() {
  if (A4.img) return
  const im = new Image()
  im.src = 'assets/act4-cliff.png'
  A4.img = im
}

function a4Build() {
  if (A4.built) return
  A4.built = true
  A4.cols = []
  // 三组紧挨着的石柱群：中间一组 + 左右各复制一份
  for (let copy = -1; copy <= 1; copy++) {
  const offX = copy * 82
  for (let gx = -9; gx <= 9; gx++) {
    for (let gz = 0; gz <= 7; gz++) {
      const seed = gx * 1.9 + gz * 3.7
      const n1 = Math.sin(seed * 1.3) * 0.5 + 0.5
      const n2 = Math.sin(seed * 0.7 + 2.1) * 0.5 + 0.5
      A4.cols.push({
        x: gx * 4.2 + (n1 - 0.5) * 1.6,
        z: -42 - gz * 4.2 - (n2 - 0.5) * 1.4,
        w: 3.2 + n1 * 1.4,
        d: 3.2 + n2 * 1.4,
        h: 22 + n1 * 70 + n2 * 36,
        x: gx * 4.2 + (n1 - 0.5) * 1.6 + offX,
      })
    }
  }
  }
}


function startFinal() {
  if (A4.started) return
  A4.started = true
  A4.t = 0
  a4Build()
  loadA4Image()
  try { stopBattleMusic() } catch (e) {}
  try { if (A2_MARCH) A2_MARCH.pause() } catch (e) {}
  try { if (A3_BGM) A3_BGM.pause() } catch (e) {}
  S.mode = 'act4'
}

function updateFinal(dt) {
  A4.t += dt
  // 和山谷一样：WASD 相对视线移动，鼠标控制视角（指针锁定）
  let fx = 0, fz = 0
  if (roomKeys['KeyW'] || roomKeys['ArrowUp']) fz -= 1
  if (roomKeys['KeyS'] || roomKeys['ArrowDown']) fz += 1
  if (roomKeys['KeyA'] || roomKeys['ArrowLeft']) fx -= 1
  if (roomKeys['KeyD'] || roomKeys['ArrowRight']) fx += 1
  const len = Math.hypot(fx, fz)
  if (len > 0.001) {
    fx /= len; fz /= len
    const cs = Math.cos(A4.yaw), sn = Math.sin(A4.yaw)
    const wx = fx * cs + fz * sn
    const wz = -fx * sn + fz * cs
    const sp = 3.2 * dt
    A4.walking = true
    A4.px = Math.max(-45, Math.min(45, A4.px + wx * sp))
    A4.pz = Math.max(-70, Math.min(60, A4.pz + wz * sp))
  }
  // 走路起伏（受伤感）+ 喘气
  if (!A4.breathA && A4.walking) {
    try {
      A4.breathA = new Audio('assets/sfx/breath-walk.mp3')
      A4.breathA.loop = true
      A4.breathA.volume = 0.3
      A4.breathA.currentTime = 7.5
      A4.breathB = new Audio('assets/sfx/breath-walk.mp3')
      A4.breathB.loop = true
      A4.breathB.volume = 0.3
    } catch (e) { A4.breathA = null; A4.breathB = null }
  }
  if (false && !A4.breath && A4.walking) {
    try {
      A4.breath = new Audio('assets/sfx/breath-walk.mp3')
      A4.breath.loop = true
      A4.breath.volume = 0.42
    } catch (e) { A4.breath = null }
  }
  if (A4.walking) {
    A4.bob = (A4.bob || 0) + dt * 7.5
    if (A4.breathA && A4.breathA.paused) A4.breathA.play().catch(() => {})
    if (A4.breathB && A4.breathB.paused) A4.breathB.play().catch(() => {})
  } else {
    if (A4.breathA && !A4.breathA.paused) { try { A4.breathA.pause() } catch (e) {} }
    if (A4.breathB && !A4.breathB.paused) { try { A4.breathB.pause() } catch (e) {} }
  }
  // 底部灰字台词：每句打字 + 停留共 4 秒
  {
    const sb = A4.sub
    if (!sb.done) {
      sb.t += dt
      if (sb.t > 4.0) { sb.t = 0; sb.i++; if (sb.i >= A4_LINES.length) sb.done = true }
    }
  }
  // 距离悬崖 5 米内 → 淡黑进小游戏
  if (A4.fadeOut < 0 && A4.pz <= -32) A4.fadeOut = 0
  if (A4.fadeOut >= 0) {
    A4.fadeOut += dt
    if (A4.fadeOut > 1.6 && S.mode === 'act4') startAct5Game()
  }
  if (roomKeys['KeyQ']) A4.pitch = Math.max(-0.9, Math.min(0.9, A4.pitch - dt * 0.9))
  if (roomKeys['KeyE']) A4.pitch = Math.max(-0.9, Math.min(0.9, A4.pitch + dt * 0.9))
}

/* ============================ 第五幕：攀爬 ============================ */
const A5_IMGS = { open: null, fist: null }
function loadA5Hands() {
  if (A5_IMGS.open) return
  const a = new Image(); a.src = 'assets/hands/hand-open.png'; A5_IMGS.open = a
  const b = new Image(); b.src = 'assets/hands/hand-fist.png'; A5_IMGS.fist = b
}

const A5 = {
  started: false, t: 0, step: 0, side: 1, phase: 'idle', timer: 0,
  shake: 0, ly: 0.62, ry: 0.70, done: false, txtT: 0,
  lines: [
    '我的手臂因为刀伤而刺痛，到最后也已变得麻木，',
    '再后来是背的刺痛，背的麻木。',
    '石头磨得我手掌全是血，但我不能停下来。',
    '我只记得当时脑袋里的念头：',
  ],
  climbChars: ['爬', '，', '爬', '，', '爬', '。', '。', '。', '。'],
}
function startAct5Game() {
  // 进入爬山动画时立刻掐掉第四幕的喘气声
  try {
    if (A4.breathA) { A4.breathA.pause(); A4.breathA.volume = 0 }
    if (A4.breathB) { A4.breathB.pause(); A4.breathB.volume = 0 }
    if (A4.breath) { A4.breath.pause(); A4.breath.volume = 0 }
  } catch (e) {}
  if (A5.started) return
  A5.started = true
  loadA5Hands()
  A5.t = 0
  A5.cycle = 0
  A5.phase = 'reach'
  A5.timer = 0
  A5.shake = 0
  A5.done = false
  A5.txtT = 0
  A5.redT = 0
  A5.pauseT = 0
  A5.redShown = 0
  A5.side = 1                       // 1 = 左手先上
  // y 以屏幕高度为单位：1.15 = 刚在画面外下方，0.45 = 抬到上方，0.80 = 被"视角上移"推到下方
  A5.L = { y: 1.15, grip: false }
  A5.R = { y: 1.55, grip: true }    // 右手先在画面外握拳待命
  S.mode = 'act5'
}

function updateAct5(dt) {
  A5.t += dt
  if (A5.shake > 0) A5.shake = Math.max(0, A5.shake - dt * 3)
  if (A5.afterRed) {
    A5.endT = (A5.endT || 0) + dt
    if (A5.endT > 1.5 && !A5.wentEnd) { A5.wentEnd = true; startAct6() }
    return
  }
  if (A5.done) { A5.txtT += dt; return }
  if (A5.txtT == null) A5.txtT = 0
  A5.txtT += (A5.pauseT > 0 ? 0 : dt)
  if (A5.pauseT > 0) { A5.pauseT -= dt; if (A5.pauseT < 0) A5.pauseT = 0 }
  if (A5.redT == null) A5.redT = 0
  const charsShown = Math.floor(A5.txtT * 8)
  const totalChars = A5.lines.reduce((a, b) => a + b.length, 0)
  if (charsShown >= totalChars) {
    const prev = A5.redShown || 0
    A5.redT += (A5.pauseT > 0 ? 0 : dt)
    const now = Math.min(A5.climbChars.length, Math.floor(A5.redT * 4))
    if (now > prev) {
      A5.redShown = now
      A5.pauseT = 1.0        // 每打出一个字停 1 秒
      A5.shake = Math.max(A5.shake, 0.7)
      if (now >= A5.climbChars.length) { A5.afterRed = true; A5.endT = 0; A5.done = true }
    }
  }
  A5.timer += dt
  const cur = A5.side === 1 ? A5.L : A5.R
  const oth = A5.side === 1 ? A5.R : A5.L

  if (A5.phase === 'reach') {
    if (A5.reachFrom == null) A5.reachFrom = cur.y
    const k = Math.min(1, A5.timer / 1.4)
    cur.y = A5.reachFrom - 0.70 * k      // 上升 2/3 屏
    if (k >= 1) {
      cur.grip = true
      A5.reachFrom = null
      A5.phase = 'hold'
      A5.timer = 0
    }
  } else if (A5.phase === 'hold') {
    if (A5.timer > 0.60) {
      A5.shake = 1
      A5.scrollFromL = A5.L.y
      A5.scrollFromR = A5.R.y
      A5.phase = 'scroll'
      A5.timer = 0
    }
  } else if (A5.phase === 'scroll') {
    const k = Math.min(1, A5.timer / 0.50)
    A5.L.y = A5.scrollFromL + 0.35 * k   // 视角上移 → 两只手一起往下走
    A5.R.y = A5.scrollFromR + 0.35 * k
    if (k >= 1) {
      A5.scrollFromL = null
      A5.scrollFromR = null
      A5.cycle++
      A5.side = -A5.side
      const nx = A5.side === 1 ? A5.L : A5.R
      nx.grip = false
      nx.y = 1.15
      A5.reachFrom = null
      A5.phase = 'reach'
      A5.timer = 0
      if (A5.cycle >= 10) A5.done = true
      if (A5.cycle >= 10 && A5.done && !A5.toEnd) { A5.toEnd = true }
    }
  }
}
/* ============================ 第六幕：苏醒序列（实时相机） ============================ */
const A6 = {
  started: false, phase: 'fade', t: 0, txt: 0, black: 0, lid: 0, exp: 1,
  fov: 70, line: '也许我想好近代史作业怎么写了',
}
const A6_POSE = {
  lying: { x: -3.02, z: -4.45, yaw: Math.PI, pitch: -1.18, eye: 0.95 },
  sit:   { x: -2.70, z: -3.70, yaw: Math.PI + 1.05, pitch: -0.04, eye: 1.36 },
  win:   { x: -2.70, z: -3.70, yaw: Math.PI + 1.42, pitch: -0.28, eye: 1.36 },
}
const lerp = (a, b, k) => a + (b - a) * k
const a6Ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)

function a6SetPose(p) {
  const cam = A0.cam
  cam.x = p.x
  cam.z = p.z
  cam.yaw = p.yaw
  cam.pitch = p.pitch
  cam.eye = p.eye
}
function startAct6() {
  if (A6.started) return
  // 关掉第一幕那套起床状态机，否则它每帧把相机拉回躺姿，把看窗的镜头覆盖掉
  WAKE.active = false
  WAKE.state = 'idle'
  WAKE.black = 0
  A6.started = true
  A6.phase = 'fade'
  A6.t = 0
  A6.txt = 0
  A6.black = 0
  A6.lid = 1
  A6.exp = 1
  A6.fov = 70
  A6.lookLineT = 0
  // 复位房间：清掉第 0 幕墨迹、笔记本状态，回到干净的房间
  try {
    INK.on = false
    INK.t = 0
    INK.blobs.length = 0
    if (typeof INK3D !== 'undefined') INK3D.length = 0
    A0.bookState = 'shelf'
    A0.bookTaken = false
    if (typeof refreshFurniture === 'function') refreshFurniture()
  } catch (e) {}
  startRoom()
  S.mode = 'act6'
  a6SetPose(A6_POSE.lying)
}
function updateAct6(dt) {
  A6.t += dt
  if (WAKE.active) { WAKE.active = false; WAKE.state = 'idle' }
  // startRoom() 会把 mode 设成 room；这里每帧拉回 act6，
  // 否则 renderAct6 不执行 —— 眼皮/黑幕/灰字/the end 全都会被跳过
  if (A6.started) S.mode = 'act6'
  if (A6.phase === 'look' || A6.phase === 'hold' || A6.phase === 'blackout' || A6.phase === 'end' || A6.phase === 'back') A6.lookLineT = (A6.lookLineT || 0) + dt
  const cam = A0.cam
  // 呼吸 + 手持微动（全程叠加）
  const br = Math.sin(A6.t * 1.9) * 0.012 + Math.sin(A6.t * 0.63) * 0.008
  const hand = Math.sin(A6.t * 3.1) * 0.004
  const base = A6.phase === 'fade' || A6.phase === 'black' ? A6_POSE.lying
    : (A6.phase === 'look' ? A6_POSE.win : (A6.phase === 'sit' || A6.phase === 'line' ? A6_POSE.sit : A6_POSE.lying))

  if (A6.phase === 'fade') {
    A6.black = Math.min(1, A6.t / 3.75)
    if (A6.t >= 3.75) { A6.phase = 'black'; A6.t = 0; A6.black = 1 }
  } else if (A6.phase === 'black') {
    A6.black = 1
    if (A6.t >= 1.5) { A6.phase = 'eye'; A6.t = 0 }
  } else if (A6.phase === 'eye') {
    // 睁眼：上下眼皮退开 + FOV 55→70 + 曝光由暗到正常
    const k = Math.min(1, A6.t / 1.8)
    A6.lid = 1 - k
    A6.black = 0
    A6.fov = lerp(55, 70, k)
    A6.exp = 0.15 + 0.85 * (1 - Math.pow(1 - k, 2))
    cam.eye = A6_POSE.lying.eye + br * 0.02
    cam.pitch = A6_POSE.lying.pitch + br
    if (k >= 1) { A6.phase = 'lying'; A6.t = 0 }
  } else if (A6.phase === 'lying') {
    a6SetPose(A6_POSE.lying)
    cam.pitch = A6_POSE.lying.pitch + br
    cam.eye = A6_POSE.lying.eye + br * 0.02
    if (A6.t > 2.4) { A6.phase = 'turn'; A6.t = 0 }
  } else if (A6.phase === 'turn') {
    // 翻身：先侧倾 30°（用 yaw 的前半段模拟），中途停 0.2 秒，再转向 yaw≈+90°
    const T = 3.3, pauseAt = 1.35, pauseLen = 0.3
    let k
    if (A6.t < pauseAt) k = 0.45 * a6Ease(A6.t / pauseAt)
    else if (A6.t < pauseAt + pauseLen) k = 0.45
    else k = 0.45 + 0.55 * a6Ease(Math.min(1, (A6.t - pauseAt - pauseLen) / (T - pauseAt - pauseLen)))
    cam.yaw = lerp(A6_POSE.lying.yaw, A6_POSE.sit.yaw, k)
    cam.pitch = lerp(A6_POSE.lying.pitch, A6_POSE.sit.pitch, k) + br * (1 + k)
    cam.eye = lerp(A6_POSE.lying.eye, A6_POSE.sit.eye, k * 0.25)
    cam.x = lerp(A6_POSE.lying.x, A6_POSE.sit.x, k)
    cam.z = lerp(A6_POSE.lying.z, A6_POSE.sit.z, k)
    if (A6.t >= pauseAt + pauseLen) A6.shake = 0.5
    if (A6.t >= T) { A6.phase = 'sit'; A6.t = 0 }
  } else if (A6.phase === 'sit') {
    // 坐起：eye 升 0.41m，pitch 抬到平视，末段轻微过冲
    const T = 2.1
    const k = Math.min(1, A6.t / T)
    const e = a6Ease(k)
    let over = 0
    if (k > 0.8) over = Math.sin((k - 0.8) / 0.2 * Math.PI) * 0.02
    cam.x = A6_POSE.sit.x
    cam.z = A6_POSE.sit.z
    cam.yaw = A6_POSE.sit.yaw
    cam.pitch = lerp(-0.05 - 0.0, A6_POSE.sit.pitch, e) - over + br
    cam.eye = lerp(A6_POSE.lying.eye, A6_POSE.sit.eye, e) + br * 0.015
    if (A6.t >= T) { A6.phase = 'look'; A6.t = 0 }
  } else if (A6.phase === 'look') {
    // 慢慢抬头、向左上方窗户转
    const T = 4.2
    const k = Math.min(1, A6.t / T)
    const e = a6Ease(k)
    // 进入本阶段时记录一次起手姿态，前 0.6 秒从它平滑过渡过来
    if (!A6.lookFrom) {
      A6.lookFrom = { x: cam.x, z: cam.z, yaw: cam.yaw, pitch: cam.pitch, eye: cam.eye }
    }
    const bk = Math.min(1, A6.t / 0.6)
    let over = 0
    if (k > 0.85) over = Math.sin((k - 0.85) / 0.15 * Math.PI) * 0.03
    const tx = A6_POSE.win.x, tz = A6_POSE.win.z
    const tyaw = lerp(A6_POSE.sit.yaw, A6_POSE.win.yaw, e) + hand
    const tpitch = lerp(A6_POSE.sit.pitch, A6_POSE.win.pitch, e) + br * 1.4
    const teye = A6_POSE.win.eye + br * 0.015
    // 用帧率无关的指数平滑贴近目标，避免缓动曲线衔接处的顿挫
    const sm = Math.min(1, dt * 5.5)
    cam.x += (tx - cam.x) * sm
    cam.z += (tz - cam.z) * sm
    cam.yaw += (tyaw - cam.yaw) * sm
    cam.pitch += (tpitch - cam.pitch) * sm
    cam.eye += (teye - cam.eye) * sm
    if (A6.t >= T) { A6.phase = 'hold'; A6.t = 0; A6.lookFrom = null }
  } else if (A6.phase === 'line') {
    cam.yaw = A6_POSE.win.yaw + hand
    cam.pitch = A6_POSE.win.pitch + br * 1.4
    if (A6.t > 3.6) { A6.phase = 'blackout'; A6.t = 0 }
  } else if (A6.phase === 'hold') {
    // 定格在看窗的画面，停留 3 秒
    const sm2 = Math.min(1, dt * 5.5)
    cam.x += (A6_POSE.win.x - cam.x) * sm2
    cam.z += (A6_POSE.win.z - cam.z) * sm2
    cam.yaw += (A6_POSE.win.yaw + hand - cam.yaw) * sm2
    cam.pitch += (A6_POSE.win.pitch + br * 1.4 - cam.pitch) * sm2
    cam.eye += (A6_POSE.win.eye + br * 0.015 - cam.eye) * sm2
    if (A6.t > 3.0) { A6.phase = 'blackout'; A6.t = 0 }
  } else if (A6.phase === 'blackout') {
    // 黑屏期间相机钉在窗户姿态，避免渐黑过程中镜头跳回躺姿
    cam.x = A6_POSE.win.x
    cam.z = A6_POSE.win.z
    cam.yaw = A6_POSE.win.yaw
    cam.pitch = A6_POSE.win.pitch
    cam.eye = A6_POSE.win.eye
    if (A6.t > 2.0) { A6.phase = 'end'; A6.t = 0 }
  } else if (A6.phase === 'end') {
    if (A6.t > 10.0) { A6.phase = 'back'; A6.t = 0 }
  } else if (A6.phase === 'back') {
    if (A6.t > 1.0) { A6.started = false; returnToTitle() }
  }
}
function renderAct6() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  const inRoom = ['eye', 'lying', 'turn', 'sit', 'look', 'hold', 'line'].indexOf(A6.phase) >= 0
  if (inRoom) {
    renderRoom()
  } else {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)

  // 睁眼：上下眼皮遮罩
  if (A6.phase === 'eye' && A6.lid > 0.001) {
    const h = H * 0.5 * A6.lid
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, h)
    ctx.fillRect(0, H - h, W, h)
  }
  // 渐暗 / 全黑
  if (A6.black > 0.001) {
    ctx.fillStyle = 'rgba(0,0,0,' + A6.black.toFixed(3) + ')'
    ctx.fillRect(0, 0, W, H)
  }
  // 曝光
  if (A6.phase === 'eye' && A6.exp < 0.999) {
    ctx.fillStyle = 'rgba(0,0,0,' + (1 - A6.exp).toFixed(3) + ')'
    ctx.fillRect(0, 0, W, H)
  }
  // 底部灰字
  if (A6.phase === 'look' || A6.phase === 'hold' || A6.phase === 'blackout') {
    const n = Math.min(A6.line.length, Math.floor((A6.lookLineT || 0) * 7))
    if (n > 0) {
      A6.drewLine = (A6.drewLine || 0) + 1
      const fs2 = Math.max(14, H * 0.026)
      ctx.font = '400 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(170,170,176,0.92)'
      ctx.fillText(A6.line.slice(0, n), W / 2, H * 0.90)
    }
  }
  if (A6.phase === 'blackout' || A6.phase === 'end' || A6.phase === 'back') {
    const kb = A6.phase === 'blackout' ? Math.min(1, A6.t / 2.0) : 1
    ctx.fillStyle = 'rgba(0,0,0,' + kb.toFixed(3) + ')'
    ctx.fillRect(0, 0, W, H)
    if (A6.phase === 'end' || A6.phase === 'back') {
      const k = Math.min(1, A6.t / 1.2)
      const fs3 = Math.max(22, H * 0.055)
      ctx.font = '300 ' + fs3.toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(235,235,240,' + k.toFixed(3) + ')'
      ctx.fillText('the end', W / 2, H / 2)
    }
  }
}

function renderAct5() {
  A5.rendered = (A5.rendered || 0) + 1
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)

  const sh = A5.shake
  ctx.save()
  if (sh > 0) ctx.translate((Math.random() - 0.5) * 20 * sh, (Math.random() - 0.5) * 20 * sh)

  const hw = Math.min(W, H) * 0.34
  const drawHand = (cx, cy, grip, mirrored) => {
    const im = grip ? A5_IMGS.fist : A5_IMGS.open
    if (!im || !im.complete || !im.naturalWidth) return
    const k = hw / im.naturalWidth
    const dw = im.naturalWidth * k
    const dh = im.naturalHeight * k
    ctx.save()
    ctx.translate(cx, cy)
    if (mirrored) ctx.scale(-1, 1)
    ctx.drawImage(im, -dw / 2, -dh / 2, dw, dh)
    ctx.restore()
  }
  // 左手镜像（拇指朝屏幕中间），右手不镜像
  drawHand(W * 0.24, H * A5.L.y, A5.L.grip, true)
  drawHand(W * 0.76, H * A5.R.y, A5.R.grip, false)
  ctx.restore()

  // 屏幕中上方：逐字打出；最后三个"爬"标红、每出一个顿一下
  {
    const fs2 = Math.max(14, H * 0.028)
    ctx.font = '400 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    let left = Math.floor(A5.txtT * 8)
    const y0 = H * 0.14, lh = fs2 * 1.75
    ctx.fillStyle = 'rgba(215,215,222,0.95)'
    for (let i = 0; i < A5.lines.length; i++) {
      const ln = A5.lines[i]
      const n = Math.max(0, Math.min(ln.length, left))
      if (n > 0) ctx.fillText(ln.slice(0, n), W / 2, y0 + i * lh)
      left -= ln.length
      if (left <= 0) break
    }
    // 红色"爬，爬，爬。。。。"
    const cy0 = y0 + A5.lines.length * lh
    let cx = W / 2 - 0
    const total = A5.climbChars.length
    const shown = Math.max(0, Math.min(total, Math.floor(A5.redT * 4)))
    ctx.font = '700 ' + (fs2 * 1.25).toFixed(0) + 'px ' + CFG.fontFamily
    let wsum = 0
    for (let i = 0; i < total; i++) wsum += ctx.measureText(A5.climbChars[i]).width
    let xx = W / 2 - wsum / 2
    for (let i = 0; i < shown; i++) {
      const ch = A5.climbChars[i]
      ctx.fillStyle = ch === '爬' ? 'rgba(230,40,30,0.98)' : 'rgba(215,215,222,0.9)'
      ctx.textAlign = 'left'
      ctx.fillText(ch, xx, cy0)
      xx += ctx.measureText(ch).width
    }
    ctx.textAlign = 'center'
  }
}

function renderFinal() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)

  const f = H * 1.15
  const cx = W / 2, cy = H * 0.5
  const csY = Math.cos(A4.yaw), snY = Math.sin(A4.yaw)
  const cpP = Math.cos(A4.pitch), spP = -Math.sin(A4.pitch)
  const pj = (x, y, z) => {
    const dx = x - A4.px, dz = z - A4.pz
    const fx2 = dx * csY - dz * snY
    const fz2 = dx * snY + dz * csY
    const vy = y - (A4.eye + Math.sin(A4.bob || 0) * 0.075)
    const vyy = vy * cpP - fz2 * spP
    const vzz = vy * spP + fz2 * cpP
    const d = -vzz
    if (d < 0.4) return null
    return { x: cx + fx2 * f / d, y: cy - vyy * f / d }
  }
  const poly = (pts, fill, edge) => {
    if (pts.some(q => !q)) return
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
    ctx.fill()
    if (edge) {
      ctx.strokeStyle = 'rgba(200,200,208,0.5)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
  // 立柱（黑面 + 白棱）
  const drawSeg = (x, z, w, d, y0, y1) => {
    const hx = w / 2, hz = d / 2
    const b0 = [
      pj(x - hx, y0, z - hz), pj(x + hx, y0, z - hz), pj(x + hx, y0, z + hz), pj(x - hx, y0, z + hz),
    ]
    const b1 = [
      pj(x - hx, y1, z - hz), pj(x + hx, y1, z - hz), pj(x + hx, y1, z + hz), pj(x - hx, y1, z + hz),
    ]
    if (b0.some(q => !q) || b1.some(q => !q)) return
    poly([b0[0], b0[1], b1[1], b1[0]], '#0d0d11', true)
    poly([b0[3], b0[0], b1[0], b1[3]], '#08080b', true)
    poly([b0[1], b0[2], b1[2], b1[1]], '#08080b', true)
    poly([b1[0], b1[1], b1[2], b1[3]], '#15151b', true)
  }
  const drawCol = (c) => {
    drawSeg(c.x, c.z, c.w, c.d, 0, c.h)
  }

  // 地面
  {
    const zBack = Math.max(A4.pz - 90, A4.pz - 80)
    const g1 = pj(A4.px - 60, 0, A4.pz - 78), g2 = pj(A4.px + 60, 0, A4.pz - 78)
    const g3 = pj(A4.px + 60, 0, A4.pz + 6), g4 = pj(A4.px - 60, 0, A4.pz + 6)
    if (g1 && g2 && g3 && g4) {
      poly([g1, g2, g3, g4], '#070709', true)
    }
  }

  // 石柱：远 → 近
  const ordered = A4.cols.slice().sort((a, b) => a.z - b.z)
  for (const c of ordered) drawCol(c)

  // 负伤：走路时抖动 + 画面逐渐泛红再复原
  if (A4.walking) {
    A4.inj = 0.5 + 0.5 * Math.sin((A4.bob || 0) * 0.6)
    const jx = (Math.random() - 0.5) * 5 * A4.inj
    const jy = (Math.random() - 0.5) * 5 * A4.inj
    ctx.save()
    ctx.translate(jx, jy)
    const grd = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.62)
    grd.addColorStop(0, 'rgba(150,10,10,0)')
    grd.addColorStop(1, 'rgba(150,10,10,' + (0.42 * A4.inj).toFixed(3) + ')')
    ctx.fillStyle = grd
    ctx.fillRect(-10, -10, W + 20, H + 20)
    ctx.restore()
  }

  // 底部灰字台词（打字机）
  if (!A4.sub.done) {
    const line = A4_LINES[A4.sub.i] || ''
    const n = Math.min(line.length, Math.floor(A4.sub.t * 10))
    const fs2 = Math.max(14, H * 0.028)
    ctx.font = '400 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(180,180,186,0.92)'
    ctx.fillText(line.slice(0, n), W / 2, H * 0.93)
  }
  // 靠近悬崖后淡黑
  if (A4.fadeOut >= 0) {
    ctx.fillStyle = 'rgba(0,0,0,' + Math.min(1, A4.fadeOut / 1.6).toFixed(3) + ')'
    ctx.fillRect(0, 0, W, H)
  }

  const k2 = Math.min(1, A4.t / 2.5)
  if (k2 < 1) {
    ctx.fillStyle = 'rgba(0,0,0,' + (1 - k2).toFixed(3) + ')'
    ctx.fillRect(0, 0, W, H)
  }
}

let A3_GUN = null
function prepareGunSound() {
  if (A3_GUN) return
  try {
    A3_GUN = new Audio('assets/sfx/gunshot.mp3')
    A3_GUN.preload = 'auto'
    A3_GUN.volume = 0.8
    A3_GUN.load()
  } catch (e) { A3_GUN = null }
}
function playGunSound() {
  if (!A3_GUN) prepareGunSound()
  if (!A3_GUN) return
  try { A3_GUN.currentTime = 0; A3_GUN.play().catch(() => {}) } catch (e) {}
}

let A3_BGM = null
function prepareBattleMusic() {
  if (A3_BGM) return
  try {
    A3_BGM = new Audio('assets/sfx/battle.mp3')
    A3_BGM.loop = true
    A3_BGM.volume = 0.42
    A3_BGM.preload = 'auto'
    A3_BGM.load()
  } catch (e) { A3_BGM = null }
}
function playBattleMusic() {
  if (!A3_BGM) {
    try {
      A3_BGM = new Audio('assets/sfx/battle.mp3')
      A3_BGM.loop = true
      A3_BGM.volume = 0.34
    } catch (e) { A3_BGM = null }
  }
  if (A3_BGM && A3_BGM.paused) A3_BGM.play().catch(() => {})
}
function stopBattleMusic() {
  if (A3_BGM && !A3_BGM.paused) { try { A3_BGM.pause() } catch (e) {} }
}

const A3 = {
  t: 0, started: false, fade: 1, houses: [], img: null,
  line1: '躲在这里……应该没事情了吧……我还……不能死在这里',
  eyeT: 0, eyeOn: false, redTxt: 0,
  game: { active: false, done: false, slots: [], floats: [], dragChar: null, dragX: 0, dragY: 0,
          parts: [], shake: 0, eyeWhite: 0, t: 0 },
  CELLS: [],
}
function loadA3Image() {
  if (A3.img) return
  const im = new Image()
  im.src = 'assets/act3-village.png'
  A3.img = im
}

function startAct3() {
  try { if (document.exitPointerLock) document.exitPointerLock() } catch (e) {}
  if (A3.started) return
  A3.started = true
  A3.t = 0
  A3.fade = 1
  // 村子轮廓：一排黑房子 + 白棱线，越远越小
  A3.houses = []
  let x = -9
  let seed = 1.7
  while (x < 9) {
    const w = 1.2 + ((seed * 37) % 1) * 1.4
    const h = 1.4 + ((seed * 53) % 1) * 1.6
    A3.houses.push({ x: x + w / 2, w: w, h: h, z: -14 - ((seed * 91) % 1) * 22 })
    x += w + 0.6 + ((seed * 17) % 1) * 0.8
    seed += 1.31
  }
  loadA3Image()
  prepareBattleMusic()
  prepareGunSound()
  S.mode = 'act3'
  try {
    if (A2_MARCH) { A2_MARCH.pause() }
    if (A2.run.breath) { A2.run.breath.pause() }
    if (A2_FIGHT.crowds) A2_FIGHT.crowds.forEach(c => { try { c.pause() } catch (e) {} })
  } catch (e) {}
}

function updateAct3(dt) {
  A3.t += dt
  updateA3Game(dt)
  A3.fade = Math.max(0, 1 - A3.t / 2.5)
}

/* ---- 第四段：拖字小游戏（多阶段） ---- */
const A3_P = {
  0: { text: '他一拳打在我脸上', move: [0, 5] },
  1: { text: '随之而来的是他的一巴掌', move: [] },
  2: { text: '我被打得踉跄', move: [] },
  3: { text: '我用力向他冲去，没把他撞翻', move: [] },
  4: { text: '他在上，我在下', move: [0, 4] },
  5: { text: '我顺势摸向他的腰间，摸到', move: [], blank: true },
}
const A3_RING = ['烟', '土', '钱', '表', '枪', '绳', '书', '笔', '饼', '纸', '线']

function a3SetPhase(n) {
  const G = A3.game
  G.phase = n
  G.phaseT = 0
  G.floats = []
  G.dragChar = null
  G.parts = []
  G.flash = 0
  G.ring = []
  if (n >= 0 && n <= 5) {
    const def = A3_P[n]
    G.slots = def.text.split('')
    if (def.blank) G.slots.push('')
  } else {
    G.slots = []
  }
  if (n === 8) {
    G.knife = {
      t: 0, count: 0, knives: [], px: W / 2, py: H * 0.90,
      hist: [], spawnT: 0, cross: -1, phase: 'intro', placed: false,
    }
  }
  if (n === 5) {
    for (let k = 0; k < A3_RING.length; k++) {
      const a = -Math.PI * 0.9 + (k / A3_RING.length) * Math.PI * 1.8
      // 从屏幕外（上方随机高处）掉进来，错开时间
      G.ring.push({
        ch: A3_RING[k], a: a, t0: 0.15 + k * 0.11,
        fx: (Math.random() * 1.4 - 0.2) * (typeof W === 'number' ? W : 1200),
        fy: -120 - Math.random() * 260,
        x: 0, y: -300, done: false,
      })
    }
  }
  if (n === 1) G.flash = 0.5
}

function a3StartGame() {
  try { if (document.exitPointerLock) document.exitPointerLock() } catch (e) {}
  const G = A3.game
  if (G.active) return
  G.active = true
  G.done = false
  G.t = 0
  G.shake = 0
  G.eyeWhite = 0
  G.blackFade = 0
  G.msg = false
  G.wentFinal = false      // 重玩时要把"已进悬崖"清掉，否则第二次打完不会切幕
  G.clicked = false
  G.wentEnd = false
  a3SetPhase(0)
}

function a3Hit(nextPhase, delay) {
  const G = A3.game
  G.shake = 1
  G.eyeWhite = 0.5
  for (let i = 0; i < 46; i++) {
    G.parts.push({
      x: (Math.random() - 0.5) * 90, y: (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 380, vy: 80 + Math.random() * 320,
      life: 1.8, r: 4 + Math.random() * 4,
    })
  }
  G.nextPhase = nextPhase
  G.nextDelay = delay || 1.3
}

function a3CheckWin() {
  const G = A3.game
  if (G.done || G.nextPhase != null) return
  const ph = G.phase
  if (ph === 0) {
    if (G.slots[0] === '我' && G.slots[5] === '他' && G.floats.length === 0) a3Hit(1)
  } else if (ph === 3) {
    // "没" 被拖出句子
    const idx = A3_P[3].text.indexOf('没')
    if (G.slots[idx] === '' && G.floats.some(f => f.ch === '没')) a3Hit(4)
  } else if (ph === 4) {
    if (G.slots[0] === '我' && G.slots[4] === '他' && G.floats.length === 0) a3Hit(8)
  } else if (ph === 5) {
    const bi = G.slots.length - 1
    if (G.slots[bi] === '枪') {
      G.done = true
      G.shake = 0.6
      G.eyeWhite = 0.4
      stopBattleMusic()
      playBreathLong()
      G.msg = true
      G.phase = 6
      G.phaseT = 0
    }
  }
}

function playBreathLong() {
  try {
    if (!A3.breath) {
      A3.breath = new Audio('assets/sfx/breath-long.mp3')
      A3.breath.loop = true
      A3.breath.volume = 0.5
    }
    A3.breath.play().catch(() => {})
  } catch (e) {}
}

function updateA3Game(dt) {
  const G = A3.game
  if (!G.active) return
  G.t += dt
  G.phaseT += dt
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 1.6)
  if (G.eyeWhite > 0) G.eyeWhite = Math.max(0, G.eyeWhite - dt)
  if (G.flash > 0) G.flash = Math.max(0, G.flash - dt)
  for (let i = G.parts.length - 1; i >= 0; i--) {
    const q = G.parts[i]
    q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 420 * dt
    q.life -= dt
    if (q.life <= 0) G.parts.splice(i, 1)
  }
  // ===== 刀阵（阶段 8）=====
  if (G.phase === 8 && G.knife) {
    const K = G.knife
    K.t += dt
    // 记录"我"的位置历史（用于 0.5 秒前的锁定）
    K.hist.push({ x: K.px, y: K.py, t: K.t })
    if (K.hist.length > 90) K.hist.shift()
    if (K.t < 1.0) return            // 先显示台词 1 秒
    // WASD 移动
    const spd = 430 * dt
    if (roomKeys['KeyA'] || roomKeys['ArrowLeft']) K.px -= spd
    if (roomKeys['KeyD'] || roomKeys['ArrowRight']) K.px += spd
    if (roomKeys['KeyW'] || roomKeys['ArrowUp']) K.py -= spd
    if (roomKeys['KeyS'] || roomKeys['ArrowDown']) K.py += spd
    K.px = Math.max(W * 0.06, Math.min(W * 0.94, K.px))
    K.py = Math.max(H * 0.18, Math.min(H * 0.92, K.py))

    // 生成刀：2~5 把/秒
    K.spawnT -= dt
    if (K.spawnT <= 0 && K.count < 70) {
      K.spawnT = 0.22 + Math.random() * 0.3
      K.count++
      K.knives.push({ x: W * (0.06 + Math.random() * 0.88), y: -50, st: 'wait', t: 0, tx: 0, ty: 0 })
    }
    // 刀逻辑
    for (let i = K.knives.length - 1; i >= 0; i--) {
      const k2 = K.knives[i]
      k2.t += dt
      if (k2.st === 'wait') {
        if (k2.t >= 1.0) {
          k2.st = 'dive'
          // 锁定"我"0.5 秒前的位置
          let ref = null
          for (const h of K.hist) { if (h.t >= K.t - 0.5) { ref = h; break } }
          k2.tx = ref ? ref.x : K.px
          k2.ty = ref ? ref.y : K.py
          const L = Math.hypot(k2.tx - k2.x, k2.ty - k2.y) || 1
          k2.vx = (k2.tx - k2.x) / L * 560
          k2.vy = (k2.ty - k2.y) / L * 560
        }
      } else {
        k2.x += k2.vx * dt
        k2.y += k2.vy * dt
        if (Math.hypot(k2.x - K.px, k2.y - K.py) < 34) {
          // 被扎：整段重来
          a3SetPhase(8)
          return
        }
        if (k2.y > H + 80 || k2.x < -80 || k2.x > W + 80) K.knives.splice(i, 1)
      }
    }
    // 30 把之后出大红叉（落刀照常）
    if (K.count >= 30 && K.cross < 0) { K.cross = 0 }
    if (K.cross >= 0) {
      K.cross += dt
      // 红叉出现 2 秒后，每隔 2 秒左右两侧各飞一把极快的刀
      if (K.cross >= 2.0) {
        K.diagT = (K.diagT == null ? 1.4 : K.diagT) + dt
        K.wave = K.wave || 0
        if (K.diagT >= 1.4 && K.wave < 5) {
          K.diagT = 0
          K.wave++
          const spd2 = 2400
          // 严格沿两条红线：(0,0)->(W,H) 与 (W,0)->(0,H)
          const L1 = Math.hypot(W, H)
          const ux = W / L1, uy = H / L1
          K.knives.push({ x: 0, y: 0, st: 'diag', vx: ux * spd2, vy: uy * spd2, t: 0 })
          K.knives.push({ x: W, y: 0, st: 'diag', vx: -ux * spd2, vy: uy * spd2, t: 0 })
        }
      }
      // 第一次快刀过后，红叉慢慢消失（2.0~4.5 秒）
      K.crossAlpha = K.cross < 2.0 ? 0.42 : Math.max(0, 0.42 * (1 - (K.cross - 2.0) / 2.5))
      for (const k3 of K.knives) {
        if (k3.st === 'diag') {
          k3.x += k3.vx * dt
          k3.y += k3.vy * dt
          if (Math.hypot(k3.x - K.px, k3.y - K.py) < 30) { a3SetPhase(8); return }
          if (k3.y > H + 60 || k3.x < -80 || k3.x > W + 80) k3.dead = true
        }
      }
      K.knives = K.knives.filter(k4 => !k4.dead)
    }
    // 完成 70 把
    if (K.count >= 70 && K.t > 4.5) { a3SetPhase(5); return }
    return
  }

  // 环形字：先掉进来，到位后环绕眼睛慢慢转
  if (G.ring && G.ring.length) {
    const ecx = W / 2, ecy = H * 0.36
    const rx = Math.min(W, H) * 0.46, ry = Math.min(W, H) * 0.34
    for (const r of G.ring) {
      if (G.floats.some(f => f.ch === r.ch)) continue
      const tx = ecx + Math.cos(r.a) * rx
      const ty = ecy + Math.sin(r.a) * ry
      if (!r.done) {
        const k = Math.max(0, Math.min(1, (G.phaseT - r.t0) / 0.9))
        const e = k * k
        r.x = r.fx + (tx - r.fx) * e
        r.y = r.fy + (ty - r.fy) * e
        if (k >= 1) r.done = true
      } else {
        r.a += 0.35 * dt
        r.x = ecx + Math.cos(r.a) * rx
        r.y = ecy + Math.sin(r.a) * ry
      }
    }
  }

  // 阶段自动推进
  if (G.nextPhase != null) {
    G.nextDelay -= dt
    if (G.nextDelay <= 0) {
      const n = G.nextPhase
      G.nextPhase = null
      a3SetPhase(n)
    }
    return
  }
  if (G.phase === 1 && G.phaseT > 1.7) a3SetPhase(2)
  else if (G.phase === 2 && G.phaseT > 2.0) a3SetPhase(3)
  else if (G.phase === 6 && G.clicked && G.done) {
    G.clicked = false
    G.phase = 7
    G.phaseT = 0
    G.shake = 0.5
    playGunSound()          // 枪声和这次左键点击同一帧
  }
  if (G.phase === 7) {
    G.shake = Math.min(3.2, 0.5 + G.phaseT * 0.7)
    G.blackFade = Math.min(1, Math.max(0, (G.phaseT - 3.2) / 1.6))
    if (G.blackFade > 0.6) {
      // 黑屏一开始就把喘气/战斗音乐停掉
      try { if (A3.breath) { A3.breath.pause(); A3.breath.volume = 0 } } catch (e) {}
      try { stopBattleMusic() } catch (e) {}
    }
    // 全黑后进最后的悬崖
    if (G.blackFade >= 1 && !G.wentFinal) {
      G.wentFinal = true
      try { if (document.exitPointerLock) document.exitPointerLock() } catch (e) {}
      startFinal()
    }
  }
}

function a3DrawGame(dt) {
  const G = A3.game
  const fs = Math.max(24, H * 0.055)
  ctx.font = '700 ' + fs.toFixed(0) + 'px ' + CFG.fontFamily
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const gap = fs * 0.10
  const y = H * 0.90
  // 环形字（第 5 阶段）
  A3.RINGBOX = []
  if (G.ring.length) {
    const ecx = W / 2, ecy = H * 0.36
    const rx = Math.min(W, H) * 0.46, ry = Math.min(W, H) * 0.34
    for (const r of G.ring) {
      if (G.floats.some(f => f.ch === r.ch)) continue
      if (!r.done && G.phaseT < r.t0) continue
      const x = r.x, yy = r.y
      const w2 = ctx.measureText(r.ch).width
      ctx.fillStyle = 'rgba(228,228,234,0.95)'
      ctx.fillText(r.ch, x - w2 / 2, yy)
      A3.RINGBOX.push({ x: x - w2 / 2, y: yy - fs * 0.6, w: w2, h: fs * 1.2, ch: r.ch })
    }
  }
  // 句子
  let total = 0
  for (let i = 0; i < G.slots.length; i++) {
    total += (G.slots[i] ? ctx.measureText(G.slots[i]).width : ctx.measureText('一').width) + gap
  }
  let x = W / 2 - total / 2
  A3.CELLS = []
  const moveSet = (A3_P[G.phase] && A3_P[G.phase].move) || []
  for (let i = 0; i < G.slots.length; i++) {
    const ch = G.slots[i]
    const w = ctx.measureText(ch || '一').width
    A3.CELLS.push({ x: x, y: y - fs * 0.6, w: w, h: fs * 1.2, idx: i, empty: !ch, ch: ch })
    if (ch) {
      const isRed = (moveSet.indexOf(i) >= 0 || (G.phase === 3 && ch === '没')) && !G.done && G.nextPhase == null
      ctx.fillStyle = isRed ? 'rgba(225,35,25,0.98)' : 'rgba(232,232,238,0.96)'
      ctx.fillText(ch, x, y)
      if (isRed) ctx.fillRect(x, y + fs * 0.52, w, Math.max(2, fs * 0.05))
    } else {
      // 空位：下划线框
      ctx.strokeStyle = 'rgba(220,220,226,0.8)'
      ctx.lineWidth = 2
      ctx.strokeRect(x, y - fs * 0.42, w, fs * 0.95)
    }
    x += w + gap
  }
  // 浮动词
  A3.FLOATBOX = []
  for (const f of G.floats) {
    const w = ctx.measureText(f.ch).width
    ctx.fillStyle = 'rgba(232,232,238,0.96)'
    ctx.fillText(f.ch, f.x - w / 2, f.y)
    A3.FLOATBOX.push({ x: f.x - w / 2, y: f.y - fs * 0.6, w: w, h: fs * 1.2, f: f })
  }
  // 拖着的字
  if (G.dragChar) {
    const w = ctx.measureText(G.dragChar.ch).width
    ctx.fillStyle = 'rgba(232,232,238,0.96)'
    ctx.fillText(G.dragChar.ch, G.dragX - w / 2, G.dragY)
  }
  // 阶段 6：按下左键开枪
  if (G.phase === 6) {
    ctx.textAlign = 'center'
    ctx.font = '400 ' + Math.max(16, H * 0.034).toFixed(0) + 'px ' + CFG.fontFamily
    const blink = 0.55 + 0.45 * Math.sin(G.t * 4)
    ctx.fillStyle = 'rgba(190,190,196,' + blink.toFixed(2) + ')'
    ctx.fillText('按下左键开枪', W / 2, H * 0.86)
  }
}

function drawBigEye(cx, cy, r, et, invert) {
  // 像素风：先画在 48x32 的小画布上，再放大（关掉平滑）
  const PW = 48, PH = 32
  if (!A3.eyeC) {
    A3.eyeC = document.createElement('canvas')
    A3.eyeC.width = PW
    A3.eyeC.height = PH
    A3.eyeP = A3.eyeC.getContext('2d')
  }
  const g = A3.eyeP
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, PW, PH)
  g.imageSmoothingEnabled = false

  // 眼白（像素椭圆，一个一个格子填）
  const cxp = 24, cyp = 16, rxp = 23, ryp = 12.5
  const noiseAt = (x, y) => (Math.sin(x * 1.73 + y * 2.31) * 0.5 + Math.sin(x * 3.11 - y * 1.37) * 0.5) * 0.06
  g.fillStyle = '#f0f0f2'
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const dx = (x + 0.5 - cxp) / rxp, dy = (y + 0.5 - cyp) / ryp
      if (dx * dx + dy * dy + noiseAt(x, y) <= 1) g.fillRect(x, y, 1, 1)
    }
  }
  // 血丝（像素折线）
  g.fillStyle = '#b81a1a'
  let sd = 7.7
  const rnd = () => { sd = (sd * 9301 + 49297) % 233280; return sd / 233280 }
  for (let i2 = 0; i2 < 22; i2++) {
    const a = rnd() * Math.PI * 2
    let x = Math.round(cxp + Math.cos(a) * rxp * 0.98)
    let y = Math.round(cyp + Math.sin(a) * ryp * 0.98)
    for (let k = 0; k < 9; k++) {
      x += (cxp - x) * 0.18 + Math.round((rnd() - 0.5) * 1.6)
      y += (cyp - y) * 0.18 + Math.round((rnd() - 0.5) * 1.6)
      if (x < 0 || y < 0 || x >= PW || y >= PH) break
      g.fillRect(x, y, 1, 1)
    }
  }
  // 黑瞳孔（像素圆）
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const dx = x + 0.5 - cxp, dy = y + 0.5 - (cyp + 0.5)
      if (dx * dx + dy * dy <= 7.2 * 7.2) { g.fillStyle = invert ? '#ffffff' : '#040404'; g.fillRect(x, y, 1, 1) }
    }
  }
  // 高光
  g.fillStyle = 'rgba(255,255,255,0.9)'
  g.fillRect(cxp - 4, cyp - 4, 2, 2)
  // 外轮廓（深色像素描边）
  g.fillStyle = invert ? '#ffffff' : '#151518'
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const dx = (x + 0.5 - cxp) / rxp, dy = (y + 0.5 - cyp) / ryp
      const d = dx * dx + dy * dy + noiseAt(x, y)
      if (d > 0.90 && d <= 1.08) g.fillRect(x, y, 1, 1)
    }
  }

  // 放大到屏幕（保持方块感）
  const w = r * 2, h = r * 2 * (PH / PW)
  const prev = ctx.imageSmoothingEnabled
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(A3.eyeC, cx - w / 2, cy - h / 2, w, h)
  ctx.imageSmoothingEnabled = prev
}

function renderAct3() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)

  const t = A3.t
  let shot = 0
  let fade = 0
  if (t < 2.5) { shot = 0; fade = 1 - t / 2.5 }          // 渐亮：村道
  else if (t < 8.0) { shot = 0; fade = 0 }                // 村道停留
  else if (t < 9.5) { shot = 0; fade = (t - 8.0) / 1.5 }  // 渐黑
  else if (t < 11.5) { shot = 1; fade = 1 - (t - 9.5) / 2.0 } // 渐亮：草房
  else if (t < 15.0) { shot = 1; fade = 0 }               // 草房停留 3.5 秒
  else if (t < 17.0) { shot = 1; fade = (t - 15.0) / 2.0 }// 渐黑
  else { shot = 1; fade = 1 }

  // 底部台词（打字机，17~21 秒）—— 黑底单独画，避免被后面的场景/渐黑盖住
  if (t >= 17.0 && t < 21.2) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    const n = Math.min(A3.line1.length, Math.floor((t - 17.0) * 8))
    const txt = A3.line1.slice(0, n)
    const fs = Math.max(15, H * 0.030)
    ctx.font = '400 ' + fs.toFixed(0) + 'px ' + CFG.fontFamily
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(190,190,196,' + (t > 20.6 ? (21.2 - t) / 0.6 : 1).toFixed(2) + ')'
    ctx.fillText(txt, W / 2, H * 0.90)
    return
  }

  if (t >= 22.0) playBattleMusic()

  // ===== 刀阵渲染（阶段 8）=====
  if (A3.game.active && A3.game.phase === 8 && A3.game.knife) {
    const K = A3.game.knife
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    // 眼睛留在场上
    const r1 = Math.min(W, H) * 0.30, y1 = H * 0.36
    drawBigEye(W / 2, y1, r1, A3.game.t, false)
    {
      // 台词：除了"我"以外的字在 1 秒后逐渐淡出
      const txt = '他掏出一把刀猛扎，我赶忙躲闪'
      const fs2 = Math.max(20, H * 0.042)
      ctx.font = '700 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      const gap2 = fs2 * 0.06
      let total2 = 0
      for (const ch of txt) total2 += ctx.measureText(ch).width + gap2
      let xx = W / 2 - total2 / 2
      const yy = H * 0.90
      const fadeOut = K.t < 1.0 ? 1 : Math.max(0, 1 - (K.t - 1.0) / 0.5)
      for (const ch of txt) {
        const w3 = ctx.measureText(ch).width
        if (ch === '我') {
          if (!K.placed) { K.px = xx + w3 / 2; K.py = yy; K.placed = true }
          // 1 秒内跟着句子画，之后由可移动的那一份接管（避免出现两个"我"）
          if (K.t < 1.0) {
            ctx.fillStyle = 'rgba(240,240,246,0.98)'
            ctx.fillText(ch, xx, yy)
          }
        } else if (fadeOut > 0.01) {
          ctx.fillStyle = 'rgba(235,235,240,' + (0.96 * fadeOut).toFixed(3) + ')'
          ctx.fillText(ch, xx, yy)
        }
        xx += w3 + gap2
      }
    }
    if (K.t >= 1.0) {
      // 大红叉（半透明）
      if (K.cross >= 0 && (K.crossAlpha == null ? 0.42 : K.crossAlpha) > 0.005) {
        ctx.save()
        ctx.strokeStyle = 'rgba(220,30,25,' + (K.crossAlpha == null ? 0.42 : K.crossAlpha).toFixed(3) + ')'
        ctx.lineWidth = Math.max(16, W * 0.018)
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, H); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(W, 0); ctx.lineTo(0, H); ctx.stroke()
        ctx.restore()
      }
      // 刀
      ctx.font = '700 ' + Math.max(18, H * 0.038).toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      for (const k2 of K.knives) {
        ctx.fillStyle = k2.st === 'wait' ? 'rgba(220,40,30,0.75)' : 'rgba(240,45,32,0.98)'
        ctx.fillText('刀', k2.x, k2.y)
      }
      // 我（可移动）
      ctx.font = '700 ' + Math.max(24, H * 0.05).toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(240,240,246,0.98)'
      ctx.fillText('我', K.px, K.py)
      // 左下提示
      ctx.textAlign = 'left'
      ctx.font = '400 ' + Math.max(13, H * 0.024).toFixed(0) + 'px ' + CFG.fontFamily
      ctx.fillStyle = 'rgba(165,165,172,0.92)'
      ctx.fillText('WASD 躲闪', Math.max(12, H * 0.02), H - Math.max(12, H * 0.024) * 0.8)
    }
    return
  }

  // 小游戏阶段（多阶段流程）
  if (A3.game.active) {
    const G = A3.game
    const sh = G.shake
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.save()
    if (sh > 0) ctx.translate((Math.random() - 0.5) * 26 * sh, (Math.random() - 0.5) * 26 * sh)
    // 眼睛：从 0.47 平滑过渡到 0.30
    const gk = Math.min(1, G.t / 0.8)
    const r0 = Math.min(W, H) * 0.47, r1 = Math.min(W, H) * 0.30
    const y0 = H * 0.52, y1 = H * 0.36
    const ee = gk * gk * (3 - 2 * gk)
    drawBigEye(W / 2, y0 + (y1 - y0) * ee, r0 + (r1 - r0) * ee, G.t, G.eyeWhite > 0)
    // 句子 / 环形字 / 拖拽
    if (G.phase <= 5) a3DrawGame()
    // 红色粒子
    for (const q of G.parts) {
      const al = Math.min(1, q.life)
      ctx.fillStyle = 'rgba(255,45,32,' + al.toFixed(2) + ')'
      ctx.shadowColor = 'rgba(255,60,40,0.9)'
      ctx.shadowBlur = 12
      ctx.beginPath(); ctx.arc(W / 2 + q.x, H * 0.78 + q.y, q.r || 4, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0
    }
    ctx.restore()
    // 受击白闪：除眼睛外整屏变白 0.5 秒
    if (G.flash > 0) {
      const a = Math.min(1, G.flash / 0.5)
      ctx.save()
      ctx.fillStyle = 'rgba(245,245,248,' + (a * 0.96).toFixed(3) + ')'
      ctx.fillRect(0, 0, W, H)
      // 眼睛重新画在上层（保持可见）
      drawBigEye(W / 2, y1, r1, G.t, false)
      ctx.restore()
    }
    // 越来越黑
    if (G.blackFade > 0) {
      ctx.fillStyle = 'rgba(0,0,0,' + G.blackFade.toFixed(3) + ')'
      ctx.fillRect(0, 0, W, H)
    }
    return
  }

  // 21 秒之后：纯黑 + 眼睛 + 红字
  if (t >= 23.0) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    const et = t - 23.0
    // 眼睛放大 1.5 倍再回落（0.35 秒）
    // 出现在正中心(1倍) → 0.5 秒放大到 1.5 倍 → 保持 0.5 秒 → 0.5 秒缩回 1 倍
    let sc2 = 1
    if (et < 0.3) {
      const u = et / 0.3
      sc2 = 1 + 0.5 * (u * u * (3 - 2 * u))       // smoothstep 1 → 1.5
    } else if (et < 0.8) {
      sc2 = 1.5
    } else if (et < 1.1) {
      const u = (et - 0.8) / 0.3
      sc2 = 1.5 - 0.5 * (u * u * (3 - 2 * u))     // smoothstep 1.5 → 1
    } else {
      sc2 = 1
    }
    drawBigEye(W / 2, H * 0.52, Math.min(W, H) * 0.47 * Math.max(1, sc2), et)
    // 顶部红字（存在 3 秒）
    if (et < 3.0) {
      const fs2 = Math.max(30, H * 0.085)
      ctx.font = '700 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.shadowColor = 'rgba(255,30,20,0.75)'
      ctx.shadowBlur = fs2 * 0.5
      ctx.fillStyle = 'rgba(235,35,25,' + (et > 2.6 ? (3.0 - et) / 0.4 : 1).toFixed(2) + ')'
      ctx.fillText('找到一个！！！', W / 2, H * 0.06)
      ctx.shadowBlur = 0
    }
    playBattleMusic()
    if (et > 3.2 && !A3.game.active) a3StartGame()
    return
  }

  const f = H * 1.15
  const cx = W / 2, cy = H * 0.60
  // 3/4 视角：相机稍微偏一点，才能看到两个墙面 + 屋顶厚度（正对着看会显得很平）
  const yawA3 = shot === 1 ? 0.34 : 0.10
  const cs3 = Math.cos(yawA3), sn3 = Math.sin(yawA3)
  const pj = (x, y, z) => {
    const rx = x * cs3 + z * sn3
    const rz = -x * sn3 + z * cs3
    const d = -rz
    if (d < 0.25) return null
    return { x: cx + rx * f / d, y: cy - (y - 1.55) * f / d }
  }
  // 一个方块：黑面 + 白棱线
  const box = (x, y, z, w, h, dpt) => {
    const hx = w / 2, hz = dpt / 2
    const pts = [
      pj(x - hx, y, z - hz), pj(x + hx, y, z - hz), pj(x + hx, y, z + hz), pj(x - hx, y, z + hz),
      pj(x - hx, y + h, z - hz), pj(x + hx, y + h, z - hz), pj(x + hx, y + h, z + hz), pj(x - hx, y + h, z + hz),
    ]
    if (pts.some(q => !q)) return
    const face = (a, b, c, d2, shade) => {
      ctx.fillStyle = shade
      ctx.beginPath()
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d2.x, d2.y)
      ctx.closePath(); ctx.fill()
    }
    face(pts[4], pts[5], pts[6], pts[7], '#1b1b20')   // 顶
    face(pts[0], pts[1], pts[5], pts[4], '#141418')   // 前
    face(pts[1], pts[2], pts[6], pts[5], '#0e0e11')   // 右
    face(pts[3], pts[0], pts[4], pts[7], '#0b0b0e')   // 左
    ctx.strokeStyle = 'rgba(205,205,212,0.55)'
    ctx.lineWidth = 1
    const E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
    for (const [a, b] of E) {
      ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke()
    }
  }
  // 坡屋顶（三棱柱）
  const roof = (x, y, z, w, dpt, hh) => {
    const hx = w / 2, hz = dpt / 2
    const A = pj(x - hx, y, z - hz), B = pj(x + hx, y, z - hz), C = pj(x + hx, y, z + hz), D = pj(x - hx, y, z + hz)
    const T1 = pj(x, y + hh, z - hz), T2 = pj(x, y + hh, z + hz)
    if (!A || !B || !C || !D || !T1 || !T2) return
    ctx.fillStyle = '#1d1d23'
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(T1.x, T1.y); ctx.closePath(); ctx.fill()
    ctx.beginPath(); ctx.moveTo(D.x, D.y); ctx.lineTo(C.x, C.y); ctx.lineTo(T2.x, T2.y); ctx.closePath(); ctx.fill()
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(T1.x, T1.y); ctx.lineTo(T2.x, T2.y); ctx.lineTo(D.x, D.y); ctx.closePath(); ctx.fill()
    ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.lineTo(T2.x, T2.y); ctx.lineTo(T1.x, T1.y); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = 'rgba(210,210,218,0.6)'
    ctx.lineWidth = 1
    const seg = [[A,T1],[B,T1],[D,T2],[C,T2],[T1,T2],[A,B],[B,C],[C,D],[D,A]]
    for (const [a, b] of seg) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke() }
  }

  if (shot === 0) {
    // 村庄：用 Blender 渲染出的图片
    if (A3.img && A3.img.complete && A3.img.naturalWidth) {
      const iw = A3.img.naturalWidth, ih = A3.img.naturalHeight
      const k = Math.max(W / iw, H / ih)
      const dw = iw * k, dh = ih * k
      ctx.drawImage(A3.img, (W - dw) / 2, (H - dh) / 2, dw, dh)
    } else {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
    }
  } else {
    // ===== 近景：一座草房（参考 3D 像素房子：石基 + 木梁 + 分层草顶 + 烟囱 + 门窗框 + 篱笆） =====
    const line = (a, b, w2) => {
      if (!a || !b) return
      ctx.lineWidth = w2 || 1
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    }
    const WALL = 'rgba(215,215,222,0.62)'
    const SOFT = 'rgba(190,190,198,0.34)'

    // 地面
    ctx.fillStyle = '#040405'
    ctx.fillRect(0, cy, W, H - cy)
    ctx.strokeStyle = 'rgba(200,200,206,0.20)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, cy + 4); ctx.lineTo(W, cy + 4); ctx.stroke()

    const HX = -0.1, HZ = -11.0, HW = 5.4, HH = 2.5, HD = 4.2

    // 石基（比墙体略宽、矮）
    box(HX, 0, HZ, HW * 1.10, 0.55, HD * 1.06)
    ctx.strokeStyle = SOFT
    for (let r = 1; r <= 3; r++) {
      const yy = r * 0.17
      line(pj(HX - HW * 0.55, yy, HZ + HD * 0.53), pj(HX + HW * 0.55, yy, HZ + HD * 0.53))
    }
    // 墙体
    box(HX, 0.55, HZ, HW, HH, HD)
    // 墙面竖木梁
    ctx.strokeStyle = SOFT
    for (let k = -2; k <= 2; k++) {
      const xx = HX + k * HW * 0.24
      line(pj(xx, 0.55, HZ + HD / 2), pj(xx, 0.55 + HH, HZ + HD / 2))
    }
    line(pj(HX - HW / 2, 0.55 + HH * 0.62, HZ + HD / 2), pj(HX + HW / 2, 0.55 + HH * 0.62, HZ + HD / 2))

    // 分层草顶（三层，逐层收窄）
    const RY = 0.55 + HH
    roof(HX, RY, HZ, HW * 1.16, HD * 1.12, 0.55)
    roof(HX, RY + 0.5, HZ, HW * 0.98, HD * 1.0, 0.62)
    roof(HX, RY + 1.04, HZ, HW * 0.72, HD * 0.86, 0.7)
    // 草纹（每层的横向纹路）
    ctx.strokeStyle = 'rgba(205,205,214,0.34)'
    const ridgeY = RY + 1.04 + 0.7
    for (let k = 1; k <= 7; k++) {
      const yy = RY + k * 0.26
      const halfW = HW * (0.62 - k * 0.05)
      line(pj(HX - halfW, yy, HZ + HD * 0.55), pj(HX + halfW, yy, HZ + HD * 0.55), 0.8)
    }
    // 屋脊
    ctx.strokeStyle = WALL
    line(pj(HX, ridgeY, HZ - HD * 0.46), pj(HX, ridgeY, HZ + HD * 0.46), 1.4)

    // 烟囱
    box(HX + HW * 0.34, RY + 0.35, HZ - HD * 0.1, 0.42, 1.15, 0.42)

    // 门（框 + 台阶）
    const doorZ = HZ + HD / 2 + 0.01
    const dL = -0.75, dR = 0.35, dH = 1.65
    ctx.strokeStyle = 'rgba(235,235,242,0.85)'
    ctx.lineWidth = 1.4
    const p1 = pj(HX + dL, 0.55, doorZ), p2 = pj(HX + dR, 0.55, doorZ)
    const p3 = pj(HX + dR, 0.55 + dH, doorZ), p4 = pj(HX + dL, 0.55 + dH, doorZ)
    if (p1 && p2 && p3 && p4) {
      ctx.fillStyle = '#000'
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }
    box(HX - 0.2, 0, HZ + HD / 2 + 0.35, 1.6, 0.28, 0.9)   // 门前台阶

    // 窗（四格窗框）
    const win = (wx, wy, ww, wh) => {
      const a = pj(wx, wy, doorZ), b = pj(wx + ww, wy, doorZ), c2 = pj(wx + ww, wy + wh, doorZ), d = pj(wx, wy + wh, doorZ)
      if (!a || !b || !c2 || !d) return
      ctx.strokeStyle = 'rgba(235,235,242,0.8)'
      ctx.lineWidth = 1.3
      ctx.fillStyle = '#000'
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(d.x, d.y)
      ctx.closePath(); ctx.fill(); ctx.stroke()
      // 十字窗棂
      const mx = (a.x + b.x) / 2, my = (a.y + c2.y) / 2
      ctx.strokeStyle = 'rgba(200,200,208,0.55)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(mx, a.y); ctx.lineTo(mx, c2.y); ctx.moveTo(a.x, my); ctx.lineTo(b.x, my); ctx.stroke()
    }
    win(HX + 1.05, 1.25, 0.95, 0.85)
    win(HX - 2.15, 1.25, 0.85, 0.8)

    // 屋檐下的横梁
    ctx.strokeStyle = WALL
    line(pj(HX - HW * 0.58, RY, HZ + HD * 0.56), pj(HX + HW * 0.58, RY, HZ + HD * 0.56), 1.3)

    // 两侧篱笆
    ctx.strokeStyle = 'rgba(190,190,198,0.45)'
    for (const side of [-1, 1]) {
      const bx0 = HX + side * (HW * 0.62), bx1 = HX + side * (HW * 0.62 + 2.2)
      const fz = HZ + HD / 2 - 0.2
      line(pj(bx0, 0.75, fz), pj(bx1, 0.75, fz), 1.2)
      line(pj(bx0, 0.42, fz), pj(bx1, 0.42, fz), 1.0)
      for (let k = 0; k <= 4; k++) {
        const xx = bx0 + (bx1 - bx0) * (k / 4)
        line(pj(xx, 0, fz), pj(xx, 0.85, fz), 0.9)
      }
    }

    // 柴堆
    for (let k = 0; k < 3; k++) {
      box(HX + HW * 0.72, k * 0.22, HZ + HD / 2 - 0.9, 1.1, 0.2, 0.5)
    }
  }

  if (fade > 0) {
    ctx.fillStyle = 'rgba(0,0,0,' + Math.min(1, fade).toFixed(3) + ')'
    ctx.fillRect(0, 0, W, H)
  }
}

function updateAct2(dt) {
  A2.t += dt
  // —— 移动：和房间一样，WASD / 方向键；Q、E 抬头低头 ——
  const cam = A2.cam
  let fx = 0, fz = 0
  if (roomKeys['KeyW'] || roomKeys['ArrowUp']) fz -= 1
  if (roomKeys['KeyS'] || roomKeys['ArrowDown']) fz += 1
  if (roomKeys['KeyA'] || roomKeys['ArrowLeft']) fx -= 1
  if (roomKeys['KeyD'] || roomKeys['ArrowRight']) fx += 1
  const len = Math.hypot(fx, fz)
  if (len > 0.001) {
    fx /= len; fz /= len
    const cs = Math.cos(cam.yaw), sn = Math.sin(cam.yaw)
    const wx = fx * cs + fz * sn
    const wz = -fx * sn + fz * cs
    const sp = 0.85 * dt           // 主角移速 = 队伍的行军速度
    cam.x = clamp(cam.x + wx * sp, -5.2, 5.2)
    cam.z = clamp(cam.z + wz * sp, -700, 110)
    A2.walk += sp
  }
  if (roomKeys['KeyQ'] || roomKeys['PageUp']) cam.pitch = clamp(cam.pitch - dt * 0.9, -1.1, 1.1)
  if (roomKeys['KeyE'] || roomKeys['PageDown']) cam.pitch = clamp(cam.pitch + dt * 0.9, -1.1, 1.1)
  updateRun(dt)
  updateFight(dt)
  if (A2.t > 2.2 && !(A2.run && A2.run.done)) {
    playMarchAudio()
    if (A2_MARCH && A2_MARCH.paused) A2_MARCH.play().catch(() => {})   // 被拦过就继续重试
  }
  if (A2_MARCH && !A2_MARCH.paused) {
    // 先用 9 秒从几乎无声涨到目标音量，再叠加 1.2 秒的呼吸起伏
    const ramp = Math.min(1, Math.max(0, (A2.t - 2.2) / 9))
    const ph = (A2.t * 0.84) % 1
    const wave = 0.55 + 0.45 * Math.cos(ph * Math.PI * 2)
    A2_MARCH.volume = ramp * (0.05 + 0.26 * wave) * (A2_FIGHT.on ? 0.55 : 1.0)
  }

  // 字幕：画面切入 5 秒后才开始；一句一句慢慢打；播完不循环
  if (A2.t > 15 && !A2.sub.done) {
    const sb = A2.sub
    const seg = A2_SEGS[sb.i]
    if (!seg) {
      sb.done = true
    } else if (sb.wait > 0) {
      sb.wait -= dt
    } else {
      // 播到"有敌人！"这一段时，战斗音效开始（一直持续到本幕结束）
      if (seg.text.indexOf('有敌人') >= 0 && !A2_FIGHT.on) startFight()
      if (seg.text.indexOf('什么声音') >= 0 && A2.stopT < 0) A2.stopT = 0
      if (seg.text.indexOf('村子跑') >= 0 && !A2.run.active) startRun()
      if (seg.text.indexOf('掩护') >= 0 && !A2.cover) {
        A2.cover = true
        if (A2.fires) {
          for (const f of A2.fires) {
            if (f.runner) continue
            f.kind = 2          // 剩下的人全部换成端枪掩护的姿势
            f.cover = true
            f.shootT = Math.random() * 0.6
          }
        }
      }
      sb.t += dt
      const typed = seg.shout ? seg.text.length : Math.floor(sb.t * 6)
      if (typed >= seg.text.length) {
        sb.holdT += dt
        if (sb.holdT >= (seg.shout ? 1.3 : 0.85)) {
          sb.i++
          sb.t = 0
          sb.holdT = 0
          const nx = A2_SEGS[sb.i]
          sb.wait = nx ? (nx.pre || 0) : 0
        }
      }
    }
  }

  // 队伍移动：先慢慢停住；端枪的一半快速前冲；喊"掩护"之后另一半后退射击
  if (A2.stopT >= 0) A2.stopT += dt
  if (A2.fires) {
    for (const f of A2.fires) {
      if (f.down) { f.speedK = 0; continue }
      const runner = !!f.runner
      let spd
      if (runner) {
        spd = 4.2                      // 端枪的一半：快速往前跑
      } else if (A2.cover) {
        spd = 0                        // 掩护的一半：原地站着开枪
      } else {
        let k = 0
        if (A2.stopT >= 0) k = Math.max(0, Math.min(1, (A2.stopT - (f.stopDelay || 0)) / 0.8))
        spd = 0.85 * (1 - k)
      }
      f.z -= spd * dt
      f.speedK = Math.min(1, Math.abs(spd) / 0.85)
      if (f.z < -110) f.z += 220
      if (f.z > 110) f.z -= 220
    }
  }

  // 掩护阶段：后退的人不断射出红色子弹（朝后方 +z 飞）
  if (A2.cover) {
    for (const f of A2.fires) {
      if (!f.cover || f.down) continue
      f.shootT = (f.shootT || 0) - dt
      if (f.shootT <= 0) {
        f.shootT = 0.25 + Math.random() * 0.5
        A2.bullets.push({ x: f.x, y: 1.25, z: f.z, life: 1.4 })
      }
    }
    for (let i = A2.bullets.length - 1; i >= 0; i--) {
      const b = A2.bullets[i]
      b.z += 62 * dt                   // 很快
      b.life -= dt
      if (b.life <= 0 || b.z > 120) A2.bullets.splice(i, 1)
    }
  }

  // 敌方子弹：从镜头后方（+z 远处）朝队伍打，黄色短线
  if (A2.cover) {
    A2.ebulletT = (A2.ebulletT || 0) - dt
    if (A2.ebulletT <= 0) {
      A2.ebulletT = 0.035 + Math.random() * 0.07
      // 一次打 3 发，弹幕更密
      for (let k = 0; k < 3; k++) {
        const pool = A2.fires.filter(f => !f.down)
        const aim = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
        const tx = aim ? aim.x : 0
        A2.ebullets.push({
          x: tx + (Math.random() - 0.5) * 1.6,
          y: 1.15,
          z: A2.cam.z + 30,
          vz: -52,
          dx: ((tx - A2.cam.x) / 30) * 52,
        })
      }
    }
    for (let i = A2.ebullets.length - 1; i >= 0; i--) {
      const b = A2.ebullets[i]
      b.z += b.vz * dt
      b.x += (b.dx || 0) * dt
      // 命中判定：体积很小（半径 0.32m）
      let hit = false
      for (const f of A2.fires) {
        if (f.down) continue
        const dz = b.z - f.z
        if (dz > 0.6 || dz < -0.6) continue
        if (Math.abs(b.x - f.x) > 0.32) continue
        f.hp = (f.hp || 0) + 1
        if (f.hp >= 10) f.down = true
        hit = true
        break
      }
      if (hit || b.z < A2.cam.z - 60) A2.ebullets.splice(i, 1)
    }
  }

  // 火焰延迟出现：人先浮现，火再慢慢亮起来
  if (A2.fires) {
    for (const f of A2.fires) {
      const shown = A2.done || Math.hypot(f.x, f.z) <= A2.ringR
      if (shown) f.fireT = (f.fireT || 0) + dt
    }
  }
  if (A2.t > 1.2) {
    const r = (A2.t - 1.2) * 7          // 光圈扩散速度 m/s
    A2.ringOn = r < 240
    if (!A2.ringOn) A2.done = true
    A2.ringR = r
  }
}

/* 光圈扫到多远就画多少个元素 */
function a2VisibleCount() {
  if (A2.done) return A2.total || 0           // 光圈扫完：全部保留
  if (!A2.ringOn) return 0                    // 还没开始：一个都不画
  let n = 0
  for (const o of A2.order) {
    if (o.d <= A2.ringR) n = o.count
    else break
  }
  return n
}


/* ============================ 奔跑小游戏 ============================ */
function startRun(isRestart) {
  const R = A2.run
  if (R.active) return
  if (!isRestart || !R.origin) {
    // 记下说这句台词那一刻的方位，死后回溯到这里
    R.origin = { x: A2.cam.x, z: A2.cam.z, yaw: A2.cam.yaw, pitch: A2.cam.pitch }
  } else {
    A2.cam.x = R.origin.x
    A2.cam.z = R.origin.z
    A2.cam.yaw = R.origin.yaw
    A2.cam.pitch = R.origin.pitch
    R.rewind = 1
  }
  A2.done = true          // 奔跑阶段整条峡谷都要画出来，不受光圈揭示范围限制
  R.active = true
  R.dist = 0
  R.stamina = 0.25
  R.shake = 0
  R.hurt = 0
  R.parts = []
  R.enemies = []
  R.ebullets = []
  R.spawnT = 0
  R.done = false
  R.hp = 10
  R.pbullets = []
  R.endT = 0
  if (!R.breath) {
    try {
      R.breath = new Audio('assets/sfx/breath.mp3')
      R.breath.loop = true
      R.breath.volume = 0
      R.breath.play().catch(() => {})
    } catch (e) { R.breath = null }
  }
}
function runPressSpace() {
  const R = A2.run
  if (!R.active) return
  R.stamina = Math.min(1, R.stamina + 0.13)
}

function updateRun(dt) {
  const R = A2.run
  if (R.rewind > 0) R.rewind = Math.max(0, R.rewind - dt * 1.6)
  if (R.done) {
    R.endT += dt
    const k = Math.max(0, 1 - R.endT / 5)
    try {
      if (A2_MARCH) A2_MARCH.volume = 0.34 * k
      if (R.breath) R.breath.volume = 0.42 * k
      if (A2_FIGHT.crowds) A2_FIGHT.crowds.forEach(c => { c.volume = 0.3 * k })
    } catch (e) {}
    if (R.endT >= 5 && !R.finished) {
      R.finished = true
      // 清空场上的一切：子弹、粒子、敌人、头顶火光、队伍
      R.enemies = []
      R.ebullets = []
      R.pbullets = []
      R.parts = []
      A2.bullets.length = 0
      A2.ebullets.length = 0
      A2.fires.length = 0
      // 全部声音停掉
      try {
        if (A2_MARCH) { A2_MARCH.pause(); A2_MARCH.volume = 0 }
        if (R.breath) { R.breath.pause(); R.breath.volume = 0 }
        if (A2_FIGHT.crowds) A2_FIGHT.crowds.forEach(c => { try { c.pause(); c.volume = 0 } catch (e) {} })
          A2_FIGHT.on = false
      } catch (e) {}
      A2.run.toAct3 = 1
      R.shake = 0
      R.hurt = 0
      R.rewind = 0
      R.stamina = 0
      R.toAct3T = 0
    }
    if (R.finished) {
      R.toAct3T = (R.toAct3T || 0) + dt
      if (R.toAct3T > 0.6) {
        R.toAct3T = -999
        startAct3()
      }
    }
    return
  }
  // 血量归零：回到"往前面的村子跑"那一刻重新开始
  if (R.active && R.hp <= 0) {
    let idx = -1
    for (let i = 0; i < A2_SEGS.length; i++) {
      if (A2_SEGS[i].text.indexOf('村子跑') >= 0) { idx = i; break }
    }
    if (idx >= 0) {
      A2.sub.i = idx
      A2.sub.t = 0
      A2.sub.wait = 0
      A2.sub.holdT = 0
      A2.sub.done = false
    }
    R.hp = 10
    R.active = false
    R.aim = false
    R.dist = 0
    R.stamina = 0
    R.enemies = []
    R.ebullets = []
    R.pbullets = []
    R.parts = []
    if (R.breath) { try { R.breath.pause(); R.breath.volume = 0 } catch (e) {} }
    // 战斗音效、人群、脚步全部停掉，进度回到那一刻
    try {
      if (A2_FIGHT.crowds) A2_FIGHT.crowds.forEach(c => { try { c.pause() } catch (e) {} })
      A2_FIGHT.crowds = []
      A2_FIGHT.crowd = null
      A2_FIGHT.on = false
    } catch (e) {}
    try { stopMarchAudio() } catch (e) {}
    A2.cover = false
    A2.ebullets.length = 0
    A2.bullets.length = 0
    startRun(true)      // 时间回溯：方位、体力、敌人全部回到那一刻
    // 战斗音效重新起来（枪声 / 爆炸 / 喊杀声）
    startFight()
    return
  }
  if (!R.active) return
  // 体力条持续下降
  if (roomKeys['Space']) R.stamina = Math.min(1, R.stamina + 0.55 * dt)
  R.stamina = Math.max(0, R.stamina - 0.30 * dt)
  // 速度：随体力上涨；满了 3 倍
  let mul = 1 + R.stamina * 2
  if (R.stamina >= 0.999) mul = 3
  const spd = 3.0 * mul
  // 往前跑的方向跟着视线走
  A2.cam.x += -Math.sin(A2.cam.yaw) * spd * dt
  A2.cam.z += -Math.cos(A2.cam.yaw) * spd * dt
  A2.cam.x = Math.max(-4.6, Math.min(4.6, A2.cam.x))
  R.dist += spd * dt
  // 半程以上开始抖
  R.shake = R.stamina >= 0.5 ? Math.min(1, (R.stamina - 0.5) * 2) : 0

  // 敌人：40m 之后，每 20m 在两侧半山腰刷一个
  if (R.dist > 40 && R.dist - R.spawnT > 20) {
    R.spawnT = R.dist
    // 错落有致：这一段可能一个都没有、也可能一侧挤三个，不再左右对称
    const n = Math.floor(Math.random() * 4)        // 0 ~ 3 个
    const mainSide = Math.random() < 0.5 ? -1 : 1
    // 前方 10~45m 内的山
    const ahead = (A2.mtns || []).filter(m => m.cz < A2.cam.z - 10 && m.cz > A2.cam.z - 60)
    for (let k = 0; k < n && ahead.length; k++) {
      const side = (k === 0) ? mainSide : (Math.random() < 0.68 ? mainSide : -mainSide)
      const cand = ahead.filter(m => (m.cx - A2.cam.x) * side > 0)
      const mtn = (cand.length ? cand : ahead)[Math.floor(Math.random() * (cand.length ? cand.length : ahead.length))]
      // 在山上找一个"实心方块"的柱面：反复随机直到该列够高，保证站在方块顶上
      let fx = 0, fz = 0, cnt = 0
      for (let tries = 0; tries < 24; tries++) {
        fx = (Math.random() * 2 - 1) * 0.85
        fz = (Math.random() * 2 - 1) * 0.85
        cnt = mtnColCount(fx, fz, mtn.seed)
        if (cnt >= 3) break
      }
      if (cnt < 2) continue
      R.enemies.push({
        x: mtn.cx + fx * mtn.sx,
        y: cnt * (mtn.h / 14),          // 站在方块顶面
        z: mtn.cz + fz * mtn.sz,
        kind: 2, down: false, shootT: 0.7 + Math.random() * 0.8,
      })
    }
  }
  // 敌人开火：橙色弹，一秒一发，直线
  for (const e of R.enemies) {
    if (e.down) continue
    e.shootT -= dt
    if (e.shootT <= 0) {
      e.shootT = 1.0
      const dx = A2.cam.x - e.x
      const dy = 1.6 - e.y
      const dz = A2.cam.z - e.z
      const L = Math.hypot(dx, dy, dz) || 1
      R.ebullets.push({ x: e.x, y: e.y, z: e.z, vx: dx / L * 26, vy: dy / L * 26, vz: dz / L * 26, life: 4 })
    }
  }
  for (let i = R.ebullets.length - 1; i >= 0; i--) {
    const b = R.ebullets[i]
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt
    b.life -= dt
    const d = Math.hypot(b.x - A2.cam.x, b.y - 1.6, b.z - A2.cam.z)
    if (d < 0.55) {
      R.ebullets.splice(i, 1)
      R.hurt = 1
      R.shake = 1
      R.hp = Math.max(0, R.hp - 1)
      for (let k = 0; k < 14; k++) {
        R.parts.push({ x: (Math.random() - 0.5) * 60, y: (Math.random() - 0.5) * 40, vx: (Math.random() - 0.5) * 120, vy: 40 + Math.random() * 90, life: 1.2 })
      }
      continue
    }
    if (b.life <= 0) R.ebullets.splice(i, 1)
  }
  // 主角红色子弹：飞出去、扫掠判定命中敌人、留下流星拖尾
  for (let i = R.pbullets.length - 1; i >= 0; i--) {
    const b = R.pbullets[i]
    const px = b.x, py = b.y, pz = b.z
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt
    b.life -= dt
    b.trail.push({ x: b.x, y: b.y, z: b.z })
    if (b.trail.length > 7) b.trail.shift()
    // 这一步走了很远，中间采样 12 个点，避免"穿过去没打中"
    let hit = false
    for (let k = 1; k <= 12 && !hit; k++) {
      const t = k / 12
      const sx = px + (b.x - px) * t
      const sy = py + (b.y - py) * t
      const sz = pz + (b.z - pz) * t
      for (const e of R.enemies) {
        if (e.down) continue
        if (Math.hypot(sx - e.x, sy - (e.y + 0.5), sz - e.z) < 1.5) { e.down = true; hit = true; break }
      }
    }
    if (hit || b.life <= 0) R.pbullets.splice(i, 1)
  }

  // 喘气声：体力过半开始，越长越响越快
  if (R.breath) {
    const k = R.stamina >= 0.5 ? Math.min(1, (R.stamina - 0.5) * 2) : 0
    R.breath.volume = 0.42 * k
    R.breath.playbackRate = 1 + R.stamina * 0.45
    if (k > 0 && R.breath.paused) R.breath.play().catch(() => {})
  }

  // 被击中的红色粒子
  for (let i = R.parts.length - 1; i >= 0; i--) {
    const q = R.parts[i]
    q.x += q.vx * dt
    q.y += q.vy * dt
    q.vy += 260 * dt
    q.life -= dt
    if (q.life <= 0) R.parts.splice(i, 1)
  }
  if (R.hurt > 0) R.hurt = Math.max(0, R.hurt - dt * 2.2)

  // 跑出山谷
  if (R.dist > 580 && !R.done) {
    R.done = true
    R.active = false
    if (R.breath) { R.breath.pause() }
  }
  if (R.done) R.endT += dt
}

// 左键射击：打屏幕中心最近的敌人
function runShoot() {
  const R = A2.run
  if (!R.active) return
  // 视线方向：forward = (-sin(yaw), -cos(yaw))
  const yaw = A2.cam.yaw, pitch = A2.cam.pitch
  const sp = 620
  const dx = -Math.sin(yaw) * Math.cos(pitch)
  const dy = -Math.sin(pitch)
  const dz = -Math.cos(yaw) * Math.cos(pitch)
  R.pbullets.push({
    x: A2.cam.x + dx * 0.6,
    y: 1.52 + dy * 0.6,
    z: A2.cam.z + dz * 0.6,
    vx: dx * sp, vy: dy * sp, vz: dz * sp,
    life: 2.0,
    trail: [],
  })
  // 开火瞬间沿射线判定：600+ m/s 一帧飞十几米，逐帧判定会打空
  let bestT = 1e9, bestE = null
  for (const e of R.enemies) {
    if (e.down) continue
    const ex = e.x - A2.cam.x, ey = (e.y + 0.5) - 1.52, ez = e.z - A2.cam.z
    const t = ex * dx + ey * dy + ez * dz
    if (t <= 0 || t > 800) continue
    const cx = ex - dx * t, cy = ey - dy * t, cz = ez - dz * t
    if (Math.hypot(cx, cy, cz) < 1.6 && t < bestT) { bestT = t; bestE = e }
  }
  if (bestE) bestE.down = true
}

function renderAct2() {
  // 全黑之后：整块黑屏，场景不再绘制（直接进入下一幕）
  if (A2.run && A2.run.finished) {
    ctx.save()
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
    return
  }

  if (!gl3dInit()) return
  const gl = GL3D.gl
  // 超采样：内部按 2 倍分辨率渲染，贴到画布时再缩回来 → 抗锯齿
  const SS = 2
  const pw = Math.max(2, Math.round(W * DPR * SS))
  const ph = Math.max(2, Math.round(H * DPR * SS))
  if (GL3D.canvas.width !== pw || GL3D.canvas.height !== ph) {
    GL3D.canvas.width = pw
    GL3D.canvas.height = ph
  }
  gl.viewport(0, 0, pw, ph)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  // 黑白：只留环境光，取消点光
  gl.useProgram(GL3D.prog)
  const cam2 = {
    x: A2.cam.x, z: A2.cam.z, y: A2.cam.eye,
    yaw: A2.cam.yaw,
    pitch: A2.cam.pitch + (A2.run && A2.run.shake ? Math.sin(A2.t * 40) * 0.006 * A2.run.shake : 0),
    yaw: A2.cam.yaw + (A2.run && A2.run.shake ? Math.sin(A2.t * 33) * 0.008 * A2.run.shake : 0),
    fov: (A2.run && A2.run.active && A2.run.aim ? 40 : 70) * Math.PI / 180,
  }
  const proj2 = mat4Perspective(cam2.fov, pw / ph, 0.05, 400)
  const view2 = mat4View(cam2)
  GL3D.mvp = mat4Mul(proj2, view2)
  gl.uniformMatrix4fv(GL3D.mvpLoc, false, GL3D.mvp)
  gl.uniform1i(GL3D.texLoc, 0)
  gl.activeTexture(gl.TEXTURE0)

  gl.uniform3fv(GL3D.lampPosLoc, new Float32Array([0, -100, 0]))
  gl.uniform3fv(GL3D.lampColLoc, new Float32Array([0, 0, 0]))
  gl.uniform3fv(GL3D.ambLoc, new Float32Array([1.25, 1.25, 1.28]))
  gl.uniform1f(GL3D.fallLoc, 0.4)
  gl.uniform3fv(GL3D.lamp2PosLoc, new Float32Array([0, -100, 0]))
  gl.uniform3fv(GL3D.lamp2ColLoc, new Float32Array([0, 0, 0]))
  gl.uniform1f(GL3D.fall2Loc, 3.2)
  gl.uniform1f(GL3D.emisLoc, 0)
  gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
  gl.bindTexture(gl.TEXTURE_2D, GL3D.white)

  if (A2.built) {
    // 白色棱线
    if (A2.edgeOrder && A2.edgeOrder.length) {
      let en = A2.done ? (A2.edgeTotal || 0) : 0
      if (!A2.done && A2.ringOn) {
        en = 0
        for (const o of A2.edgeOrder) {
          if (o.d <= A2.ringR) en = o.count
          else break
        }
      }
      if (en > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.a2edges)
        bindAttribs(gl)
        gl.drawArrays(gl.LINES, 0, en)
      }
    }
    const n = a2VisibleCount()
    if (n > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.valley)
      bindAttribs(gl)
      gl.drawArrays(gl.TRIANGLES, 0, n)
    }
  }

  // 地面上的 3D 光圈：走深度测试，所以会被山挡住
  if (A2.ringOn && A2.ringR > 0.5) {
    const segs = 72
    const rOut = A2.ringR, rIn = Math.max(0.1, A2.ringR - 1.8)
    const data = []
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2
      const a1 = ((i + 1) / segs) * Math.PI * 2
      const x0 = Math.cos(a0), z0 = Math.sin(a0)
      const x1 = Math.cos(a1), z1 = Math.sin(a1)
      a2Quad(data, A2.cam.x + x0 * rIn, 0.03, A2.cam.z + z0 * rIn, A2.cam.x + x0 * rOut, 0.03, A2.cam.z + z0 * rOut,
             A2.cam.x + x1 * rOut, 0.03, A2.cam.z + z1 * rOut, A2.cam.x + x1 * rIn, 0.03, A2.cam.z + z1 * rIn, [2.4, 2.4, 2.4])
    }
    gl.bindTexture(gl.TEXTURE_2D, GL3D.white)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
    if (!GL3D.a2ring) GL3D.a2ring = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.a2ring)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 11)
  }

  // 所有 GL 画完再贴到 2D 层（否则光圈画在贴图之后，看不见）
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(GL3D.canvas, 0, 0, W * DPR, H * DPR)
  ctx.restore()

  // 头顶火焰：把每个战士的头的位置投到屏幕，再画跳动粒子
  drawFires()

  // ===== 奔跑小游戏 =====
  if (A2.run.active) {
    const R = A2.run
    const scaleRef = (H * 0.5) / Math.tan((70 * Math.PI / 180) / 2)
    // 敌人（灰火，站在半山腰）
    for (const e of R.enemies) {
      const pr = a2Project(e.x, e.y, e.z)
      if (!pr) continue
      const spr = SOLDIER_IMGS[e.kind] || makeSoldierSprite()
      if (!spr) continue
      const hPx = (1.95 / pr.d) * scaleRef
      const wPx = hPx * (spr.width / spr.height)
      ctx.globalCompositeOperation = 'source-over'
      ctx.save()
      if (e.down) {
        ctx.translate(pr.sx, pr.sy)
        ctx.rotate(Math.PI / 2)
        ctx.drawImage(spr, -wPx / 2, -hPx, wPx, hPx)
      } else {
        ctx.drawImage(spr, pr.sx - wPx / 2, pr.sy - hPx, wPx, hPx)
      }
      ctx.restore()
      if (!e.down) {
        // 灰色火
        const b2 = 26
        const g3 = ctx.createRadialGradient(pr.sx, pr.sy - hPx * 0.9, 0, pr.sx, pr.sy - hPx * 0.9, b2)
        g3.addColorStop(0, 'rgba(210,210,215,0.95)')
        g3.addColorStop(0.6, 'rgba(120,120,128,0.55)')
        g3.addColorStop(1, 'rgba(80,80,86,0)')
        ctx.fillStyle = g3
        ctx.beginPath()
        ctx.arc(pr.sx, pr.sy - hPx * 0.9, b2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // 橙色敌弹
    ctx.save()
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.strokeStyle = 'rgba(255,140,30,0.95)'
    ctx.lineWidth = 3
    for (const b of R.ebullets) {
      const q1 = a2Project(b.x, b.y, b.z)
      const q2 = a2Project(b.x - b.vx * 0.04, b.y - b.vy * 0.04, b.z - b.vz * 0.04)
      if (!q1 || !q2) continue
      ctx.beginPath(); ctx.moveTo(q1.sx, q1.sy); ctx.lineTo(q2.sx, q2.sy); ctx.stroke()
    }
    // 主角红色子弹
    // 主角红色子弹：流星式拖尾
    if (R.pbullets && R.pbullets.length) {
      ctx.strokeStyle = 'rgba(255,60,40,0.95)'
      ctx.lineCap = 'round'
      for (const b of R.pbullets) {
        const pts = []
        for (const tp of (b.trail || [])) {
          const q = a2Project(tp.x, tp.y, tp.z)
          if (q) pts.push(q)
        }
        const head = a2Project(b.x, b.y, b.z)
        if (head) pts.push(head)
        if (pts.length < 2) continue
        for (let k = 1; k < pts.length; k++) {
          const a = k / pts.length
          ctx.strokeStyle = 'rgba(255,' + Math.round(40 + 90 * a) + ',' + Math.round(30 + 30 * a) + ',' + (0.15 + 0.82 * a).toFixed(2) + ')'
          ctx.lineWidth = 1.5 + 6 * a
          ctx.beginPath()
          ctx.moveTo(pts[k - 1].sx, pts[k - 1].sy)
          ctx.lineTo(pts[k].sx, pts[k].sy)
          ctx.stroke()
        }
        const hd = pts[pts.length - 1]
        ctx.fillStyle = 'rgba(255,210,160,0.95)'
        ctx.beginPath(); ctx.arc(hd.sx, hd.sy, 4.5, 0, Math.PI * 2); ctx.fill()
      }
    }

    // 被击中的红色粒子（屏幕中心）
    for (const q of R.parts) {
      ctx.fillStyle = 'rgba(255,40,30,' + Math.min(1, q.life).toFixed(2) + ')'
      ctx.beginPath(); ctx.arc(W / 2 + q.x, H / 2 + q.y, 2.6, 0, Math.PI * 2); ctx.fill()
    }
    // 时间回溯白光
    if (R.rewind > 0.01) {
      ctx.fillStyle = 'rgba(230,235,255,' + (R.rewind * 0.55).toFixed(3) + ')'
      ctx.fillRect(0, 0, W, H)
    }

    // 受伤红闪
    if (R.hurt > 0.01) {
      ctx.fillStyle = 'rgba(200,20,10,' + (R.hurt * 0.22).toFixed(3) + ')'
      ctx.fillRect(0, 0, W, H)
    }
    // 右上角血量：10 个小方块
    {
      const n = 10, sz = Math.max(9, H * 0.022), gap = sz * 0.45
      const totalW = n * sz + (n - 1) * gap
      const sx0 = W - totalW - W * 0.035, sy0 = H * 0.055
      for (let i = 0; i < n; i++) {
        const on = i < R.hp
        ctx.fillStyle = on ? 'rgba(226,226,232,0.95)' : 'rgba(60,60,66,0.75)'
        ctx.fillRect(sx0 + i * (sz + gap), sy0, sz, sz)
        if (on) {
          ctx.strokeStyle = 'rgba(255,255,255,0.5)'
          ctx.lineWidth = 1
          ctx.strokeRect(sx0 + i * (sz + gap) + 0.5, sy0 + 0.5, sz - 1, sz - 1)
        }
      }
    }

    // 左侧体力条
    const bw = Math.max(10, W * 0.012), bh = H * 0.42
    const bx = W * 0.045, by = H * 0.5 - bh / 2
    ctx.fillStyle = 'rgba(0,0,0,0.85)'
    ctx.fillRect(bx, by, bw, bh)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(bx, by, bw, bh)
    const hFill = bh * R.stamina
    ctx.fillStyle = R.stamina >= 0.999 ? 'rgba(255,80,60,1)' : 'rgba(220,40,30,0.95)'
    ctx.fillRect(bx + 2, by + bh - hFill + 1, bw - 4, Math.max(0, hFill - 2))
    // 左下角：按键说明
    {
      const fs3 = Math.max(12, H * 0.022)
      const lines = ['空格　加速奔跑', '左键　开枪', 'WASD　移动', '鼠标　转视角']
      ctx.font = '400 ' + fs3.toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      const lh = fs3 * 1.45
      const x0 = fs3 * 0.8
      const y0 = H - fs3 * 0.7
      ctx.fillStyle = 'rgba(165,165,172,0.92)'
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x0, y0 - lh * (lines.length - 1 - i))
      }
    }
    // 瞄准
    {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(W / 2 - 8, H / 2); ctx.lineTo(W / 2 - 3, H / 2)
      ctx.moveTo(W / 2 + 3, H / 2); ctx.lineTo(W / 2 + 8, H / 2)
      ctx.moveTo(W / 2, H / 2 - 8); ctx.lineTo(W / 2, H / 2 - 3)
      ctx.moveTo(W / 2, H / 2 + 3); ctx.lineTo(W / 2, H / 2 + 8)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,40,30,0.95)'
      ctx.beginPath(); ctx.arc(W / 2, H / 2, 2, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()
  }

  // 敌方黄色子弹
  if (A2.ebullets.length) {
    ctx.save()
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.strokeStyle = 'rgba(255,205,60,0.95)'
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    for (const b of A2.ebullets) {
      const q1 = a2Project(b.x, b.y, b.z)
      const q2 = a2Project(b.x, b.y, b.z + 2.0)
      if (!q1 || !q2) continue
      ctx.beginPath()
      ctx.moveTo(q1.sx, q1.sy)
      ctx.lineTo(q2.sx, q2.sy)
      ctx.stroke()
    }
    ctx.restore()
  }

  // 红色子弹：一条快速移动的短线
  if (A2.bullets.length) {
    ctx.save()
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.strokeStyle = 'rgba(255,40,30,0.95)'
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    for (const b of A2.bullets) {
      const a1 = a2Project(b.x, b.y, b.z - 2.2)
      const a2p = a2Project(b.x, b.y, b.z)
      if (!a1 || !a2p) continue
      ctx.beginPath()
      ctx.moveTo(a1.sx, a1.sy)
      ctx.lineTo(a2p.sx, a2p.sy)
      ctx.stroke()
    }
    ctx.restore()
  }

  // 常态（还没开跑）：左下角按键说明
  if (!A2.run.active && !A2.run.done) {
    ctx.save()
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    const fs4 = Math.max(12, H * 0.022)
    ctx.font = '400 ' + fs4.toFixed(0) + 'px ' + CFG.fontFamily
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
    ctx.fillStyle = 'rgba(165,165,172,0.92)'
    ctx.fillText('WASD　移动', fs4 * 0.8, H - fs4 * 0.7 - fs4 * 1.45)
    ctx.fillText('鼠标　转视角', fs4 * 0.8, H - fs4 * 0.7)
    ctx.restore()
  }

  // 主角旁白：光圈一开始扫就从屏幕下方浮出来，3 秒后消失
  if (A2.t > 1.2 && A2.t < 4.2) {
    const k = Math.min(1, (A2.t - 1.2) / 0.8) * Math.min(1, (4.2 - A2.t) / 0.8)
    ctx.save()
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    const fs2 = Math.max(16, H * 0.036)
    ctx.font = '400 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(235,235,240,' + (0.95 * k).toFixed(3) + ')'
    ctx.fillText('我……这是……在书里？', W / 2, H * 0.88)
    ctx.restore()
  }

  // 顶部字幕（灰字，逐字打出；一小段一小段）
  if (A2.t > 15 && !A2.sub.done) {
    const sb = A2.sub
    const seg = A2_SEGS[sb.i]
    if (seg) {
      const n = seg.shout ? seg.text.length : Math.min(seg.text.length, Math.floor(sb.t * 6))
      const shown = seg.text.slice(0, n)
      const crow = seg.shout
      const fs = crow ? Math.max(26, H * 0.075) : Math.max(15, H * 0.034)
      ctx.save()
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      ctx.font = (crow ? '700 ' : '400 ') + fs.toFixed(0) + 'px ' + CFG.fontFamily
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      if (crow) {
        ctx.shadowColor = 'rgba(255,40,20,0.55)'
        ctx.shadowBlur = fs * 0.5
        ctx.fillStyle = 'rgba(240,45,32,0.98)'
      } else {
        ctx.fillStyle = 'rgba(185,185,190,0.92)'
      }
      const caret = (sb.wait <= 0 && sb.holdT <= 0 && Math.floor(A2.t * 3) % 2 === 0) ? '▏' : ''
      ctx.fillText(shown + caret, W / 2, H * 0.085)
      ctx.restore()
    }
  }

  // 收尾：整帧（含背景、子弹、头顶火光、HUD）一起渐黑
  if (A2.run.done) {
    ctx.save()
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.fillStyle = 'rgba(0,0,0,' + Math.min(1, A2.run.endT / 5).toFixed(3) + ')'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  }
}

/* 把世界坐标投到屏幕（和 GL 用同一套 yaw/pitch/fov） */
function a2Project(wx, wy, wz) {
  const cam = A2.cam
  const dx = wx - cam.x, dy = wy - cam.eye, dz = wz - cam.z
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw)
  const x1 = dx * cy - dz * sy
  const z1 = dx * sy + dz * cy
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch)
  const y2 = dy * cp - z1 * sp
  const z2 = dy * sp + z1 * cp
  if (z2 > -0.15) return null
  const f = (H * 0.5) / Math.tan((70 * Math.PI / 180) / 2)
  return { sx: W / 2 + (x1 / -z2) * f, sy: H / 2 - (y2 / -z2) * f, d: -z2 }
}

function drawFires() {
  if (!A2.fires || !A2.fires.length) return
  const T = A2.t
  ctx.save()
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  loadSoldierImages()
  const scaleRef = (H * 0.5) / Math.tan((70 * Math.PI / 180) / 2)

  // 先按距离从远到近排序：近处的人会盖住远处人的火
  const list = []
  for (const f of A2.fires) {
    const pr = a2Project(f.x, 0, f.z)
    if (!pr || pr.d > 90) continue
    if (!A2.done && pr.d > A2.ringR) continue
    list.push({ f, pr })
  }
  list.sort((a, b) => b.pr.d - a.pr.d)
  const heads = []

  for (const item of list) {
    const f = item.f, footPr = item.pr
    const idx = f.kind % (SOLDIER_IMGS.length || 1)
    const spr = SOLDIER_IMGS[idx] || makeSoldierSprite()
    if (!spr) continue
    const hPx = (1.95 / footPr.d) * scaleRef
    // 走路起伏：脚底每秒上下晃一次左右
    footPr.sy += Math.sin(T * 7.5 + f.seed * 2.3) * hPx * 0.018 * (f.speedK == null ? 1 : f.speedK)
    if (hPx < 3) continue
    const wPx = hPx * (spr.width / spr.height)
    const leftPx = footPr.sx - wPx / 2
    const topPx = footPr.sy - hPx

    // ① 人（白色剪影）；倒地的人横躺在地上
    ctx.globalCompositeOperation = 'source-over'
    ctx.save()
    if (f.down) {
      ctx.translate(footPr.sx, footPr.sy)
      ctx.rotate(f.mirror ? Math.PI / 2 : -Math.PI / 2)
      ctx.drawImage(spr, -wPx / 2, -hPx, wPx, hPx)
      ctx.restore()
      const hd0 = SOLDIER_HEADS[idx] || { fx: 0.5 }
      heads.push({ x: footPr.sx, y: footPr.sy, d: footPr.d, seed: f.seed, fireT: 0 })
      continue
    }
    if (f.mirror) {
      ctx.translate(footPr.sx, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(spr, -wPx / 2, topPx, wPx, hPx)
    } else {
      ctx.drawImage(spr, leftPx, topPx, wPx, hPx)
    }
    ctx.restore()

    // 记下这个人的头顶，最后统一画火（避免被别的人物盖掉）
    const hd = SOLDIER_HEADS[idx] || { fx: 0.5, fy: 0.10 }
    const headX = f.mirror ? (leftPx + wPx * (1 - hd.fx)) : (leftPx + wPx * hd.fx)
    heads.push({ x: headX, y: topPx + hPx * 0.10, d: footPr.d, seed: f.seed, fireT: f.fireT || 0, k: 1 })
  }

  // 统一画火（远→近，保证每个人都有）
  for (let hi = heads.length - 1; hi >= 0; hi--) {
    const hp = heads[hi]
    // 人出现 1.5 秒之后火才开始，再花 2 秒慢慢亮起来；每个人的延迟再随机错开一点
    const delay = 1.5 + Math.sin(hp.seed * 2.7) * 0.55
    const fade = Math.max(0, Math.min(1, ((hp.fireT || 0) - delay) / 2.0))
    if (fade <= 0.01) continue
    // 火焰是一个真实大小的东西（半径 0.34m），按透视投影到屏幕 → 近大远小
    const FIRE_WORLD_R = 0.34
    const base = (FIRE_WORLD_R * scaleRef) / Math.max(0.6, hp.d) * (0.35 + 0.65 * fade)
    ctx.globalCompositeOperation = 'source-over'
    const grd = ctx.createRadialGradient(hp.x, hp.y, 0, hp.x, hp.y, base * 1.15)
    grd.addColorStop(0, 'rgba(255,105,55,' + (0.88 * fade).toFixed(3) + ')')
    grd.addColorStop(0.55, 'rgba(210,32,14,' + (0.72 * fade).toFixed(3) + ')')
    grd.addColorStop(1, 'rgba(120,8,6,0)')
    ctx.fillStyle = grd
    ctx.beginPath()
    ctx.arc(hp.x, hp.y, base * 1.15, 0, Math.PI * 2)
    ctx.fill()

    ctx.globalCompositeOperation = 'lighter'
    for (let i2 = 0; i2 < 16; i2++) {
      const ph = (T * 2.2 + i2 * 0.37 + hp.seed) % 1
      const rise = ph * base * 1.6
      const sway = Math.sin(T * 7 + i2 * 2.1 + hp.seed) * base * 0.20 * (0.4 + ph)
      const r = base * (0.52 - ph * 0.34) * (0.75 + 0.25 * Math.sin(T * 13 + i2))
      const a = (1 - ph * 0.85) * 0.8
      const g2 = ctx.createRadialGradient(hp.x + sway, hp.y - rise, 0, hp.x + sway, hp.y - rise, Math.max(1, r))
      g2.addColorStop(0, 'rgba(255,110,60,' + Math.min(1, a).toFixed(3) + ')')
      g2.addColorStop(0.4, 'rgba(235,45,18,' + (a * 0.85).toFixed(3) + ')')
      g2.addColorStop(0.75, 'rgba(150,12,8,' + (a * 0.5).toFixed(3) + ')')
      g2.addColorStop(1, 'rgba(80,4,4,0)')
      ctx.fillStyle = g2
      ctx.beginPath()
      ctx.arc(hp.x + sway, hp.y - rise, Math.max(1, r), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.restore()
}

function renderDesk() {
  WAKE.blur = DESK.blurNow || 0
  if (renderRoomGL(W, H)) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(GL3D.canvas, 0, 0, W * DPR, H * DPR)
    ctx.restore()
    // 2D 墨层已停用（改为家具碰撞盒上的贴图）
  }
}


/* 第 0 幕的即时提示：显示固定秒数后淡出 */
const A0_TIP = { on: false, t: 0, dur: 3, text: '' }
function showTip(text, dur) {
  A0_TIP.on = true
  A0_TIP.t = 0
  A0_TIP.dur = dur || 3
  A0_TIP.text = text
}
function updateTip(dt) {
  if (!A0_TIP.on) return
  A0_TIP.t += dt
  if (A0_TIP.t > A0_TIP.dur) A0_TIP.on = false
}
function drawTip() {
  if (!A0_TIP.on) return
  const fade = Math.min(1, (A0_TIP.dur - A0_TIP.t) / 0.5)
  const n = Math.min(A0_TIP.text.length, Math.floor(A0_TIP.t * 14))
  if (n <= 0) return
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  const fs2 = Math.max(14, H * 0.026)
  ctx.font = '400 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(178,178,184,' + (0.94 * Math.max(0, fade)).toFixed(3) + ')'
  ctx.fillText(A0_TIP.text.slice(0, n), W / 2, H * 0.84)
}

/* 第 0 幕起床后的旁白：屏幕下方灰字逐字打出 */
const A0_SUB = { t: 0, on: false, done: false, line: '唉。。。睡都睡不好，这个长征70周年近代史作业怎么做呀。。。算了，拿本书参考一下把。。。' }
function updateA0Sub(dt) {
  if (!A0_SUB.on || A0_SUB.done) return
  A0_SUB.t += dt
  if (A0_SUB.t > A0_SUB.line.length / 9 + 4.5) A0_SUB.done = true
}
function drawRoomHint() {
  // 左下角常驻提示：按 E 交互
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  const fs2 = Math.max(11, H * 0.019)
  const padx = Math.max(10, W * 0.008)
  const x = padx
  const y = H - padx - fs2 * 3.4
  ctx.font = '400 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  const kw = fs2 * 1.5, kh = fs2 * 1.5
  ctx.strokeStyle = 'rgba(210,210,216,0.55)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y - kh / 2 + 0.5, kw, kh)
  ctx.fillStyle = 'rgba(228,228,234,0.92)'
  ctx.textAlign = 'center'
  ctx.fillText('E', x + kw / 2, y)
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(196,196,202,0.86)'
  ctx.fillText('按 E 交互', x + kw + fs2 * 0.6, y)
}

function drawA0Sub() {
  if (!A0_SUB.on) return
  const alpha = A0_SUB.done ? 0 : Math.min(1, (A0_SUB.line.length / 9 + 4.5 - A0_SUB.t) / 0.8)
  if (alpha <= 0) return
  const n = Math.min(A0_SUB.line.length, Math.floor(A0_SUB.t * 9))
  if (n <= 0) return
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  const fs2 = Math.max(14, H * 0.026)
  ctx.font = '400 ' + fs2.toFixed(0) + 'px ' + CFG.fontFamily
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(170,170,176,' + (0.92 * alpha).toFixed(3) + ')'
  ctx.fillText(A0_SUB.line.slice(0, n), W / 2, H * 0.90)
}

function renderRoom() {
  // 优先走真 3D（WebGL，带抗锯齿）；不可用才退回 2D 像素画法
  if (renderRoomGL(W, H)) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // 苏醒序列里的失焦/运动模糊：直接对 3D 这一帧做高斯模糊
    if (WAKE.blur >= 0.05) {
      ctx.imageSmoothingEnabled = true
      ctx.filter = `blur(${WAKE.blur.toFixed(2)}px)`
      ctx.drawImage(GL3D.canvas, 0, 0, W * DPR, H * DPR)
      ctx.filter = "none"
    } else {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(GL3D.canvas, 0, 0, W * DPR, H * DPR)
    }
    ctx.restore()
  } else {
    drawRoomPixels(ctx, W, H, A0.cam, 0, DPR)
  }
  const g = ctx
  g.save()
  g.setTransform(DPR, 0, 0, DPR, 0, 0)
  g.font = `400 ${Math.round(H * 0.02)}px ${CFG.fontFamily}`
  g.textAlign = 'left'
  g.textBaseline = 'bottom'
  if (WAKE.hud && !A6.started) {
  g.fillStyle = 'rgba(255,255,255,0.5)'
  g.fillText('WASD 走动 · 移动鼠标转视角 · Q/E 上下看', 18, H - 16)
  }
  // 交互提示：书架的笔记本 / 书桌前的椅子
  const hint = A0.nearShelf ? { p: SHELF_BOOK, tip: "E 取下这本笔记本" }
             : A0.nearSeat ? { p: DESK_SEAT, tip: "E 坐下" }
             : null
  if (hint && !WAKE.active) {
    const pulse = 0.55 + 0.45 * Math.sin(A0.t * 3.2)
    const sp = worldToScreen(hint.p.x, hint.p.y || 1.30, hint.p.z, W, H)
    if (sp) {
      g.beginPath()
      g.arc(sp.x, sp.y, 5, 0, Math.PI * 2)
      g.fillStyle = `rgba(255,236,180,${(0.45 + 0.4 * pulse).toFixed(3)})`
      g.fill()
    }
    g.textAlign = "center"
    g.textBaseline = "bottom"
    g.font = `400 ${Math.round(H * 0.024)}px ${CFG.fontFamily}`
    g.fillStyle = `rgba(255,255,255,${(0.55 + 0.35 * pulse).toFixed(3)})`
    g.fillText(hint.tip, W / 2, H - Math.round(H * 0.06))
    g.textAlign = "left"
  }
  drawColliderWireframe(g)   // 开发者模式：碰撞体线框
  g.restore()
}

addEventListener('keyup', (e) => {
  roomKeys[e.code] = false })
addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  if (S.mode === 'act0') { A0.mx = x; A0.my = y }
  if (A0.dragVol && A0.modal === 'settings' && A0.modalRect) {
    const mr = A0.modalRect
    const sx = mr.x + mr.w * 0.32
    const sw = mr.w * 0.52
    A0.volume = clamp((x - sx) / sw, 0, 1)
    bgm.volume = A0.volume
  }
  if (S.mode === 'act2' && A2.dragging) {
    A2.cam.yaw -= (x - A2.lastX) * 0.0045
    A2.cam.pitch = clamp(A2.cam.pitch + (y - A2.lastY) * 0.0035, -1.1, 1.1)
    A2.lastX = x; A2.lastY = y
  }
  if (S.mode === 'room' && A0.turning && !document.pointerLockElement) {
    const dxm = x - (A0.lastX ?? x)
    const dym = y - (A0.lastY ?? y)
    A0.cam.yaw -= dxm * 0.005
    A0.cam.pitch = clamp((A0.cam.pitch ?? 0) + dym * 0.004, -1.1, 1.1)
    A0.lastX = x
    A0.lastY = y
  }
})
addEventListener('pointerup', (e) => { A0.dragVol = false; A0.turning = false; A2.dragging = false;  })

/* 开发者模式下的 M：把当前这一幕直接推到结尾 */
function skipCurrentAct() {
  if (S.mode !== 'act1') return
  let guard = 0
  while (guard++ < 40000) {
    update(1 / 30)
    const zoomDone = A1.zoom <= ACT1.zoomEnd + 0.002
    const roadDone = A1.roadT > ACT1.roadDelay + ACT1.roadGrowTime
    if (A1.phase === 'hold' && roadDone && zoomDone) break
  }
}
/* ============================ 真 3D 卧室（WebGL） ============================ */
/* 房间与家具全部是 3D 方块，但贴图是"像素风"：32~64 像素的小图、每张限色 3~5 色、
   NEAREST 采样（放大不模糊）、木纹/布料用逐像素点画。
   家具不再是 billboard 贴片，而是一堆贴了材质的小方块。 */

const GL3D = {
  canvas: null, gl: null, prog: null, buf: null,
  tex: null, white: null, atlas: null,
  ready: false, failed: false, err: null,
  furn: null, furnCount: 0,
}

const GL_WALL_SPLIT = 1.15     // 腰线高度（米）

/* ---------- 像素色板（每张图只用其中 3~5 个） ---------- */
const P = {
  woodLL: '#d8a86e', woodL: '#c4924f', woodM: '#a8703c', woodD: '#7d4f28', woodDD: '#5a381c',
  red1: '#b03a3a', red2: '#8e2d2d', red3: '#d05555',
  cream1: '#f2ead6', cream2: '#ddd2b8',
  stone1: '#a8a294', stone2: '#8a8478', stone3: '#6d675d',
  metal1: '#b9b3a6', metal2: '#8d8579',
  fire1: '#e88c28', fire2: '#fad060', fire3: '#b85a18',
  leaf1: '#4a8a3a', leaf2: '#3a6f2e', leaf3: '#66a852',
  ink: '#3a2214',
}

function mkCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function pxGrid(g, x, y, w, h, colorFn) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = colorFn(i, j)
      if (!c) continue
      g.fillStyle = c
      g.fillRect(x + i, y + j, 1, 1)
    }
  }
}

/* ---------- 房间贴图（像素风、可平铺、低对比） ---------- */
/* 关键：相邻色只差一点（约 5~10% 亮度），靠"线的位置"出纹理，不靠高对比的散点。
   之前地上/天花板/木头上的白点黑点就是对比太高，看着扎眼。 */

function softNoise(x, y, seed) {
  // 低频、低幅度的伪随机：只用来让整块面不呆板，不产生孤立亮点
  const n = Math.sin((x * 12.9898 + y * 78.233 + seed) * 43758.5453) % 1
  return (n - 0.5) * 2
}

// 木地板：32×32，竖条木板，只用同一色系的 4 个近似色
function makeFloorTexture() {
  const S = 32
  const c = mkCanvas(S, S)
  const g = c.getContext('2d')
  const tones = ['#c4924f', '#bd8b4a', '#c89756', '#b98748']   // 彼此只差一点点
  for (let i = 0; i < S; i++) {
    const band = Math.floor(i / 8)
    g.fillStyle = tones[band]
    g.fillRect(i, 0, 1, S)
    if (i % 8 === 0) { g.fillStyle = '#a06a38'; g.fillRect(i, 0, 1, S) }   // 板缝：只暗一档
    if (i % 8 === 7) { g.fillStyle = '#b88549'; g.fillRect(i, 0, 1, S) }   // 板边：只暗一点点
  }
  // 木纹：细长的竖线，颜色比底色只暗/亮一档
  for (let k = 0; k < 10; k++) {
    const x = 2 + ((k * 11) % (S - 3))
    const y = (k * 7) % S
    g.fillStyle = k % 2 ? '#bd8b4a' : '#c89756'
    g.fillRect(x, y, 1, 4 + (k % 3))
  }
  // 板与板的横向接缝：细、浅
  g.fillStyle = '#b0803f'
  g.fillRect(0, 23, S, 1)
  return c
}

// 墙：64×64，上半壁纸（细竖纹）+ 腰线 + 下半护墙板（浅木格）
function makeWallTexture() {
  const S = 64
  const c = mkCanvas(S, S)
  const g = c.getContext('2d')
  const split = Math.round(S * (1 - GL_WALL_SPLIT / ACT0.roomH))
  // 壁纸：两种米色交替，竖纹很淡
  for (let y = 0; y < split; y++) {
    for (let x = 0; x < S; x++) {
      g.fillStyle = (x % 8 < 4) ? '#e6c48e' : '#e2be86'
      g.fillRect(x, y, 1, 1)
    }
  }
  g.fillStyle = '#eacb96'                        // 顶部一条亮边
  g.fillRect(0, 0, S, 1)
  // 腰线
  g.fillStyle = '#f0dcb4'; g.fillRect(0, split - 4, S, 5)
  g.fillStyle = '#c8a173'; g.fillRect(0, split + 1, S, 1)
  // 护墙板：底色 + 每 16px 一条浅缝，不画格子线
  for (let y = split + 2; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let col = '#a9743f'
      if (x % 16 === 0) col = '#9a6535'        // 竖缝只暗一档
      if (x % 16 === 1) col = '#b58250'        // 缝旁亮一档（高光）
      g.fillStyle = col
      g.fillRect(x, y, 1, 1)
    }
  }
  // 踢脚
  g.fillStyle = '#8a5a30'; g.fillRect(0, S - 4, S, 4)
  g.fillStyle = '#96643a'; g.fillRect(0, S - 5, S, 1)
  return c
}

// 天花板：32×32 深色木条
function makeCeilTexture() {
  const S = 32
  const c = mkCanvas(S, S)
  const g = c.getContext('2d')
  for (let x = 0; x < S; x++) {
    const band = Math.floor(x / 8) % 2
    g.fillStyle = band ? '#4a3320' : '#4e3623'      // 两档只差一点
    g.fillRect(x, 0, 1, S)
    if (x % 8 === 0) { g.fillStyle = '#412c1b'; g.fillRect(x, 0, 1, S) }   // 缝
    if (x % 8 === 1) { g.fillStyle = '#553b26'; g.fillRect(x, 0, 1, S) }   // 缝旁微亮
  }
  return c
}

// 窗：32×32，夜空 + 窗格（星星少而暗）
function makeWindowTexture() {
  const S = 32
  const c = mkCanvas(S, S)
  const g = c.getContext('2d')
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      g.fillStyle = y < 11 ? '#2f3d5e' : y < 21 ? '#374d76' : '#405a84'
      g.fillRect(x, y, 1, 1)
    }
  }
  const stars = [[6, 4], [18, 7], [25, 3], [11, 12], [22, 15]]
  for (const [x, y] of stars) {
    g.fillStyle = '#cfd0bd'
    g.fillRect(x, y, 1, 1)
  }
  g.fillStyle = '#6b4626'
  g.fillRect(0, 0, S, 2); g.fillRect(0, S - 2, S, 2)
  g.fillRect(0, 0, 2, S); g.fillRect(S - 2, 0, 2, S)
  g.fillRect(S / 2 - 1, 0, 2, S)
  g.fillRect(0, S / 2 - 1, S, 2)
  return c
}

// 窗外：夜晚 —— 深蓝夜空 + 月亮 + 星 + 远山 + 村舍剪影（128×64 像素图）
function makeOutsideTexture() {
  const W2 = 128, H2 = 64
  const c = mkCanvas(W2, H2)
  const g = c.getContext('2d')
  // 夜空：上深下浅（地平线附近有点微光）
  for (let y = 0; y < H2; y++) {
    const t = y / H2
    let col
    if (t < 0.3) col = '#1b2238'
    else if (t < 0.5) col = '#232c48'
    else if (t < 0.66) col = '#2f3a58'
    else if (t < 0.78) col = '#3b4768'
    else col = '#2a3146'
    g.fillStyle = col
    g.fillRect(0, y, W2, 1)
  }
  // 星星（暗一点，不要扎眼）
  const stars = [[8, 6], [18, 12], [27, 4], [41, 9], [56, 5], [66, 14], [78, 7], [90, 11], [103, 4], [114, 13], [120, 8], [48, 19]]
  for (const [x, y] of stars) {
    g.fillStyle = '#c9cfe0'
    g.fillRect(x, y, 1, 1)
  }
  // 月亮（右侧，带柔和光晕）
  const mx2 = 96, my2 = 16
  for (let r = 11; r >= 5; r--) {
    g.fillStyle = r > 8 ? 'rgba(210,220,240,0.16)' : r > 6 ? 'rgba(226,232,246,0.3)' : '#e8ecf6'
    g.beginPath(); g.arc(mx2, my2, r, 0, Math.PI * 2); g.fill()
  }
  // 远山（两层，夜色剪影）
  g.fillStyle = '#252e40'
  g.beginPath()
  g.moveTo(0, 50)
  for (let x = 0; x <= W2; x += 8) g.lineTo(x, 50 - Math.round(6 * Math.sin(x * 0.08) + 3 * Math.sin(x * 0.21)))
  g.lineTo(W2, H2); g.lineTo(0, H2); g.closePath(); g.fill()
  g.fillStyle = '#1d2534'
  g.beginPath()
  g.moveTo(0, 55)
  for (let x = 0; x <= W2; x += 7) g.lineTo(x, 55 - Math.round(4 * Math.sin(x * 0.12 + 1) + 2 * Math.sin(x * 0.3)))
  g.lineTo(W2, H2); g.lineTo(0, H2); g.closePath(); g.fill()
  // 地面
  g.fillStyle = '#161d29'
  g.fillRect(0, 58, W2, H2 - 58)
  // 远处的房子剪影 + 一扇亮着的窗
  g.fillStyle = '#10151f'
  g.fillRect(30, 50, 16, 10)
  g.fillRect(34, 46, 8, 5)
  g.fillStyle = '#c9a86a'
  g.fillRect(35, 52, 3, 3)
  g.fillStyle = '#10151f'
  g.fillRect(58, 52, 12, 8)
  return c
}
// 地毯：64×64，暗红底 + 双边框 + 中心花纹（低对比）
function makeRugTexture() {
  const S = 64
  const c = mkCanvas(S, S)
  const g = c.getContext('2d')
  g.fillStyle = '#8e3f3a'; g.fillRect(0, 0, S, S)
  g.fillStyle = '#a4554c'                        // 边框：只亮一档
  g.fillRect(4, 4, S - 8, 2); g.fillRect(4, S - 6, S - 8, 2)
  g.fillRect(4, 4, 2, S - 8); g.fillRect(S - 6, 4, 2, S - 8)
  g.fillStyle = '#c08a68'
  g.fillRect(10, 10, S - 20, 1); g.fillRect(10, S - 11, S - 20, 1)
  g.fillRect(10, 10, 1, S - 20); g.fillRect(S - 11, 10, 1, S - 20)
  const cx = S / 2, cy = S / 2
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d < 5) { g.fillStyle = '#c08a68'; g.fillRect(x, y, 1, 1) }
      else if (d > 13 && d < 15) { g.fillStyle = '#9c4a42'; g.fillRect(x, y, 1, 1) }
    }
  }
  return c
}

/* 被子贴图：红底 + 黄色波浪线（非几何，直接印在被面上）。
   左侧 94% 是图案区（被子的 uv 落在这里），右侧 6% 是纯白（其他部件采样这里）。 */
/* 带文字的日记内页：泛黄纸 + 顶格横排文字（左上角第一行第一个字起，无缩进） */
function makeTextPage(lines, opt) {
  const o = opt || {}
  const S = 1024
  const c = mkCanvas(S, S)
  const g = c.getContext("2d")
  // 纸底
  g.fillStyle = "#e9dcbb"
  g.fillRect(0, 0, S, S)
  // 纤维 / 老化斑点
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * S, y = Math.random() * S
    g.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(150,130,95,0.05)"
    g.fillRect(x, y, 1, 1)
  }
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * S, y = Math.random() * S
    const r = 10 + Math.random() * 40
    const gr = g.createRadialGradient(x, y, 0, x, y, r)
    gr.addColorStop(0, "rgba(150,120,70,0.07)")
    gr.addColorStop(1, "rgba(150,120,70,0)")
    g.fillStyle = gr
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
  }
  // 边缘压暗
  const vg = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.34, S * 0.5, S * 0.5, S * 0.74)
  vg.addColorStop(0, "rgba(0,0,0,0)")
  vg.addColorStop(1, "rgba(90,70,44,0.20)")
  g.fillStyle = vg
  g.fillRect(0, 0, S, S)

  // 文字：顶格（左上角起，无首行缩进；行距均匀）
  const size = o.size || 40
  const lh = Math.round(size * (o.lh == null ? 1.55 : o.lh))
  const padX = o.padX == null ? 36 : o.padX
  const padY = o.padY == null ? 40 : o.padY
  g.font = `${size}px "SimSun", "宋体", serif`
  g.textAlign = "left"
  g.textBaseline = "top"
  g.fillStyle = o.color || "#3a2c1c"
  let y = padY
  for (const line of lines) {
    // 简单折行：按可用宽度切
    let cur = ""
    for (const ch of line) {
      if (g.measureText(cur + ch).width > S - padX * 2 && cur) {
        g.fillText(cur, padX, y)
        y += lh
        cur = ch
      } else cur += ch
    }
    if (cur) { g.fillText(cur, padX, y); y += lh }
    y += Math.round(size * 0.35)      // 段落间距
  }
  return c
}

/* 老旧牛皮日记本封面：深褐牛皮 + 磨损/污渍 + 边缘压深 */
function makeKraftTexture() {
  const S = 256
  const c = mkCanvas(S, S)
  const g = c.getContext("2d")
  // 底色：深褐牛皮
  g.fillStyle = "#8a6038"
  g.fillRect(0, 0, S, S)
  // 皮纹：大量短弧线，方向随机
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * S, y = Math.random() * S
    const l = 3 + Math.random() * 10
    const a = Math.random() * Math.PI
    g.strokeStyle = Math.random() > 0.5 ? "rgba(120,88,58,0.16)" : "rgba(48,32,20,0.16)"
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l)
    g.stroke()
  }
  // 大块污渍（旧）
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S, y = Math.random() * S
    const r = 8 + Math.random() * 34
    const gr = g.createRadialGradient(x, y, 0, x, y, r)
    gr.addColorStop(0, "rgba(40,26,14,0.20)")
    gr.addColorStop(1, "rgba(40,26,14,0)")
    g.fillStyle = gr
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
  }
  // 边缘压深（磨损）
  const vg = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.30, S * 0.5, S * 0.5, S * 0.72)
  vg.addColorStop(0, "rgba(0,0,0,0)")
  vg.addColorStop(1, "rgba(20,12,6,0.34)")
  g.fillStyle = vg
  g.fillRect(0, 0, S, S)
  // 烫金细边
  g.strokeStyle = "rgba(206,170,100,0.55)"
  g.lineWidth = 3
  g.strokeRect(14.5, 14.5, S - 29, S - 29)
  // 中间压印的小方框（旧日记本常见）
  g.strokeStyle = "rgba(186,150,84,0.30)"
  g.lineWidth = 2
  g.strokeRect(S * 0.34, S * 0.40, S * 0.32, S * 0.20)
  return c
}

/* 笔记本内页：米白纸 + 淡横格 + 左侧红线 */
function makePageTexture() {
  const S = 256
  const c = mkCanvas(S, S)
  const g = c.getContext("2d")
  g.fillStyle = "#e9dcbb"
  g.fillRect(0, 0, S, S)
  // 纸的细颗粒
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * S, y = Math.random() * S
    g.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(150,130,100,0.05)"
    g.fillRect(x, y, 1, 1)
  }
  // 横格线
  g.strokeStyle = "rgba(126,106,78,0.34)"
  g.lineWidth = 1
  for (let y = 26; y < S; y += 26) {
    g.beginPath()
    g.moveTo(16, y + 0.5)
    g.lineTo(S - 8, y + 0.5)
    g.stroke()
  }
  // 左侧红边线
  g.strokeStyle = "rgba(178,70,66,0.55)"
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(18, 6)
  g.lineTo(18, S - 6)
  g.stroke()
  // 边缘压暗一点，像真的纸堆
  const gr = g.createLinearGradient(0, 0, S, 0)
  gr.addColorStop(0, "rgba(90,70,50,0.10)")
  gr.addColorStop(0.06, "rgba(90,70,50,0)")
  gr.addColorStop(0.94, "rgba(90,70,50,0)")
  gr.addColorStop(1, "rgba(90,70,50,0.10)")
  g.fillStyle = gr
  g.fillRect(0, 0, S, S)
  return c
}

function makeDuvetTexture() {
  const S = 256
  const c = mkCanvas(S, S)
  const g = c.getContext('2d')
  const patW = S          // 铺满整幅，图案不会在边缘断掉
  // 底色：被子的红
  g.fillStyle = '#b03a3a'
  g.fillRect(0, 0, patW, S)
  // 布的细纹（很淡，避免死板）
  for (let y = 0; y < S; y += 2) {
    g.fillStyle = 'rgba(255,255,255,0.02)'
    g.fillRect(0, y, patW, 1)
  }
  // 黄色波浪：三条，粗 3px
  const waves = [
    { y0: 46, amp: 10, len: 96, color: '#d9b04a', w: 24 },
    { y0: 128, amp: 11, len: 88, color: '#e0b955', w: 24 },
    { y0: 210, amp: 10, len: 102, color: '#d9b04a', w: 24 },
  ]
  for (const wv of waves) {
    g.strokeStyle = wv.color
    g.lineWidth = wv.w
    g.beginPath()
    for (let x = 4; x <= patW - 4; x++) {
      const y = wv.y0 + Math.sin((x / wv.len) * Math.PI * 2) * wv.amp
      if (x === 4) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
  }
  // 右侧纯白区
  g.fillStyle = '#ffffff'
  g.fillRect(patW, 0, S - patW, S)
  return c
}

/* ---------- 材质图集（家具用）：4×4 个 64×64 瓷砖 ---------- */
const ATLAS_TILE = 64
const ATLAS_COLS = 4
const MAT = {
  woodL: 0, woodM: 1, woodD: 2, red: 3,
  cream: 4, stone: 5, metal: 6, fire: 7,
  leaf: 8, paper: 9, dark: 10,
}

function makeAtlas() {
  const W2 = ATLAS_TILE * ATLAS_COLS
  const H2 = ATLAS_TILE * ATLAS_COLS
  const c = mkCanvas(W2, H2)
  const g = c.getContext('2d')
  const fillTile = (mat, fn) => {
    const col = mat % ATLAS_COLS
    const row = Math.floor(mat / ATLAS_COLS)
    pxGrid(g, col * ATLAS_TILE, row * ATLAS_TILE, ATLAS_TILE, ATLAS_TILE, fn)
  }

  // 亮木：木纹是按方向的细线，不是散点
  fillTile(MAT.woodL, (i, j) => {
    if (i % 21 === 0) return '#b88549'
    if (j % 13 === 0) return '#c08a4c'
    return (j % 7 === 0 && (i * 3) % 17 === 0) ? '#c89756' : '#c4924f'
  })
  // 中木
  fillTile(MAT.woodM, (i, j) => {
    if (i % 19 === 0) return '#9e6a39'
    if (j % 11 === 0) return '#a26d3b'
    return '#a8703c'
  })
  // 深木
  fillTile(MAT.woodD, (i, j) => {
    if (i % 23 === 0) return '#754a26'
    if (j % 15 === 0) return '#7a4d28'
    return '#7d4f28'
  })
  // 红布：织纹（棋盘格只差一档）
  fillTile(MAT.red, (i, j) => {
    if ((i + j) % 8 === 0) return '#a83838'
    if ((i * j) % 31 === 0) return '#b84040'
    return '#b03a3a'
  })
  // 米白布
  fillTile(MAT.cream, (i, j) => {
    if ((i + j) % 10 === 0) return '#ebe2cc'
    return '#f2ead6'
  })
  // 石头：用低频斑块，不用格子线
  fillTile(MAT.stone, (i, j) => {
    const n = softNoise(Math.floor(i / 3), Math.floor(j / 3), 7)
    if (n > 0.45) return '#a29c8e'
    if (n < -0.55) return '#9c9688'
    return '#a8a294'
  })
  // 金属：竖向一条高光带
  fillTile(MAT.metal, (i, j) => {
    if (i % 16 < 3) return '#c2bcaf'
    if (i % 16 === 15) return '#a8a295'
    return '#b9b3a6'
  })
  // 火：竖向火苗条带（三档橙，不跳色）
  fillTile(MAT.fire, (i, j) => {
    const t = (i * 5 + j * 3) % 23
    if (j < 20) return t < 8 ? '#f0a63c' : '#e88c28'
    if (j < 44) return t < 6 ? '#f0a63c' : '#e2861f'
    return t < 5 ? '#d97f22' : '#d07a20'
  })
  // 叶子
  fillTile(MAT.leaf, (i, j) => {
    if ((i + j * 3) % 17 === 0) return '#4f8f3d'
    if ((i * 3 + j) % 19 === 0) return '#54973f'
    return '#4a8a3a'
  })
  // 纸
  fillTile(MAT.paper, (i, j) => {
    if (j % 12 === 0) return "#e6dcc4"
    return "#f2ead6"
  })
  // 近黑（吊灯外壳、灯座）：留一点微弱亮边，不死黑
  fillTile(MAT.dark, (i, j) => {
    if (i % 24 === 0) return "#3a352f"
    if (j % 18 === 0) return "#332e29"
    return "#2a2622"
  })
  return c
}

/* Blender 导出的床（base64 → 顶点）：pos3 + uv2 + color3 + normal3 */
const BED_OFFSET = { x: -3.30, z: -3.82 }   // 床紧贴左墙与后墙（顶面 x=-4.5、床头 z=-5.5 附近）
function decodeBedMesh(b64) {
  if (!b64) return null
  const bin = atob(b64)
  const n = Math.floor(bin.length / 16)
  const dv = new DataView(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i))
  const out = new Float32Array(n * 11)
  for (let i = 0; i < n; i++) {
    const o = i * 16, k = i * 11
    out[k] = dv.getInt16(o, true) / 1000 + BED_OFFSET.x
    out[k + 1] = dv.getInt16(o + 2, true) / 1000
    out[k + 2] = dv.getInt16(o + 4, true) / 1000 + BED_OFFSET.z
    out[k + 3] = dv.getUint16(o + 12, true) / 65535   // u
    out[k + 4] = dv.getUint16(o + 14, true) / 65535   // v
    // 字节序：pos(0..5) + normal(6..8) + color(9..11) + uv(12..15)
    out[k + 5] = dv.getUint8(o + 9) / 255
    out[k + 6] = dv.getUint8(o + 10) / 255
    out[k + 7] = dv.getUint8(o + 11) / 255
    out[k + 8] = dv.getInt8(o + 6) / 127
    out[k + 9] = dv.getInt8(o + 7) / 127
    out[k + 10] = dv.getInt8(o + 8) / 127
  }
  return { data: out, count: n }
}

/* ---------- 顶点收集 ---------- */
const FURN = []
const EMIT = []          // 自发光部件（灯球）：单独一个 buffer，绘制时不走光照
let PUSH_TARGET = FURN

function tileUV(mat, u, v) {
  const col = mat % ATLAS_COLS
  const row = Math.floor(mat / ATLAS_COLS)
  const pad = 1
  const x0 = (col * ATLAS_TILE + pad) / (ATLAS_TILE * ATLAS_COLS)
  const y0 = (row * ATLAS_TILE + pad) / (ATLAS_TILE * ATLAS_COLS)
  const span = (ATLAS_TILE - pad * 2) / (ATLAS_TILE * ATLAS_COLS)
  return [x0 + u * span, y0 + v * span]
}

/* 把 4 个角点按 0,1,2 / 0,2,3 拆成两个三角形，连同法线一起写入 */
function pushQuadData(data, q) {
  const a = q[0], b = q[1], d = q[3]
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len; ny /= len; nz /= len
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const v = q[i]
    data.push(v[0], v[1], v[2], v[3], v[4], 1, 1, 1, nx, ny, nz)
  }
}
function quad(a, b, c, d, mat, shade) {
  const pts = [a, b, c, a, c, d]
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]
  // 面法线（a→b 与 a→d 的叉积）：光照要用，双面取绝对值，所以朝向不影响
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len; ny /= len; nz /= len
  for (let i = 0; i < 6; i++) {
    const p = pts[i]
    const uv = tileUV(mat, uvs[i][0], uvs[i][1])
    PUSH_TARGET.push(p[0], p[1], p[2], uv[0], uv[1], shade, shade, shade, nx, ny, nz)
  }
}

function box(x, y, z, w, h, d, mat) {
  const x0 = x, x1 = x + w
  const y0 = y, y1 = y + h
  const z0 = z, z1 = z + d
  quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], mat, 1.0)    // 顶
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], mat, 0.88)   // 前
  quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], mat, 0.74)   // 后
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], mat, 0.70)   // 左
  quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], mat, 0.80)   // 右
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], mat, 0.5)    // 底
}

/* 圆台（锥形）：灯罩、花盆都用它 —— 比堆方块好看得多 */
function frustum(cx, cz, y0, y1, r0, r1, mat, segs = 12) {
  const pt = (y, r, a) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2
    const a1 = ((i + 1) / segs) * Math.PI * 2
    // 侧面：越往下越暗一点，模拟灯罩内壁/受光差
    quad(pt(y0, r0, a0), pt(y0, r0, a1), pt(y1, r1, a1), pt(y1, r1, a0), mat, 0.92)
  }
}

/* 圆柱：就是等半径的圆台（灯座、吊杆用） */
function cylinder(cx, cz, y0, y1, r, mat, segs = 14) {
  frustum(cx, cz, y0, y1, r, r, mat, segs)
}

/* 球体：给灯泡用（经纬细分，顶点带明暗） */
function sphere(cx, cy, cz, r, mat, latSegs = 10, lonSegs = 14) {
  const pt = (t, p) => [
    cx + r * Math.sin(t) * Math.cos(p),
    cy + r * Math.cos(t),
    cz + r * Math.sin(t) * Math.sin(p),
  ]
  for (let i = 0; i < latSegs; i++) {
    const t0 = (i / latSegs) * Math.PI
    const t1 = ((i + 1) / latSegs) * Math.PI
    for (let j = 0; j < lonSegs; j++) {
      const p0 = (j / lonSegs) * Math.PI * 2
      const p1 = ((j + 1) / lonSegs) * Math.PI * 2
      const shade = 0.45 + 0.55 * Math.cos(t0)     // 上亮下暗
      quad(pt(t0, p0), pt(t0, p1), pt(t1, p1), pt(t1, p0), mat, shade)
    }
  }
}

/* ---------- 3D 家具（方块堆出来的） ---------- */
function buildFurniture() {
  FURN.length = 0
  EMIT.length = 0
  PUSH_TARGET = FURN
  const hw = ACT0.roomW / 2
  const hd = ACT0.roomD / 2
  const hh2 = ACT0.roomH

  // ── 床：改用 Blender 导出的精细模型（assets/bed.js），不再手搓方块 ──

  // ── 床头柜 ──
  const nx = -2.02, nz = -5.44   // 床头柜：床右侧、紧贴后墙
  box(nx, 0, nz, 0.95, 0.72, 0.6, MAT.woodM)
  for (let i = 0; i < 2; i++) {
    box(nx + 0.06, 0.08 + i * 0.32, nz + 0.58, 0.83, 0.26, 0.05, MAT.woodL)
    box(nx + 0.42, 0.16 + i * 0.32, nz + 0.62, 0.16, 0.06, 0.04, MAT.metal)
  }
  box(nx + 0.03, 0.72, nz + 0.03, 0.89, 0.05, 0.54, MAT.woodL)   // 台面
  // 床头小台灯：圆底座 + 细杆 + 锥形罩 + 金属罩口 + 灯球
  cylinder(nx + 0.47, nz + 0.30, 0.77, 0.82, 0.13, MAT.metal, 14)
  cylinder(nx + 0.47, nz + 0.30, 0.82, 0.98, 0.022, MAT.metal, 10)
  frustum(nx + 0.47, nz + 0.30, 0.95, 1.05, 0.19, 0.075, MAT.dark, 16)
  frustum(nx + 0.47, nz + 0.30, 1.05, 1.07, 0.075, 0.055, MAT.metal, 16)
  PUSH_TARGET = EMIT
  sphere(nx + 0.47, 0.96, nz + 0.30, 0.062, MAT.fire, 10, 12)
  PUSH_TARGET = FURN
  // ── 五斗柜（左墙）──
  const dx = -hw + 0.12, dz = -0.9
  box(dx, 0, dz, 0.55, 1.0, 1.9, MAT.woodM)
  for (let i = 0; i < 3; i++) {
    box(dx + 0.54, 0.1 + i * 0.3, dz + 0.1, 0.05, 0.24, 1.7, MAT.woodL)
    box(dx + 0.58, 0.2 + i * 0.3, dz + 0.85, 0.04, 0.07, 0.18, MAT.metal)
  }

  // ── 衣柜（右墙靠后，门朝房间内侧）──
  const wx = hw - 0.75, wz = -3.4
  box(wx, 0, wz, 0.75, 2.5, 2.1, MAT.woodM)
  box(wx - 0.05, 0.15, wz + 0.1, 0.06, 2.15, 0.9, MAT.woodL)
  box(wx - 0.05, 0.15, wz + 1.1, 0.06, 2.15, 0.9, MAT.woodL)
  box(wx - 0.09, 1.1, wz + 0.95, 0.05, 0.3, 0.16, MAT.metal)
  box(wx, 2.45, wz, 0.75, 0.1, 2.1, MAT.woodD)

  // ── 书架（后墙右）：背板 + 两侧 + 顶底 + 三层隔板 + 书 ──
  const sx = 1.7, sz = -hd + 0.15
  box(sx, 0, sz, 2.4, 2.3, 0.1, MAT.woodM)
  box(sx, 0, sz, 0.12, 2.3, 0.6, MAT.woodM)
  box(sx + 2.28, 0, sz, 0.12, 2.3, 0.6, MAT.woodM)
  box(sx, 2.22, sz, 2.4, 0.1, 0.6, MAT.woodM)
  box(sx, 0, sz, 2.4, 0.12, 0.6, MAT.woodM)
  // 书：高矮不一 + 厚薄不一 + 偶尔留空档，颜色只用书会有的
  const BOOK_MATS = [MAT.red, MAT.leaf, MAT.paper, MAT.woodD, MAT.metal]
  const BOOK_H = [0.52, 0.46, 0.56, 0.42, 0.50, 0.44]
  const BOOK_W = [0.075, 0.11, 0.06, 0.09, 0.13, 0.07]
  for (let r = 0; r < 3; r++) {
    const y = 0.14 + r * 0.7
    box(sx + 0.12, y + 0.62, sz + 0.05, 2.16, 0.08, 0.5, MAT.woodL)
    let bx2 = sx + 0.22
    for (let k = 0; k < 11; k++) {
      const w = BOOK_W[(k + r) % BOOK_W.length]
      const h = BOOK_H[(k * 2 + r) % BOOK_H.length]
      if (bx2 + w > sx + 2.16) break
      if ((k + r) % 7 === 6) { bx2 += 0.09; continue }
      box(bx2, y, sz + 0.14, w, h, 0.34, BOOK_MATS[(k + r * 2) % BOOK_MATS.length])
      bx2 += w + 0.012
    }
  }
  // ── 书架上的红皮笔记本（可交互，取下后会消失）──
  if (!A0.bookTaken) {
    // 牛皮日记本：深褐封面 + 泛黄纸口 + 烫金线（和桌上那本是同一本）
    box(2.50, 0.84, -5.12, 0.078, 0.32, 0.225, MAT.woodD)   // 封面（坐第二层板上）
    box(2.504, 0.85, -5.115, 0.070, 0.30, 0.215, MAT.cream) // 纸芯，露出三面纸口
    box(2.494, 0.845, -5.11, 0.012, 0.31, 0.215, MAT.woodM) // 书脊（背面，靠里一侧）
    box(2.505, 1.030, -5.115, 0.066, 0.006, 0.212, MAT.metal) // 烫金细边
    box(2.512, 0.955, -5.085, 0.010, 0.020, 0.012, MAT.metal) // 书签皮绳扣
  }


  // ── 书桌 + 椅子 + 桌上台灯 ──
  const dtx = hw - 1.1, dtz = 1.0
  box(dtx, 0.74, dtz, 1.0, 0.1, 2.2, MAT.woodL)
  box(dtx + 0.06, 0, dtz + 0.08, 0.14, 0.74, 0.14, MAT.woodM)
  box(dtx + 0.8, 0, dtz + 0.08, 0.14, 0.74, 0.14, MAT.woodM)
  box(dtx + 0.06, 0, dtz + 1.98, 0.14, 0.74, 0.14, MAT.woodM)
  box(dtx + 0.8, 0, dtz + 1.98, 0.14, 0.74, 0.14, MAT.woodM)
  const tlx = dtx + 0.80, tlz = dtz + 0.32   // 台灯放在桌面右上角
  // 书桌台灯：圆底座 + 细杆 + 锥形罩 + 金属罩口 + 灯球（比床头灯大一号）
  cylinder(tlx, tlz, 0.84, 0.89, 0.15, MAT.metal, 16)
  cylinder(tlx, tlz, 0.89, 1.12, 0.024, MAT.metal, 10)
  frustum(tlx, tlz, 1.08, 1.20, 0.24, 0.09, MAT.dark, 18)
  frustum(tlx, tlz, 1.20, 1.225, 0.09, 0.065, MAT.metal, 18)
  PUSH_TARGET = EMIT
  sphere(tlx, 1.10, tlz, 0.075, MAT.fire, 10, 12)
  PUSH_TARGET = FURN
  // 椅子
  const cx3 = dtx - 0.75, cz3 = dtz + 0.85
  box(cx3, 0.44, cz3, 0.6, 0.1, 0.6, MAT.woodL)
  for (const [ox, oz] of [[0.02, 0.02], [0.48, 0.02], [0.02, 0.48], [0.48, 0.48]]) {
    box(cx3 + ox, 0, cz3 + oz, 0.1, 0.44, 0.1, MAT.woodD)
  }
  box(cx3 - 0.02, 0.54, cz3, 0.1, 0.8, 0.6, MAT.woodM)

  // ── 桌上的信：可交互物件（走近按 E 触发剧情）──
  box(3.55, 0.845, 1.35, 0.30, 0.014, 0.22, MAT.paper)      // 信纸（桌面在 y=0.84）
  box(3.56, 0.860, 1.36, 0.26, 0.010, 0.19, MAT.cream)      // 上面压着的一层，显得是叠着的
  box(3.68, 0.871, 1.44, 0.07, 0.012, 0.07, MAT.red)        // 一颗红色印记

  // ── 门（前墙偏右）──
  const drX = 1.4, drW = 1.2, drH = 2.15, dwz = hd - 0.02
  box(drX - 0.1, 0, dwz - 0.12, 0.14, drH + 0.1, 0.14, MAT.woodD)
  box(drX + drW - 0.04, 0, dwz - 0.12, 0.14, drH + 0.1, 0.14, MAT.woodD)
  box(drX - 0.1, drH, dwz - 0.12, drW + 0.2, 0.14, 0.14, MAT.woodD)
  box(drX, 0, dwz - 0.08, drW, drH, 0.08, MAT.woodM)
  box(drX + 0.1, 0.5, dwz - 0.12, drW - 0.2, 0.7, 0.04, MAT.woodL)
  box(drX + 0.1, 1.35, dwz - 0.12, drW - 0.2, 0.6, 0.04, MAT.woodL)
  box(drX + drW - 0.24, 1.0, dwz - 0.16, 0.1, 0.08, 0.06, MAT.metal)
  box(drX - 0.1, 0, dwz - 0.3, drW + 0.2, 0.05, 0.3, MAT.stone)

  // ── 窗框 ──
  for (const win of [{ x0: -2.6, x1: -0.4 }, { x0: 0.6, x1: 2.8 }]) {
    const ww = win.x1 - win.x0
    const y0 = 1.5, y1 = 2.8
    box(win.x0 - 0.08, y0 - 0.08, -hd + 0.02, ww + 0.16, 0.1, 0.14, MAT.woodL)
    box(win.x0 - 0.08, y1 - 0.02, -hd + 0.02, ww + 0.16, 0.1, 0.14, MAT.woodL)
    box(win.x0 - 0.08, y0 - 0.08, -hd + 0.02, 0.1, y1 - y0 + 0.16, 0.14, MAT.woodL)
    box(win.x1 - 0.02, y0 - 0.08, -hd + 0.02, 0.1, y1 - y0 + 0.16, 0.14, MAT.woodL)
    box(win.x0 + ww / 2 - 0.03, y0 - 0.08, -hd + 0.02, 0.07, y1 - y0 + 0.16, 0.10, MAT.woodL)
    box(win.x0 - 0.08, (y0 + y1) / 2 - 0.03, -hd + 0.02, ww + 0.16, 0.07, 0.10, MAT.woodL)
  }

  // ── 木箱 / 盆栽 ──
  box(3.6, 0, hd - 1.0, 0.95, 0.75, 0.95, MAT.woodM)
  box(3.62, 0.66, hd - 0.98, 0.91, 0.12, 0.91, MAT.woodL)
  box(3.96, 0.3, hd - 0.14, 0.04, 0.2, 0.16, MAT.metal)

  const px3 = -hw + 0.55, pz3 = hd - 1.3
  frustum(px3, pz3, 0, 0.42, 0.30, 0.22, MAT.woodM, 12)
  box(px3 - 0.32, 0.40, pz3 - 0.32, 0.64, 0.06, 0.64, MAT.woodL)
  box(px3 - 0.28, 0.42, pz3 - 0.28, 0.56, 0.04, 0.56, MAT.woodD)
  box(px3 - 0.03, 0.46, pz3 - 0.03, 0.06, 0.5, 0.06, MAT.woodD)
  box(px3 - 0.16, 0.5, pz3 + 0.04, 0.05, 0.36, 0.05, MAT.woodD)
  box(px3 + 0.1, 0.5, pz3 - 0.1, 0.05, 0.32, 0.05, MAT.woodD)
  const leafSpots = [
    [0, 0.95, 0, 0.34], [0, 0.80, 0, 0.30], [0, 1.10, 0, 0.24],
    [-0.26, 0.86, 0.02, 0.24], [0.24, 0.90, -0.04, 0.26],
    [-0.16, 1.02, -0.16, 0.20], [0.14, 1.04, 0.14, 0.20],
    [-0.30, 0.72, -0.14, 0.22], [0.28, 0.74, 0.12, 0.22],
    [0, 0.66, 0.22, 0.20],
  ]
  for (const [ox, oy, oz, s] of leafSpots) {
    box(px3 + ox - s / 2, oy, pz3 + oz - s / 2, s, s * 0.7, s, MAT.leaf)
  }

  // ── 吊灯：黑色外壳、扁一点（吸顶盘 + 短杆 + 扁锥罩 + 灯球）──
  const lx = 0, lz = -1.1
  cylinder(lx, lz, hh2 - 0.05, hh2, 0.16, MAT.dark, 20)
  cylinder(lx, lz, hh2 - 0.20, hh2 - 0.05, 0.026, MAT.dark, 12)
  frustum(lx, lz, hh2 - 0.26, hh2 - 0.20, 0.09, 0.05, MAT.dark, 16)
  frustum(lx, lz, hh2 - 0.56, hh2 - 0.26, 0.44, 0.09, MAT.dark, 22)
  frustum(lx, lz, hh2 - 0.60, hh2 - 0.56, 0.47, 0.44, MAT.dark, 22)
  frustum(lx, lz, hh2 - 0.62, hh2 - 0.60, 0.44, 0.44, MAT.metal, 22)
  // 罩口里的灯座 + 灯珠（露在罩口下沿一点，侧面也能看见）
  cylinder(lx, lz, hh2 - 0.60, hh2 - 0.46, 0.045, MAT.dark, 12)        // 灯座
  PUSH_TARGET = EMIT
  sphere(lx, hh2 - 0.555, lz, 0.08, MAT.fire, 14, 18)                  // 灯珠（收进罩口里，抬高）
  PUSH_TARGET = FURN

  return { data: new Float32Array(FURN), emit: new Float32Array(EMIT), count: FURN.length / 11, emitCount: EMIT.length / 11 }
}

/* ---------- 矩阵 ---------- */
function mat4Perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}

function mat4View(cam) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw)
  const pitch = cam.pitch ?? 0
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const dx = -sy * cp, dy = -sp, dz = -cy * cp
  let rx = cy, ry = 0, rz = -sy
  const zx = -dx, zy = -dy, zz = -dz
  const ux = zy * rz - zz * ry
  const uy = zz * rx - zx * rz
  const uz = zx * ry - zy * rx
  const ex = cam.x, ey = cam.eye ?? ACT0.eyeHeight, ez = cam.z
  return new Float32Array([
    rx, ux, zx, 0,
    ry, uy, zy, 0,
    rz, uz, zz, 0,
    -(rx * ex + ry * ey + rz * ez),
    -(ux * ex + uy * ey + uz * ez),
    -(zx * ex + zy * ey + zz * ez),
    1,
  ])
}

function mat4Mul(a, b) {
  const o = new Float32Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]
      o[i * 4 + j] = s
    }
  }
  return o
}

/* ---------- 初始化 ---------- */
function gl3dInit() {
  if (GL3D.ready || GL3D.failed) return GL3D.ready
  try {
    const cv = document.createElement('canvas')
    const gl = cv.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true })
    if (!gl) { GL3D.failed = true; return false }
    // 顶点着色器把世界坐标传下去；法线在片元里用屏幕导数现算（不必为每个顶点存法线）
    const vs = `
      attribute vec3 aPos; attribute vec2 aUV; attribute vec3 aColor; attribute vec3 aNormal;
      uniform mat4 uMVP;
      varying vec2 vUV; varying vec3 vColor; varying vec3 vWorld; varying vec3 vNormal;
      void main() {
        vUV = aUV; vColor = aColor; vWorld = aPos; vNormal = aNormal;
        gl_Position = uMVP * vec4(aPos, 1.0);
      }`
    // 点光源：灯在场景里固定不动，和相机无关，转向/走位都不会影响它
    const fs = `
      precision mediump float;
      varying vec2 vUV; varying vec3 vColor; varying vec3 vWorld; varying vec3 vNormal;
      uniform sampler2D uTex;
      uniform vec3 uTint;
      uniform vec3 uLampPos;
      uniform vec3 uLampColor;
      uniform vec3 uAmbient;
      uniform float uFalloff;
      uniform vec3 uLamp2Pos;
      uniform vec3 uLamp2Color;
      uniform float uFalloff2;
      uniform float uEmissive;
      void main() {
        vec3 N = normalize(vNormal);
        vec3 Lv = uLampPos - vWorld;
        float d = length(Lv);
        vec3 L = Lv / max(d, 0.001);
        float lam = abs(dot(N, L));
        float atten = 1.0 / (1.0 + uFalloff * d * d);
        vec3 lit = uAmbient + uLampColor * atten * (0.25 + 0.75 * lam);
        // 第二盏灯：桌上小台灯，范围小、亮度低，只把桌面托出来
        vec3 Lv2 = uLamp2Pos - vWorld;
        float d2 = length(Lv2);
        vec3 L2 = Lv2 / max(d2, 0.001);
        float lam2 = abs(dot(N, L2));
        float atten2 = 1.0 / (1.0 + uFalloff2 * d2 * d2);
        lit += uLamp2Color * atten2 * (0.25 + 0.75 * lam2);
        vec4 c = texture2D(uTex, vUV);
        vec3 rgb0 = c.rgb * vColor * uTint;
        // 自发光部件（灯球）：不吃光照，直接给亮色
        vec3 outCol = mix(rgb0 * lit, rgb0 * 1.7 + vec3(0.30, 0.22, 0.10), uEmissive);
        gl_FragColor = vec4(outCol, c.a);
      }`
    const make = (t, src) => {
      const sh = gl.createShader(t)
      gl.shaderSource(sh, src); gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader')
      return sh
    }
    const prog = gl.createProgram()
    gl.attachShader(prog, make(gl.VERTEX_SHADER, vs))
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link')
    gl.useProgram(prog)

    GL3D.canvas = cv; GL3D.gl = gl; GL3D.prog = prog
    GL3D.buf = gl.createBuffer()
    GL3D.posLoc = gl.getAttribLocation(prog, 'aPos')
    GL3D.uvLoc = gl.getAttribLocation(prog, 'aUV')
    GL3D.colLoc = gl.getAttribLocation(prog, 'aColor')
    GL3D.nrmLoc = gl.getAttribLocation(prog, 'aNormal')
    GL3D.mvpLoc = gl.getUniformLocation(prog, 'uMVP')
    GL3D.texLoc = gl.getUniformLocation(prog, 'uTex')
    GL3D.tintLoc = gl.getUniformLocation(prog, 'uTint')
    GL3D.lampPosLoc = gl.getUniformLocation(prog, 'uLampPos')
    GL3D.lampColLoc = gl.getUniformLocation(prog, 'uLampColor')
    GL3D.ambLoc = gl.getUniformLocation(prog, 'uAmbient')
    GL3D.fallLoc = gl.getUniformLocation(prog, 'uFalloff')
    GL3D.lamp2PosLoc = gl.getUniformLocation(prog, 'uLamp2Pos')
    GL3D.lamp2ColLoc = gl.getUniformLocation(prog, 'uLamp2Color')
    GL3D.fall2Loc = gl.getUniformLocation(prog, 'uFalloff2')
    GL3D.emisLoc = gl.getUniformLocation(prog, 'uEmissive')

    const mk = (canvas) => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
      // 像素风：不做线性插值，放大后仍是硬边
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      return t
    }
    GL3D.tex = {
      floor: mk(makeFloorTexture()),
      wall: mk(makeWallTexture()),
      ceil: mk(makeCeilTexture()),
      window: mk(makeWindowTexture()),
      outside: mk(makeOutsideTexture()),
      rug: mk(makeRugTexture()),
      duvet: mk(makeDuvetTexture()),
    pages: mk(makePageTexture()),
    kraft: mk(makeKraftTexture()),
    pageA: mk(makeTextPage(['纪念长征中的同志，', '1935年9月20日，我们小队在和大部队被敌军打散后，我随着运输队来到了一座山脚下的村庄，队长赋予了我保护战略地图的任务。但我们不知道有敌军跟在我们后面，我只想快点跟上大部队，好完成任务'], { size: 70, padY: 84, padX: 110, lh: 1.52 })),
    pageB: mk(makeTextPage(['头磨得我手掌全是血，但我不能停下来。', '我只记得当时脑袋里的念头：爬，爬，爬。。。。'], { size: 70, padY: 84, padX: 110, lh: 1.52 })),
    }
    GL3D.atlas = mk(makeAtlas())
    const w = mkCanvas(2, 2)
    const wg = w.getContext('2d')
    wg.fillStyle = '#fff'; wg.fillRect(0, 0, 2, 2)
    GL3D.white = mk(w)

    const furn = buildFurniture()
    GL3D.furn = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.furn)
    gl.bufferData(gl.ARRAY_BUFFER, furn.data, gl.STATIC_DRAW)
    GL3D.furnCount = furn.count

    // Blender 导出的床
    const mkBuf = (b64) => {
      const m = decodeBedMesh(b64)
      if (!m) return { buf: null, count: 0 }
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW)
      return { buf, count: m.count }
    }
    const bedPlain = mkBuf(window.BED_MESH)
    const bedDuvet = mkBuf(window.BED_DUVET)
    GL3D.bed = bedPlain.buf
    GL3D.bedCount = bedPlain.count
    GL3D.bedDuvet = bedDuvet.buf
    GL3D.bedDuvetCount = bedDuvet.count
    console.log("[bed] 普通件", bedPlain.count, "被子", bedDuvet.count)
    GL3D.emit = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.emit)
    gl.bufferData(gl.ARRAY_BUFFER, furn.emit, gl.STATIC_DRAW)
    GL3D.emitCount = furn.emitCount
    GL3D.book = gl.createBuffer()   // 坐姿过场里的笔记本（每帧重建）

    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    GL3D.ready = true
    return true
  } catch (e) {
    console.warn('[3d] WebGL 初始化失败，退回 2D 画法:', e && e.message)
    GL3D.err = e && (e.stack || e.message)
    GL3D.failed = true
    return false
  }
}

function bindAttribs(gl) {
  const S = 44                       // 11 个 float：pos3 + uv2 + color3 + normal3
  gl.enableVertexAttribArray(GL3D.posLoc)
  gl.vertexAttribPointer(GL3D.posLoc, 3, gl.FLOAT, false, S, 0)
  gl.enableVertexAttribArray(GL3D.uvLoc)
  gl.vertexAttribPointer(GL3D.uvLoc, 2, gl.FLOAT, false, S, 12)
  gl.enableVertexAttribArray(GL3D.colLoc)
  gl.vertexAttribPointer(GL3D.colLoc, 3, gl.FLOAT, false, S, 20)
  gl.enableVertexAttribArray(GL3D.nrmLoc)
  gl.vertexAttribPointer(GL3D.nrmLoc, 3, gl.FLOAT, false, S, 32)
}

/* ---------- 每帧绘制 ---------- */
function gl3dDraw(cam, w, h, dpr) {
  const gl = GL3D.gl
  const cv = GL3D.canvas
  const pw = Math.max(2, Math.round(w * dpr))
  const ph = Math.max(2, Math.round(h * dpr))
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph }
  gl.viewport(0, 0, pw, ph)
  gl.clearColor(0.09, 0.07, 0.05, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.useProgram(GL3D.prog)

  const proj = mat4Perspective(cam.fov ?? ACT0.fov, pw / ph, 0.05, 100)
  const view = mat4View(cam)
  GL3D.mvp = mat4Mul(proj, view)
  gl.uniformMatrix4fv(GL3D.mvpLoc, false, GL3D.mvp)
  gl.uniform1i(GL3D.texLoc, 0)
  // 光源：天花板中央的灯，位置固定，和相机无关
  const lampP = [0, ACT0.roomH - 0.44, -1.1]
  const lampOn = A0.lampOn !== false
  gl.uniform3fv(GL3D.lampPosLoc, new Float32Array(lampP))
  gl.uniform3fv(GL3D.lampColLoc, lampOn ? new Float32Array([1.75, 1.42, 0.95]) : new Float32Array([0, 0, 0]))
  gl.uniform3fv(GL3D.ambLoc, new Float32Array([0.17, 0.18, 0.25]))
  gl.uniform1f(GL3D.fallLoc, 0.40)
  // 第二盏灯：书桌上的小台灯（位置固定，暗一点、范围小一点）
  gl.uniform3fv(GL3D.lamp2PosLoc, new Float32Array([4.20, 1.16, 1.32]))
  gl.uniform3fv(GL3D.lamp2ColLoc, new Float32Array([1.05, 0.78, 0.42]))
  gl.uniform1f(GL3D.fall2Loc, 3.2)
  gl.uniform1f(GL3D.emisLoc, 0.0)
  gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
  gl.activeTexture(gl.TEXTURE0)

  const hw = ACT0.roomW / 2
  const hd = ACT0.roomD / 2
  const hh = ACT0.roomH

  // 房间面：uv 按米数平铺，保持像素大小一致
  const F = {
    floor: [[-hw, 0, -hd, 0, 0], [hw, 0, -hd, ACT0.roomW / 0.8, 0], [hw, 0, hd, ACT0.roomW / 0.8, ACT0.roomD / 0.8], [-hw, 0, hd, 0, ACT0.roomD / 0.8]],
    ceil: [[-hw, hh, -hd, 0, 0], [hw, hh, -hd, ACT0.roomW / 1.6, 0], [hw, hh, hd, ACT0.roomW / 1.6, ACT0.roomD / 1.6], [-hw, hh, hd, 0, ACT0.roomD / 1.6]],
    backBottom: [[-hw, 0, -hd, 0, 1], [hw, 0, -hd, 1, 1], [hw, 1.5, -hd, 1, 0.72], [-hw, 1.5, -hd, 0, 0.72]],
    backTop: [[-hw, 2.8, -hd, 0, 0.28], [hw, 2.8, -hd, 1, 0.28], [hw, hh, -hd, 1, 0], [-hw, hh, -hd, 0, 0]],
    backL: [[-hw, 1.5, -hd, 0, 0.72], [-2.6, 1.5, -hd, 0.19, 0.72], [-2.6, 2.8, -hd, 0.19, 0.28], [-hw, 2.8, -hd, 0, 0.28]],
    backM: [[-0.4, 1.5, -hd, 0.42, 0.72], [0.6, 1.5, -hd, 0.53, 0.72], [0.6, 2.8, -hd, 0.53, 0.28], [-0.4, 2.8, -hd, 0.42, 0.28]],
    backR: [[2.8, 1.5, -hd, 0.81, 0.72], [hw, 1.5, -hd, 1, 0.72], [hw, 2.8, -hd, 1, 0.28], [2.8, 2.8, -hd, 0.81, 0.28]],
    front: [[hw, 0, hd, 0, 1], [-hw, 0, hd, 1, 1], [-hw, hh, hd, 1, 0], [hw, hh, hd, 0, 0]],
    left: [[-hw, 0, hd, 0, 1], [-hw, 0, -hd, 1, 1], [-hw, hh, -hd, 1, 0], [-hw, hh, hd, 0, 0]],
    right: [[hw, 0, -hd, 0, 1], [hw, 0, hd, 1, 1], [hw, hh, hd, 1, 0], [hw, hh, -hd, 0, 0]],
  }
  const ORDER = [
    ['ceil', 'ceil', [0.58, 0.55, 0.52]],
    ['backBottom', 'wall', [1.0, 1.0, 1.0]],
    ['backTop', 'wall', [0.96, 0.96, 0.96]],
    ['backL', 'wall', [1.0, 1.0, 1.0]],
    ['backM', 'wall', [1.0, 1.0, 1.0]],
    ['backR', 'wall', [1.0, 1.0, 1.0]],
    ['front', 'wall', [0.82, 0.82, 0.84]],
    ['left', 'wall', [0.88, 0.88, 0.90]],
    ['right', 'wall', [0.88, 0.88, 0.90]],
    ['floor', 'floor', [1.0, 0.98, 0.94]],
  ]
  const idx = [0, 1, 2, 0, 2, 3]
  for (const [name, texName, tint] of ORDER) {
    const f = F[name]
    const data = []
    pushQuadData(data, f)
    gl.bindTexture(gl.TEXTURE_2D, GL3D.tex[texName])
    gl.uniform3fv(GL3D.tintLoc, new Float32Array(tint))
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // 窗外的"假沙盒"：把房间整个包起来（前后左右 + 天顶 + 地面），任何角度看窗外都是夜色
  {
    const D = 18, TOP = 16, BOT = -6
    const sides = [
      { q: [[-D, BOT, -hd - 10, 0, 1], [D, BOT, -hd - 10, 1, 1], [D, TOP, -hd - 10, 1, 0], [-D, TOP, -hd - 10, 0, 0]], t: [1, 1, 1] },
      { q: [[D, BOT, hd + 10, 0, 1], [-D, BOT, hd + 10, 1, 1], [-D, TOP, hd + 10, 1, 0], [D, TOP, hd + 10, 0, 0]], t: [0.92, 0.92, 0.96] },
      { q: [[-D, BOT, hd + 10, 0, 1], [-D, BOT, -hd - 10, 1, 1], [-D, TOP, -hd - 10, 1, 0], [-D, TOP, hd + 10, 0, 0]], t: [0.88, 0.90, 0.98] },
      { q: [[D, BOT, -hd - 10, 0, 1], [D, BOT, hd + 10, 1, 1], [D, TOP, hd + 10, 1, 0], [D, TOP, -hd - 10, 0, 0]], t: [0.88, 0.90, 0.98] },
      { q: [[-D, TOP, -hd - 10, 0, 1], [D, TOP, -hd - 10, 1, 1], [D, TOP, hd + 10, 1, 0], [-D, TOP, hd + 10, 0, 0]], t: [0.50, 0.55, 0.70] },
      { q: [[-D, BOT, hd + 10, 0, 1], [D, BOT, hd + 10, 1, 1], [D, BOT, -hd - 10, 1, 0], [-D, BOT, -hd - 10, 0, 0]], t: [0.32, 0.34, 0.42] },
    ]
    gl.bindTexture(gl.TEXTURE_2D, GL3D.tex.outside)
    for (const f of sides) {
      const data = []
      pushQuadData(data, f.q)
      gl.uniform3fv(GL3D.tintLoc, new Float32Array(f.t))
      gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW)
      bindAttribs(gl)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
  }

  // 贴图元素：地毯（窗户已经挖了洞，不需要再贴片）
  const extras = [
    { tex: 'rug', quad: [[-2.2, 0.02, -2.4, 0, 0], [2.2, 0.02, -2.4, 1, 0], [2.2, 0.02, 1.4, 1, 1], [-2.2, 0.02, 1.4, 0, 1]], tint: [1, 1, 1] },
  ]
  for (const ex of extras) {
    const data = []
    pushQuadData(data, ex.quad)
    gl.bindTexture(gl.TEXTURE_2D, GL3D.tex[ex.tex])
    gl.uniform3fv(GL3D.tintLoc, new Float32Array(ex.tint))
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // Blender 导出的床：平直着色 + 材质色（走白色贴图，颜色来自顶点色）

  // 床（Blender 导出）：普通件走白色贴图 + 顶点色，被子走被子贴图（红底 + 黄波纹）
  if (GL3D.bedCount) {
    gl.bindTexture(gl.TEXTURE_2D, GL3D.white)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.bed)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, GL3D.bedCount)
  }
  if (GL3D.bedDuvetCount) {
    gl.bindTexture(gl.TEXTURE_2D, GL3D.tex.duvet)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.bedDuvet)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, GL3D.bedDuvetCount)
  }
  // 家具：一次画完，全部走材质图集
  if (GL3D.furnCount) {
    gl.bindTexture(gl.TEXTURE_2D, GL3D.atlas)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.furn)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, GL3D.furnCount)
  }

  // 坐姿过场：笔记本（动态几何，每帧重建）——阴影用图集、书页用老纸、封面用牛皮
  if (DESK.active) {
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
    const pass = (arr, tex) => {
      if (!arr.length) return
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.book)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW)
      bindAttribs(gl)
      gl.drawArrays(gl.TRIANGLES, 0, arr.length / 11)
    }
    pass(BOOKV, GL3D.atlas)         // 接触阴影
    pass(BOOKP, GL3D.tex.pages)     // 书页
    pass(BOOKA, GL3D.tex.pageA)     // 右侧第一页（纪念长征中的同志）
    pass(BOOKB, GL3D.tex.pageB)     // 左侧主页 / 翻起那叠的页背（我只想着爬，爬，爬）
    pass(BOOKC, GL3D.tex.kraft)     // 牛皮封面
  }

  // 墨块（3D）：正常走深度测试，所以会被家具遮挡、有透视
  if (INK3D.length) {
    gl.bindTexture(gl.TEXTURE_2D, GL3D.atlas)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([0.03, 0.028, 0.035]))
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.book)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(INK3D), gl.DYNAMIC_DRAW)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, INK3D.length / 11)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
  }

  // 自发光部件（灯珠）：不吃光照，直接给亮色
  if (GL3D.emitCount) {
    gl.bindTexture(gl.TEXTURE_2D, GL3D.atlas)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array(A0.lampOn !== false ? [1, 1, 1] : [0.10, 0.10, 0.12]))
    gl.uniform1f(GL3D.emisLoc, 1.0)
    gl.bindBuffer(gl.ARRAY_BUFFER, GL3D.emit)
    bindAttribs(gl)
    gl.drawArrays(gl.TRIANGLES, 0, GL3D.emitCount)
    gl.uniform1f(GL3D.emisLoc, 0.0)
    gl.uniform3fv(GL3D.tintLoc, new Float32Array([1, 1, 1]))
  }


  return cv
}

/* 世界坐标 → 屏幕像素（用最后一帧的 MVP） */
function worldToScreen(x, y, z, w, h) {
  const m = GL3D.mvp
  if (!m) return null
  // 点在相机背后时 w<=0：以前直接 return null，导致"走到窗边光就没了"。
  // 现在夹到近平面，并沿视线把坐标推到画面外，光晕是滑出画面而不是突然消失。
  let cw = m[3] * x + m[7] * y + m[11] * z + m[15]
  const behind = cw <= 0.0001
  if (behind) cw = 0.0001
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
  const sx = (cx / cw) * 0.5 + 0.5
  const sy = 0.5 - (cy / cw) * 0.5
  if (behind) return { x: (sx > 0 ? 1.5 : -0.5) * w, y: (sy > 0 ? 1.5 : -0.5) * h, behind: true }
  return { x: sx * w, y: sy * h, behind: false }
}

function renderRoomGL(w, h) {
  if (!gl3dInit()) return false
  gl3dDraw(A0.cam, w, h, DPR)
  return true
}

function makeRoomBackdrop(w, h, cam) {
  if (gl3dInit()) return gl3dDraw(cam, w, h, Math.min(2, DPR))
  const c = mkCanvas(w, h)
  drawRoomPixels(c.getContext('2d'), w, h, cam, 0, 1)
  return c
}

/* ============================ 主循环 ============================ */

let last = 0
function frame(now) {
  if (!last) last = now
  let dt = (now - last) / 1000
  last = now
  dt = Math.min(dt, 1 / 30)      // 掉帧保护：一帧绝不跳过整个碰撞

  // 出错不许黑屏：update/render 各包一层，出错就把原因画在屏幕上，循环继续活着
  try {
    if (!S.paused && !S.error) update(dt)
  } catch (e) {
    S.error = (e && e.message) || String(e)
    console.error('[update]', e)
  }
  try {
    render()
    drawWakeOverlay()      // 苏醒序列的全屏遮罩（黑幕 / 眼睑 / 曝光）
    drawCurtain()          // 过场黑幕：统一盖在所有模式之上
  } catch (e) {
    S.error = (e && e.message) || String(e)
    console.error('[render]', e)
    try { drawError() } catch { /* 连错误都画不出来就算了 */ }
  }

  trackFps(now)
  requestAnimationFrame(frame)
}

function drawError() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(9,7,12,0.94)'
  ctx.fillRect(0, 0, W, H)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ff9b9b'
  ctx.font = '15px ui-monospace,Consolas,monospace'
  ctx.fillText('演出出错了 —— 程序没崩，按 R 可以重播', W / 2, H / 2 - 26)
  ctx.fillStyle = '#c9d4e6'
  ctx.font = '12px ui-monospace,Consolas,monospace'
  ctx.fillText(String(S.error).slice(0, 140), W / 2, H / 2 + 4)
  ctx.fillStyle = '#6f7f99'
  ctx.fillText('把这个提示发给我就能定位', W / 2, H / 2 + 30)
}

function trackFps(now) {
  S.frames = (S.frames || 0) + 1
  if (!S.fpsAt) S.fpsAt = now
  const span = now - S.fpsAt
  if (span >= 500) {
    S.fps = Math.round((S.frames * 1000) / span)
    S.frames = 0
    S.fpsAt = now
    const el = document.getElementById('tuneFps')
    if (el) el.textContent = S.fps + ' fps'
  }
}

function update(dt) {
  updateA0Sub(dt)
  updateTip(dt)
  stepCurtain(dt)
  if (S.mode === 'act0') A0.t += dt
  else if (S.mode === 'room') updateRoom(dt)
  else if (S.mode === 'desk') updateDesk(dt)
  updateWake(dt)          // 苏醒序列：相机位姿 + 遮罩，逐帧推进
  if (S.mode === 'intro') updateIntro(dt)
  else if (S.mode === 'play') updatePlay(dt)
  else if (S.mode === 'act2') updateAct2(dt)
  else if (S.mode === 'act3') updateAct3(dt)
  else if (S.mode === 'act4') updateFinal(dt)
  else if (S.mode === 'act5') updateAct5(dt)
  else if (S.mode === 'act6') updateAct6(dt)
  if (A6.started && S.mode !== 'act6') updateAct6(dt)
  else if (S.mode === 'act1') updateAct1(dt)
}

/* ============================ 过场黑幕 ============================ */
/* 任何"换场"都需要它：fadeTo(1) 淡出到黑，fadeTo(0) 淡回画面。
   不预设你什么时候用，只提供工具。 */

function fadeTo(target, duration = 0.6, onDone) {
  S.fade = {
    from: S.curtain,
    to: clamp(target, 0, 1),
    t: 0,
    dur: Math.max(0.001, duration),
    onDone: typeof onDone === 'function' ? onDone : null,
  }
}

function stepCurtain(dt) {
  if (!S.fade) return
  const f = S.fade
  f.t += dt
  const k = clamp(f.t / f.dur, 0, 1)
  S.curtain = f.from + (f.to - f.from) * k
  if (k >= 1) {
    S.curtain = f.to
    S.fade = null
    if (f.onDone) f.onDone()
  }
}

// 清场：把台上的字都收掉（换场前用）
function clearStage() {
  for (const b of S.line) b.alpha = 0
  for (const b of S.field) b.alpha = 0
  S.fallers.length = 0
  S.waves.length = 0
}

/* ============================ 启动 ============================ */

resize()

// 截图/调试用：index.html?t=1.5 直接定到第 1.5 秒的画面
// 也可以带内容：?line=天地玄黄&hero=破&ambient=风雨如晦
// ?demo=1 回到早期的演示序列（回归测试用）
let jumpT = null
let DEMO = false
{
  const q = new URLSearchParams(location.search)
  const raw = q.get('t')
  if (raw !== null) jumpT = clamp(parseFloat(raw) || 0, 0, 60)
  if (q.has('line')) S.lineText = q.get('line')
  if (q.has('hero')) S.heroChar = q.get('hero')
  if (q.has('ambient')) S.ambientText = q.get('ambient')
  DEMO = q.get('demo') === '1'
}

// 当前"这一幕"的入口：正式流程进第一幕，?demo=1 走旧演示
// DEBUG ENTRY SWITCH
//   true  = 点开游戏直接进第一幕（调试用）
//   false = 恢复正常流程：第0幕 -> 第1幕 -> 第2幕
const DEBUG_START_AT_ACT1 = false
const DEBUG_START_AT_ACT2 = false
const DEBUG_START_AT_ACT3 = false
const DEBUG_START_AT_ACT4 = false    // 临时：直接进山谷场景

function startCurrent(auto) {
  // ?start=act0 强制走完整流程（自动测试用）；?start=act1 强制进第一幕
  if (location.search.indexOf('start=act0') >= 0) return startAct0(auto)
  if (location.search.indexOf('start=act4') >= 0) return startFinal()
  if (location.search.indexOf('start=act3') >= 0) return startAct3()
  if (location.search.indexOf('start=act2') >= 0) return startAct2()
  if (location.search.indexOf('start=act1') >= 0) return startAct1(auto)
  if (DEBUG_START_AT_ACT4) return startFinal()
  if (DEBUG_START_AT_ACT3) return startAct3()
  if (DEBUG_START_AT_ACT2) return startAct2()
  if (DEBUG_START_AT_ACT1) return startAct1(auto)
  if (DEMO) return startGame(auto)
  if (jumpT !== null) return startAct1(auto)
  startAct0(auto)
}

function returnToTitle() {
  // 和 startAct0 一样，但跳过 DEBUG_START_AT_* 的跳转（那些会把玩家又弹回第四幕）
  S.mode = 'act0'
  S.paused = false
  A0.modal = null
  A0.btns = []
  A0.bg = null
  A0.t = 0
  ACT0.t = 0
  ACT0.started = false
}

function startAct0() {
  loadA5Hands()   // 手部贴图在标题画面就预热：等到第五幕才下载的话，reach 动画只有 1.4 秒，慢网络下来不及显示
  // debug switch: skip Act 0 entirely (flip DEBUG_START_AT_ACT1 to false to restore)
  if (location.search.indexOf('start=act0') < 0 && DEBUG_START_AT_ACT4) { startFinal(); return }
  if (location.search.indexOf('start=act0') < 0 && DEBUG_START_AT_ACT3) { startAct3(); return }
  if (location.search.indexOf('start=act0') < 0 && DEBUG_START_AT_ACT2) { startAct2(); return }
  if (location.search.indexOf('start=act0') < 0 && DEBUG_START_AT_ACT1) { startAct1(true); return }
  S.mode = 'act0'
  A0.modal = null
  A0.btns = []
  A0.bg = null
  A0.t = 0
}

function applyJump() {
  startCurrent(true)
  const steps = Math.round(jumpT * 60)
  for (let i = 0; i < steps; i++) update(1 / 60)
  S.paused = true
}

if (jumpT !== null) {
  applyJump()
  // 调试可见性：截图时能从 DOM 里读到到底定在哪一帧
  const ph = DEMO ? S.phase : A1.phase
  document.title = `${CFG.title} · t=${jumpT} · ${S.mode}/${ph}`
} else if (!DEMO) {
  startAct0()   // 正式启动：先进第 0 幕开始界面
}

// 调试句柄：控制台里可以直接 __game.S.mode / __game.CFG.gravity 改参数
window.__game = {
  A0_SUB, A0_TIP, showTip, S, A1, ACT1, A0, ACT0, CFG, GL3D, WAKE, WAKE_T, WAKE_POSE, SFX, startWake, finishWake, skipWake, ROOM_COLLIDERS, hitsFurniture, SHELF_BOOK, DESK_SEAT, DESK, BOOKV, BOOKP, BOOKC, BOOKA, BOOKB, INK, INK3D, A0_SUB, A2, A3, A4, A5, A6, A5_IMGS, startAct5Game, startAct6, renderAct5, startFinal, a3CheckWin, a3SetPhase, a3StartGame, startAct3, A2_FIGHT, startFight, startRun, runPressSpace, runShoot, startAct2, startDeskScene, nearShelfBook, nearDeskSeat, startGame, spawnFaller, layout, startIntro,
  startAct0, startRoom, act0Click, skipCurrentAct,
  startAct1, startCurrent, demo: () => DEMO, mountainRect,
  audio: () => ({ src: bgm.src, index: trackIndex, paused: bgm.paused, muted, broken: audioBroken }),
  audioCheck, fontReport,
  fadeTo, clearStage,
  time: () => bgm.currentTime,     // 音频时钟：做音画同步用这个，别用 performance.now
  tick: (dt) => update(dt),         // 测试用：手动推进一帧（配合 S.paused 做确定性回放）
}

/* ============================ 调参面板 ============================ */
/* 按 ` 开关。只出现在开发时，正式演出不受影响。
   改完点「复制参数」，把弹出来的那几行发给我，我写回 CFG 当默认值。 */

const TUNE_SPEC = [
  { key: 'gravity', label: '重力', min: 400, max: 5200, step: 50 },
  { key: 'scatterSpeed', label: '爆散力度', min: 200, max: 2000, step: 25 },
  { key: 'scatterUpBias', label: '上飘', min: 0, max: 1, step: 0.05 },
  { key: 'damping', label: '速度衰减', min: 0.2, max: 4, step: 0.1 },
  { key: 'springK', label: '回位刚度', min: 4, max: 60, step: 1 },
  { key: 'springC', label: '回位阻尼', min: 1, max: 20, step: 0.5 },
  { key: 'smoothTime', label: '落定急刹', min: 0.1, max: 1.2, step: 0.02 },
  { key: 'impactHold', label: '定格帧', min: 0, max: 0.3, step: 0.01 },
  { key: 'musicVolume', label: '音量', min: 0, max: 1, step: 0.05 },
  // 下面几项要重排几何才生效
  { key: 'lineSize', label: '字号', min: 32, max: 140, step: 2, weak: true },
  { key: 'tracking', label: '字距', min: 0, max: 60, step: 2, weak: true },
  { key: 'ambientCount', label: '环境字数', min: 0, max: 30, step: 1, weak: true },
]

const DEFAULT_CFG = { ...CFG }
const tuneEl = document.getElementById('tune')

function buildTunePanel() {
  if (!tuneEl) return
  tuneEl.innerHTML = ''
  const h = document.createElement('h2')
  h.textContent = '调参面板　` 关闭'
  tuneEl.appendChild(h)

  for (const spec of TUNE_SPEC) {
    const row = document.createElement('div')
    row.className = 'row' + (spec.weak ? ' weak' : '')

    const label = document.createElement('label')
    const name = document.createElement('span')
    name.textContent = spec.label + (spec.weak ? '（重播生效）' : '')
    const val = document.createElement('b')
    val.textContent = CFG[spec.key]
    label.append(name, val)

    const input = document.createElement('input')
    input.type = 'range'
    input.min = spec.min
    input.max = spec.max
    input.step = spec.step
    input.value = CFG[spec.key]
    input.dataset.key = spec.key
    input.addEventListener('input', () => {
      CFG[spec.key] = Number(input.value)
      val.textContent = CFG[spec.key]
      if (spec.key === 'musicVolume') bgm.volume = CFG.musicVolume
    })

    row.append(label, input)
    tuneEl.appendChild(row)
  }

  const btns = document.createElement('div')
  btns.className = 'btns'

  const replay = document.createElement('button')
  replay.textContent = '重播开场'
  replay.onclick = () => startGame(false)

  const copy = document.createElement('button')
  copy.textContent = '复制参数'
  copy.onclick = () => copyChanged()

  const check = document.createElement('button')
  check.textContent = '检查音轨'
  check.onclick = () => showAudioCheck()

  const fontBtn = document.createElement('button')
  fontBtn.textContent = '字体检查'
  fontBtn.onclick = () => showFontCheck()

  btns.append(replay, copy, check, fontBtn)
  tuneEl.appendChild(btns)

  const fpsRow = document.createElement('div')
  fpsRow.className = 'tip'
  fpsRow.id = 'tuneFps'
  fpsRow.textContent = '— fps'
  tuneEl.appendChild(fpsRow)

  const out = document.createElement('div')
  out.className = 'tip'
  out.id = 'tuneOut'
  out.textContent = '改完点「复制参数」，把那几行发我。'
  tuneEl.appendChild(out)
}

/* 字形一致性：这游戏只用系统字体，换台电脑字形会变。
   这里把本机实际可用的中文字体列出来，方便判断差异来源。
   注意 document.fonts.check 对"系统字体是否存在"并不可靠（常常一律返回 true），
   所以用"实测宽度和 monospace 基准比"来判断。 */
const FONT_CANDIDATES = [
  'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Source Han Sans SC',
  'Hiragino Sans GB', 'Heiti SC', 'SimHei', 'SimSun',
]

function fontExists(family) {
  const probe = document.createElement('canvas').getContext('2d')
  const text = '中文字形测试ABC123'
  probe.font = '40px monospace'
  const base = probe.measureText(text).width
  probe.font = `40px "${family}", monospace`
  const w = probe.measureText(text).width
  return Math.abs(w - base) > 0.5
}

function fontReport() {
  return FONT_CANDIDATES.map((f) => ({ font: f, ok: fontExists(f) }))
}

function showFontCheck() {
  const out = document.getElementById('tuneOut')
  const list = fontReport()
  const first = list.find((x) => x.ok)
  const lines = list.map((x) => `${x.ok ? '✓' : '✗'} ${x.font}`)
  lines.push('')
  lines.push(first ? `最靠前的可用字体：${first.font}` : '没找到常见中文字体，会退到系统默认')
  lines.push('换电脑字形可能变——要完全一致得内嵌字体（跟我说）')
  if (out) out.textContent = lines.join('\n')
}

function changedConfig() {
  const lines = []
  for (const spec of TUNE_SPEC) {
    if (CFG[spec.key] !== DEFAULT_CFG[spec.key]) lines.push(`CFG.${spec.key} = ${CFG[spec.key]}`)
  }
  return lines
}

async function copyChanged() {
  const lines = changedConfig()
  const text = lines.length ? lines.join('\n') : '（没有改动）'
  const out = document.getElementById('tuneOut')
  try {
    await navigator.clipboard.writeText(text)
    if (out) out.textContent = '已复制到剪贴板：\n' + text
  } catch {
    // file:// 或权限被拒时退化成可选中的文本框
    const ta = document.createElement('textarea')
    ta.value = text
    tuneEl.appendChild(ta)
    ta.select()
    if (out) out.textContent = '剪贴板不可用，已选中文字，Ctrl+C 复制。'
  }
  console.log('[tune] 改动参数：\n' + text)
}

async function showAudioCheck() {
  const out = document.getElementById('tuneOut')
  if (out) out.textContent = '正在检查音轨…'
  const res = await audioCheck()
  const lines = res.map((r) => (r.ok ? `✓ ${r.src}  ${r.duration}s` : `✗ ${r.src}  读不到${r.timeout ? '（超时）' : ''}`))
  if (out) out.textContent = lines.join('\n')
}

// 逐首读取时长；文件缺失/损坏不会抛异常，只会标 ✗
async function audioCheck() {
  const out = []
  for (const src of CFG.musicTracks) {
    out.push(await new Promise((resolve) => {
      const a = new Audio()
      let settled = false
      const finish = (r) => { if (settled) return; settled = true; resolve(r) }
      a.addEventListener('loadedmetadata', () => finish({ src, ok: true, duration: +a.duration.toFixed(2) }))
      a.addEventListener('error', () => finish({ src, ok: false }))
      setTimeout(() => finish({ src, ok: false, timeout: true }), 4000)
      a.preload = 'metadata'
      a.src = src
    }))
  }
  return out
}

if (tuneEl) {
  buildTunePanel()
  // 面板里的点击不算游戏输入
  tuneEl.addEventListener('pointerdown', (e) => e.stopPropagation())
  tuneEl.addEventListener('keydown', (e) => e.stopPropagation())
}

addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    if (!tuneEl) return
    tuneEl.hidden = !tuneEl.hidden
    e.preventDefault()
  }
})

requestAnimationFrame(frame)









