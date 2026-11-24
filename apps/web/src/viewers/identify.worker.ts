import { Magika } from 'magika'

export type FormatResult = { label: string; isText: boolean }

self.onmessage = async (event: MessageEvent<{ modelBase: string; sample: Uint8Array }>) => {
  try {
    const { modelBase, sample } = event.data
    const model = await Magika.create({
      modelURL: new URL('model.json', modelBase).href,
      modelConfigURL: new URL('config.min.json', modelBase).href,
    })
    const result = await model.identifyBytes(sample)
    if (result.status !== 'ok') throw new Error('Identification failed')
    const { label, is_text } = result.prediction.output
    self.postMessage({ label, isText: is_text } satisfies FormatResult)
  } catch {
    self.postMessage({ error: '无法运行 Magika，请检查模型资源是否可读取后重试。' })
  }
}
