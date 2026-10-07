import { cachePeriod, pendingAssets, cacheProgress } from './cache-policy.js';

// Every completed page and asset is durable. A new runner can continue after Safari
// suspends the background; partially downloaded bytes are retried as a whole image.
export class CacheRunner {
  constructor(io) { this.io = io; }
  async run(account, { budget = 18000, retry = false } = {}) {
    const io = this.io, started = io.now();
    let job = await io.job(account) || { key: account, phase: 'idle', failures: {} };
    if (job.quotaPaused && !retry) return { pending: false, job };
    if ((job.retryAt || 0) > started && !retry) return { pending: false, job };
    if (retry) { job.failures = {}; job.quotaPaused = false; job.retryAt = 0; }
    const save = async changes => { job = { ...job, ...changes, updatedAt: io.now(), key: account }; await io.save(job); };
    try {
      await io.verify(account);
      if (job.activeAsset) await save({ activeAsset: null });
      if (!job.scan && io.now() - (job.lastSync || 0) >= 30000) {
        await save({ phase: 'scan', scan: { cursor: null, offset: 0, seenIds: [], pages: 0, startedAt: io.now() }, error: '', retryAt: 0 });
      }
      let advanced = false;
      do {
        if (job.scan) {
          const scan = job.scan;
          const page = await io.page(account, scan);
          const expanded = [...page.images];
          for (const conversation of page.conversations || []) expanded.push(...await io.conversation(account, conversation));
          if (page.itemCount && !expanded.length && !page.skippedCount) throw Object.assign(new Error('无法识别图片库数据，已保留原有图片。'), { code: 'DATA' });
          const seen = new Set(scan.seenIds), before = seen.size;
          for (const image of expanded) seen.add(image.id);
          if (scan.pages && expanded.length && before === seen.size) throw Object.assign(new Error('图片库重复返回同一页，已保留原有图片。'), { code: 'DATA' });
          // A repeated/non-advancing cursor is a failure, never proof of deletion.
          if (page.cursor && page.cursor === scan.cursor) throw Object.assign(new Error('图片库分页未继续前进，已保留原有图片。'), { code: 'DATA' });
          await io.merge(account, expanded, false);
          const next = { ...scan, cursor: page.cursor, offset: scan.offset + page.itemCount, seenIds: [...seen], pages: scan.pages + 1 };
          const done = !page.itemCount || page.hasMore === false || (!page.cursor && page.hasMore !== true);
          if (done) {
            const records = await io.images(account);
            const snapshot = records.filter(image => seen.has(image.id) || image.createdAt > scan.startedAt);
            await io.merge(account, snapshot, true);
            await save({ scan: null, phase: 'cache', lastSync: io.now(), loaded: seen.size, error: '' });
          } else await save({ scan: next, phase: 'scan', loaded: seen.size, error: '' });
          await io.updated(account); advanced = true;
        }
        const period = cachePeriod(await io.period());
        await io.clean(period);
        const images = await io.images(account), metadata = await io.assets(account);
        const pending = pendingAssets(images, metadata, period, job.failures, io.now());
        // Downloads are sequential, with interactive viewing handled independently.
        const batch = pending.slice(0, job.scan ? 2 : 4);
        for (const item of batch) {
          if (io.now() - started >= budget && advanced) break;
          try {
            await save({ activeAsset: { id: item.id, kind: item.kind } });
            await io.progress?.(account);
            await io.asset(account, item.id, item.kind);
            const failures = { ...job.failures }; delete failures[item.key];
            await save({ failures, error: '', retryAt: 0, activeAsset: null });
          } catch (error) {
            if (['AUTH', 'ACCOUNT_CHANGED', 'RATE_LIMIT', 'SOURCE'].includes(error.code) || error.name === 'QuotaExceededError' || error.code === 'QUOTA') throw error;
            const attempts = (job.failures?.[item.key]?.attempts || 0) + 1;
            await save({ activeAsset: null, failures: { ...job.failures, [item.key]: { attempts, retryAt: io.now() + Math.min(600000, 30000 * 2 ** Math.min(attempts - 1, 5)), error: error.message } } });
          }
          advanced = true;
        }
        const progress = cacheProgress(await io.images(account), await io.assets(account), period, io.now());
        await save({ ...progress, phase: job.scan ? 'scan' : progress.completed === progress.total ? 'idle' : 'cache' });
        await io.updated(account);
        if (!job.scan && !pending.length) break;
      } while (io.now() - started < budget);
      const period = cachePeriod(await io.period());
      const pending = pendingAssets(await io.images(account), await io.assets(account), period, job.failures, io.now());
      return { pending: Boolean(job.scan || pending.length), job };
    } catch (error) {
      const quotaPaused = error.name === 'QuotaExceededError' || error.code === 'QUOTA';
      if (['DATA', 'CURSOR'].includes(error.code)) job.scan = null;
      await save({ phase: 'paused', activeAsset: null, error: quotaPaused ? '本地空间不足，缓存已暂停。已保存的图片仍可查看。' : error.message,
        quotaPaused, retryAt: io.now() + (error.code === 'RATE_LIMIT' ? 300000 : 60000) });
      await io.updated(account);
      return { pending: false, job };
    }
  }
}
