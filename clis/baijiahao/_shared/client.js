import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { backendId, count, exactId, normalizeManagement, normalizeStatistics, platformType, statisticsRange } from './model.js';

const ORIGIN = 'https://baijiahao.baidu.com';
const readTokens = new WeakMap();
async function readToken(page) {
  if (readTokens.has(page)) return readTokens.get(page);
  if (!await page.startNetworkCapture('/pcui/article/lists')) throw new CommandExecutionError('Native authenticated read capture is required for draft details');
  await page.goto(`${ORIGIN}/builder/rc/content`, { stealth: false });
  for (let n = 0; n < 40; n++) {
    for (const item of await page.readNetworkCapture()) {
      if (item.method !== 'GET' || !/^https:\/\/baijiahao\.baidu\.com\/pcui\/article\/lists(?:\?|$)/.test(item.url || '')) continue;
      const entry = Object.entries(item.requestHeaders || {}).find(([key]) => key.toLowerCase() === 'token');
      if (typeof entry?.[1] === 'string' && entry[1]) { readTokens.set(page, entry[1]); return entry[1]; }
    }
    await page.wait(0.25);
  }
  throw new CommandExecutionError('No native authenticated management read was observed; draft detail was not requested');
}
export async function bootstrap(page) {
  let origin;
  try { origin = await page.evaluate('location.origin'); }
  catch (error) {
    if (!/Page not found|stale page identity|target.*closed/i.test(String(error?.message || error))) throw error;
  }
  // Long uploads run in a separate editor lease. The original read lease may
  // have idled out; Page.goto renews its stale identity before another API read.
  if (origin !== ORIGIN) await page.goto(`${ORIGIN}/builder/rc/content`, { stealth: false });
}
export async function request(page, path) {
  if (!/^\/(?:builder\/app\/appinfo|pcui\/article\/(?:lists|edit)|author\/eco\/statistics\/articleListStatistic)(?:\?|$)/.test(path)) throw new CommandExecutionError('Unsupported Baijiahao read endpoint');
  await bootstrap(page);
  const token = path.startsWith('/pcui/article/edit?') ? await readToken(page) : undefined;
  let response;
  try { response = await page.evaluate(`(async () => {
    if (location.origin !== ${JSON.stringify(ORIGIN)}) return {wrongOrigin:true};
    if (location.pathname.split('/').includes('login')) return {login:true};
    const r=await fetch(${JSON.stringify(path)},{credentials:'include',cache:'no-store',headers:${JSON.stringify(token ? { token } : {})}});
    let body;try{body=await r.json();}catch{return {status:r.status,invalidJson:true};}
    return {status:r.status,body};
  })()`); } catch { throw new CommandExecutionError('Could not read the Baijiahao backend'); }
  if (response?.login || response?.status === 401 || response?.body?.errno === 10000013) throw new AuthRequiredError('baijiahao.baidu.com');
  if (!response || response.wrongOrigin || response.invalidJson || response.status !== 200 || response.body?.errno !== 0 || !response.body.data) throw new CommandExecutionError(`Baijiahao read failed (HTTP ${response?.status ?? 'unavailable'}, errno ${response?.body?.errno ?? 'unavailable'})`);
  return response.body.data;
}
export async function account(page, expected) {
  await bootstrap(page);
  const data = await request(page, '/builder/app/appinfo');
  const id = backendId(data.user?.app_id, 'account id');
  if (expected && id !== expected) throw new CommandExecutionError('Baijiahao account changed; refusing to modify this operation');
  return id;
}
export async function managementPost(page, id, kind) {
  exactId(id); await bootstrap(page);
  const seen = new Set(); let expected;
  for (let index = 1; index <= 100; index++) {
    const query = new URLSearchParams({ currentPage: String(index), pageSize: '10', search: '', type: '', collection: '', startDate: '', endDate: '', clearBeforeFetch: 'false', dynamic: '1' });
    const data = await request(page, `/pcui/article/lists?${query}`);
    if (!Array.isArray(data.list)) throw new CommandExecutionError('Invalid Baijiahao management list');
    const total = count(data.page?.totalCount, 'totalCount');
    if (total === null) throw new CommandExecutionError('Baijiahao list pagination is unavailable');
    if (expected === undefined) expected = total;
    const before = seen.size; let matched;
    for (const raw of data.list) {
      const currentId = backendId(raw.article_id, 'management id');
      if (seen.has(currentId)) throw new CommandExecutionError('Baijiahao management pagination repeated a work; retry the read');
      seen.add(currentId);
      if (currentId === id) matched = { ...normalizeManagement(raw, id, kind), raw };
    }
    if (matched) return matched;
    if (seen.size >= expected) throw new EmptyResultError('baijiahao content', 'Exact work ID is not present in the current account');
    if (seen.size === before || data.list.length < 10) throw new CommandExecutionError('Incomplete Baijiahao management pagination');
  }
  throw new CommandExecutionError('Baijiahao management lookup exceeded 100 pages; no incomplete result was accepted');
}
export async function readStatistics(page, args, kind) {
  const id = exactId(args.id);
  const work = await managementPost(page, id, kind);
  if (work.status !== 'publish') throw new CommandExecutionError('Statistics require a published work; drafts and processing items are not valid samples');
  const range = statisticsRange(args, work.publishedAt?.slice(0, 10));
  const seen = new Set(); let expected;
  for (let index = 1; index <= 100; index++) {
    const query = new URLSearchParams({ start_day: range.start.replaceAll('-', ''), end_day: range.end.replaceAll('-', ''), type: platformType(kind), num: String(index), count: '10' });
    const data = await request(page, `/author/eco/statistics/articleListStatistic?${query}`);
    if (!Array.isArray(data.list)) throw new CommandExecutionError('Invalid Baijiahao single-work statistics list');
    const total = count(data.count, 'statistics count');
    if (total === null) throw new CommandExecutionError('Baijiahao statistics pagination is unavailable');
    if (expected === undefined) expected = total;
    const before = seen.size; let matched;
    for (const raw of data.list) {
      const currentId = backendId(raw.id, 'statistics management id');
      if (seen.has(currentId)) throw new CommandExecutionError('Baijiahao statistics pagination repeated a work');
      seen.add(currentId);
      if (currentId === id) matched = normalizeStatistics(raw, work, kind, range);
    }
    if (matched) return [matched];
    if (seen.size >= expected) throw new EmptyResultError('baijiahao statistics', 'Exact published work is absent from this date selection; no zero-filled row was generated');
    if (seen.size === before || data.list.length < 10) throw new CommandExecutionError('Incomplete Baijiahao statistics pagination');
  }
  throw new CommandExecutionError('Baijiahao statistics lookup exceeded 100 pages');
}
