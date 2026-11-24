/**
 * dsh-comfyui-use —— 让 DeepSeek Harness 在对话里调用主人本机 ComfyUI 的
 * **已有工作流**出图。
 * ============================================================================
 * 与 dsh-qwen-paint 的区别（别混）：
 *   · qwen-paint 用内置的一份千问工作流，按模型参数现场拼图；
 *   · 本插件用主人自己在 ComfyUI 前端保存的 6 个工作流（UI 图格式），
 *     启动时**预先把它们转成 API 格式**存在 api-workflows/ 下
 *     （转换用真实前端 GraphToPrompt，子图/bypass/静音节点都已正确处理），
 *     运行时只做参数补丁，不手搓节点。
 *
 * 设计要点：
 *   ① 零外部依赖：只用 node 内置模块；tool 定义直接用标准 JSON Schema
 *      （tools.register 只校验 output.schema）。
 *   ② ComfyUI 后台隐藏启动、空闲自动关停（只杀"监听本插件端口且命令行像 ComfyUI"的进程）。
 *   ③ 工作流选择：工具参数 > 界面上选中的 > 按需求自动挑。
 *   ④ 出图后在正文内联展示（systemPrompt 段落 + 客户端自绘卡片两条路都留）。
 * ============================================================================
 */

import { promises as fsp, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import dns from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { isApiWorkflow, isUiWorkflow, uiToApi, inferParams, setNodeInput, modelRefs } from './convert.js'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_DIR = path.join(HERE, '..', 'api-workflows')
const SKILL_FILE = path.join(HERE, '..', 'skills', 'comfyui-workflow-prompts', 'SKILL.md')

export const name = 'comfyui-use'
/** 版本号会出现在状态端点里，方便确认宿主加载的是哪份代码。 */
export const version = '0.2.1'

/* --------------------------------------------------------------- 默认配置 ---- */

/** 默认端口；被别的程序占用时会自动往后试。 */
const DEFAULT_PORT = 18189
const PORT_TRIES = 10

/** 展开 ~、%USERPROFILE% 这类写法，让配置能跨机器复制。 */
function expandPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let text = value.trim()
  if (text === '~' || /^[~][\\/]/u.test(text)) text = path.join(os.homedir(), text.slice(1))
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/gu, (match, name) => process.env[name] ?? match)
  text = text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, (match, name) => process.env[name] ?? match)
  return text
}

function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

const DEFAULTS = {
  /** 留空 = 按 port 自动拼 http://127.0.0.1:<port>；也可以给完整地址连别处的 ComfyUI。 */
  comfyUrl: '',
  port: DEFAULT_PORT,
  /** ComfyUI 目录（里面要有 main.py）。留空就按常见路径和环境变量自动探测。 */
  comfyRoot: '',
  comfyPython: '',
  comfyMainPy: '',
  comfyWorkdir: '',
  comfyArgs: [],
  /** ComfyUI Desktop 的模型路径 yaml；留空 = 不传。 */
  modelPathsYaml: '',
  /** 让 ComfyUI 用统一的 input/output 目录（可选）；留空 = 用 ComfyUI 自己的。 */
  inputDir: '',
  sharedOutputDir: '',
  /** 成品落盘目录（与 ComfyUI 自己的 output 分开，方便找）。 */
  outputDir: path.join(os.homedir(), 'Pictures', 'dsh-comfyui'),
  /** 出图后多久没活动就关掉 ComfyUI（毫秒）；0 = 永不关。默认 1 分钟。 */
  idleShutdownMs: 60000,
  /** 启动 ComfyUI 后等它就绪的上限。 */
  startTimeoutMs: 240000,
  /** 单次出图上限。moss/zimage 带 LLM 改写，留足。 */
  timeoutMs: 900000,
  pollIntervalMs: 1500,
  statusCacheMs: 4000,
  idleCheckMs: 20000,
  autoStartComfy: true,
  /** 加载插件（也就是每次启动 DSH）时要不要顺手把 ComfyUI 拉起来。默认 false：只在真正画图时启动。 */
  warmupOnLoad: false,
  autoShutdown: true,
  /** 界面上选中的工作流；'auto' = 由插件按需求挑。 */
  workflow: 'auto',
  /** 选中的二级变体（同一个 json 的不同跑法）；null = 用该工作流的默认变体。 */
  variant: null,
}

/** 空闲关停的可选分钟数（界面上的四档）。 */
const IDLE_OPTIONS_MIN = [1, 3, 5, 10]

/* ------------------------------------------------------- ComfyUI 位置探测 ---- */

function isFile(file) {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

function looksLikeComfyRoot(dir) {
  return isFile(path.join(dir, 'main.py'))
}

/** 常见安装位置 + 环境变量。桌面版的用户名/实例号不能写死，只列通用路径。 */
function comfyCandidates() {
  const list = []
  const push = (value) => {
    const resolved = expandPath(value)
    if (resolved !== '') list.push(resolved)
  }
  push(process.env.COMFYUI_ROOT)
  push(process.env.COMFYUI_PATH)
  push(process.env.COMFYUI_DIR)
  if (process.platform === 'win32') {
    push(path.join(os.homedir(), 'ComfyUI'))
    push(path.join(os.homedir(), 'Documents', 'ComfyUI'))
    push('C:\\ComfyUI')
    push('D:\\ComfyUI')
    push('C:\\ComfyUI_windows_portable\\ComfyUI')
    push(path.join(process.env.LOCALAPPDATA ?? '', 'ComfyUI'))
  } else {
    push(path.join(os.homedir(), 'ComfyUI'))
    push('/opt/ComfyUI')
    push('/usr/local/ComfyUI')
  }
  return [...new Set(list.filter((dir) => dir !== ''))]
}

function pythonForRoot(root) {
  const win = process.platform === 'win32'
  const candidates = win
    ? [
      path.join(root, '.venv', 'Scripts', 'python.exe'),
      path.join(path.dirname(root), 'python_embeded', 'python.exe'),
      path.join(root, 'python_embeded', 'python.exe'),
    ]
    : [
      path.join(root, '.venv', 'bin', 'python3'),
      path.join(root, 'venv', 'bin', 'python3'),
      '/usr/bin/python3',
    ]
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate
  }
  return win ? 'python' : 'python3'
}

/** 本机私有配置：$DSH_HOME/dsh-comfyui-use-config.json（不进包，用来写死自己机器的路径）。 */
function readLocalConfig(log = () => {}) {
  const file = path.join(dshHome(), 'dsh-comfyui-use-config.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', `读本地配置失败：${file}（${error?.message ?? error}）`)
    return {}
  }
}

const PATH_KEYS = [
  'comfyRoot', 'comfyPython', 'comfyMainPy', 'comfyWorkdir', 'modelPathsYaml',
  'inputDir', 'sharedOutputDir', 'outputDir',
]

/**
 * 合并配置：默认值 ← $DSH_HOME 本地配置 ← bundle/profile 传入的 config。
 * 路径型字段统一展开 ~ 与 %VAR%，再自动探测 ComfyUI 安装位置。
 */
function resolveConfig(rawConfig, log = () => {}) {
  const cfg = { ...DEFAULTS, ...readLocalConfig(log), ...(rawConfig ?? {}) }
  for (const key of PATH_KEYS) cfg[key] = expandPath(cfg[key])
  if (Array.isArray(cfg.comfyArgs)) cfg.comfyArgs = cfg.comfyArgs.map((arg) => expandPath(arg))

  const port = Number.parseInt(String(cfg.port ?? DEFAULT_PORT), 10)
  cfg.port = Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT
  if (typeof cfg.comfyUrl !== 'string' || cfg.comfyUrl.trim() === '') {
    cfg.comfyUrl = `http://127.0.0.1:${cfg.port}`
  } else {
    cfg.comfyUrl = cfg.comfyUrl.trim().replace(/\/+$/u, '')
  }

  cfg.comfySource = 'config'
  if (cfg.comfyMainPy === '') {
    for (const root of comfyCandidates()) {
      if (looksLikeComfyRoot(root)) {
        cfg.comfyRoot = root
        cfg.comfyMainPy = path.join(root, 'main.py')
        cfg.comfySource = 'discovered'
        break
      }
    }
  }
  if (cfg.comfyMainPy !== '' && cfg.comfyRoot === '') cfg.comfyRoot = path.dirname(cfg.comfyMainPy)
  if (cfg.comfyPython === '' && cfg.comfyRoot !== '') cfg.comfyPython = pythonForRoot(cfg.comfyRoot)
  if (cfg.comfyWorkdir === '' && cfg.comfyMainPy !== '') cfg.comfyWorkdir = path.dirname(cfg.comfyMainPy)
  if (cfg.inputDir === '' && cfg.comfyRoot !== '') {
    const guessed = path.join(cfg.comfyRoot, 'input')
    if (existsSync(guessed)) cfg.inputDir = guessed
  }
  if (cfg.comfySource === 'discovered') {
    log('info', `自动探测到 ComfyUI：${cfg.comfyRoot}`)
  } else if (cfg.comfyMainPy === '') {
    log('warn', '没探测到 ComfyUI 安装位置：只能连已在运行的实例（comfyUrl），自动启动会失败。')
  }
  return cfg
}

/** 端口能不能自己占（用来避开别的程序）。 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/* ------------------------------------------------------------- 工作流描述 ---- */

/** 用户/模型用的画幅名 → ComfyUI ResolutionSelector 的完整选项串。 */
const ASPECT_LABELS = {
  '1:1': '1:1 (Square)',
  '3:4': '3:4 (Portrait Standard)',
  '4:3': '4:3 (Standard)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '9:16': '9:16 (Portrait Widescreen)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
}
const ASPECT_KEYS = Object.keys(ASPECT_LABELS)

/** 从完整选项串里取裸比例（LayerUtility 那个节点只认 "9:16" 这种写法）。 */
function bareAspect(full) {
  return String(full).split(' ')[0]
}

/** "3:4" → { w: 3, h: 4 }，给界面里的占位框算比例。 */
function aspectFrame(label) {
  const [w, h] = String(label).split(':').map((part) => Number(part))
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : { w: 1, h: 1 }
}

/** MOSS 两个变体共用的基础参数。 */
function mossBase(wf, p) {
  wf['129'].inputs.text = p.prompt
  if (p.negative !== '') wf['130'].inputs.text = p.negative
  // Seed (rgthree) 的 -1 = 每次随机；这里给它确定值
  wf['132'].inputs.seed = p.seed
  wf['127'].inputs.aspect_ratio = p.aspect
  wf['127'].inputs.megapixels = p.megapixels
}

/** Z-Image 两个变体共用的基础参数。 */
function zimageBase(wf, p) {
  // 用户提示词进 205；208 的 TextGenerate 会拿它做一次改写再喂给 CLIPTextEncode。
  wf['205'].inputs.value = p.prompt
  wf['162'].inputs.seed = p.seed
  wf['168'].inputs.aspect_ratio = p.aspect
  wf['168'].inputs.megapixels = p.megapixels
}

/**
 * 六个工作流。每个 spec 负责：把参数打到正确的节点上。
 * 节点 id 见 api-workflows/*.map.json，别再猜。
 *
 * 同一个 json 里的不同跑法（双采/单采、精修/单次、快速/进阶）拆成 variants：
 * 前端二级菜单按 variants 展开，工具也能用 args.variant 指定。
 */
const WORKFLOWS = {
  // 默认给所有人的那一个：ComfyUI 官方 Qwen-Image 2.1 文生图工作流（int8 小体积权重）。
  'qwen-image-2.1': {
    label: 'Qwen-Image 2.1',
    short: 'Qwen 2.1',
    hint: '官方工作流 · 25 步 · int8 权重（约 7-9 GB 下载）',
    needsReference: false,
    defaultAspect: '1:1',
    defaultMegapixels: 1,
    enableReference: true,
    defaultVariant: 't2i',
    builtin: true,
    variants: {
      t2i: {
        label: '文生图',
        hint: 'Qwen-Image 2.1 原版，25 步，cfg 1',
        file: 'qwen-image-2.1-t2i.json',
        patch(wf, p) {
          wf['452'].inputs.prompt = p.prompt
          if (p.negative !== '') wf['452'].inputs.negative_prompt = p.negative
          wf['458'].inputs.seed = p.seed
          wf['13'].inputs.aspect_ratio = p.aspect
          wf['13'].inputs.megapixels = p.megapixels
          wf['461'].inputs.filename_prefix = p.prefix
        },
      },
      edit: {
        label: '图片编辑',
        hint: '官方编辑工作流：给 1–4 张参考图，按提示词改（服装/姿势/风格）',
        file: 'qwen-image-2.1-edit.json',
        needsReference: true,
        patch(wf, p) {
          const refs = p.references ?? [p.reference]
          wf['470'].inputs.image = refs[0]
          wf['474'].inputs.prompt = p.prompt
          for (let i = 1; i < Math.min(refs.length, 4); i += 1) {
            wf[`470_${i}`] = { class_type: 'LoadImage', inputs: { image: refs[i] } }
            wf['474'].inputs[`images.image_${i + 1}`] = [`470_${i}`, 0]
          }
          wf['458'].inputs.seed = p.seed
          wf['461'].inputs.filename_prefix = p.prefix
        },
      },
    },
  },
  'qwen-turbo-t2i': {
    label: 'Qwen-Image-2.1 Turbo 生图',
    short: 'Qwen Turbo',
    hint: '8 步快速文生图 · 通用',
    needsReference: false,
    defaultAspect: '16:9',
    defaultMegapixels: 1,
    enableReference: false,
    defaultVariant: 'fast',
    variants: {
      fast: {
        label: '快速版',
        hint: '8 步直接出图，最快',
        file: 'qwen-turbo-t2i.json',
        patch(wf, p) {
          wf['218'].inputs.value = p.prompt
          wf['219'].inputs.noise_seed = p.seed
          wf['215'].inputs.aspect_ratio = p.aspect
          wf['215'].inputs.megapixels = p.megapixels
          wf['212'].inputs.filename_prefix = p.prefix
        },
      },
      advanced: {
        label: '进阶版',
        hint: '先用 9B 模型把提示词改写成英文长描述，再画（慢）',
        file: 'qwen-turbo-t2i-advanced.json',
        patch(wf, p) {
          wf['13'].inputs.value = p.prompt
          wf['224'].inputs.noise_seed = p.seed
          wf['39'].inputs.aspect_ratio = p.aspect
          wf['39'].inputs.megapixels = p.megapixels
          wf['10'].inputs.filename_prefix = p.prefix
        },
      },
    },
  },
  'qwen-turbo-edit': {
    label: 'Qwen-Image-2.1 Turbo 编辑',
    short: 'Qwen 编辑',
    hint: '按参考图改写 · 换风格/改主体',
    needsReference: true,
    defaultAspect: '1:1',
    defaultMegapixels: 1,
    enableReference: true,
    defaultVariant: 'edit',
    variants: {
      edit: {
        label: '编辑',
        hint: '保留原图构图，按提示词改写',
        file: 'qwen-turbo-edit.json',
        patch(wf, p) {
          wf['1'].inputs.value = p.prompt
          const refs = Array.isArray(p.references) && p.references.length > 0 ? p.references : [p.reference]
          wf['3'].inputs.image = refs[0]
          wf['4'].inputs.aspect_ratio = bareAspect(p.aspect)
          // 多参考图：给第 2..4 张各复制一套 LoadImage + 等比缩放，接到 TextEncode 的 images.image_2..4。
          // Qwen-Image-2.1 的 TextEncodeQwenImage21 原生支持 4 路参考图，按「图1定长相、图2补服装细节」的方式融合。
          for (let i = 1; i < refs.length; i += 1) {
            const k = i + 1
            const loadId = `3_${k}`
            const scaleId = `4_${k}`
            wf[loadId] = { class_type: 'LoadImage', inputs: { image: refs[i] } }
            wf[scaleId] = { class_type: wf['4'].class_type, inputs: { ...wf['4'].inputs, image: [loadId, 0] } }
            wf['16'].inputs[`images.image_${k}`] = [scaleId, 0]
          }
          wf['25'].inputs.noise_seed = p.seed
          wf['22'].inputs.filename_prefix = p.prefix
        },
      },
    },
  },
  'krea2-turbo': {
    label: 'Krea2 Turbo',
    short: 'Krea2',
    hint: '8 步 · 胶片感 / 艺术插画',
    needsReference: false,
    defaultAspect: '16:9',
    defaultMegapixels: 1,
    enableReference: false,
    defaultVariant: 'standard',
    variants: {
      standard: {
        label: '标准',
        hint: '8 步 · 胶片感 / 艺术插画',
        file: 'krea2-turbo.json',
        patch(wf, p) {
          wf['30:19'].inputs.value = p.prompt
          // 默认关掉 LLM 扩写：用户要什么就画什么，不让小模型改写提示词。
          wf['30:24'].inputs.value = p.refine === true
          // LoRA 开关（krea2_darkbrush，0.8 强度）
          wf['30:23'].inputs.value = p.lora === true
          wf['30:3'].inputs.seed = p.seed
          wf['49'].inputs.aspect_ratio = p.aspect
          wf['49'].inputs.megapixels = p.megapixels
          wf['29'].inputs.filename_prefix = p.prefix
        },
      },
    },
  },
  moss: {
    label: 'MOSS 整合',
    short: 'MOSS',
    hint: '中文文字 / 海报 / 排版最强',
    needsReference: false,
    defaultAspect: '9:16',
    defaultMegapixels: 1,
    enableReference: false,
    defaultVariant: 'double',
    variants: {
      double: {
        label: '双采',
        hint: '先低步铺底，再二采放大（更细致，慢）',
        file: 'moss.json',
        patch(wf, p) {
          mossBase(wf, p)
          wf['141'].inputs.filename_prefix = p.prefix
        },
      },
      single: {
        label: '单采',
        hint: '一步到底，快接近一半',
        file: 'moss.json',
        patch(wf, p) {
          mossBase(wf, p)
          // 120 一步跑满 16 步，去掉二采（121/122），解码直接吃 120。
          wf['120'].inputs.end_at_step = 16
          wf['120'].inputs.return_with_leftover_noise = 'disable'
          delete wf['121']
          delete wf['122']
          wf['138'].inputs.samples = ['120', 0]
          wf['141'].inputs.filename_prefix = p.prefix
        },
      },
    },
  },
  zimage: {
    label: 'Z-Image 整合',
    short: 'Z-Image',
    hint: '写实锐利 · 自带二次精修',
    needsReference: false,
    defaultAspect: '9:16',
    defaultMegapixels: 1,
    enableReference: false,
    defaultVariant: 'refine',
    variants: {
      refine: {
        label: '精修',
        hint: '7 步出图 + 5 步低 denoise 二次精修',
        file: 'zimage.json',
        patch(wf, p) {
          zimageBase(wf, p)
          wf['179'].inputs.filename_prefix = p.prefix
        },
      },
      single: {
        label: '单次',
        hint: '只跑第一次采样，快',
        file: 'zimage.json',
        patch(wf, p) {
          zimageBase(wf, p)
          // 去掉 160 放大 + 161 二次采样，解码直接吃 103。
          delete wf['160']
          delete wf['161']
          wf['108'].inputs.samples = ['103', 0]
          wf['179'].inputs.filename_prefix = p.prefix
        },
      },
    },
  },
  seedvr2: {
    label: 'SeedVR2 超分',
    short: 'SeedVR2',
    hint: '把参考图放大 / 修复清晰度',
    needsReference: true,
    defaultAspect: null,
    defaultMegapixels: null,
    enableReference: true,
    defaultVariant: 'upscale',
    variants: {
      upscale: {
        label: '超分',
        hint: '1 步采样 + 分块编码解码，放大 1-4 倍',
        file: 'seedvr2.json',
        patch(wf, p) {
          wf['1'].inputs.image = p.reference
          const scale = Number.isFinite(p.scale) ? Math.min(4, Math.max(1, Math.round(p.scale))) : 2
          wf['66:57'].inputs['resize_type.multiplier'] = scale
          wf['66:54'].inputs.seed = p.seed
          wf['9'].inputs.filename_prefix = p.prefix
        },
      },
    },
  },
}
const WORKFLOW_IDS = Object.keys(WORKFLOWS)
const LEGACY_IDS = WORKFLOW_IDS.filter((id) => WORKFLOWS[id].legacy === true)

/* ----------------------------------------------------------------- 工具函数 ---- */

/** 稳定 id：把模型/界面传来的名字归一化成上面的 key。 */
// 除了内置的官方 Qwen-Image 2.1，其余六个是我这台机器上调好的工作流，作为「旧打包」随插件带着；
// 别人的机器上没有这套模型时，体检会报出来，选择器里也标成不可用。
for (const [id, spec] of Object.entries(WORKFLOWS)) {
  if (id !== 'qwen-image-2.1') spec.legacy = true
  spec.id = id
}
const DEFAULT_WORKFLOW = 'qwen-image-2.1'

/** 权重文件的官方下载地址（魔搭 Comfy-Org/Qwen-Image-2.1，文件结构就是 ComfyUI 的 models/*）。 */
const MODEL_SOURCES = {
  'qwen_image_2.1_int8_convrot.safetensors': {
    dir: 'diffusion_models',
    path: 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
    size: '约 7 GB',
  },
  'qwen3vl_8b_int8_convrot.safetensors': {
    dir: 'text_encoders',
    path: 'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
    size: '约 9 GB',
  },
  'qwen_image_2.1_vae_bf16.safetensors': {
    dir: 'vae',
    path: 'vae/qwen_image_2.1_vae_bf16.safetensors',
    size: '约 0.3 GB',
  },
  'qwen_image_2.1_bf16.safetensors': {
    dir: 'diffusion_models',
    path: 'diffusion_models/qwen_image_2.1_bf16.safetensors',
    size: '约 13 GB',
  },
  'qwen3vl_8b_bf16.safetensors': {
    dir: 'text_encoders',
    path: 'text_encoders/qwen3vl_8b_bf16.safetensors',
    size: '约 16 GB',
  },
}
const MODELSCOPE_REPO = 'Comfy-Org/Qwen-Image-2.1'
const MODELSCOPE_PAGE = `https://modelscope.cn/models/${MODELSCOPE_REPO}`

function downloadHint(name) {
  const src = MODEL_SOURCES[name]
  if (!src) return null
  return {
    name,
    dir: src.dir,
    size: src.size ?? '',
    page: MODELSCOPE_PAGE,
    url: `https://modelscope.cn/models/${MODELSCOPE_REPO}/resolve/master/${src.path}`,
    target: `ComfyUI/models/${src.dir}/${name}`,
  }
}

function normalizeWorkflow(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw === '' || raw === 'auto' || raw === '自动') return 'auto'
  const lower = raw.toLowerCase()
  for (const id of WORKFLOW_IDS) {
    if (lower === id) return id
    if (lower === WORKFLOWS[id].label.toLowerCase()) return id
    if (lower === WORKFLOWS[id].short.toLowerCase()) return id
  }
  // 宽松匹配：包含关系（"Krea2_Turbo"、"moss 整合" 之类）
  for (const id of WORKFLOW_IDS) {
    const s = WORKFLOWS[id]
    if (lower.includes(s.short.toLowerCase()) || lower.includes(id)) return id
  }
  if (lower.includes('qwen') && lower.includes('编辑')) return 'qwen-turbo-edit'
  if (lower.includes('qwen')) return 'qwen-turbo-t2i'
  if (lower.includes('超分') || lower.includes('放大')) return 'seedvr2'
  return null
}

/** 变体名的别名表（中文习惯说法 + 英文）。 */
const VARIANT_ALIASES = {
  fast: ['快速', 'fast', 'quick'],
  advanced: ['进阶', '改写', '扩写', '润色', 'advance', 'advanced', 'llm'],
  double: ['双采', '两次', 'double', 'two-pass', '2-pass', '2 pass'],
  single: ['单采', '单次', 'single', 'one-pass', '1-pass', '1 pass'],
  refine: ['精修', '二次', 'refine', 'second-pass', 'second pass'],
  edit: ['编辑', 'edit'],
  standard: ['标准', 'standard'],
  upscale: ['超分', '放大', 'upscale'],
}

/** 在某个工作流内部把变体名归一化成 key。 */
function normalizeVariant(workflowId, input, view = WORKFLOWS) {
  const spec = view[workflowId]
  if (spec === undefined || typeof input !== 'string') return null
  const raw = input.trim()
  if (raw === '') return null
  const lower = raw.toLowerCase()
  const ids = Object.keys(spec.variants)
  for (const id of ids) {
    const v = spec.variants[id]
    if (lower === id) return id
    if (lower === String(v.label).toLowerCase()) return id
  }
  for (const id of ids) {
    if (lower.includes(id)) return id
  }
  for (const id of ids) {
    for (const alias of VARIANT_ALIASES[id] ?? []) {
      if (lower.includes(alias)) return id
    }
  }
  return null
}

/** 状态端点/客户端用的变体列表。 */
function variantRows(workflowId, view = WORKFLOWS) {
  const spec = view[workflowId]
  if (spec === undefined) return []
  return Object.entries(spec.variants).map(([id, v]) => ({ id, label: v.label, hint: v.hint }))
}

/** 状态端点给选择器的工作流列表（含内置/旧打包/导入三种来源）。 */
function workflowRows(state) {
  const view = workflowView(state)
  return Object.keys(view).map((id) => {
    const spec = view[id]
    return {
      id,
      label: spec.label,
      short: spec.short,
      hint: spec.hint,
      builtin: spec.builtin === true,
      legacy: spec.legacy === true,
      imported: spec.imported === true,
      needsReference: spec.needsReference === true,
      // 没跑过体检时先当作可用（别让老用户一重载就发现自己的选项变灰），体检确认缺模型后才灰掉。
      available: spec.legacy === true ? state?.legacyReady !== false : true,
      checked: spec.legacy === true ? state?.legacyReady !== null && state?.legacyReady !== undefined : true,
      defaultVariant: spec.defaultVariant,
      variants: variantRows(id, view),
    }
  })
}

/**
 * 没有指定工作流时按需求挑一个。
 * 规则保守：拿不准就用最快的 Qwen Turbo（快速版）。
 */
function chooseWorkflow(prompt, referencePath, legacyReady = false) {
  const text = String(prompt ?? '')
  const pick = (workflow, variant) => {
    // 旧打包的六个工作流依赖我这一套模型；体检明确说缺模型时不要自动挑到它们。
    if (legacyReady === false && WORKFLOWS[workflow]?.legacy === true) {
      return { workflow: DEFAULT_WORKFLOW, variant: WORKFLOWS[DEFAULT_WORKFLOW].defaultVariant }
    }
    return { workflow, variant: variant ?? WORKFLOWS[workflow].defaultVariant }
  }
  if (referencePath !== '') {
    if (/超分|放大|清晰|修复|upscale|enhance|4k|8k|分辨率/iu.test(text)) return pick('seedvr2')
    // 默认用内置的官方 Qwen-Image 2.1 编辑工作流（同一套三件模型，不需要额外权重）
    return { workflow: DEFAULT_WORKFLOW, variant: 'edit' }
  }
  if (/海报|文字|标题|排版|字体|标语|封面|logo|菜单|对话框|漫画分镜/iu.test(text)) return pick('moss')
  if (/二次元|动漫|插画|素描|水彩|手绘|胶片|艺术|anime|illustration/iu.test(text)) return pick('krea2-turbo')
  if (/写实|摄影|照片|人像|真人|产品图|realistic|photo/iu.test(text)) return pick('zimage')
  // 明确要「进阶版 / 先改写提示词」时才用 LLM 那条慢路径
  if (/进阶版|改写提示词|提示词改写|润色提示词|rewrite the prompt/iu.test(text)) {
    return { workflow: 'qwen-turbo-t2i', variant: 'advanced' }
  }
  return pick('qwen-turbo-t2i')
}

function makeLog(ctx) {
  return (level, message) => {
    try {
      const logger = ctx.logger ?? ctx.root?.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[comfyui-use] ${message}`)
      else if (level === 'error' || level === 'warn') console.error(`[comfyui-use] ${message}`)
    } catch {
      /* 日志失败绝不影响出图 */
    }
  }
}

function uiStatePath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-comfyui-use-ui.json')
}

/** skill 的正文不含 frontmatter（name/description 由注册参数提供）。 */
function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  return text.slice(end + 4).replace(/^\s*\n/, '')
}

function readUiState() {
  try {
    return JSON.parse(readFileSync(uiStatePath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeUiState(patch, log) {
  try {
    const next = { ...readUiState(), ...patch }
    mkdirSync(path.dirname(uiStatePath()), { recursive: true })
    writeFileSync(uiStatePath(), JSON.stringify(next, null, 2), 'utf8')
    return next
  } catch (error) {
    log('warn', `保存界面偏好失败（不影响出图）：${error?.message ?? error}`)
    return null
  }
}

/* ------------------------------------------------ 本地工作流导入（别人的机器） ---- */

function importsPath() {
  return path.join(dshHome(), 'dsh-comfyui-use-workflows.json')
}

function readImports(log) {
  try {
    const list = JSON.parse(readFileSync(importsPath(), 'utf8'))
    return Array.isArray(list) ? list.filter((item) => item && typeof item.id === 'string') : []
  } catch {
    return []
  }
}

function writeImports(list, log) {
  try {
    mkdirSync(path.dirname(importsPath()), { recursive: true })
    writeFileSync(importsPath(), JSON.stringify(list, null, 2), 'utf8')
  } catch (error) {
    log('warn', `保存导入的工作流失败：${error?.message ?? error}`)
  }
}

function workflowDirs(cfg) {
  const roots = []
  if (cfg.comfyRoot !== '') roots.push(cfg.comfyRoot)
  if (cfg.comfyMainPy !== '') roots.push(path.dirname(cfg.comfyMainPy))
  const dirs = []
  for (const root of [...new Set(roots)]) {
    dirs.push(path.join(root, 'user', 'default', 'workflows'))
    try {
      for (const entry of readdirSync(path.join(root, 'user'), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(root, 'user', entry.name, 'workflows'))
      }
    } catch { /* 没有 user 目录就算了 */ }
  }
  return [...new Set(dirs)].filter((dir) => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

/** 把一个工作流 JSON（UI 或 API 格式）变成「API prompt + 参数位置」。 */
function analyzeWorkflowJson(json, objectInfo) {
  let api = null
  let warnings = []
  if (isApiWorkflow(json)) {
    api = json
  } else if (isUiWorkflow(json)) {
    const converted = uiToApi(json, objectInfo)
    if (!converted.ok) return { ok: false, reason: converted.reason, warnings: converted.warnings }
    api = converted.prompt
    warnings = converted.warnings
  } else {
    return { ok: false, reason: '不是 ComfyUI 的工作流文件', warnings: [] }
  }
  const params = inferParams(api)
  const missingClasses = [...new Set(
    Object.values(api).map((n) => n.class_type).filter((cls) => objectInfo?.[cls] === undefined),
  )]
  const missingModels = []
  for (const ref of modelRefs(api)) {
    const options = optionsOf(objectInfo, ref.classType, ref.input)
    if (options !== null && !options.includes(ref.name)) missingModels.push(`${ref.name}（${ref.dir}）`)
  }
  return {
    ok: missingClasses.length === 0,
    api,
    params,
    warnings: [...warnings, ...params.warnings],
    missingClasses,
    missingModels: [...new Set(missingModels)],
    reason: missingClasses.length > 0 ? `这台 ComfyUI 不认识节点类型：${missingClasses.join(', ')}` : '',
  }
}

async function scanLocalWorkflows(cfg, objectInfo, log) {
  const out = []
  for (const dir of workflowDirs(cfg)) {
    let files = []
    try {
      files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'))
    } catch {
      continue
    }
    for (const name of files.slice(0, 200)) {
      const file = path.join(dir, name)
      if (file === importsPath()) continue
      try {
        const json = JSON.parse(readFileSync(file, 'utf8'))
        const analysis = analyzeWorkflowJson(json, objectInfo)
        if (analysis.ok && analysis.params.prompt !== null) {
          out.push({
            file,
            label: path.basename(name, '.json'),
            ok: analysis.missingModels.length === 0,
            missingModels: analysis.missingModels,
            warnings: analysis.warnings,
          })
        } else {
          out.push({
            file,
            label: path.basename(name, '.json'),
            ok: false,
            missingModels: analysis.missingModels ?? [],
            warnings: [],
            reason: analysis.reason || '没找到可以写提示词的文本节点',
          })
        }
      } catch (error) {
        out.push({ file, label: name, ok: false, missingModels: [], warnings: [], reason: `读不了：${error?.message ?? error}` })
      }
    }
  }
  log('info', `扫到 ${out.length} 个本地工作流（${out.filter((item) => item.ok).length} 个可直接用）`)
  return out
}

/** 导入记录 → 与内置工作流同形的 spec。 */
function importedSpec(record) {
  return {
    id: record.id,
    label: record.label,
    short: record.label.length > 16 ? `${record.label.slice(0, 16)}…` : record.label,
    hint: '你本机 ComfyUI 里导入的工作流',
    needsReference: false,
    defaultAspect: '1:1',
    defaultMegapixels: 1,
    enableReference: false,
    defaultVariant: 'imported',
    imported: true,
    variants: {
      imported: {
        label: '导入',
        hint: record.file,
        file: record.file,
        patch(wf, p) {
          const params = record.params ?? {}
          if (params.prompt) setNodeInput(wf, params.prompt.node, params.prompt.input, p.prompt)
          if (params.seed) setNodeInput(wf, params.seed.node, params.seed.input, p.seed)
          if (params.size?.kind === 'resolution') {
            setNodeInput(wf, params.size.node, 'aspect_ratio', p.aspect)
            setNodeInput(wf, params.size.node, 'megapixels', p.megapixels)
          } else if (params.size?.kind === 'pixels') {
            const { width, height } = pixelsForAspect(p.aspectKey ?? '1:1', p.megapixels)
            setNodeInput(wf, params.size.node, 'width', width)
            setNodeInput(wf, params.size.node, 'height', height)
          }
          if (params.save) setNodeInput(wf, params.save.node, params.save.input, p.prefix)
        },
      },
    },
    record,
  }
}

/** 「1:1 + 1MP」→ 16 的倍数宽高。 */
function pixelsForAspect(aspectKey, megapixels) {
  const frame = aspectFrame(aspectKey)
  const total = Math.max(0.25, Math.min(8, megapixels)) * 1024 * 1024
  const unit = Math.sqrt(total / (frame.w * frame.h))
  const r = (value) => Math.max(64, Math.round(value / 16) * 16)
  return { width: r(frame.w * unit), height: r(frame.h * unit) }
}

function workflowView(state) {
  const view = { ...WORKFLOWS }
  for (const record of state.imports ?? []) view[record.id] = importedSpec(record)
  return view
}

/** 读一份 API 模板：内置变体按文件缓存，导入的用记录里的快照（再深拷贝）。 */
async function templateFor(state, spec, variant, cfg, log, signal) {
  if (spec.imported === true) {
    const record = spec.record ?? (state.imports ?? []).find((item) => item.id === spec.id)
    if (record === undefined) throw new Error(`导入的工作流 ${spec.id} 找不到记录`)
    return JSON.parse(JSON.stringify(record.api))
  }
  const cached = state.templates[variant.file]
  if (cached !== undefined) return JSON.parse(JSON.stringify(cached))
  const file = path.join(WORKFLOW_DIR, variant.file)
  const json = JSON.parse(readFileSync(file, 'utf8'))
  state.templates[variant.file] = json
  return JSON.parse(JSON.stringify(json))
}

function portOf(url) {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number.parseInt(parsed.port, 10)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return PORT
  }
}

function safeStem(prompt, maxChars = 24) {
  const cleaned = String(prompt ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned === '') return 'untitled'
  if (/^[\x20-\x7e]+$/u.test(cleaned)) {
    let out = ''
    for (const word of cleaned.split(' ')) {
      if (out.length + word.length + 1 > 30) break
      out = `${out} ${word}`.trim()
    }
    return out || cleaned.slice(0, 30)
  }
  return cleaned.slice(0, maxChars)
}

/** 读参考图的原始宽高（PNG 直读 IHDR，JPEG 扫 SOF；读不到就返回 null）。用于让界面占位框跟图片比例一致。 */
async function readImageSize(file) {
  try {
    const data = await fsp.readFile(file)
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (data.length >= 24 && data.subarray(0, 8).equals(PNG)) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    }
    if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
      let off = 2
      while (off + 9 < data.length) {
        if (data[off] !== 0xff) { off += 1; continue }
        const marker = data[off + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
        const len = data.readUInt16BE(off + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: data.readUInt16BE(off + 7), height: data.readUInt16BE(off + 5) }
        }
        off += 2 + Math.max(2, len)
      }
    }
  } catch {
    /* 读不到就让界面用默认比例 */
  }
  return null
}

async function uniquePath(dir, filename) {
  const first = path.join(dir, filename)
  try {
    await fsp.access(first)
  } catch {
    return first
  }
  const ext = path.extname(filename)
  const stem = path.basename(filename, ext)
  for (let i = 2; i < 999; i += 1) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

/** 带超时的 fetch（同时尊重 exec.signal）。 */
async function fetchWithTimeout(url, { method = 'GET', body, headers, timeoutMs = 10000, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined || signal === null
    ? timeout
    : AbortSignal.any([signal, timeout])
  return fetch(url, { method, body, headers, signal: combined })
}

/* -------------------------------------------------------------- ComfyUI 交互 ---- */

async function runPowerShell(script, timeoutMs = 20000) {
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
  )
  return String(stdout ?? '').trim()
}

async function startComfyHidden(cfg, log) {
  if (cfg.comfyMainPy === '' || !isFile(cfg.comfyMainPy)) {
    throw new Error(
      '没找到 ComfyUI 的 main.py，无法自动启动。请任选一种办法：\n'
      + '  · 在插件配置里写 comfyRoot（ComfyUI 目录），或\n'
      + '  · 设环境变量 COMFYUI_ROOT，或\n'
      + '  · 先自己把 ComfyUI 开起来，插件会直接连 comfyUrl。',
    )
  }
  const args = Array.isArray(cfg.comfyArgs) ? [...cfg.comfyArgs] : []
  // 端口跟着 comfyUrl 走（配置里可能只改了一边；端口会自动避让别的程序）
  const wantedPort = String(portOf(cfg.comfyUrl))
  const portIndex = args.indexOf('--port')
  if (portIndex >= 0) args[portIndex + 1] = wantedPort
  else args.push('--port', wantedPort)
  if (!args.includes('--disable-auto-launch')) args.push('--disable-auto-launch')
  if (cfg.modelPathsYaml !== '' && !args.includes('--extra-model-paths-config')) {
    args.push('--extra-model-paths-config', cfg.modelPathsYaml)
  }
  if (cfg.inputDir !== '' && !args.includes('--input-directory')) {
    args.push('--input-directory', cfg.inputDir)
  }
  if (cfg.sharedOutputDir !== '' && !args.includes('--output-directory')) {
    args.push('--output-directory', cfg.sharedOutputDir)
  }

  log('info', `后台启动 ComfyUI：${cfg.comfyPython} -s ${cfg.comfyMainPy}`)
  log('info', `启动参数：${args.join(' ')}`)
  // ⚠ Start-Process -ArgumentList 用数组会把每个元素直接拼成空格分隔的字符串，
  // 带空格的路径（比如 "Comfy Desktop\instance-model-paths\..."）就会被拆成两个参数，
  // ComfyUI 的 argparse 直接报错退出。所以这里自己拼一条带引号的命令行，整体传进去。
  const quoteForWindows = (value) => {
    const text = String(value)
    return /[\s"]/u.test(text) ? `"${text}"` : text
  }
  const commandLine = ['-s', cfg.comfyMainPy, ...args].map(quoteForWindows).join(' ')
  await runPowerShell(
    `Start-Process -FilePath '${cfg.comfyPython.replace(/'/gu, "''")}' ` +
      `-ArgumentList '${commandLine.replace(/'/gu, "''")}' ` +
      `-WorkingDirectory '${cfg.comfyWorkdir.replace(/'/gu, "''")}' -WindowStyle Hidden`,
    30000,
  )
}

async function assertComfyUp(cfg, signal) {
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 6000, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (error) {
    throw new Error(
      `连不上本机 ComfyUI（${cfg.comfyUrl}）：${error?.message ?? error}`,
    )
  }
}

async function ensureComfyUp(cfg, log, signal) {
  try {
    await assertComfyUp(cfg, signal)
    return { started: false }
  } catch {
    if (cfg.autoStartComfy === false) {
      throw new Error(`ComfyUI 没在运行，且插件配置里关闭了自动启动（${cfg.comfyUrl}）。`)
    }
    log('info', 'ComfyUI 没在跑 → 后台隐藏启动它')
  }
  // 端口被别的程序占着就往后找空闲的，免得启动直接失败。
  if (!await isPortFree(cfg.port)) {
    let picked = 0
    for (let i = 1; i < PORT_TRIES; i += 1) {
      const candidate = cfg.port + i
      if (await isPortFree(candidate)) {
        picked = candidate
        break
      }
    }
    if (picked === 0) {
      throw new Error(`端口 ${cfg.port}～${cfg.port + PORT_TRIES - 1} 都被占用，没法启动 ComfyUI。`)
    }
    log('warn', `端口 ${cfg.port} 被占用，改用 ${picked}`)
    cfg.port = picked
    cfg.comfyUrl = `http://127.0.0.1:${picked}`
  }
  await startComfyHidden(cfg, log)
  const startedAt = Date.now()
  const limit = Number(cfg.startTimeoutMs ?? 240000)
  for (;;) {
    if (Date.now() - startedAt > limit) {
      throw new Error(
        `已在后台启动 ComfyUI，但 ${Math.round(limit / 1000)} 秒内没就绪。\n`
        + `常见原因：python 路径不对、模型/节点加载报错、端口被防火墙拦。\n`
        + `当前配置：python=${cfg.comfyPython || '(空)'} main=${cfg.comfyMainPy || '(空)'} url=${cfg.comfyUrl}`,
      )
    }
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      await assertComfyUp(cfg, signal)
      log('info', `ComfyUI 已就绪（等了 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`)
      return { started: true }
    } catch {
      /* 继续等 */
    }
  }
}

function makeComfyStatus(cfg) {
  let cache = { at: 0, online: false }
  return {
    async probe(force = false) {
      const now = Date.now()
      if (!force && now - cache.at < cfg.statusCacheMs) return cache.online
      let online = false
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 2500 })
        online = res.ok
      } catch {
        online = false
      }
      cache = { at: now, online }
      return online
    },
    async queueState() {
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 3000 })
        if (!res.ok) return { busy: false, running: [], pending: [] }
        const data = await res.json()
        const running = Array.isArray(data?.queue_running) ? data.queue_running : []
        const pending = Array.isArray(data?.queue_pending) ? data.queue_pending : []
        return { busy: running.length + pending.length > 0, running, pending }
      } catch {
        return { busy: false, running: [], pending: [] }
      }
    },
    invalidate() {
      cache = { at: 0, online: cache.online }
    },
  }
}

/** 只杀"监听本插件端口且命令行确实是 ComfyUI"的进程。 */
async function findComfyProcess(cfg, log) {
  const port = portOf(cfg.comfyUrl)
  try {
    const pidText = await runPowerShell(
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
        'Select-Object -First 1 -ExpandProperty OwningProcess)',
    )
    const pid = Number.parseInt(pidText, 10)
    if (!Number.isInteger(pid) || pid <= 0) return null
    const commandLine = await runPowerShell(
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | ` +
        'Select-Object -ExpandProperty CommandLine)',
    )
    if (!/comfy/iu.test(commandLine) || !/main\.py/iu.test(commandLine)) {
      log('warn', `端口 ${port} 上的 PID ${pid} 不像 ComfyUI，拒绝关闭：${commandLine.slice(0, 160)}`)
      return null
    }
    return { pid, commandLine }
  } catch (error) {
    log('warn', `识别 ComfyUI 进程失败：${error?.message ?? error}`)
    return null
  }
}

function makeIdleShutdown(cfg, log, status) {
  const state = { lastActivityAt: null, shuttingDown: false, shutdowns: 0 }
  return {
    touch() {
      state.lastActivityAt = Date.now()
    },
    idleShutdownInMs() {
      if (!cfg.autoShutdown || cfg.idleShutdownMs <= 0) return 0
      if (state.lastActivityAt === null) return 0
      return Math.max(0, cfg.idleShutdownMs - (Date.now() - state.lastActivityAt))
    },
    snapshot() {
      return {
        autoShutdown: cfg.autoShutdown,
        lastActivityAt: state.lastActivityAt,
        idleShutdownMs: cfg.idleShutdownMs,
        idleShutdownInMs: this.idleShutdownInMs(),
        shutdowns: state.shutdowns,
      }
    },
    async tick() {
      if (!cfg.autoShutdown || cfg.idleShutdownMs <= 0) return false
      if (state.lastActivityAt === null || state.shuttingDown) return false
      if (Date.now() - state.lastActivityAt < cfg.idleShutdownMs) return false
      const online = await status.probe(true)
      if (!online) {
        state.lastActivityAt = null
        return false
      }
      const queue = await status.queueState()
      if (queue.busy) {
        state.lastActivityAt = Date.now()
        return false
      }
      state.shuttingDown = true
      try {
        const found = await findComfyProcess(cfg, log)
        if (found === null) {
          log('warn', '空闲已超时，但没能确认哪个进程是 ComfyUI，本次不关闭')
          return false
        }
        await runPowerShell(`Stop-Process -Id ${found.pid} -Force`)
        state.shutdowns += 1
        log('info', `已空闲 ${Math.round((Date.now() - state.lastActivityAt) / 1000)} 秒，关闭 ComfyUI（PID ${found.pid}）`)
        state.lastActivityAt = null
        status.invalidate()
        return true
      } catch (error) {
        log('warn', `关闭 ComfyUI 失败：${error?.message ?? error}`)
        return false
      } finally {
        state.shuttingDown = false
      }
    },
  }
}

function isLocalRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const remote = String(req?.socket?.remoteAddress ?? '')
  const hostOk = host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host)
  const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return hostOk && remoteOk
}

function respondJson(res, body, code = 200) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(text)
  } catch {
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"ok":false}')
    } catch {
      /* 连接已断 */
    }
  }
}

/* ---------------------------------------------------- 参考图下载（含安全闸） ---- */

/** 判断一个 IP 是不是内网/回环/链路本地/保留地址。 */
function isPrivateAddress(ip) {
  const text = String(ip).toLowerCase()
  if (text === '' ) return true
  if (text === '::1' || text === '::' || text === '0.0.0.0') return true
  const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)
  if (mapped !== null) return isPrivateAddress(mapped[1])
  if (text.includes(':')) {
    return /^f[cd][0-9a-f]{2}:/u.test(text) || /^fe[89ab][0-9a-f]:/u.test(text) || text.startsWith('ff')
  }
  const parts = text.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/**
 * 只允许公网 http(s)：挡住 127.0.0.1、局域网、云元数据地址，
 * 免得工具被当成“让宿主替我访问内网”的跳板。
 */
async function assertPublicUrl(url) {
  let parsed = null
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`参考图地址不合法：${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('参考图地址只支持 http/https。')
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '')
  if (isPrivateAddress(host)) {
    throw new Error(`参考图地址指向本机/内网，出于安全考虑不允许：${host}`)
  }
  let addresses = []
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch (error) {
    throw new Error(`解析不了参考图域名 ${host}：${error?.message ?? error}`)
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`参考图域名解析到了内网地址，已拒绝：${host}`)
  }
  return parsed
}

/** 把本地参考图交给 ComfyUI，返回它认得的文件名。 */
async function downloadReference(url, log, signal, timeoutMs = 60000) {
  await assertPublicUrl(url)
  const dir = path.join(os.tmpdir(), 'dsh-comfyui-refs')
  await fsp.mkdir(dir, { recursive: true })
  const res = await fetchWithTimeout(url, {
    timeoutMs,
    signal,
    headers: {
      // 有些图床（Wikimedia、pixiv 代理）会拒绝没有 UA 的请求。
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-comfyui-use/0.1.27',
      accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
    },
  })
  if (!res.ok) throw new Error(`下载参考图失败（HTTP ${res.status}）：${url}`)
  // 重定向可能把我们带到内网，最终地址要再校验一遍。
  if (res.url !== '' && res.url !== url) await assertPublicUrl(res.url)
  const type = String(res.headers.get('content-type') ?? '').toLowerCase()
  if (type !== '' && !type.startsWith('image/')) {
    throw new Error(`参考图地址返回的不是图片（content-type: ${type}）：${url}`)
  }
  const limit = 30 * 1024 * 1024
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`参考图太大（${Math.round(declared / 1024 / 1024)}MB，上限 30MB）：${url}`)
  }
  const ext = type.includes('png') ? '.png'
    : type.includes('webp') ? '.webp'
      : type.includes('gif') ? '.gif'
        : '.jpg'
  const file = path.join(dir, `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > limit) throw new Error(`参考图太大（${Math.round(bytes.length / 1024 / 1024)}MB，上限 30MB）。`)
  await fsp.writeFile(file, bytes)
  log('info', `下载参考图 ${url} → ${file}（${bytes.length} 字节）`)
  return file
}

async function uploadImage(cfg, filePath, log, signal) {
  let bytes
  try {
    bytes = await fsp.readFile(filePath)
  } catch (error) {
    throw new Error(`读不到参考图：${filePath}（${error?.message ?? error}）`)
  }
  const ext = (path.extname(filePath) || '.png').toLowerCase()
  const filename = `dsh-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  try {
    const form = new FormData()
    form.append('image', new Blob([bytes]), filename)
    form.append('overwrite', 'true')
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/upload/image`, {
      method: 'POST', body: form, timeoutMs: 60000, signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const name = String(data?.name ?? filename)
    const subfolder = String(data?.subfolder ?? '')
    return subfolder === '' ? name : `${subfolder}/${name}`
  } catch (error) {
    log('warn', `上传参考图失败，改用复制到 input 目录：${error?.message ?? error}`)
    // 兜底：复制到 ComfyUI 自己的 input 目录（配置优先，其次跟着 main.py 推）
    const inputDir = cfg.inputDir !== ''
      ? cfg.inputDir
      : path.join(path.dirname(cfg.comfyMainPy || '.'), 'input')
    await fsp.mkdir(inputDir, { recursive: true })
    await fsp.copyFile(filePath, path.join(inputDir, filename))
    return filename
  }
}

async function submitPrompt(cfg, workflow, signal) {
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `dsh-comfyui-${Date.now()}` }),
    timeoutMs: 60000,
    signal,
  })
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const detail = data?.error?.message ?? text.slice(0, 400)
    throw new Error(`ComfyUI 拒绝了任务（HTTP ${res.status}）：${detail}`)
  }
  if (data?.prompt_id === undefined) throw new Error(`ComfyUI 没有返回 prompt_id：${text.slice(0, 300)}`)
  if (data?.node_errors !== undefined && Object.keys(data.node_errors).length > 0) {
    throw new Error(`工作流节点校验失败：${JSON.stringify(data.node_errors).slice(0, 800)}`)
  }
  return data.prompt_id
}

async function cancelPrompt(cfg, promptId, log) {
  try {
    await fetchWithTimeout(`${cfg.comfyUrl}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      timeoutMs: 10000,
    })
    log('info', `已请求取消任务 ${promptId}`)
  } catch {
    /* 取消失败不抛 */
  }
}

async function waitForResult(cfg, promptId, { signal, timeoutMs, onTick }) {
  const startedAt = Date.now()
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没出图，已放弃（任务 ${promptId}）。`)
    }
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs ?? 1500))
    let entry = null
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/history/${promptId}`, { timeoutMs: 8000, signal })
      if (res.ok) {
        const data = await res.json()
        entry = data?.[promptId] ?? null
      }
    } catch {
      /* 网络抖动，下一轮 */
    }
    if (entry !== null) {
      const status = entry?.status
      if (status?.completed === true || status?.status_str === 'success') {
        const images = []
        for (const output of Object.values(entry?.outputs ?? {})) {
          for (const image of output?.images ?? []) images.push(image)
        }
        if (images.length === 0) throw new Error('ComfyUI 报告完成，但输出里没有图片。')
        return { images, entry }
      }
      if (status?.status_str === 'error') {
        const messages = Array.isArray(status?.messages) ? status.messages : []
        const detail = messages
          .filter((pair) => Array.isArray(pair) && /error/i.test(String(pair[0])))
          .map((pair) => JSON.stringify(pair[1]).slice(0, 300))
          .join('; ')
        throw new Error(`ComfyUI 执行失败：${detail || '未知错误'}`)
      }
    }
    if (typeof onTick === 'function') {
      try {
        await onTick()
      } catch {
        /* 进度回调失败不影响等待 */
      }
    }
  }
}

async function fetchImageBytes(cfg, image, signal) {
  const params = new URLSearchParams({
    filename: String(image.filename ?? ''),
    subfolder: String(image.subfolder ?? ''),
    type: String(image.type ?? 'output'),
  })
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/view?${params.toString()}`, { timeoutMs: 60000, signal })
  if (!res.ok) throw new Error(`取图失败（HTTP ${res.status}）：${image.filename}`)
  return Buffer.from(await res.arrayBuffer())
}

/* --------------------------------------------------------------- 体检 ---- */

const OBJECT_INFO_TTL_MS = 10 * 60 * 1000
const objectInfoCache = new Map()

async function fetchObjectInfo(cfg, signal) {
  const cached = objectInfoCache.get(cfg.comfyUrl)
  if (cached !== undefined && Date.now() - cached.at < OBJECT_INFO_TTL_MS) return cached.data
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/object_info`, { timeoutMs: 45000, signal })
  if (!res.ok) throw new Error(`读 /object_info 失败（HTTP ${res.status}）`)
  const data = await res.json()
  objectInfoCache.set(cfg.comfyUrl, { at: Date.now(), data })
  return data
}

/** 这些节点用哪个输入名引用模型文件。 */
const MODEL_LOADER_KEYS = {
  UNETLoader: 'unet_name',
  CLIPLoader: 'clip_name',
  VAELoader: 'vae_name',
  LoraLoaderModelOnly: 'lora_name',
  LoraLoader: 'lora_name',
  CheckpointLoaderSimple: 'ckpt_name',
}

function optionsOf(objectInfo, cls, key) {
  const input = objectInfo?.[cls]?.input
  const spec = input?.required?.[key] ?? input?.optional?.[key]
  const first = Array.isArray(spec) ? spec[0] : null
  return Array.isArray(first) ? first.map((item) => String(item)) : null
}

const CHECK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    online: { type: 'boolean' },
    url: { type: 'string' },
    version: { type: 'string' },
    ok: { type: 'boolean' },
    comfy: { type: 'string' },
    missingClasses: { type: 'array', items: { type: 'string' } },
    missingModels: { type: 'array', items: { type: 'string' } },
    workflows: { type: 'array', items: { type: 'string' } },
    hints: { type: 'array', items: { type: 'string' } },
    downloads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          dir: { type: 'string' },
          size: { type: 'string' },
          page: { type: 'string' },
          url: { type: 'string' },
          target: { type: 'string' },
        },
        required: ['name', 'dir', 'page', 'url', 'target'],
      },
    },
    localCandidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          label: { type: 'string' },
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          missingModels: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['file', 'label', 'ok'],
      },
    },
    imported: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, label: { type: 'string' }, file: { type: 'string' } },
        required: ['id', 'label', 'file'],
      },
    },
  },
  required: [
    'online', 'url', 'version', 'ok', 'comfy',
    'missingClasses', 'missingModels', 'workflows', 'hints',
  ],
}

/**
 * 体检：ComfyUI 在不在线、六个工作流各自缺哪些节点类/模型文件。
 * 分享给别人时，装完先跑这个，比让 /prompt 抛 400 友好得多。
 */
async function runDoctor(cfg, templates, log, signal, state) {
  const stateRef = state ?? { imports: [], templates }
  const report = {
    online: false,
    url: cfg.comfyUrl,
    version: '',
    ok: false,
    comfy: `python=${cfg.comfyPython || '(未探测到)'} main=${cfg.comfyMainPy || '(未探测到)'} source=${cfg.comfySource}`,
    missingClasses: [],
    missingModels: [],
    workflows: [],
    hints: [],
    downloads: [],
    localCandidates: [],
    imported: [],
  }
  try {
    const stats = await assertComfyUp(cfg, signal)
    report.online = true
    report.version = String(stats?.system?.comfyui_version ?? '')
  } catch (error) {
    report.hints.push(String(error?.message ?? error))
    if (cfg.comfyMainPy === '') {
      report.hints.push('没探测到 ComfyUI 安装目录：把 comfyRoot 写进插件配置，或设环境变量 COMFYUI_ROOT。')
    }
    report.hints.push('ComfyUI 没在运行时没法做节点/模型体检；先画一张图（会自动启动）再来。')
    return report
  }

  let objectInfo = null
  try {
    objectInfo = await fetchObjectInfo(cfg, signal)
  } catch (error) {
    report.hints.push(`读节点清单失败（/object_info）：${error?.message ?? error}`)
    return report
  }

  const classExists = (cls) => objectInfo[cls] !== undefined
  const familyOk = {}
  const missingClassSet = new Set()
  const missingModelSet = new Map()

  for (const id of WORKFLOW_IDS) {
    const family = WORKFLOWS[id]
    for (const [variantId, variant] of Object.entries(family.variants)) {
      const label = `${family.label} · ${variant.label}`
      const workflow = templates[variant.file]
      const missingClasses = []
      const missingModels = []
      if (workflow === undefined) {
        report.workflows.push(`${label}：模板读不到（${variant.file}）`)
        continue
      }
      for (const node of Object.values(workflow)) {
        const cls = node?.class_type
        if (typeof cls !== 'string') continue
        if (!classExists(cls)) {
          if (!missingClasses.includes(cls)) missingClasses.push(cls)
          missingClassSet.add(cls)
          continue
        }
        const key = MODEL_LOADER_KEYS[cls]
        if (key === undefined) continue
        const value = node?.inputs?.[key]
        if (typeof value !== 'string' || value === '') continue
        const options = optionsOf(objectInfo, cls, key)
        if (options === null || options.includes(value)) continue
        const text = `${value}（${cls}）`
        if (!missingModels.includes(text)) missingModels.push(text)
        if (!missingModelSet.has(text)) missingModelSet.set(text, new Set())
        missingModelSet.get(text).add(family.short)
      }
      const ok = missingClasses.length === 0 && missingModels.length === 0
      familyOk[id] = (familyOk[id] ?? true) && ok
      report.workflows.push(
        `${ok ? '✓' : '✗'} ${label}${ok ? '' : `：缺节点 ${missingClasses.join(', ') || '无'}；缺模型 ${missingModels.join(', ') || '无'}`}`,
      )
    }
  }

  stateRef.legacyReady = LEGACY_IDS.every((id) => familyOk[id] === true)

  // 导入的工作流也要过一遍（别人的机器上，这才是他真正会用的那些）
  for (const record of stateRef.imports ?? []) {
    const missing = Object.values(record.api ?? {}).map((n) => n.class_type).filter((cls) => !classExists(cls))
    const models = modelRefs(record.api ?? {})
      .filter((ref) => {
        const options = optionsOf(objectInfo, ref.classType, ref.input)
        return options !== null && !options.includes(ref.name)
      })
      .map((ref) => `${ref.name}（${ref.dir}）`)
    for (const cls of missing) missingClassSet.add(cls)
    const ok = missing.length === 0 && models.length === 0
    report.workflows.push(
      `${ok ? '✓' : '✗'} （导入）${record.label}${ok ? '' : `：缺节点 ${[...new Set(missing)].join(', ') || '无'}；缺模型 ${models.join(', ') || '无'}`}`,
    )
  }

  report.missingClasses = [...missingClassSet].sort()
  report.missingModels = [...missingModelSet.entries()]
    .map(([text, families]) => `${text} ← ${[...families].join(' / ')}`)
    .sort()
  report.ok = report.missingClasses.length === 0 && report.missingModels.length === 0

  if (report.missingClasses.length > 0) {
    report.hints.push('缺自定义节点：用 ComfyUI-Manager 搜类名的仓库装上，重启 ComfyUI。')
  }
  if (report.missingModels.length > 0) {
    const known = report.missingModels
      .map((text) => downloadHint(String(text).split('（')[0]))
      .filter((hint) => hint !== null)
    report.downloads = known
    if (known.length > 0) {
      report.hints.push(`缺的模型可以在魔搭 ${MODELSCOPE_PAGE} 下载，放到 ComfyUI/models 对应子目录（下面给了逐文件链接）。`)
    } else {
      report.hints.push('缺模型文件：按括号里的文件名放进 models 对应子目录（unet/clip/vae/loras），或改用你有的模型重建工作流。')
    }
  } else {
    report.downloads = []
  }
  // 别人机器上可能已经有一堆自己的好工作流：扫出来问用户要不要导入，而不是硬推我这套。
  report.localCandidates = await scanLocalWorkflows(cfg, objectInfo, log)
  const usable = report.localCandidates.filter(
    (item) => item.ok && !String(item.file).startsWith(importsPath()),
  )
  report.imported = (stateRef.imports ?? []).map((record) => ({ id: record.id, label: record.label, file: record.file }))
  if (usable.length > 0) {
    report.hints.push(
      `本机 ComfyUI 里还有 ${usable.length} 个可以直接用的工作流（见 localCandidates）；`
      + '问用户要不要把它们加入插件（调用 comfyui_import），加入后就不必用插件自带的那套模型。',
    )
  }
  log('info', `体检完成：${report.ok ? '通过' : `缺 ${report.missingClasses.length} 个节点类、${report.missingModels.length} 个模型`}`)
  stateRef.lastDoctor = { ...report, at: Date.now() }
  return report
}

function makeCheckTool(ctx, cfg, state, log) {
  return {
    name: 'comfyui_check',
    description:
      '体检本机 ComfyUI：是否在线、缺哪些自定义节点、内置工作流缺哪些模型（附魔搭下载链接），'
      + '并扫描本机已有的 ComfyUI 工作流、标出哪些可以直接用。'
      + '别人刚装好插件、第一次用、出现“节点校验失败/Value not in list”时先跑这个。'
      + '如果 localCandidates 里有 ok:true 的条目，先问用户要不要把他们的工作流加入插件（comfyui_import），'
      + '不要默认让用户去下插件自带那套模型。它不会启动 ComfyUI，也不会改配置。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    timeoutMs: 180000,
    output: {
      schema: CHECK_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [
          `ComfyUI：${value.online ? `在线（${value.url}${value.version === '' ? '' : `，v${value.version}`}）` : `离线（${value.url}）`}`,
          `安装：${value.comfy}`,
          `结论：${value.ok ? '工作流都齐了' : '有缺项，见下'}`,
          ...(value.missingClasses.length > 0 ? ['', '缺节点类：', ...value.missingClasses.map((cls) => `  · ${cls}`)] : []),
          ...(value.missingModels.length > 0 ? ['', '缺模型：', ...value.missingModels.map((item) => `  · ${item}`)] : []),
          ...(value.downloads.length > 0 ? ['', '可用下载：', ...value.downloads.map((item) => `  · ${item.name}（${item.size}）\n    下载：${item.url}\n    放到：${item.target}`)] : []),
          ...(value.workflows.length > 0 ? ['', '逐工作流：', ...value.workflows.map((row) => `  ${row}`)] : []),
          ...(value.localCandidates.length > 0 ? ['', '本机已有工作流：', ...value.localCandidates.map((row) => `  ${row.ok ? '✓' : '✗'} ${row.label}${row.reason ? `（${row.reason}）` : ''}${row.missingModels?.length > 0 ? ` 缺模型：${row.missingModels.join(', ')}` : ''}\n    文件：${row.file}`)] : []),
          ...(value.imported.length > 0 ? ['', '已加入插件：', ...value.imported.map((row) => `  · ${row.label}（${row.id}）`)] : []),
          ...(value.hints.length > 0 ? ['', '提示：', ...value.hints.map((hint) => `  · ${hint}`)] : []),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return await runDoctor(cfg, state.templates, log, exec?.signal, state)
    },
  }
}

const IMPORT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    id: { type: 'string' },
    label: { type: 'string' },
    file: { type: 'string' },
    format: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    missingModels: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'id', 'label', 'file', 'format', 'warnings', 'missingModels'],
}

/**
 * 把本机 ComfyUI 里已有的工作流加入插件：UI 图自动转 API，并推断出提示词/种子/尺寸/保存前缀的位置。
 * 别人的机器上优先用这个，而不是让用户去下插件自带那套模型。
 */
function makeImportTool(cfg, state, log) {
  return {
    name: 'comfyui_import',
    description:
      '把一个本机 ComfyUI 工作流加入插件（在 comfyui_check 的 localCandidates 里看到 ok:true 的，先问用户要不要加）。'
      + 'file 给工作流 JSON 的绝对路径。UI 格式会自动转成 API，并识别提示词、种子、尺寸、保存前缀；'
      + '识别不到提示词节点会直接报错。加入后可以用它的 id 作为 comfyui_draw 的 workflow。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '工作流 JSON 的绝对路径（ComfyUI/user/default/workflows/xxx.json）' },
        label: { type: 'string', description: '可选的显示名；默认用文件名' },
      },
      required: ['file'],
    },
    timeoutMs: 120000,
    output: {
      schema: IMPORT_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [
          `已加入：${value.label}（${value.id}）`,
          `文件：${value.file}（${value.format}）`,
          ...(value.missingModels.length > 0 ? [`缺模型：${value.missingModels.join(', ')}`] : []),
          ...(value.warnings.length > 0 ? [`注意：${value.warnings.join('；')}`] : []),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const file = path.resolve(String(args?.file ?? '').trim())
      if (file === '' || !isFile(file)) throw new Error(`找不到工作流文件：${file}`)
      let json
      try {
        json = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        throw new Error(`读不了这个 JSON：${error?.message ?? error}`)
      }
      await ensureComfyUp(cfg, log, exec?.signal)
      const objectInfo = await fetchObjectInfo(cfg, exec?.signal)
      const analysis = analyzeWorkflowJson(json, objectInfo)
      if (!analysis.ok) throw new Error(`这个工作流没法直接用：${analysis.reason}`)
      if (analysis.params?.prompt === null || analysis.params?.prompt === undefined) {
        throw new Error('没找到可以写提示词的文本节点（需要 CLIPTextEncode 之类），这个工作流不适合接进插件')
      }
      const stem = path.basename(file, path.extname(file))
      const safeId = `local:${stem.replace(/[^\w\u4e00-\u9fa5-]+/gu, '-').slice(0, 48)}`
      const label = typeof args?.label === 'string' && args.label.trim() !== '' ? args.label.trim() : stem
      const record = {
        id: safeId,
        label,
        file,
        addedAt: Date.now(),
        api: analysis.api,
        params: analysis.params,
      }
      const list = (state.imports ?? []).filter((item) => item.id !== safeId && item.file !== file)
      list.push(record)
      state.imports = list
      writeImports(list, log)
      log('info', `导入工作流 ${safeId}（${label}，${Object.keys(analysis.api).length} 节点）`)
      return {
        ok: true,
        id: safeId,
        label,
        file,
        format: isApiWorkflow(json) ? 'API' : 'UI→API',
        warnings: analysis.warnings,
        missingModels: analysis.missingModels,
      }
    },
  }
}

/* ------------------------------------------------------------- 工具定义 ---- */

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: {
      type: 'string',
      description: '画面描述。按工作流习惯写中文即可；MOSS 擅长画面里带中文文字的排版。',
    },
    workflow: {
      type: 'string',
      description:
        '用哪个工作流。默认是内置的 qwen-image-2.1（官方 Qwen-Image 2.1 文生图）；'
        + '插件还带着六个旧打包工作流（qwen-turbo-t2i / qwen-turbo-edit / krea2-turbo / moss / zimage / seedvr2，'
        + '需要我这套模型，只有体检确认齐全时才会自动用到），以及本机导入的 local:<名字>。'
        + '只有用户在**这条消息里明确点名**了某个才填，并且必须同时传 override_ui: true。'
        + '其它情况一律不填：界面下拉里选中的就是用户的指定，界面是「自动」时由插件按需求挑。'
        + '填了但没传 override_ui 会被插件忽略。',
    },
    override_ui: {
      type: 'boolean',
      description:
        '只有用户在消息里点名的工作流/变体与界面下拉里的选择不同、确实要改用它时才传 true；'
        + '平时不要传。界面已有明确选择、又没传这个开关时，工具参数会被忽略，按界面选择画。',
    },
    variant: {
      type: 'string',
      description:
        '同一个工作流里的具体跑法（只有这三个工作流有）：'
        + 'qwen-turbo-t2i = fast（快速版，默认）| advanced（进阶版：先让 9B 模型把提示词改写成英文长描述再画）；'
        + 'moss = double（双采，默认）| single（单采，快）；'
        + 'zimage = refine（精修，默认）| single（单次，快）。'
        + '用户说“用 MOSS 单采”“Qwen 进阶版”“Z-Image 单次”时填对应值；其它工作流忽略这个参数。',
    },
    size: {
      type: 'string',
      enum: ASPECT_KEYS,
      description: '画幅比例，默认沿用工作流自己的（多数 16:9，MOSS/Z-Image 是 9:16）。',
    },
    megapixels: {
      type: 'number',
      description: '总像素（百万），默认 1.0。调大更清楚也更慢。',
    },
    seed: {
      type: 'integer',
      description: '随机种子。同一提示词 + 同一种子 = 同一张图；不填每次都不一样。',
    },
    negative: {
      type: 'string',
      description: '负面提示词。只有 MOSS 的 cfg 让它真正生效，其它 turbo 工作流可以不管。',
    },
    reference: {
      type: 'string',
      description:
        '参考图的本地路径（和 reference_url 二选一）。Qwen 编辑与 SeedVR2 必填：编辑=按这张图改，超分=把这张图放大。',
    },
    reference_url: {
      type: 'string',
      description:
        '参考图的网络地址（只支持公网 http/https；本机、局域网、内网地址会被拒绝），和 reference 二选一。'
        + '插件会先下载到临时目录再传给 ComfyUI。'
        + '画**特定角色**时首选这条路：先搜到官方/高清立绘，把图片地址填这里，用 qwen-turbo-edit 让模型按原图改'
        + '（去掉水印文字、清理背景、提升清晰度，保留人物长相与设定），比纯文字硬画像得多。',
    },
    references: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 4,
      description:
        '多张参考图的本地路径（最多 4 张，qwen-turbo-edit 专属）。第 1 张定长相/主构图，第 2..4 张补服装、配色、'
        + '细节——融合不同图源比只拿一张更稳。和 references_urls 可以混用。',
    },
    reference_urls: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 4,
      description:
        '多张参考图的网络地址（最多 4 张，qwen-turbo-edit 专属，插件会逐张下载）。'
        + '画特定角色时**至少找两张不一样的**（官方立绘 + 设定图/同人高清图/表情集），让模型融合特征，'
        + '不要只抓一张就重画。',
    },
    scale: {
      type: 'number',
      description: 'SeedVR2 放大倍率（1-4，默认 2）。',
    },
    lora: {
      type: 'boolean',
      description: 'Krea2 是否叠加 krea2_darkbrush LoRA（默认关闭）。',
    },
    refine: {
      type: 'boolean',
      description: 'Krea2 是否先用小模型扩写提示词（默认关闭，保持用户原意）。',
    },
  },
  required: ['prompt'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workflow: { type: 'string' },
    variant: { type: 'string' },
    workflowSource: { type: 'string' },
    workflowLabel: { type: 'string' },
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    seed: { type: 'integer' },
    seconds: { type: 'number' },
    prompt: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['workflow', 'variant', 'workflowSource', 'workflowLabel', 'path', 'width', 'height', 'seed', 'seconds', 'prompt', 'files'],
}

function syncPickerToWorkflow(state, workflowId, variant, log) {
  if (state.workflow === workflowId && (variant === null || variant === undefined || state.variant === variant)) {
    return false
  }
  state.workflow = workflowId
  state.variant = variant ?? null
  try {
    writeUiState({ workflow: workflowId, variant: state.variant })
    log('info', `界面选择已同步为 ${workflowId}/${state.variant ?? '-'}`)
  } catch (error) {
    log('warn', `同步界面选择失败（不影响出图）：${error?.message ?? error}`)
  }
  return true
}

function resolveWorkflowChoice(state, args, prompt, referencePath, log) {
  const view = workflowView(state)
  // 界面上的选择是用户的决定：界面上不是「自动」时，工具参数默认靠边站，
  // 必须显式传 override_ui: true（只在用户这条消息里点名了别的工作流时才该传）。
  const uiExplicit = state.workflow !== 'auto'
  const overrideAllowed = args?.override_ui === true
  const asked = normalizeWorkflow(args?.workflow, view)
  let requested = asked
  if (uiExplicit && !overrideAllowed) {
    if (asked !== null && asked !== state.workflow) {
      log('warn', `界面选的是 ${state.workflow}，忽略工具参数里的 ${asked}（要改需 override_ui: true）`)
    }
    requested = null
  }
  const picked = requested ?? state.workflow
  const workflowSource = requested !== null ? 'param' : (uiExplicit ? 'ui' : 'auto')
  let resolution = picked === 'auto' || picked === null
    ? chooseWorkflow(prompt, referencePath, state.legacyReady === true)
    : { workflow: picked, variant: state.variant }
  let id = resolution.workflow
  if (view[id] === undefined) {
    // 选择器内部出错时不要弄死这次作画请求，退回最稳的官方文生图。
    log('warn', `工作流 ${String(id)} 不存在，退回 Qwen-Image 2.1`)
    id = DEFAULT_WORKFLOW
    resolution = { workflow: id, variant: null }
  }
  const spec = view[id]
  // 变体优先级：界面锁定时完全听界面的；否则 工具参数 > 解析结果 > 工作流默认
  const uiVariantLock = uiExplicit && !overrideAllowed
  const askedVariant = uiVariantLock ? null : normalizeVariant(id, args?.variant, view)
  let variant = uiVariantLock
    ? (normalizeVariant(id, state.variant, view) ?? spec.defaultVariant)
    : (askedVariant ?? normalizeVariant(id, resolution.variant, view) ?? spec.defaultVariant)
  if (spec.variants[variant] === undefined) variant = spec.defaultVariant
  if (uiVariantLock && typeof args?.variant === 'string' && args.variant.trim() !== '') {
    log('warn', `界面选的是 ${state.variant ?? spec.defaultVariant}，忽略工具参数里的变体 ${args.variant}`)
  } else if (!uiVariantLock && typeof args?.variant === 'string' && args.variant.trim() !== '' && askedVariant === null) {
    log('warn', `${id} 没有变体「${args.variant}」，用默认 ${variant}`)
  }
  return { id, variant, workflowSource, spec, pickedVariant: spec.variants[variant] }
}

function makeDrawTool(ctx, cfg, log, state, onProduced) {
  return {
    name: 'comfyui_draw',
    description:
      '调用主人本机 ComfyUI 里**已保存的工作流**出图。纯本地、不出网、不花钱。'
      + '可用工作流：qwen-turbo-t2i（通用文生图，最快）、qwen-turbo-edit（按参考图改写）、'
      + 'krea2-turbo（胶片感/艺术插画）、moss（中文文字、海报、排版最强）、'
      + 'zimage（写实锐利、自带精修）、seedvr2（把参考图放大/修复清晰度）。'
      + '用户点名了工作流就填 workflow；没点名会自动用界面上选中的那个，界面是「自动」时由插件按需求挑。'
      + '三个工作流还有二级变体（variant）：qwen-turbo-t2i 的 fast/advanced、moss 的 double/single、'
      + 'zimage 的 refine/single；用户说「单采」「进阶版」「单次」时把 variant 一起填上。'
      + '需要参考图的两个工作流（qwen-turbo-edit / seedvr2）必须给 reference 本地路径。'
      + '出图后把返回的绝对路径用 Markdown 图片内联展示给用户，并把实际使用的提示词一起说出来。'
      + 'ComfyUI 会在后台自动启动，空闲 5 分钟自动关停。',
    parameters: PARAMETERS,
    timeoutMs: cfg.timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: `已出图：${value.path}（${value.workflowLabel}，${value.width}x${value.height}，seed ${value.seed}，${value.seconds}s）\n提示词：${value.prompt}`,
        },
      ],
      presentationMeta: (_args, value) => ({ path: value.path, workflow: value.workflow, prompt: value.prompt }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const signal = exec?.signal
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt === '') throw new Error('prompt 不能为空：请描述你想画什么。')
      const referenceFiles = []
      const addRefFile = (value) => {
        if (typeof value === 'string' && value.trim() !== '' && !referenceFiles.includes(value.trim())) {
          referenceFiles.push(value.trim())
        }
      }
      if (Array.isArray(args?.references)) args.references.forEach(addRefFile)
      addRefFile(args?.reference)
      const urlList = [
        ...(Array.isArray(args?.reference_urls) ? args.reference_urls : []),
        ...(typeof args?.reference_url === 'string' ? [args.reference_url] : []),
      ].filter((u) => typeof u === 'string' && /^https?:/iu.test(u.trim()))
      const seenUrls = new Set()
      for (const url of urlList.slice(0, 4)) {
        const trimmed = url.trim()
        if (seenUrls.has(trimmed)) continue
        seenUrls.add(trimmed)
        addRefFile(await downloadReference(trimmed, log, signal))
      }
      const referenceFile = referenceFiles[0] ?? ''
      const { id, variant, workflowSource, spec, pickedVariant } = resolveWorkflowChoice(
        state, args, prompt, referenceFile, log)
      // 按参考图改画时，把界面上的选择同步成 Qwen Edit（用户能在下拉里看到这次用的就是它）。
      // 只在确实拿着参考图走编辑时同步，纯文字出图不动用户的选择。
      if (id === 'qwen-turbo-edit' && referenceFile !== '') {
        syncPickerToWorkflow(state, id, variant, log)
      }
      if (spec.needsReference && referenceFile === '') {
        throw new Error(`${spec.label} 需要一张参考图：请把本地图片路径填到 reference。`)
      }
      if (!spec.enableReference && referenceFile !== '') {
        log('warn', `${spec.label} 不支持参考图，已忽略 reference`)
      }

      const aspectKey = typeof args?.size === 'string' && ASPECT_LABELS[args.size] !== undefined
        ? args.size
        : (spec.defaultAspect ?? '1:1')
      const aspect = ASPECT_LABELS[aspectKey] ?? '1:1 (Square)'
      const megapixels = Number.isFinite(args?.megapixels) && args.megapixels > 0
        ? Math.min(8, args.megapixels)
        : (spec.defaultMegapixels ?? 1)
      const seed = Number.isFinite(args?.seed)
        ? Math.trunc(args.seed)
        : Math.floor(Math.random() * 2 ** 31)
      const prefix = `dsh-comfyui/${id}/${Date.now()}`

      const job = {
        stage: 'starting', workflow: id, variant,
        workflowLabel: `${spec.label} · ${pickedVariant.label}`,
        prompt: prompt.slice(0, 120), startedAt: Date.now(), promptId: null,
        frame: aspectFrame(aspectKey),
      }
      state.job = job

      try {
        await ensureComfyUp(cfg, log, signal)
        job.stage = 'uploading'
        let reference = ''
        const referenceNames = []
        const usable = spec.enableReference
          ? (pickedVariant.needsReference === true || spec.needsReference === true
            ? referenceFiles.slice(0, 4)
            : referenceFiles.slice(0, 1))
          : []
        if (pickedVariant.needsReference === true && referenceFiles.length === 0) {
          throw new Error(`「${spec.label} · ${pickedVariant.label}」需要一张参考图：传 reference 或 reference_url`)
        }
        for (const file of usable) {
          const uploaded = await uploadImage(cfg, file, log, signal)
          referenceNames.push(uploaded)
          log('info', `参考图已交给 ComfyUI：${file} → ${uploaded}`)
        }
        reference = referenceNames[0] ?? ''
        if (id === 'seedvr2' && referenceFile !== '') {
          // 超分不改画幅，占位框要跟参考图的比例走。
          const dims = await readImageSize(referenceFile)
          if (dims !== null && dims.width > 0 && dims.height > 0) {
            job.frame = { w: dims.width, h: dims.height }
          }
        }

        const template = state.templates[pickedVariant.file]
        if (template === undefined) throw new Error(`工作流模板缺失：${pickedVariant.file}`)
        const wf = structuredClone(template)
        pickedVariant.patch(wf, {
          prompt, seed, aspect, megapixels, prefix, reference, references: referenceNames,
          negative: typeof args?.negative === 'string' ? args.negative : '',
          scale: args?.scale, lora: args?.lora === true, refine: args?.refine === true,
        })

        job.stage = 'queued'
        const promptId = await submitPrompt(cfg, wf, signal)
        job.promptId = promptId
        log('info', `已提交 ${spec.short}/${pickedVariant.label} ${aspectKey} ${megapixels}MP seed=${seed} → ${promptId}`)

        const started = Date.now()
        const { images, entry } = await waitForResult(cfg, promptId, {
          signal,
          timeoutMs: cfg.timeoutMs,
          onTick: async () => {
            job.stage = 'sampling'
            const queue = await state.status.queueState()
            const running = queue.running.some((item) => Array.isArray(item) && item[1] === promptId)
            if (!running) job.stage = 'queued'
          },
        })
        job.stage = 'saving'
        const seconds = Number(((Date.now() - started) / 1000).toFixed(1))

        await fsp.mkdir(cfg.outputDir, { recursive: true })
        const files = []
        let first = null
        let index = 0
        for (const image of images.slice(0, 4)) {
          index += 1
          const bytes = await fetchImageBytes(cfg, image, signal)
          const meta = image?.metadata ?? {}
          const width = Number(meta.width) || 0
          const height = Number(meta.height) || 0
          const ext = path.extname(String(image.filename ?? '')) || '.png'
          const suffix = Object.keys(spec.variants).length > 1 ? `-${variant}` : ''
          const filename = `${safeStem(prompt)}_${spec.short.replace(/\s+/gu, '-')}${suffix}_${String(index).padStart(2, '0')}${ext}`
          const target = await uniquePath(cfg.outputDir, filename)
          await fsp.writeFile(target, bytes)
          files.push(target)
          if (first === null) first = { path: target, width, height }
          log('info', `落盘 ${target}（${bytes.length} 字节，${width}x${height}）`)
        }
        if (first === null) throw new Error('ComfyUI 报告成功，但没取到任何图片')

        const value = {
          workflow: id,
          variant,
          workflowSource,
          workflowLabel: `${spec.label} · ${pickedVariant.label}`,
          path: first.path,
          width: first.width,
          height: first.height,
          seed,
          seconds,
          prompt,
          files,
        }
        job.stage = 'done'
        state.lastResult = { ...value, at: Date.now() }
        if (onProduced) {
          try {
            onProduced(exec, value)
          } catch (error) {
            log('warn', `登记交付事件失败（不影响出图）：${error?.message ?? error}`)
          }
        }
        return value
      } catch (error) {
        job.stage = 'error'
        job.error = String(error?.message ?? error).slice(0, 300)
        if (job.promptId !== null) await cancelPrompt(cfg, job.promptId, log)
        throw error
      } finally {
        state.job = job.stage === 'done' || job.stage === 'error' ? { ...job, finishedAt: Date.now() } : job
      }
    },
  }
}

/* ------------------------------------------------------------------ 入口 ---- */

export function apply(root, rawConfig) {
  const log = makeLog(root)
  // 默认值 ← 本机私有配置 ← bundle/profile 配置，再自动探测 ComfyUI 安装位置。
  const cfg = resolveConfig(rawConfig, log)

  // 界面选择的工作流：界面上最后选的那个是用户的决定，优先于 bundle 配置里的默认值。
  const savedUi = readUiState()
  {
    const restored = normalizeWorkflow(savedUi.workflow)
    if (restored !== null) cfg.workflow = restored
  }
  {
    const family = cfg.workflow === 'auto' ? null : cfg.workflow
    const restoredVariant = family === null ? null : normalizeVariant(family, savedUi.variant)
    cfg.variant = restoredVariant ?? (family === null ? null : WORKFLOWS[family].defaultVariant)
  }
  // 空闲关停固定按配置走（默认 60 秒）；界面上不再提供分钟数选择。

  // 预加载 API 工作流模板（变体共用文件，按文件名去重）
  const templates = {}
  const templateFiles = [
    ...new Set(WORKFLOW_IDS.flatMap((id) => Object.values(WORKFLOWS[id].variants).map((v) => v.file))),
  ]
  for (const name of templateFiles) {
    const file = path.join(WORKFLOW_DIR, name)
    try {
      templates[name] = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      log('warn', `工作流模板读不到（${name} ← ${file}）：${error?.message ?? error}`)
    }
  }

  // 提示词写法随插件交付成一个 skill：画图前先 skill({ name }) 读全文。
  root.inject(['skills'], (skillsCtx) => {
    try {
      const content = stripFrontmatter(readFileSync(SKILL_FILE, 'utf8'))
      skillsCtx.effect(
        () => skillsCtx.skills.register({
          name: 'comfyui-workflow-prompts',
          description:
            '给 dsh-comfyui-use 的六个本地 ComfyUI 工作流写画面提示词：'
            + 'Qwen-Image 2.1 Turbo（快速/进阶）、Qwen-Image 2.1 Turbo Edit、Krea2 Turbo、MOSS、Z-Image Turbo、SeedVR2。'
            + '当用户要求画图、生成海报/照片/插画，或按参考图改图、放大修复图片时使用。',
          whenToUse:
            '调用 comfyui_draw 之前：先按这份规则把用户的一句话写成对应模型吃得动的提示词，再决定 workflow / variant / 尺寸。',
          source: 'custom',
          provider: 'comfyui-use',
          content,
        }),
        'comfyui-use:skill',
      )
      log('info', `已注册 skill comfyui-workflow-prompts（${content.length} 字符）`)
    } catch (error) {
      log('warn', `注册提示词 skill 失败（不影响出图）：${error?.message ?? error}`)
    }
  })

  root.inject(['tools', 'sessionProjections'], (ctx) => {
    const status = makeComfyStatus(cfg)
    const idle = makeIdleShutdown(cfg, log, status)
    const state = {
      workflow: cfg.workflow,
      variant: cfg.variant,
      templates,
      imports: readImports(log),
      legacyReady: null,
      lastDoctor: null,
      job: null,
      lastResult: null,
      status,
    }

    const pending = new WeakMap()
    const onProduced = (exec, value) => {
      idle.touch()
      const session = exec?.agent?.session
      if (session === undefined) return
      let turn
      try {
        const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
        turn = boundary?.lastTurn
      } catch {
        turn = undefined
      }
      if (!Number.isSafeInteger(turn)) return
      pending.set(exec, {
        session,
        turn,
        files: value.files.map((file) => ({ path: file, description: `${value.workflowLabel} 生成` })),
      })
    }

    const tool = makeDrawTool(ctx, cfg, log, state, onProduced)
    ctx.tools.register(tool)
    const checkTool = makeCheckTool(ctx, cfg, state, log)
    ctx.tools.register(checkTool)
    const importTool = makeImportTool(cfg, state, log)
    ctx.tools.register(importTool)
    log('info', `已注册工具 ${tool.name} / ${checkTool.name} / ${importTool.name}`
      + `（ComfyUI=${cfg.comfyUrl}，输出=${cfg.outputDir}，导入=${state.imports.length}）`)

    // 让"出图后正文内联展示"成为固有行为
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        systemPrompt.section({
          name: 'comfyui-use:inline-image',
          order: 9102,
          text:
            '用 comfyui_draw 出图前，必须先在回复里把这次确定的提示词写出来（一两句说明 + 完整 prompt 原文），'
            + '然后再调用工具；用户看完可以当场叫停或让你改词。'
            + '出图后，必须在回复正文里用 Markdown 图片语法把生成的图直接展示给用户：'
            + '![画面简述](<图片的绝对路径>)。不要把图片路径放进代码块，也不要只给路径或链接而不给图。'
            + '同时把这次实际使用的提示词原样写出来（放在图片下面，用引用或代码块都行；'
            + '如果是从一句很短的原始需求扩写的，注明原始需求与扩写方向）。'
            + '一次请求只出一张图，不要连着调用多次。',
        })
        systemPrompt.section({
          name: 'comfyui-use:workflow-choice',
          order: 9103,
          text:
            '【ComfyUI 工作流】默认只有一个内置工作流：`qwen-image-2.1`（ComfyUI 官方的 Qwen-Image 2.1，25 步、cfg 1），'
            + '它有两个变体：`t2i`（文生图，默认）和 `edit`（图片编辑，必须给参考图）。'
            + '插件还留着六个旧打包工作流（qwen-turbo-t2i / qwen-turbo-edit / krea2-turbo / moss / zimage / seedvr2），'
            + '但它们依赖我这一套其它模型，只在 comfyui_check 确认齐全（status.legacyReady=true）时才可用，'
            + '界面上不可用的那几项是灰的、标着「缺模型」。'
            + '用户本机 ComfyUI 里已有的工作流可以用 `comfyui_import` 加进来（id 形如 `local:<名字>`）；'
            + '先跑 `comfyui_check`：如果 localCandidates 里有 ok:true 的，先问用户要不要用他们自己的、而不是让他们去下我这套模型。'
            + '缺模型时 comfyui_check 会逐文件给魔搭（ModelScope）下载链接和该放的目录，把链接原样转给用户。'
            + '用户说「MOSS 单采」「Qwen 进阶版」这类时，workflow 和 variant 一起填，并同时传 override_ui: true。'
            + '没点名时不要自己乱填 workflow：输入框下拉里选中的就是用户的指定，界面是「自动」时由插件按需求挑。'
            + '插件层面有硬保护：界面上不是「自动」时，工具里的 workflow/variant 会被忽略，除非同一次调用里传 override_ui: true。'
            + '写提示词之前先调用 skill 工具加载 comfyui-workflow-prompts。'
            + '至少记住三条：画面里的文字要加引号；cfg 1 的模型（Qwen 2.1 / Qwen Turbo / Z-Image）不要传 negative；尺寸用 16 的倍数。'
            + '用户的画图需求只有一句、缺主体细节/风格/文字/比例时，先用 1–2 个问题补关键信息再画（最多 3 个，不要长篇分析）；'
            + '遇到动漫/游戏/社区角色名（如「崩铁的花火」「Grok 娘」）而模型未必认识时：先联网找图，'
            + '**不要只抓一张就重画——至少找 2 张（最好 3–4 张）不同来源/角度的**（官方立绘定长相、设定图补背面与配饰、同人高清图补配色），≥1024px、尽量无水印，'
            + '然后用官方的编辑变体融合改画（`workflow: "qwen-image-2.1"` + `variant: "edit"` + `override_ui: true` + `reference_urls: [图1, 图2, ...]`，最多 4 张），'
            + '提示词写清每张图的分工：「以第一张为准保留长相/发型/主配色，融合第二张的服装结构与配饰，去掉水印/logo/文字/噪点，清理背景，提升清晰度」；'
            + '要更大更清晰就再走 seedvr2（也要先确认它的模型在不在）。'
            + '但**不要无条件触发**：Saber、明日香、初音这类知名度极高、训练数据里有大量图的，直接文生图 + 写清特征即可，'
            + '只有画出来明显不像、或用户明确要求「要像原图」时才退回图改。'
            + '判断要落在**这一个角色**身上，不能按作品名气一刀切：原神、崩铁这类长线运营游戏角色一直在更新，'
            + '近一年内首次登场的新角色（以及冷门龙套）训练数据里很可能没有，默认走图改；老角色图多，可以文生图、不像再退回。'
            + '依据是角色上线时间、同人图/官方立绘数量，拿不准就先文本画一版或问一句。'
            + '一旦按参考图改画，插件会自动把界面下拉切到对应的编辑变体，交付时说明一句。'
            + '用户说随便/你定/快点就直接按默认补全并说明。信息够了就立刻调用工具，不要拖。'
            + '调用 comfyui_draw 之前，先在回复里写出这次确定的完整提示词（一句话说明选型即可），再开始画；用户可当场打断改词。',
        })
        log('info', '已注册 systemPrompt 段落')
      }
    } catch (error) {
      log('warn', `注册 systemPrompt 段落失败（不影响出图）：${error?.message ?? error}`)
    }

    // 启动预热（可选，默认关闭：DSH 启动时不占显存，画图时才拉起 ComfyUI）
    try {
      ctx.effect(() => {
        if (cfg.warmupOnLoad !== true) return undefined
        if (cfg.autoStartComfy === false) return undefined
        let cancelled = false
        Promise.resolve()
          .then(() => status.probe(false))
          .then((online) => {
            if (cancelled) return undefined
            if (online) {
              idle.touch()
              log('info', '启动预热：ComfyUI 已在线')
              return undefined
            }
            log('info', '启动预热：ComfyUI 不在线，后台拉起')
            return ensureComfyUp(cfg, log, null).then((result) => {
              if (!cancelled) idle.touch()
              return result
            })
          })
          .catch((error) => log('warn', `启动预热失败（出图时还会再试）：${error?.message ?? error}`))
        return () => { cancelled = true }
      }, 'comfyui-use:warmup')
    } catch (error) {
      log('warn', `注册启动预热失败（不影响出图）：${error?.message ?? error}`)
    }

    // 交付事件
    ctx.on('tools/result', (exec, result) => {
      const delivery = pending.get(exec)
      pending.delete(exec)
      if (delivery === undefined || result?.isError) return
      try {
        delivery.session.append('deliverables/presented', {
          turn: delivery.turn,
          callId: exec.callId,
          files: delivery.files,
        })
      } catch (error) {
        log('warn', `append deliverables/presented 失败：${error?.message ?? error}`)
      }
    })

    // 空闲关停
    if (cfg.autoShutdown) {
      try {
        ctx.effect(() => {
          const timer = setInterval(() => {
            idle.tick().catch((error) => log('warn', `空闲检查出错：${error?.message ?? error}`))
          }, cfg.idleCheckMs)
          if (typeof timer.unref === 'function') timer.unref()
          log('info', `空闲关停已启用：${Math.round(cfg.idleShutdownMs / 60000)} 分钟没出图就关掉 ComfyUI`)
          return () => clearInterval(timer)
        }, 'comfyui-use:idle-shutdown')
      } catch (error) {
        log('warn', `启动空闲关停失败（不影响出图）：${error?.message ?? error}`)
      }
    }

    // 状态 / 选择端点
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (webCtx) => {
      const handler = async (req, res) => {
        if (!isLocalRequest(req)) {
          respondJson(res, { ok: false, reason: 'local requests only' }, 403)
          return
        }
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method === 'POST') {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const hasWorkflow = body?.workflow !== undefined || body?.id !== undefined
            const hasIdle = body?.idleMinutes !== undefined
            if (!hasWorkflow && !hasIdle) {
              respondJson(res, { ok: false, reason: 'nothing to change' }, 400)
              return
            }
            let picked = null
            let variant = null
            if (hasWorkflow) {
              picked = normalizeWorkflow(body?.workflow ?? body?.id)
              if (picked === null) {
                respondJson(res, { ok: false, reason: 'unknown workflow' }, 400)
                return
              }
              variant = picked === 'auto'
                ? null
                : (normalizeVariant(picked, body?.variant) ?? WORKFLOWS[picked].defaultVariant)
            }
            let idleMinutes = null
            if (hasIdle) {
              const minutes = Number(body.idleMinutes)
              if (!IDLE_OPTIONS_MIN.includes(minutes)) {
                respondJson(res, { ok: false, reason: 'idleMinutes must be one of 1, 3, 5, 10' }, 400)
                return
              }
              idleMinutes = minutes
            }
            const patch = {}
            if (hasWorkflow) {
              state.workflow = picked
              state.variant = variant
              cfg.workflow = picked
              cfg.variant = variant
              patch.workflow = picked
              patch.variant = variant
              log('info', `界面工作流切换为 ${picked}${variant === null ? '' : ` / ${variant}`}`)
            }
            if (hasIdle) {
              cfg.idleShutdownMs = idleMinutes * 60000
              patch.idleMinutes = idleMinutes
              log('info', `空闲关停调整为 ${idleMinutes} 分钟`)
            }
            writeUiState(patch, log)
            respondJson(res, {
              ok: true,
              selected: state.workflow,
              selectedVariant: state.variant,
              idleMinutes: Math.round(cfg.idleShutdownMs / 60000),
            })
            return
          } catch (error) {
            respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 400)
            return
          }
        }
        try {
          const online = await status.probe()
          const queue = online ? await status.queueState() : { busy: false }
          respondJson(res, {
            ok: true,
            version,
            online,
            busy: queue.busy,
            url: cfg.comfyUrl,
            comfy: {
              port: cfg.port,
              python: cfg.comfyPython,
              mainPy: cfg.comfyMainPy,
              source: cfg.comfySource,
            },
            selected: state.workflow,
            selectedVariant: state.variant,
            idleMinutes: Math.round(cfg.idleShutdownMs / 60000),
            idleOptions: IDLE_OPTIONS_MIN,
            workflows: workflowRows(state),
            imports: (state.imports ?? []).map((record) => ({
              id: record.id,
              label: record.label,
              file: record.file,
            })),
            legacyReady: state.legacyReady === true,
            defaultWorkflow: DEFAULT_WORKFLOW,
            downloads: state.lastDoctor?.downloads ?? [],
            localCandidates: state.lastDoctor?.localCandidates ?? [],
            lastDoctor: state.lastDoctor === null ? null : {
              ok: state.lastDoctor.ok,
              at: state.lastDoctor.at,
            },
            job: state.job === null ? null : {
              stage: state.job.stage,
              workflow: state.job.workflow,
              variant: state.job.variant,
              workflowLabel: state.job.workflowLabel,
              promptId: state.job.promptId,
              startedAt: state.job.startedAt,
              error: state.job.error ?? null,
            },
            last: state.lastResult === null ? null : {
              workflow: state.lastResult.workflow,
              variant: state.lastResult.variant,
              path: state.lastResult.path,
              at: state.lastResult.at,
            },
            ...idle.snapshot(),
          })
        } catch (error) {
          respondJson(res, { ok: false, reason: String(error?.message ?? error) })
        }
      }
      try {
        webCtx.effect(() => {
          const disposers = [
            '/api/comfyui-use/status.json',
            '/comfyui-use/status.json',
          ].map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          log('info', '已注册状态端点 /api/comfyui-use/status.json')
          return () => { for (const dispose of disposers) dispose() }
        }, 'comfyui-use:status-route')
      } catch (error) {
        log('warn', `注册状态端点失败（不影响出图）：${error?.message ?? error}`)
      }
    })
  })
}

/** 自测用内部导出。 */
export const __internal = {
  DEFAULTS,
  resolveConfig,
  isPrivateAddress,
  assertPublicUrl,
  runDoctor,
  isPortFree,
  resolveWorkflowChoice,
  analyzeWorkflowJson,
  scanLocalWorkflows,
  workflowRows,
  syncPickerToWorkflow,
  downloadReference,
  ensureComfyUp,
  startComfyHidden,
  findComfyProcess,
  WORKFLOWS,
  WORKFLOW_IDS,
  ASPECT_LABELS,
  normalizeWorkflow,
  normalizeVariant,
  variantRows,
  chooseWorkflow,
  safeStem,
  portOf,
}








