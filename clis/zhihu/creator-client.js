import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

export async function fetchCreatorStats(page, target, range) {
    try { await page.goto(target.statsUrl, { stealth: false }); }
    catch { throw new CommandExecutionError('Could not open Zhihu creator analytics'); }
    const request = async (part, start) => {
        const params = new URLSearchParams({ type: target.type, token: target.id, end: range.end });
        if (start) params.set('start', start);
        const path = `/api/v4/creators/analysis/realtime/content/${part}?${params}`;
        let response;
        try { response = await page.evaluate(`(async () => {
            if (location.origin !== 'https://www.zhihu.com') return {origin_error:true};
            if (/^\\/(signin|signup|account\\/unhuman)(\\/|$)/.test(location.pathname)) return {login_required:true};
            const response=await fetch(${JSON.stringify(path)},{credentials:'include'});
            let body;try{body=await response.json();}catch{return {status:response.status,invalid_json:true};}
            return {status:response.status,body};
        })()`); } catch { throw new CommandExecutionError(`Could not read Zhihu creator ${part}; no alternate content type was attempted`); }
        if (response?.login_required || response?.status === 401 || response?.body?.error?.code === 401) throw new AuthRequiredError('www.zhihu.com');
        if (!response || response.origin_error || response.invalid_json || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || response.body?.error || response.body?.code !== undefined && response.body.code !== 0) {
            throw new CommandExecutionError(`Zhihu creator ${part} failed for type=${target.type} (HTTP ${response?.status ?? 'unavailable'}); verify ownership, type and creator access without retrying another type`);
        }
        return response.body;
    };
    const aggregate = await request('aggr', range.scope === 'period' ? range.start : null);
    const daily = await request('daily', range.start);
    return { aggregate, daily };
}
