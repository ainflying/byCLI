import { cli, Strategy } from '@sovovs/bycli/registry';
import { publishVideo, validatePublishArgs, PUBLISH_COLUMNS } from './_shared/publish.js';
import { editorSessionPage } from './_shared/editor-session.js';

export const videoPublishCommand = cli({
  site: 'weixin-channels', name: 'video-publish', access: 'write',
  domain: 'channels.weixin.qq.com', strategy: Strategy.UI, browser: true, navigateBefore: false,
  siteSession: 'persistent',
  description: '准备视频并显式提交：默认只准备，--mode submit 提交同一操作；原页等待封面完成，未知态不自动重发',
  validateArgs: validatePublishArgs,
  args: [
    { name: 'file', positional: true, help: '本地视频文件（prepare / retry-upload 模式必填）' },
    { name: 'description', help: '完整视频描述（prepare / adopt-draft 必填）' },
    { name: 'ai-generated', choices: ['yes', 'no'], help: '如实选择是否含 AI 生成内容（prepare / adopt-draft 必填）' },
    { name: 'operation', required: true, help: '本地操作记录 JSON 路径，父目录须存在；同一条内容始终复用' },
    { name: 'mode', default: 'prepare', choices: ['prepare', 'adopt-draft', 'retry-upload', 'recover', 'resume', 'submit'], help: 'prepare 上传；adopt-draft 核验现有平台草稿；retry-upload 空页重传；recover 核验重启预览；resume 原页恢复；submit 提交' },
    { name: 'draft-id', help: 'adopt-draft 专用：草稿箱卡片对应的精确 export/... ID' },
    { name: 'editor-page', help: 'adopt-draft / recover / retry-upload：明确检查过的 Chrome 编辑页 ID' },
    { name: 'editor-session', help: 'adopt-draft / recover / retry-upload：已通过 browser <session> bind 明确绑定的浏览器会话' },
    { name: 'timeout', type: 'int', default: 180, help: '上传处理等待秒数（1–1800）' },
    { name: 'execute', type: 'boolean', help: '执行当前操作；提交另需 --mode submit' },
  ],
  columns: PUBLISH_COLUMNS,
  func: async (page, args) => publishVideo(await editorSessionPage(page, args), args),
});
