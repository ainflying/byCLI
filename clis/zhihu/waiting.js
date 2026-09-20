import { cli, Strategy } from '@sovovs/bycli/registry';
import { AuthRequiredError, CliError } from '@sovovs/bycli/errors';

// Serialized into the browser; keep this function self-contained. Use the
// semantic list and question URLs rather than Zhihu's generated CSS hashes.
export function readWaitingPage(expectedLabel) {
    if (/^\/(?:signin|signup|account\/unhuman)(?:\/|$)/.test(location.pathname)) {
        return { status: 'auth', items: [] };
    }
    if (expectedLabel && document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() !== expectedLabel) {
        return { status: 'missing', items: [] };
    }
    const list = document.querySelector('.QuestionWaiting-questions');
    if (!list) return { status: 'missing', items: [] };
    const items = [];
    for (const link of list.querySelectorAll('a[href]')) {
        const url = new URL(link.getAttribute('href'), location.href);
        const id = url.pathname.match(/^\/question\/(\d+)\/?$/)?.[1];
        if (url.origin !== 'https://www.zhihu.com' || !id) continue;
        const titleNode = link.cloneNode(true);
        // The title link may have a block badge such as “新问” or “飙升”.
        titleNode.querySelectorAll('div').forEach(node => node.remove());
        const title = titleNode.textContent.trim();
        if (!title) continue;
        const metadata = link.nextElementSibling?.textContent || '';
        const count = label => {
            const match = metadata.match(new RegExp('([\\d,]+(?:\\.\\d+)?)\\s*([万亿]?)\\s*' + label));
            if (!match) return null;
            const multiplier = match[2] === '万' ? 10000 : match[2] === '亿' ? 100000000 : 1;
            return Math.round(Number(match[1].replace(/,/g, '')) * multiplier);
        };
        items.push({ id, title, views: count('浏览'), answers: count('回答'), followers: count('关注'),
            url: `https://www.zhihu.com/question/${id}` });
    }
    return { status: 'ready', items };
}

const CATEGORIES = {
    recommend: { query: '', label: '为你推荐' },
    invited: { query: '?type=invite', label: '邀请回答' },
    latest: { query: '?type=new', label: '最新问题' },
    hot: { query: '?type=hot', label: '人气问题' },
};

cli({
    site: 'zhihu',
    name: 'waiting',
    access: 'read',
    description: '知乎写回答（等你来答）问题列表',
    domain: 'www.zhihu.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'type', default: 'recommend', choices: Object.keys(CATEGORIES), help: 'Question category: recommend 为你推荐, invited 邀请回答, latest 最新问题, hot 人气问题' },
        { name: 'limit', type: 'int', default: 20, help: 'Maximum questions to return (1–1000; stops when the page stops loading)' },
    ],
    columns: ['rank', 'id', 'title', 'views', 'answers', 'followers', 'url'],
    func: async (page, kwargs) => {
        const limit = Number(kwargs.limit ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
            throw new CliError('INVALID_INPUT', 'Limit must be a positive integer no greater than 1000', 'Example: bycli zhihu waiting --limit 20');
        }
        const type = kwargs.type ?? 'recommend';
        if (!Object.hasOwn(CATEGORIES, type)) {
            throw new CliError('INVALID_INPUT', 'Type must be one of: recommend, invited, latest, hot', 'Example: bycli zhihu waiting --type latest');
        }
        const category = CATEGORIES[type];
        await page.goto(`https://www.zhihu.com/question/waiting${category.query}`);
        const rows = [];
        const seen = new Set();
        let idle = 0;
        let missing = 0;
        // Bound both stalled loading and a feed that continually changes.
        for (let round = 0; round < 120; round++) {
            const state = await page.evaluate(`(${readWaitingPage.toString()})(${JSON.stringify(category.label)})`);
            if (state?.status === 'auth') {
                throw new AuthRequiredError('www.zhihu.com', 'Log into Zhihu and open https://www.zhihu.com/question/waiting');
            }
            if (state?.status !== 'ready' || !Array.isArray(state.items)) {
                if (++missing >= 5) {
                    throw new CliError('DOM_CHANGED', 'Zhihu waiting question list was not found', 'Open https://www.zhihu.com/question/waiting and check that the question list is visible');
                }
                await page.wait(1);
                continue;
            }
            missing = 0;
            const before = rows.length;
            for (const item of state.items) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                rows.push({ rank: rows.length + 1, ...item });
                if (rows.length >= limit) return rows;
            }
            idle = rows.length === before ? idle + 1 : 0;
            if (idle >= 3) break;
            await page.scroll('down', 10000);
            await page.wait(1.5);
        }
        return rows;
    },
});
