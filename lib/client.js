/**
 * dsh-comfyui-use —— 浏览器侧。
 *  - conversation.input.right：输入框右下、紧挨着「模型选择器」的工作流选择器，
 *    外观与模型选择器一致（一行 trigger + 下拉菜单，带勾选）。
 *  - tool.call.toolview（key=comfyui_draw）：出图卡片，运行中是 ChatGPT 式绘图框动画，
 *    完成后原地换成图片。
 * 约束：不要 require Harness 客户端包；只用 React；所有 DOM 操作限定在自己的根节点里。
 */

window.__ModuleLoader__.load({
  id: 'dsh-comfyui-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    // 菜单挂到 body，避免被 composer 的 overflow / stacking context 裁掉。
    // 拿不到 react-dom 时退化成内联 fixed 定位（现代浏览器下同样可用）。
    let createPortal = null
    try {
      const dom = require('react-dom')
      if (dom && typeof dom.createPortal === 'function') createPortal = dom.createPortal
    } catch {
      createPortal = null
    }

    const STATUS_ROUTES = ['api/comfyui-use/status.json', 'comfyui-use/status.json']

    /* ------------------------------------------------------------ 工具函数 ---- */

    function textOf(block) {
      const content = block?.content
      if (!Array.isArray(content)) return ''
      return content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }

    function imagePathOf(block) {
      const direct = block?.meta?.path ?? block?.presentationMeta?.path
      if (typeof direct === 'string' && direct !== '') return direct
      const match = /已出图[：:]\s*([^\n（(]+)/u.exec(textOf(block))
      return match ? match[1].trim() : ''
    }

    function dimensionsOf(block) {
      const match = /(\d{2,5})\s*[x×]\s*(\d{2,5})/u.exec(textOf(block))
      return match ? { width: Number(match[1]), height: Number(match[2]) } : null
    }

    function promptOf(block) {
      const text = textOf(block)
      const labelled = /提示词[：:]\s*([^\n]+)/u.exec(text)
      if (labelled) return labelled[1].trim()
      const match = /(?:画|绘制|生成)[：:]?\s*([^\n]{4,120})/u.exec(text)
      return match ? match[1].trim() : ''
    }

    async function fetchStatus() {
      for (const route of STATUS_ROUTES) {
        try {
          const res = await fetch(route, { cache: 'no-store' })
          if (!res.ok) continue
          const data = await res.json()
          if (data && data.ok === true) return data
        } catch {
          /* 试下一条 */
        }
      }
      return null
    }

    async function selectWorkflow(id, variant) {
      for (const route of STATUS_ROUTES) {
        try {
          const res = await fetch(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(variant ? { workflow: id, variant } : { workflow: id }),
          })
          if (!res.ok) continue
          const data = await res.json()
          if (data && data.ok === true) return data
        } catch {
          /* 试下一条 */
        }
      }
      return null
    }

    const STAGE_TEXT = {
      starting: 'Preparing',
      queued: 'Queued',
      uploading: 'Preparing reference',
      sampling: 'Drawing',
      saving: 'Saving image',
      done: 'Done',
      error: 'Failed',
    }

    // 选择器文案一律只用拉丁字符（用户要求界面上不出现汉字）。
    const CATALOG = {
      'qwen-image-2.1': {
        short: 'Qwen 2.1',
        label: 'Qwen-Image 2.1',
        hint: '官方工作流，25 步（推荐）',
        variants: [
          { id: 't2i', short: 'Text', hint: '文生图' },
          { id: 'edit', short: 'Edit', hint: '按参考图改' },
        ],
      },
      'qwen-turbo-t2i': {
        short: 'Qwen Turbo',
        label: 'Qwen-Image-2.1 Turbo',
        hint: '通用文生图，8 步最快',
        variants: [
          { id: 'fast', short: 'Fast', hint: '直接 8 步出图' },
          { id: 'advanced', short: 'Advanced', hint: '先改写提示词再画' },
        ],
      },
      'qwen-turbo-edit': {
        short: 'Qwen Edit',
        label: 'Qwen-Image-2.1 Turbo Edit',
        hint: '按参考图改画',
      },
      'krea2-turbo': { short: 'Krea2', label: 'Krea2 Turbo', hint: '胶片感 / 插画' },
      moss: {
        short: 'MOSS',
        label: 'MOSS',
        hint: '中文文字 / 海报排版',
        variants: [
          { id: 'double', short: 'Double', hint: '双采，更细' },
          { id: 'single', short: 'Single', hint: '单采，更快' },
        ],
      },
      zimage: {
        short: 'Z-Image',
        label: 'Z-Image',
        hint: '写实摄影 / 二次精修',
        variants: [
          { id: 'refine', short: 'Refine', hint: '精修，更细' },
          { id: 'single', short: 'Single', hint: '单次，更快' },
        ],
      },
      seedvr2: { short: 'SeedVR2', label: 'SeedVR2', hint: '放大 / 修复清晰度' },
    }

    /** 运行卡片上显示“工作流 · 变体”的短名。 */
    function variantShortOf(workflowId, variantId) {
      const entry = CATALOG[workflowId]
      const hit = Array.isArray(entry?.variants)
        ? entry.variants.find((variant) => variant.id === variantId)
        : null
      return hit?.short ?? ''
    }

    function fallbackWorkflows() {
      return Object.keys(CATALOG).map((id) => ({ id, ...CATALOG[id] }))
    }

    const CHECK_SVG = 'M3.5 8.5l3 3 6-6.5'

    function checkIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: CHECK_SVG }))
    }

    function chevronIcon(open) {
      return h('svg', {
        className: 'cyc-picker__chev',
        'data-open': open ? '1' : '0',
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M3 4.5L6 7.5L9 4.5' }))
    }

    function chevronRight() {
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M4.5 3L7.5 6L4.5 9' }))
    }

    function chevronLeft() {
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M7.5 3L4.5 6L7.5 9' }))
    }

    function workflowIcon() {
      return h('svg', {
        className: 'cyc-picker__icon',
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('rect', { x: 1.6, y: 2.2, width: 4.4, height: 3.6, rx: 1 }),
      h('rect', { x: 10, y: 2.2, width: 4.4, height: 3.6, rx: 1 }),
      h('rect', { x: 5.8, y: 10.2, width: 4.4, height: 3.6, rx: 1 }),
      h('path', { d: 'M6 4h4M3.8 5.8v2.4h8.4V5.8M8 8.2v2' }))
    }

    /* --------------------------------------------------------------- 样式 ---- */

    const CSS = `
.cyc-picker{position:relative;display:inline-flex;flex:none;min-width:0}
.cyc-picker__trigger{display:inline-flex;align-items:center;gap:5px;height:28px;max-width:210px;
  padding:0 5px 0 7px;border:0;outline:none;background:transparent;border-radius:var(--dsw-radius-sm,6px);
  color:var(--dsw-alias-label-secondary,#9aa0a6);font-family:inherit;font-size:13px;font-weight:400;
  line-height:20px;cursor:pointer;transition:background .12s ease,color .12s ease}
.cyc-picker__trigger:hover,.cyc-picker__trigger[aria-expanded="true"]{
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.13));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.cyc-picker__trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d92ef))}
.cyc-picker__icon{flex:none;opacity:.85}
.cyc-picker__text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cyc-picker__chev{flex:none;color:var(--dsw-alias-label-secondary,#9aa0a6);transition:transform .12s ease}
.cyc-picker__chev[data-open="1"]{transform:rotate(180deg)}

.cyc-menu{position:fixed;z-index:1100;box-sizing:border-box;display:flex;flex-direction:column;
  padding:4px;border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));
  background:var(--dsw-specific-menu,#232427);color:var(--dsw-alias-label-primary,#e8eaed);
  box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.32));
  backdrop-filter:var(--dsw-menu-backdrop-filter,blur(24px) saturate(140%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(24px) saturate(140%));animation:cyc-pop .12s ease both}
.cyc-menu *{box-sizing:border-box}
.cyc-menu__head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:6px 8px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.cyc-menu__title{letter-spacing:.02em}
.cyc-menu__status{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-variant-numeric:tabular-nums}
.cyc-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#5c6067);flex:none}
.cyc-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary,#46c07a);box-shadow:0 0 0 3px rgba(70,192,122,.14)}
.cyc-dot[data-busy="1"]{background:var(--dsw-alias-state-warn-primary,#f0a83b);box-shadow:0 0 0 3px rgba(240,168,59,.16);
  animation:cyc-pulse 1.2s ease-in-out infinite}
.cyc-menu__list{display:flex;flex-direction:column;gap:1px;max-height:min(320px,50vh);overflow-y:auto;overflow-x:hidden;
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.cyc-option{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:5px 7px;
  border:0;background:transparent;border-radius:var(--dsw-radius-md,8px);color:inherit;font:inherit;
  font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.cyc-option:hover,.cyc-option:focus-visible{
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.13));outline:none}
.cyc-option:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(127,127,127,.24))}
.cyc-option:disabled{opacity:.55;cursor:default}
.cyc-option__name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cyc-option__hint{flex:none;max-width:184px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cyc-option__check{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
  color:var(--dsw-alias-state-business-primary,#4d92ef)}
.cyc-menu__foot{padding:6px 8px 2px;margin-top:4px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1));
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.cyc-flyout{position:fixed;z-index:1101;box-sizing:border-box;display:flex;flex-direction:column;padding:4px;
  backdrop-filter:var(--dsw-menu-backdrop-filter,blur(24px) saturate(140%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(24px) saturate(140%));
  color:var(--dsw-alias-label-primary,#e8eaed);
  border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,#1f2124);
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));
  box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.35));animation:cyc-pop .12s ease-out}
.cyc-flyout__head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 7px;
  margin-bottom:2px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1));
  font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.cyc-flyout__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cyc-menu__head--sub{justify-content:flex-start}
.cyc-menu__back{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-right:2px;
  border:0;background:transparent;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-secondary,#9aa0a6);
  cursor:pointer}
.cyc-menu__back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.13));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.cyc-menu__title--sub{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
.cyc-option__chev{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}

.cyc-card{width:100%;max-width:560px;margin:2px 0 4px;border-radius:16px;overflow:hidden;
  background:rgba(127,127,127,.055);border:1px solid rgba(127,127,127,.16);position:relative}
.cyc-stage{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;isolation:isolate;
  background:
    radial-gradient(120% 90% at 18% 10%, rgba(120,170,255,.16), transparent 62%),
    radial-gradient(110% 90% at 82% 88%, rgba(190,140,255,.14), transparent 60%),
    linear-gradient(150deg, rgba(127,127,127,.10), rgba(127,127,127,.04))}
.cyc-stage::before{content:"";position:absolute;inset:-45% -20%;z-index:0;
  background:conic-gradient(from 0deg,transparent 0 26%,rgba(130,170,255,.22) 38%,rgba(255,255,255,.30) 47%,
    rgba(190,140,255,.22) 56%,transparent 68% 100%);
  filter:blur(26px);animation:cyc-spin 5.6s linear infinite}
.cyc-stage::after{content:"";position:absolute;inset:0;z-index:1;opacity:.5;
  background-image:radial-gradient(rgba(127,127,127,.28) 1px,transparent 1px);
  background-size:22px 22px;mask-image:radial-gradient(70% 70% at 50% 50%,#000 30%,transparent 78%)}
.cyc-stage[data-state="done"]{background:rgba(127,127,127,.06)}
.cyc-stage[data-state="done"]::before,.cyc-stage[data-state="done"]::after{display:none}
.cyc-center{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:10px;text-align:center;padding:16px}
.cyc-waves{display:flex;align-items:flex-end;gap:5px;height:26px}
.cyc-waves i{display:block;width:4px;border-radius:99px;background:rgba(110,150,235,.75);
  animation:cyc-wave 1.25s ease-in-out infinite}
.cyc-waves i:nth-child(1){height:9px;animation-delay:0s}
.cyc-waves i:nth-child(2){height:17px;animation-delay:.12s}
.cyc-waves i:nth-child(3){height:24px;animation-delay:.24s}
.cyc-waves i:nth-child(4){height:15px;animation-delay:.36s}
.cyc-waves i:nth-child(5){height:8px;animation-delay:.48s}
.cyc-title{font-size:14px;font-weight:560;letter-spacing:.02em;opacity:.9}
.cyc-sub{font-size:11.5px;opacity:.55;line-height:1.5;max-width:88%}
.cyc-elapsed{font-variant-numeric:tabular-nums}
.cyc-bar{position:absolute;left:0;right:0;bottom:0;height:3px;z-index:3;background:rgba(127,127,127,.12)}
.cyc-bar i{display:block;height:100%;width:34%;border-radius:99px;
  background:linear-gradient(90deg,transparent,rgba(110,150,235,.95),rgba(190,140,255,.95),transparent);
  animation:cyc-slide 1.8s ease-in-out infinite}
.cyc-image{display:block;width:auto;max-width:100%;height:auto;max-height:562px;margin:0 auto;object-fit:contain;
  background:rgba(0,0,0,.04);animation:cyc-fade .5s ease both}
.cyc-foot{display:flex;align-items:center;gap:8px;padding:9px 12px;flex-wrap:wrap;
  border-top:1px solid rgba(127,127,127,.12);background:rgba(127,127,127,.035)}
.cyc-tag{font-size:11px;line-height:1;padding:4px 8px;border-radius:6px;
  background:rgba(94,160,255,.12);color:inherit;opacity:.8;white-space:nowrap}
.cyc-meta{font-size:11px;opacity:.5;font-variant-numeric:tabular-nums;white-space:nowrap}
.cyc-prompt{flex:1 1 160px;min-width:0;font-size:11.5px;opacity:.62;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cyc-error{display:flex;align-items:center;gap:8px;padding:14px;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#d06060)}
.cyc-error__icon{flex:none;width:18px;height:18px;border-radius:50%;background:rgba(208,96,96,.14);
  display:inline-flex;align-items:center;justify-content:center;font-size:12px}

.cyc-dock{position:relative;align-self:center;width:100%;max-width:440px;
  margin:0 0 6px;border-radius:14px;overflow:hidden;
  color:var(--dsw-alias-label-primary,#e8eaed);background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));
  box-shadow:0 6px 20px rgba(0,0,0,.10);animation:cyc-fade .3s ease both}
.cyc-dock .cyc-stage{aspect-ratio:auto;height:128px}
@keyframes cyc-spin{to{transform:rotate(1turn)}}
@keyframes cyc-slide{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}
@keyframes cyc-wave{0%,100%{transform:scaleY(.5);opacity:.5}50%{transform:scaleY(1);opacity:1}}
@keyframes cyc-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes cyc-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes cyc-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){
  .cyc-stage::before,.cyc-waves i,.cyc-bar i,.cyc-dot[data-busy="1"]{animation:none}
  .cyc-menu,.cyc-flyout,.cyc-dock{animation:none}
}
`

    /* --------------------------------------------------------- 工作流选择器 ---- */

    function WorkflowPicker() {
      const [state, setState] = useState({
        selected: 'auto',
        selectedVariant: null,
        workflows: fallbackWorkflows(),
        online: false,
        busy: false,
      })
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState(null)
      const [subPos, setSubPos] = useState(null)
      const [pending, setPending] = useState('')
      const [pos, setPos] = useState(null)
      const alive = useRef(true)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)
      const flyoutRef = useRef(null)
      const hoverTimer = useRef(0)
      const closeTimer = useRef(0)

      const clearHover = () => {
        if (hoverTimer.current !== 0) {
          window.clearTimeout(hoverTimer.current)
          hoverTimer.current = 0
        }
      }

      const clearClose = () => {
        if (closeTimer.current !== 0) {
          window.clearTimeout(closeTimer.current)
          closeTimer.current = 0
        }
      }

      // 在父菜单旁边弹出独立面板，父菜单本身不换内容。
      const openSub = (id, row) => {
        clearHover()
        clearClose()
        if (state.workflows.find((item) => item.id === id)?.available === false) return
        if (row === null || typeof window === 'undefined') {
          setPane(id)
          setSubPos(null)
          return
        }
        const variants = CATALOG[id]?.variants
        const count = Array.isArray(variants) ? variants.length : 2
        const width = 252
        const height = 44 + count * 36
        const rect = row.getBoundingClientRect()
        const baseLeft = pos === null ? rect.left : pos.left
        const baseWidth = pos === null ? 340 : pos.width
        const rightLeft = baseLeft + baseWidth + 6
        const left = rightLeft + width <= window.innerWidth - 8 ? rightLeft : Math.max(8, baseLeft - width - 6)
        const top = Math.min(Math.max(8, rect.top - 6), Math.max(8, window.innerHeight - height - 8))
        setSubPos({ left, top, width })
        setPane(id)
      }

      const scheduleCloseSub = () => {
        clearClose()
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = 0
          setPane(null)
          setSubPos(null)
        }, 180)
      }

      const cancelCloseSub = () => clearClose()

      const hoverOpen = (id, row) => {
        clearHover()
        clearClose()
        hoverTimer.current = window.setTimeout(() => {
          hoverTimer.current = 0
          openSub(id, row)
        }, 140)
      }

      useEffect(() => {
        alive.current = true
        let timer = 0
        const load = async () => {
          const data = await fetchStatus()
          if (!alive.current) return
          if (data) {
            setState((previous) => ({
              ...previous,
              selected: typeof data.selected === 'string' ? data.selected : previous.selected,
              selectedVariant: typeof data.selectedVariant === 'string' ? data.selectedVariant : null,
              workflows: Array.isArray(data.workflows) && data.workflows.length > 0 ? data.workflows : previous.workflows,
              online: data.online === true,
              busy: data.busy === true,
            }))
          }
          timer = window.setTimeout(load, 6000)
        }
        load()
        return () => {
          alive.current = false
          window.clearTimeout(timer)
        }
      }, [])

      const place = () => {
        const trigger = triggerRef.current
        if (trigger === null || typeof window === 'undefined') return
        const rect = trigger.getBoundingClientRect()
        const width = Math.min(400, Math.max(340, window.innerWidth - 16))
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
        const bottom = Math.max(8, window.innerHeight - rect.top + 8)
        setPos({ left, bottom, width })
      }

      const closeMenu = () => {
        clearHover()
        clearClose()
        setOpen(false)
        setPane(null)
        setSubPos(null)
      }

      const toggle = () => {
        if (open) {
          closeMenu()
          return
        }
        place()
        setPane(null)
        setSubPos(null)
        setOpen(true)
      }

      useEffect(() => () => {
        clearHover()
        clearClose()
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (rootRef.current !== null && rootRef.current.contains(target)) return
          if (menuRef.current !== null && menuRef.current.contains(target)) return
          if (flyoutRef.current !== null && flyoutRef.current.contains(target)) return
          closeMenu()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            closeMenu()
            if (triggerRef.current !== null) triggerRef.current.focus()
          }
        }
        const onScroll = () => closeMenu()
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onScroll)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onScroll)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [open])

      useEffect(() => {
        if (!open || menuRef.current === null) return
        const buttons = Array.from(menuRef.current.querySelectorAll('.cyc-option'))
        const active = menuRef.current.querySelector('.cyc-option[data-on="1"]')
        const target = active ?? buttons[0]
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true })
      }, [open, pane])

      const onMenuKeyDown = (event) => {
        if (event.key === 'ArrowRight') {
          const active = document.activeElement
          const id = active !== null ? active.getAttribute('data-id') : null
          const target = id !== null ? families.find((item) => item.id === id) : null
          if (target !== null && target.variants.length > 1) {
            event.preventDefault()
            openSub(target.id, active)
          }
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'Backspace') {
          if (pane !== null) {
            event.preventDefault()
            setPane(null)
            setSubPos(null)
          }
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const menu = (pane !== null ? flyoutRef.current : null) ?? menuRef.current
        if (menu === null) return
        const buttons = Array.from(menu.querySelectorAll('.cyc-option:not([disabled])'))
        if (buttons.length === 0) return
        event.preventDefault()
        const index = buttons.indexOf(document.activeElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length
        buttons[next].focus()
      }

      const choose = async (id, variant) => {
        closeMenu()
        const sameFamily = id === state.selected
        const sameVariant = (variant ?? null) === (state.selectedVariant ?? null)
        if (sameFamily && sameVariant) return
        if (pending !== '') return
        setPending(id)
        setState((previous) => ({ ...previous, selected: id, selectedVariant: variant ?? null }))
        await selectWorkflow(id, variant)
        setPending('')
        if (triggerRef.current !== null) triggerRef.current.focus()
      }

      const families = useMemo(() => {
        const list = [{ id: 'auto', short: 'Auto', label: 'Auto', hint: '按需求自动选择', variants: [] }]
        for (const item of state.workflows) {
          const known = CATALOG[item.id] ?? {}
          const variants = (Array.isArray(item.variants) ? item.variants : []).map((variant) => {
            const hit = Array.isArray(known.variants)
              ? known.variants.find((entry) => entry.id === variant.id)
              : null
            return {
              id: variant.id,
              short: hit?.short ?? variant.label ?? variant.id,
              hint: hit?.hint ?? variant.hint ?? '',
            }
          })
          const missing = item.available === false
          list.push({
            id: item.id,
            short: known.short ?? item.short ?? item.id,
            label: known.label ?? item.label ?? item.short ?? item.id,
            hint: known.hint ?? item.hint ?? '',
            unavailable: missing,
            variants,
          })
        }
        return list
      }, [state.workflows])

      const current = families.find((item) => item.id === state.selected) ?? families[0]
      const currentVariant = current.variants.find((v) => v.id === state.selectedVariant) ?? null
      const statusText = state.busy ? 'Drawing' : state.online ? 'Ready' : 'Idle'
      const triggerText = current.id === 'auto'
        ? 'Auto'
        : currentVariant === null
          ? current.short
          : `${current.short} · ${currentVariant.short}`

      const subFamily = pane === null ? null : (families.find((item) => item.id === pane) ?? null)

      const statusSeat = h('span', {
        className: 'cyc-menu__status',
        title: state.online ? 'ComfyUI online' : 'ComfyUI idle — starts on demand',
      },
      h('span', { className: 'cyc-dot', 'data-on': state.online ? '1' : '0', 'data-busy': state.busy ? '1' : '0' }),
      statusText)

      const head = h('div', { className: 'cyc-menu__head' },
        h('span', { className: 'cyc-menu__title' }, 'Workflow'),
        statusSeat)

      const list = h('div', { className: 'cyc-menu__list' },
        families.map((item) => {
          const isOn = state.selected === item.id
          const hasSub = item.variants.length > 1
          const variantName = isOn && currentVariant !== null ? currentVariant.short : ''
          return h('button', {
            key: item.id,
            type: 'button',
            role: hasSub ? 'menuitem' : 'menuitemradio',
            'aria-checked': hasSub ? undefined : isOn,
            'aria-haspopup': hasSub ? 'menu' : undefined,
            'aria-expanded': hasSub ? pane === item.id : undefined,
            className: 'cyc-option',
            'data-on': isOn ? '1' : '0',
            'data-sub': hasSub ? '1' : '0',
            'data-id': item.id,
            title: item.unavailable
              ? `${item.label} — 缺模型，先跑 comfyui_check`
              : (item.hint === '' ? item.label : `${item.label} — ${item.hint}`),
            disabled: item.unavailable || (pending !== '' && pending !== item.id),
            onMouseEnter: (event) => {
              if (pending !== '') return
              if (hasSub) hoverOpen(item.id, event.currentTarget)
              else scheduleCloseSub()
            },
            onMouseLeave: () => {
              clearHover()
              if (hasSub) scheduleCloseSub()
            },
            onClick: () => {
              if (item.id === 'auto') {
                choose('auto', null)
                return
              }
              if (hasSub) {
                openSub(item.id, event.currentTarget)
                return
              }
              choose(item.id, item.variants[0]?.id ?? null)
            },
          },
          h('span', { className: 'cyc-option__name' }, item.label),
          item.unavailable
            ? h('span', { className: 'cyc-option__hint' }, '缺模型')
            : variantName !== ''
              ? h('span', { className: 'cyc-option__hint' }, variantName)
              : item.hint ? h('span', { className: 'cyc-option__hint' }, item.hint) : null,
          hasSub
            ? h('span', { className: 'cyc-option__chev' }, chevronRight())
            : h('span', { className: 'cyc-option__check' }, isOn ? checkIcon() : null))
        }))

      const flyout = open && subFamily !== null && subPos !== null
        ? h('div', {
          ref: flyoutRef,
          className: 'cyc-flyout',
          role: 'menu',
          'aria-label': `Choose how ${subFamily.label} runs`,
          style: { left: `${subPos.left}px`, top: `${subPos.top}px`, width: `${subPos.width}px` },
          onMouseEnter: cancelCloseSub,
          onMouseLeave: scheduleCloseSub,
          onKeyDown: onMenuKeyDown,
        },
        h('div', { className: 'cyc-flyout__head' },
          h('span', { className: 'cyc-flyout__title' }, subFamily.label),
          statusSeat),
        h('div', { className: 'cyc-menu__list' },
          subFamily.variants.map((variant) => {
            const isOn = state.selected === subFamily.id && state.selectedVariant === variant.id
            return h('button', {
              key: variant.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': isOn,
              className: 'cyc-option',
              'data-on': isOn ? '1' : '0',
              title: `${variant.short} — ${variant.hint}`,
              disabled: pending !== '',
              onClick: () => { choose(subFamily.id, variant.id) },
            },
            h('span', { className: 'cyc-option__name' }, variant.short),
            variant.hint ? h('span', { className: 'cyc-option__hint' }, variant.hint) : null,
            h('span', { className: 'cyc-option__check' }, isOn ? checkIcon() : null))
          })))
        : null

      const menu = open && pos !== null
        ? h('div', {
          ref: menuRef,
          className: 'cyc-menu',
          role: 'menu',
          'aria-label': 'Choose the image workflow',
          style: { left: `${pos.left}px`, bottom: `${pos.bottom}px`, width: `${pos.width}px` },
          onKeyDown: onMenuKeyDown,
        },
        head,
        list,
        h('div', { className: 'cyc-menu__foot' }, 'Applies to this chat — or just say “draw it with MOSS”.'))
        : null

      const layers = menu === null ? null : h(React.Fragment, null, menu, flyout)

      const portal = layers !== null && createPortal !== null && typeof document !== 'undefined'
        ? createPortal(layers, document.body)
        : layers

      return h('span', { ref: rootRef, className: 'cyc-picker' },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'cyc-picker__trigger',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: `Workflow: ${current.label}${currentVariant === null ? '' : ` / ${currentVariant.short}`} · ${statusText}`,
          onClick: toggle,
        },
        workflowIcon(),
        h('span', { className: 'cyc-picker__text' }, triggerText),
        chevronIcon(open)),
        portal)
    }

    /* ------------------------------------------------------------- 出图卡片 ---- */

    // 占位框按这次要出的图的比例来：横图铺满卡片宽，竖图限高。
    function frameBox(frame) {
      const w = Number(frame?.w)
      const h = Number(frame?.h)
      const ratio = w > 0 && h > 0 ? w / h : 16 / 9
      const viewH = (typeof window !== 'undefined' && Number(window.innerHeight)) || 900
      const maxW = 560
      const maxH = Math.min(560, Math.round(viewH * 0.62))
      let width = maxW
      let height = Math.round(maxW / ratio)
      if (height > maxH) {
        height = maxH
        width = Math.round(maxH * ratio)
      }
      return { width, height }
    }

    function DrawCard(props) {
      const block = props?.block
      const phase = props?.phase
      const done = phase === 'result'
      const failed = block?.isError === true || (done && imagePathOf(block) === '')
      const path = done && !failed ? imagePathOf(block) : ''
      const dims = dimensionsOf(block)
      const prompt = promptOf(block)
      const [status, setStatus] = useState(null)
      const [elapsed, setElapsed] = useState(0)

      useEffect(() => {
        if (done || failed) return undefined
        let alive = true
        const tick = async () => {
          const data = await fetchStatus()
          if (alive && data) setStatus(data)
        }
        tick()
        const poll = window.setInterval(tick, 2000)
        const clock = window.setInterval(() => {
          setElapsed((value) => value + 1)
        }, 1000)
        return () => {
          alive = false
          window.clearInterval(poll)
          window.clearInterval(clock)
        }
      }, [done, failed])

      if (failed) {
        return h('div', { className: 'cyc-card' },
          h('div', { className: 'cyc-error' },
            h('span', { className: 'cyc-error__icon' }, '!'),
            h('span', null, textOf(block).slice(0, 240) || 'Generation failed — try again.')))
      }

      if (path !== '') {
        return h('div', { className: 'cyc-card' },
          h('img', {
            className: 'cyc-image',
            src: `api/file?path=${encodeURIComponent(path)}`,
            alt: prompt || 'generated image',
            loading: 'lazy',
          }),
          h('div', { className: 'cyc-foot' },
            h('span', { className: 'cyc-tag' },
              [CATALOG[status?.last?.workflow]?.short ?? 'ComfyUI',
                variantShortOf(status?.last?.workflow, status?.last?.variant)].filter(Boolean).join(' · ')),
            h('span', { className: 'cyc-meta' },
              [dims ? `${dims.width}×${dims.height}` : '',
                dims || prompt ? '' : 'Generated'].filter(Boolean).join(' · ')),
            h('span', { className: 'cyc-prompt', title: prompt }, prompt)),
        )
      }

      const job = status?.job
      const stage = job?.stage ?? 'starting'
      const label = [CATALOG[job?.workflow]?.short ?? '', variantShortOf(job?.workflow, job?.variant)]
        .filter(Boolean).join(' · ')
      const seconds = job?.startedAt ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) : elapsed
      const box = frameBox(job?.frame)
      return h('div', { className: 'cyc-card' },
        h('div', {
          className: 'cyc-stage',
          'data-state': 'working',
          style: { width: `${box.width}px`, height: `${box.height}px`, margin: '0 auto' },
        },
          h('div', { className: 'cyc-center' },
            h('div', { className: 'cyc-waves' }, h('i'), h('i'), h('i'), h('i'), h('i')),
            h('div', { className: 'cyc-title' }, STAGE_TEXT[stage] ?? 'Drawing'),
            h('div', { className: 'cyc-sub' },
              [label, seconds > 0 ? `${seconds}s` : ''].filter(Boolean).join(' · ')
              || 'Starting local ComfyUI…')),
          h('div', { className: 'cyc-bar' }, h('i'))),
      )
    }

    /* ------------------------------------------------------ 正在画的进度条 ---- */

    function dockLabel(job) {
      return [CATALOG[job?.workflow]?.short ?? '', variantShortOf(job?.workflow, job?.variant)]
        .filter(Boolean).join(' · ')
    }

    // 只在真正画的时候出现，画完就消失；结果图走聊天正文的 Markdown，不另开面板占位置。
    function DrawingDock() {
      const [status, setStatus] = useState(null)
      const [now, setNow] = useState(() => Date.now())

      useEffect(() => {
        let alive = true
        const tick = async () => {
          const data = await fetchStatus()
          if (alive && data) setStatus(data)
        }
        tick()
        const poll = window.setInterval(tick, 1500)
        const clock = window.setInterval(() => setNow(Date.now()), 1000)
        return () => {
          alive = false
          window.clearInterval(poll)
          window.clearInterval(clock)
        }
      }, [])

      if (status === null) return null
      const job = status.job
      // 宿主出图结束后仍保留 job（stage=done/error），只有真正在跑的阶段才显示这条。
      const stage = job?.stage ?? ''
      if (stage === '' || stage === 'done' || stage === 'error') return null

      const label = dockLabel(job)
      const seconds = job.startedAt ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0
      return h('div', { className: 'cyc-dock', 'data-busy': '1', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'cyc-stage', 'data-state': 'working' },
          h('div', { className: 'cyc-center' },
            h('div', { className: 'cyc-waves' }, h('i'), h('i'), h('i'), h('i'), h('i')),
            h('div', { className: 'cyc-title' }, STAGE_TEXT[stage] ?? 'Drawing'),
            h('div', { className: 'cyc-sub' },
              [label, seconds > 0 ? `${seconds}s` : ''].filter(Boolean).join(' · ')
              || 'Starting local ComfyUI…')),
          h('div', { className: 'cyc-bar' }, h('i'))))
    }

    /* ---------------------------------------------------------------- 入口 ---- */

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式注一次；热更新时旧 <style> 还在，必须覆盖内容，否则新组件会用旧样式裸奔
        try {
          if (typeof document !== 'undefined') {
            let style = document.getElementById('dsh-comfyui-use-css')
            if (style === null) {
              style = document.createElement('style')
              style.id = 'dsh-comfyui-use-css'
              document.head.appendChild(style)
            }
            if (style.textContent !== CSS) style.textContent = CSS
          }
        } catch {
          /* 样式失败也要把功能放上去 */
        }

        // 输入框那一行，紧挨着模型选择器
        try {
          ctx.slots.inject('conversation.input.right', () => {
            try {
              return ctx.slots.register({
                name: 'conversation.input.right',
                id: 'comfyui-use-workflows',
                order: 20,
              }, WorkflowPicker)
            } catch {
              return undefined
            }
          })
        } catch {
          /* 没有这个槽就算了，工具本身还能用 */
        }

        // 输入框上方：绘图过程/最新结果常显，不随工具调用折叠
        try {
          ctx.slots.inject('conversation.input.dock', () => {
            try {
              return ctx.slots.register({
                name: 'conversation.input.dock',
                id: 'comfyui-use-drawing',
                order: 40,
              }, DrawingDock)
            } catch {
              return undefined
            }
          })
        } catch {
          /* 没有这个槽就只靠工具卡片 */
        }

        try {
          ctx.slots.inject('tool.call.toolview', () => {
            try {
              return ctx.slots.register({ name: 'tool.call.toolview', key: 'comfyui_draw' }, DrawCard)
            } catch {
              return undefined
            }
          })
        } catch {
          /* 卡片降级：工具结果仍是文本 + deliverables */
        }
      },
    }
  },
})