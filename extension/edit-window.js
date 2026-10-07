import { nativeDescribeEdit } from './native-edit.js';

export async function openEditWindow(extension, input) {
  if (!extension.scripting?.executeScript) throw new Error('当前 Safari 不支持官网编辑连接，请更新 Safari 后重试。');
  const window = await extension.windows.create({ url: 'https://chatgpt.com/images', type: 'normal', focused: true });
  let tab = window.tabs?.[0];
  if (!tab) [tab] = await extension.tabs.query({ windowId: window.id });
  if (!tab?.id) throw new Error('无法打开 Describe edits 窗口。');
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await extension.tabs.get(tab.id);
    const url = state.url || state.pendingUrl;
    if (url && url !== 'about:blank' && !url.startsWith('https://chatgpt.com/')) throw new Error('新窗口已离开 ChatGPT，编辑已停止。');
    if (state.status === 'complete') {
      const results = await extension.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: nativeDescribeEdit, args: [input] });
      const result = results.find(value => value.frameId === 0)?.result;
      if (result?.ok) return { windowId: window.id, ...result };
      if (result?.ready !== false) throw new Error(result?.error || '未能确认编辑提交结果，请先检查新窗口。');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('官网编辑接口加载超时，草稿已保留，请稍后重试。');
}
