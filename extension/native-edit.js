// Runs in ChatGPT's MAIN world. Only image identity and the user's edit are passed in;
// authentication stays inside the site's own request and completion services.
export async function nativeDescribeEdit(input) {
  const fail = message => ({ ok: false, error: message });
  if (location.origin !== 'https://chatgpt.com') return fail('请在 ChatGPT 中提交 Describe edits。');
  if (!input?.account || !input.image?.fileId || !input.image?.conversationId || !input.prompt?.trim()) return fail('缺少原图或编辑指令。');
  const jobKey = '__imageLibraryEditJobs';
  const jobs = window[jobKey] ||= new Map();
  if (jobs.has(input.jobId)) return jobs.get(input.jobId);
  const work = (async () => {
    let dispatched = false;
    try {
      const runtimePath = window.__reactRouterManifest?.entry?.imports?.[0];
      if (!/^\/cdn\/assets\/[\w.-]+\.js$/.test(runtimePath || '')) throw new Error('官网编辑接口尚未就绪。');
      const require = (await import(runtimePath)).__webpack_require__;
      // Guard the native implementation before calling its exports. A site update must
      // fail visibly rather than fall back to editing another image or conversation.
      if (!require?.m?.RW7?.toString().includes('prepareChatGptImageEditOperation') ||
          !require.m.ccw || !require.m.ezq || !require.m.no || !window.__reactRouterDataRouter?.navigate) {
        return { ok: false, ready: false, error: '官网编辑接口尚未就绪，请稍后重试。' };
      }
      const rootScope = require('OW').a;
      let scope;
      for (const element of document.querySelectorAll('input,textarea,[contenteditable],main,form')) {
        let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
        for (let depth = 0; fiber && depth < 180 && !scope; depth++, fiber = fiber.return) {
          for (let hook = fiber.memoizedState, count = 0; hook && count < 300; hook = hook.next, count++) {
            const value = hook.memoizedState?.current;
            if (value?.scope === rootScope && typeof value.get === 'function' && typeof value.set === 'function') { scope = value; break; }
          }
        }
        if (scope) break;
      }
      if (!scope) return { ok: false, ready: false, error: '官网页面尚未就绪，请稍后重试。' };
      const identity = require('LPf'), accountId = scope.get(identity.d), userId = scope.get(identity.i);
      if (!userId || !scope.get(identity.m)) throw new Error('请先在 ChatGPT 登录。');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${accountId || ''}`));
      const account = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (account !== input.account) throw new Error('ChatGPT 账号已切换，请刷新图片库。');
      const native = require('no'), composer = require('Ow'), submit = require('RW7').d, route = require('jA').c;
      // Discover the constructor by its verified contract, not its minified name.
      // Aliases share one function; distinct matches are ambiguous and fail closed.
      const constructors = [...new Set(Object.values(native))].filter(create => {
        if (typeof create !== 'function') return false;
        const source = create.toString().replace(/\s/g, '');
        return create.length === 1 && source.includes('arguments.length>1') &&
          source.includes('arguments[1]') && source.includes('.get(') && source.includes('||') && /,[$\w]+;?}$/.test(source);
      });
      // State exports can shift independently. Keep only verified state layouts;
      // an unknown layout must never be guessed from arbitrary array-valued atoms.
      const bindings = [
        { create: constructors[0], saved: native.j, localIds: native.k },
        { create: constructors[0], saved: native.k, localIds: native.l }
      ].filter(binding => {
        if (constructors.length !== 1 || !binding.saved || !binding.localIds) return false;
        try { return Array.isArray(scope.get(binding.localIds)); } catch { return false; }
      });
      if (bindings.length !== 1 || typeof composer.P !== 'function' || typeof route !== 'function' ||
          typeof submit !== 'function' || !submit.toString().includes('sourceConversationId') ||
          !submit.toString().includes('isSubmissionCurrent') || route('local-test') !== '/c/local-test') {
        throw new Error('官网新会话接口已更新，暂时无法提交 Describe edits；草稿已保留。');
      }
      const binding = bindings[0];
      const model = scope.get(composer.s, scope.get(require('ezq').d, JSON.stringify([accountId, userId])));
      if (!model?.slug) return { ok: false, ready: false, error: '官网图片模型尚未就绪，请稍后重试。' };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const assertCurrent = () => {
          controller.signal.throwIfAborted();
          if (!scope.get(identity.m) || scope.get(identity.d) !== accountId || scope.get(identity.i) !== userId) throw new Error('ChatGPT 账号已切换，编辑已停止。');
        };
        const conversationId = input.image.conversationId;
        const conversation = await require('Kwu').Request.safeGet('/conversation/{conversation_id}', {
          additionalHeaders: accountId ? { 'ChatGPT-Account-ID': accountId } : undefined,
          parameters: { path: { conversation_id: conversationId } }, signal: controller.signal
        });
        assertCurrent();
        const candidates = Object.values(conversation.mapping || {}).flatMap(node =>
          !node.message || (input.image.messageId && node.message.id !== input.image.messageId) ? [] :
            require('ccw').b(node.message, { isActiveTurn: false, isStreaming: false }))
          .filter(image => image.status === 'completed' && require('iq').c(image.src || '') === input.image.fileId);
        if (candidates.length !== 1) throw new Error('无法准确找到原图，请打开原聊天确认图片仍然存在。');
        if (input.dryRun) return { ok: true, verified: true, submissionReady: true };
        const target = binding.create(scope);
        if (typeof target !== 'string' || !/^(?:local-chatgpt:)?[\w-]+$/.test(target)) throw new Error('官网没有创建有效的新会话，草稿已保留。');
        let accepted = false;
        try {
          composer.P(scope, target, model);
          dispatched = true;
          accepted = await submit(scope, {
            beforeRequest: assertCurrent, conversationId: target, image: candidates[0],
            isSubmissionCurrent: () => !controller.signal.aborted && scope.get(identity.d) === accountId && scope.get(identity.i) === userId,
            isTemporaryChat: false, request: { prompt: input.prompt.trim(), attribution: { imageSource: 'generated', editEntryPoint: 'images' } },
            signal: controller.signal, sourceConversationId: conversationId
          });
          if (!accepted) throw new Error('官网未接受编辑指令，草稿已保留。');
          await window.__reactRouterDataRouter.navigate(route(target));
          return { ok: true, submitted: true };
        } finally {
          if (!accepted && !scope.get(binding.saved, target)) scope.set(binding.localIds, values => values.filter(value => value !== target));
        }
      } finally { clearTimeout(timeout); }
    } catch (error) {
      return { ok: false, dispatched, error: dispatched ? '未能确认编辑提交结果，请先检查新窗口，再决定是否重试。' : error.message || 'Describe edits 暂时不可用。' };
    }
  })();
  jobs.set(input.jobId, work);
  const result = await work;
  if (result.ready === false) jobs.delete(input.jobId);
  return result;
}
