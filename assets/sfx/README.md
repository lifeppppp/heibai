# 音效（当前状态：**已关闭**）

## 现在的状态

`game.js` 里 `SFX.enabled = false` —— **游戏完全不发声**（背景音乐 `audio/bgm.mp3` 不受影响，照常播放）。

关闭的只是苏醒序列的音效（眨眼 / 呼吸 / 布料 / 床板）。代码、文件、接口都还在。

## 以后要加音频，怎么用

### 1. 放文件

把音频丢进 `assets/sfx/`，例如 `assets/sfx/door.mp3`。

**建议**：单声道、44.1kHz、64kbps 的 mp3，几秒钟的素材压到 20KB 以内最合适。

### 2. 登记（一行）

`game.js` 里找到 `SFX.files`：

```js
files: {
  blink:  "assets/sfx/rustle.mp3",
  breath: "assets/sfx/breath.mp3",
  cloth:  "assets/sfx/rustle.mp3",
  creak:  "assets/sfx/creak.mp3",
  door:   "assets/sfx/door.mp3",     // ← 加这一行
},
```

顺便在 `SFX.vol` 里给个音量（0~1）：

```js
vol: { blink: 0.20, breath: 0.60, cloth: 0.55, creak: 0.45, door: 0.6 },
```

### 3. 打开总开关

```js
enabled: false,   →   enabled: true,
```

### 4. 在代码里调用

```js
SFX.play('door')
```

随时可以在浏览器控制台里试：

```js
__game.SFX.enabled = true
__game.SFX.initFiles()
__game.SFX.play('breath')
```

## 三个现成音效（CC0）

| 用途 | 文件 | 原始素材 | 授权 | 来源 |
|---|---|---|---|---|
| 呼吸 | `breath.mp3` | breathing tired.ogg | CC0 | https://opengameart.org/content/breathing-tired |
| 布料 / 眨眼 | `rustle.mp3` | rustling.ogg | CC0 | https://opengameart.org/content/fabric-rustling |
| 床板吱呀 | `creak.mp3` | tree_creak.ogg | CC0 | https://opengameart.org/content/tree-creaking |

## 兜底

如果文件缺失或解码失败，会自动退回**现场合成**的音效（`SFX.noise()` / `SFX.tone()`），
所以就算漏传文件也不会“完全没声”——但现在总开关是关的，两者都不会响。

## 发布

这些 mp3 是普通文件，跟着文件夹一起上传即可，链接访问时按相对路径 `assets/sfx/xxx.mp3` 加载。

单文件版（`dist/heibai.html`）会在打包时把这三个 mp3 内联成 data URI；
**以后新增的音频需要重新打包**，或者直接用文件夹版发布。