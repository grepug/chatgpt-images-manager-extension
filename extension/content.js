(() => {
  const extension = globalThis.browser || globalThis.chrome;
  extension.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== extension.runtime.id || message?.type !== 'source-request') return false;
    globalThis.ImageLibrarySource.request(message.command, message.args).then(reply,
      () => reply({ ok: false, error: '无法读取 ChatGPT 图片库，请重新打开官方图片库。', code: 'SOURCE' }));
    return true;
  });
})();
