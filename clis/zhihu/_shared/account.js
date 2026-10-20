import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
export async function accountDOM() {
    if (!['https://www.zhihu.com', 'https://zhuanlan.zhihu.com'].includes(location.origin)) return { status: 0 };
    const response = await fetch('https://www.zhihu.com/api/v4/me', { credentials: 'include' });
    if (!response.ok) return { status: response.status };
    const body = await response.json();
    return { status: response.status, slug: body.url_token };
}
export async function currentAccount(page, expected) {
    let result;
    try { result = await page.evaluate(`(${accountDOM.toString()})()`); }
    catch { throw new CommandExecutionError('Could not verify the current Zhihu account'); }
    if (result?.status === 401) throw new AuthRequiredError('www.zhihu.com');
    if (result?.status !== 200 || typeof result.slug !== 'string' || !/^[\w-]+$/.test(result.slug)) throw new CommandExecutionError('Current Zhihu account identity is unavailable');
    if (expected && result.slug !== expected) throw new CommandExecutionError('Zhihu account changed; refusing to modify or submit this operation');
    return result.slug;
}
