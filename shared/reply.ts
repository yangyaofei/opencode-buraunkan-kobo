// 零模型回复(同 opencode-acp /acp、quota-retry /retry-setting 模式):
// 本地生成报告 → noReply+ignored 消息写入会话(可回看不触发模型) → 抛哨兵中断模型轮次。

export async function replyLocal(client: any, sessionID: string, text: string, sentinel: string): Promise<never> {
  try {
    await client?.session?.prompt?.({
      path: { id: sessionID },
      body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
    })
  } catch {}
  throw new Error(sentinel)
}
