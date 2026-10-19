import { USER_CONFIRMED_ARG } from '../_shared/publish-confirmation.js';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { publishVideo, validatePublishArgs, PUBLISH_COLUMNS } from './_shared/publish.js';
import { editorSessionPage } from './_shared/editor-session.js';

export const videoPublishCommand = cli({
  site: 'weixin-channels', name: 'video-publish', access: 'write',
  domain: 'channels.weixin.qq.com', strategy: Strategy.UI, browser: true, navigateBefore: false,
  siteSession: 'persistent',
  description: '先上传并保存、重开核对平台草稿；上层获得用户确认后才以 submit --user-confirmed 单次提交',
  validateArgs: validatePublishArgs,
  args: [
    { name: 'file', positional: true, help: '本地视频文件（prepare / retry-upload 模式必填）' },
    { name: 'description', help: '完整视频描述（prepare / adopt-draft 必填）' },
    { name: 'ai-generated', choices: ['yes', 'no'], help: '如实选择是否含 AI 生成内容（prepare / adopt-draft 必填）' },
    { name: 'operation', required: true, help: '本地操作记录 JSON 路径，父目录须存在；同一条内容始终复用' },
    { name: 'mode', default: 'prepare', choices: ['prepare', 'adopt-draft', 'retry-upload', 'recover', 'resume', 'submit'], help: 'prepare 上传并保存核对草稿；adopt-draft 核验现有草稿；retry-upload 空页重传；recover 核验重启预览；resume 恢复或重开已保存草稿；submit 用户确认后提交' },
    { name: 'draft-id', help: 'adopt-draft 专用：草稿箱卡片对应的精确 export/... ID' },
    { name: 'editor-page', help: 'adopt-draft / recover / retry-upload：明确检查过的 Chrome 编辑页 ID' },
    { name: 'editor-session', help: 'adopt-draft / recover / retry-upload：已通过 browser <session> bind 明确绑定的浏览器会话' },
    { name: 'timeout', type: 'int', default: 180, help: '上传处理等待秒数（1–1800）' },
    USER_CONFIRMED_ARG,
    { name: 'execute', type: 'boolean', help: '执行当前操作；提交另需 --mode submit' },
  ],
  columns: PUBLISH_COLUMNS,
  func: async (page, args) => publishVideo(await editorSessionPage(page, args), args),
});
