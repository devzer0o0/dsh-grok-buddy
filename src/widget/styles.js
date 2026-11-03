/**
 * 注入到页面的样式表。
 *
 * 这一份只做三件事：把 DSH 前导位里的原生状态点藏掉、把头像摆进去、
 * 并给调色板与菜单项一点自己的外观。单独成模块是为了能被单测直接断言。
 *
 * 布局踩过的坑（值得钉死）：
 * DSH 的会话前导位（.slot）是**定宽 16px** 的格子，原生状态点/转圈画在里面。
 * DSH 还会往同一格里塞自己的标记 —— 定时任务的时钟（[data-session-schedule-mark]，
 * 也是 16px）。原生实现只在该行 idle 时才画时钟，所以两者从不同框；我们顶掉状态点后，
 * 头像和时钟会同时出现，两个 16px 挤进一个 16px 盒子 → 溢出 → 时钟压到标题上。
 *
 * 所以格子改成**按内容撑开**：只剩头像时仍是 16px（与原布局逐像素对齐），
 * 多出标记时并排摆放、留 2px 缝，标题顺延让位。
 *
 * @module dsh-grok-buddy/styles
 */

/** 头像与前导位里其它标记之间的缝（px）。 */
export const CELL_GAP = 2

/**
 * 项目菜单项 + 调色板的样式。
 * @returns {string} CSS 文本。
 */
export function paletteStyles() {
  return [
    // 项目行的颜色圆点已移除：文件夹前面只留 DSH 自己的图标。
    // 这条只清理老版本留下的痕迹，不显示、不占位。
    '.dsgb-chip{display:none!important}',
    '.dsgb-menu-item{display:flex;width:100%}',
    '.dsgb-menu-button{' +
      'display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:none;' +
      'background:transparent;color:inherit;font:inherit;text-align:left;border-radius:6px;cursor:pointer}',
    '.dsgb-menu-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
    '.dsgb-menu-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;opacity:.85}',
    '.dsgb-menu-label{flex:1;min-width:0}',
    '.dsgb-palette{' +
      'position:fixed;z-index:2147483000;width:236px;padding:10px;border-radius:10px;' +
      'background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#1f2328);' +
      'box-shadow:0 8px 28px rgba(0,0,0,.22),0 0 0 1px rgba(127,127,127,.22);' +
      'font:13px/18px "PingFang SC",system-ui,sans-serif;box-sizing:border-box}',
    '.dsgb-palette-head{font-size:12px;opacity:.6;margin:0 0 8px 2px}',
    '.dsgb-palette-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:5px}',
    '.dsgb-swatch{' +
      'width:100%;aspect-ratio:1;border-radius:6px;border:none;padding:0;cursor:pointer;' +
      'box-shadow:inset 0 0 0 1px rgba(0,0,0,.14);transition:transform .12s ease}',
    '.dsgb-swatch:hover{transform:scale(1.12)}',
    '.dsgb-swatch.is-on{box-shadow:inset 0 0 0 2px #fff,0 0 0 2px currentColor}',
    '.dsgb-palette-custom{display:flex;gap:6px;margin-top:10px}',
    '.dsgb-hex{' +
      'flex:1;min-width:0;height:26px;padding:0 8px;border-radius:6px;box-sizing:border-box;' +
      'border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit}',
    '.dsgb-hex.is-bad{border-color:#ff263c}',
    '.dsgb-palette-apply{' +
      'height:26px;padding:0 10px;border-radius:6px;border:none;cursor:pointer;' +
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:inherit;font:inherit}',
    '.dsgb-palette-reset{' +
      'display:block;width:100%;margin-top:8px;height:26px;border-radius:6px;cursor:pointer;' +
      'border:none;background:transparent;color:inherit;opacity:.65;font:inherit;text-align:left;padding:0 2px}',
    '.dsgb-palette-reset:hover{opacity:1}',
    '.dsgb-palette-feedback{min-height:16px;margin-top:6px;font-size:12px;color:#ff263c}',
    '.dsgb-color-error{' +
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483001;' +
      'padding:8px 14px;border-radius:8px;background:rgba(20,22,26,.92);color:#fff;' +
      'font:13px/18px "PingFang SC",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.28)}',
  ].join('\n')
}

/**
 * 拼出前导位与头像的样式。
 *
 * @param {string} botClass 头像的类名。
 * @param {string} slotAttr 标记过前导位的属性名（不带括号）。
 * @param {number} size 头像边长（px），应与 DSH 原生格子同宽。
 * @param {{reduce?: boolean}} [options] reduced-motion 等选项。
 * @returns {string} CSS 文本。
 */
export function slotStyles(botClass, slotAttr, size, options) {
  const opts = options !== undefined && options !== null ? options : {}
  // 属性选择器写两遍：模块类给的 width:16px 与它同特异度，靠顺序不保险。
  const cell = '[' + slotAttr + '][' + slotAttr + ']'
  const bot = cell + ' > .' + botClass
  const rules = [
    cell +
      '{position:relative;display:inline-flex;align-items:center;justify-content:flex-start;' +
      'gap:' + CELL_GAP + 'px;width:auto;min-width:' + size + 'px;flex:none}',
    cell + ' > [data-state]{display:none!important}',
    cell + ' > [class*="visuallyHidden"]{display:none!important}',
    // order:-1 兜底：前导位里万一还有别的标记，头像也永远是最左那个。
    // 轨道/拖尾要能画到头像本体之外，但又不能溢出 16px 格子去压标题：
    // 画布本身就是 1.5× 身体直径，轨迹已经收在里面，所以这里只要不裁切即可。
    bot + '{order:-1;display:block;width:' + size + 'px;height:' + size + 'px;flex:none;overflow:visible}',
  ]
  if (opts.reduce === true) {
    // 减少动效：不缩放、不淡入，只留可区分的静态姿态（姿态由引擎按状态选表情）
    rules.push(bot + '{transition:none!important;animation:none!important}')
  }
  return rules.join('\n')
}
