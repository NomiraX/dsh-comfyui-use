// UI workflow (ComfyUI frontend graph) -> API prompt converter + parameter inference.
// This is intentionally a conservative subset: it handles ordinary widget graphs,
// mute/bypass, reroutes and primitive nodes. Subgraphs are rejected with a hint.

const VIRTUAL = new Set([
  'Note', 'MarkdownNote', 'Label (rgthree)', 'Reroute', 'PrimitiveNode',
  'Fast Groups Muter (rgthree)', 'Fast Groups Bypasser (rgthree)', 'Bookmark (rgthree)',
])

const SEED_CONTROL = new Set(['fixed', 'randomize', 'increment', 'decrement'])

export function isApiWorkflow(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  const values = Object.values(json)
  return values.length > 0 && values.every((v) => v && typeof v === 'object' && typeof v.class_type === 'string' && v.inputs)
}

export function isUiWorkflow(json) {
  return Boolean(json && Array.isArray(json.nodes) && Array.isArray(json.links))
}

function orderedInputs(objectInfo, classType) {
  const spec = objectInfo?.[classType]
  if (!spec) return null
  const order = spec.input_order
  if (!order) {
    const req = Object.keys(spec.input?.required ?? {})
    const opt = Object.keys(spec.input?.optional ?? {})
    return [...req, ...opt]
  }
  return [...(order.required ?? []), ...(order.optional ?? [])]
}

function inputSpec(objectInfo, classType, name) {
  const spec = objectInfo?.[classType]
  return spec?.input?.required?.[name] ?? spec?.input?.optional?.[name] ?? null
}

function isWidgetInput(spec) {
  if (!spec) return false
  const type = Array.isArray(spec) ? spec[0] : spec.type
  if (Array.isArray(type)) return true // COMBO
  return ['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(type)
}

/**
 * Convert a UI-format workflow into an API prompt.
 * @returns {{ok:boolean, prompt:object, warnings:string[], reason?:string}}
 */
export function uiToApi(workflow, objectInfo) {
  const warnings = []
  if (!isUiWorkflow(workflow)) return { ok: false, prompt: {}, warnings, reason: '不是 ComfyUI 的工作流文件（缺少 nodes/links）' }
  if (workflow.definitions?.subgraphs?.length) {
    return { ok: false, prompt: {}, warnings, reason: '这个工作流含子图（subgraph），请先在 ComfyUI 里用 Export (API) 导出后再导入' }
  }

  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]))
  // link id -> {origin_id, origin_slot, type}
  const links = new Map()
  for (const l of workflow.links) {
    if (Array.isArray(l)) links.set(l[0], { origin_id: l[1], origin_slot: l[2], type: l[5] })
  }
  const incoming = new Map() // node id -> Map(input name -> link info)
  for (const n of workflow.nodes) {
    const m = new Map()
    for (const [slotIndex, input] of (n.inputs ?? []).entries()) {
      if (input?.link == null) continue
      const link = links.get(input.link)
      if (!link) continue
      const name = input.name ?? String(slotIndex)
      m.set(name, { ...link, name })
    }
    incoming.set(n.id, m)
  }

  const resolveReroute = (link, depth = 0) => {
    if (depth > 32) return null
    const origin = nodes.get(link.origin_id)
    if (!origin) return null
    if (origin.type === 'PrimitiveNode') {
      const value = origin.widgets_values?.[0]
      return { kind: 'value', value }
    }
    if (origin.type === 'Reroute' || origin.type === 'Reroute (rgthree)') {
      const upstream = incoming.get(origin.id)?.get(origin.inputs?.[0]?.name ?? '')
      if (!upstream) return null
      return resolveReroute(upstream, depth + 1)
    }
    return { kind: 'link', nodeId: String(origin.id), slot: link.origin_slot }
  }

  const prompt = {}
  const skipped = []

  for (const node of workflow.nodes) {
    const classType = node.type
    if (VIRTUAL.has(classType)) continue
    const mode = node.mode ?? 0
    if (mode === 2) { skipped.push(`${classType}（静音）`); continue }
    if (mode === 4) {
      // Bypass: cg-use doesn't emulate pass-through wiring, refuse instead of producing a wrong graph.
      const outs = node.outputs?.some((o) => o.links?.length)
      if (outs) return { ok: false, prompt: {}, warnings, reason: `节点 ${node.id}（${classType}）被 bypass（紫色），请先在 ComfyUI 里删除或恢复它再导入` }
      continue
    }
    const order = orderedInputs(objectInfo, classType)
    if (!order) return { ok: false, prompt: {}, warnings, reason: `这台 ComfyUI 不认识节点类型 ${classType}（缺自定义节点）` }

    const inputs = {}
    const nodeInputs = incoming.get(node.id) ?? new Map()
    for (const [name, link] of nodeInputs) {
      if (!order.includes(name)) continue
      const resolved = resolveReroute(link)
      if (!resolved) return { ok: false, prompt: {}, warnings, reason: `节点 ${node.id} 的输入 ${name} 连接无法解析` }
      if (resolved.kind === 'link') inputs[name] = [resolved.nodeId, resolved.slot]
      else inputs[name] = resolved.value
    }

    // Widget values map in order to widget-typed inputs that are not linked.
    const widgets = Array.isArray(node.widgets_values) ? [...node.widgets_values] : []
    let w = 0
    for (const name of order) {
      if (inputs[name] !== undefined) continue
      const spec = inputSpec(objectInfo, classType, name)
      if (!isWidgetInput(spec)) continue
      if (w >= widgets.length) break
      inputs[name] = widgets[w++]
      // seed controls ("control_after_generate") are a frontend-only extra widget
      if (name === 'seed' || name === 'noise_seed') {
        if (typeof widgets[w] === 'string' && SEED_CONTROL.has(widgets[w])) w++
      }
    }
    if (w < widgets.length) warnings.push(`${classType}#${node.id} 多出 ${widgets.length - w} 个未映射的 widget`)

    prompt[String(node.id)] = { class_type: classType, inputs }
  }

  if (Object.keys(prompt).length === 0) return { ok: false, prompt: {}, warnings, reason: '转换后没有任何可执行节点' }
  return { ok: true, prompt, warnings }
}

/** Resolve the source node of an input that may be a link or a literal. */
function sourceOf(prompt, ref) {
  if (Array.isArray(ref) && ref.length === 2) return { nodeId: ref[0], slot: ref[1] }
  return null
}

function findFirst(prompt, classes) {
  for (const [id, node] of Object.entries(prompt)) if (classes.includes(node.class_type)) return { id, node }
  return null
}

/**
 * Infer where prompt / seed / size / save prefix live in an API prompt.
 * All inferred entries are optional; callers patch what they find.
 */
export function inferParams(prompt) {
  const out = { prompt: null, seed: null, size: null, save: null, warnings: [] }

  // 1) Save node
  const save = findFirst(prompt, ['SaveImage', 'SaveImageAdvanced', 'Image Save'])
  if (save) out.save = { node: save.id, input: 'filename_prefix' }

  // 2) Sampler -> positive -> text encoder
  const sampler = findFirst(prompt, ['KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced'])
  let positiveNode = null
  if (sampler) {
    const s = sampler.node
    const seedInput = s.inputs?.seed !== undefined ? 'seed' : s.inputs?.noise_seed !== undefined ? 'noise_seed' : null
    if (seedInput) {
      const ref = sourceOf(prompt, s.inputs[seedInput])
      const target = ref ? prompt[ref.nodeId] : null
      if (target && (target.inputs?.seed !== undefined || target.inputs?.noise_seed !== undefined || target.inputs?.value !== undefined)) {
        const key = target.inputs.seed !== undefined ? 'seed' : target.inputs.noise_seed !== undefined ? 'noise_seed' : 'value'
        out.seed = { node: ref.nodeId, input: key }
      } else {
        out.seed = { node: sampler.id, input: seedInput }
      }
    }
    let posRef = sourceOf(prompt, s.inputs?.positive)
    if (posRef && prompt[posRef.nodeId]) {
      positiveNode = posRef.nodeId
      // ConditioningZeroOut / FluxGuidance / ControlNetApply pass through: follow the source for text lookup
      for (let depth = 0; depth < 4; depth++) {
        const node = prompt[positiveNode]
        const passthrough = node.inputs?.conditioning ?? node.inputs?.positive ?? node.inputs?.conditioning_1 ?? node.inputs?.conditioning_to
        const next = sourceOf(prompt, passthrough)
        if (!next) break
        positiveNode = next.nodeId
      }
    }
  }

  // 3) Text node: from positive chain, else biggest string-bearing encoder
  const textClasses = ['CLIPTextEncode', 'TextEncodeQwenImage21', 'TextEncodeQwenImage', 'T5TextEncode', 'CLIPTextEncodeFlux', 'TextEncodeHunyuanDiT']
  const candidates = []
  if (positiveNode) candidates.push(positiveNode)
  for (const [id, node] of Object.entries(prompt)) if (textClasses.includes(node.class_type)) candidates.push(id)
  for (const id of candidates) {
    const node = prompt[id]
    if (!node || !textClasses.includes(node.class_type)) continue
    const textRef = sourceOf(prompt, node.inputs?.text)
    if (textRef && typeof prompt[textRef.nodeId]?.inputs?.value === 'string') {
      out.prompt = { node: textRef.nodeId, input: 'value' }
      break
    }
    if (typeof node.inputs?.text === 'string') { out.prompt = { node: id, input: 'text' }; break }
    // TextEncodeQwenImage21 keeps the prompt in its own `prompt` widget (string or link)
    const promptRef = sourceOf(prompt, node.inputs?.prompt)
    if (promptRef && typeof prompt[promptRef.nodeId]?.inputs?.value === 'string') {
      out.prompt = { node: promptRef.nodeId, input: 'value' }
      break
    }
    if (typeof node.inputs?.prompt === 'string') { out.prompt = { node: id, input: 'prompt' }; break }
  }

  // 4) Size: EmptyLatent* -> optional ResolutionSelector source
  const latent = findFirst(prompt, ['EmptyLatentImage', 'EmptySD3LatentImage'])
  if (latent) {
    const widthRef = sourceOf(prompt, latent.node.inputs?.width)
    const selector = widthRef ? prompt[widthRef.nodeId] : null
    if (selector && selector.class_type === 'ResolutionSelector') {
      out.size = { kind: 'resolution', node: widthRef.nodeId }
    } else {
      out.size = { kind: 'pixels', node: latent.id }
    }
  } else if (!out.size) {
    const selector = findFirst(prompt, ['ResolutionSelector'])
    if (selector) out.size = { kind: 'resolution', node: selector.id }
  }

  if (!out.prompt) out.warnings.push('没找到可以写提示词的文本节点')
  if (!out.seed) out.warnings.push('没找到种子输入')
  return out
}

/** Replace `${input}` on a node, tolerating both API and inferred shapes. */
export function setNodeInput(prompt, nodeId, input, value) {
  const node = prompt?.[String(nodeId)]
  if (!node) return false
  node.inputs = node.inputs ?? {}
  node.inputs[input] = value
  return true
}

export function deleteNode(prompt, nodeId) {
  delete prompt[String(nodeId)]
  for (const node of Object.values(prompt)) {
    if (!node.inputs) continue
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && String(value[0]) === String(nodeId)) node.inputs[key] = 0
    }
  }
}

/** Collect model files referenced by a prompt so the doctor can check them. */
export function modelRefs(prompt) {
  const map = {
    UNETLoader: [['unet_name', 'diffusion_models']],
    CLIPLoader: [['clip_name', 'text_encoders']],
    DualCLIPLoader: [['clip_name1', 'text_encoders'], ['clip_name2', 'text_encoders']],
    VAELoader: [['vae_name', 'vae']],
    LoraLoaderModelOnly: [['lora_name', 'loras']],
    LoraLoader: [['lora_name', 'loras']],
    CheckpointLoaderSimple: [['ckpt_name', 'checkpoints']],
  }
  const refs = []
  for (const node of Object.values(prompt)) {
    const spec = map[node.class_type]
    if (!spec) continue
    for (const [input, dir] of spec) {
      const value = node.inputs?.[input]
      if (typeof value === 'string' && value) refs.push({ classType: node.class_type, input, name: value, dir })
    }
  }
  return refs
}