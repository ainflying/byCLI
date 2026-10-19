import { cli, Strategy } from '@sovovs/bycli/registry';
import { videoStatus, PUBLISH_COLUMNS } from './_shared/publish.js';
import { editorSessionPage } from './_shared/editor-session.js';

export const videoStatusCommand = cli({
  site: 'weixin-channels', name: 'video-status', access: 'read',
  domain: 'channels.weixin.qq.com', strategy: Strategy.COOKIE,
  browser: args => !!args.id || !!args['management-id'] || !!args['inspect-editor'], navigateBefore: false,
  siteSession: 'persistent',
  description: '读取本地/原页状态；管理端 ID 查询新作品累计数据，数字 ID 复用截至昨日统计',
  args: [
    { name: 'operation', required: true, help: 'video-publish 创建的操作记录路径' },
    { name: 'id', type: 'str', help: 'posts 返回的精确 objectId；不会按描述猜测作品' },
    { name: 'management-id', type: 'str', help: '管理页 export/... ID：查询新作品已发表状态和累计指标，独立于数字统计 ID' },
    { name: 'inspect-editor', type: 'boolean', help: '只读核对原标签页的文件选择、描述、预览及 AI 标注；不上传或提交' },
    { name: 'days', type: 'int', valueRequired: true, help: '发布时间窗口，默认30天，截至上海昨日' },
    { name: 'start-date', type: 'str', valueRequired: true, help: '发布时间起日，须同时提供 end-date' },
    { name: 'end-date', type: 'str', valueRequired: true, help: '发布时间止日，最晚上海昨日' },
    { name: 'limit', type: 'int', default: 100, valueRequired: true, help: '最多查询作品数，1–1000' },
  ],
  columns: PUBLISH_COLUMNS,
  func: async (page, args) => videoStatus(await editorSessionPage(page, args, true), args),
});
